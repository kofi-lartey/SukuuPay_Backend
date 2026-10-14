import mongoose from "mongoose";
import { School } from "../../models/schoolModel.js";
import { Student } from "../../models/studentModel.js";
import { User } from "../../models/userModel.js";
import { log as auditLog } from "../../utils/auditService.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import ApiError from "../../utils/ApiError.js";
import {
  currentSlotHolder,
  moveClassSlot,
  syncClassTeacher,
} from "./teacherClassLink.js";

/**
 * Class and teacher management, built on how SukuuPay *actually* models a class.
 *
 * There is no `Class` collection. A class is a **name** that lives in
 * `School.academic.classes` (a list of strings) and is denormalised onto
 * students, grades, report cards and timetables as `className` /
 * `studentClass`. A teacher's link to a class lives on their own account, as
 * `User.assignedClasses: [{ className, subject }]` — one entry per class per
 * subject, and a *class teacher* is the entry with an empty `subject`
 * (see `models/userModel.js` and `utils/teacherScope.js`, the single reader).
 *
 * This service is therefore the headmaster's surface over those two fields:
 * it adds and retires class *names*, and it moves the `{ className, subject }`
 * assignment rows between teachers. Nothing here invents a `Class` document,
 * because doing so would put the class list in two places that could disagree —
 * and `teacherScope` reads the name, not a document.
 */

/** Roles that may be assigned to teach. `accountant` and `viewer` may not. */
const TEACHING_ROLES = ["teacher", "school_admin"];

/** The school's live class names, or an empty list. */
const readClassNames = async (schoolId) => {
  const school = await School.findById(schoolId).select("academic.classes").lean();
  return Array.isArray(school?.academic?.classes)
    ? school.academic.classes.filter(Boolean)
    : [];
};

/** The school exists and names this class, or throw. */
const assertClassExists = async (schoolId, className) => {
  const names = await readClassNames(schoolId);
  if (!names.includes(className)) {
    throw new ApiError(`Class "${className}" not found`, 404, "CLASS_NOT_FOUND");
  }
};

/** Load and authorise the teacher being assigned, or throw. */
const loadTeacher = async (schoolId, teacherUserId) => {
  if (!teacherUserId || !/^[0-9a-fA-F]{24}$/.test(String(teacherUserId))) {
    throw new ApiError("A valid teacherId is required", 400, "VALIDATION_ERROR");
  }
  const teacher = await User.findOne({
    _id: teacherUserId,
    schoolId,
    role: { $in: TEACHING_ROLES },
    deletedAt: null,
  })
    .select("_id name role")
    .lean();
  if (!teacher) {
    throw new ApiError(
      "Teacher not found in this school",
      404,
      "TEACHER_NOT_FOUND"
    );
  }
  return teacher;
};

/**
 * The `{ className, subject }` slot primitives now live in
 * `teacherClassLink.js`, next to the per-student rows they must stay in step
 * with. They were private here, which is what allowed the two assignment
 * surfaces to drift — see that module's header for the bug this fixed.
 */

/**
 * List the school's classes, each with a headcount and a teacher count.
 *
 * Headcounts count `active` students only — the same liveness filter the student
 * module and `teacherScope` use — so the number a headmaster sees here matches
 * the number on the roster. Both counts are two aggregate queries for the whole
 * list, not one per class: a school with fifty classes reads this on every
 * dashboard load.
 */
export const listClasses = async (schoolId, { search } = {}) => {
  let names = await readClassNames(schoolId);
  if (search) {
    const rx = new RegExp(String(search).trim(), "i");
    names = names.filter((name) => rx.test(name));
  }
  names.sort((a, b) => a.localeCompare(b));

  if (!names.length) return { classes: [] };

  const schoolObjectId = new mongoose.Types.ObjectId(String(schoolId));

  const studentCounts = await Student.aggregate([
    {
      $match: {
        schoolId: schoolObjectId,
        deletedAt: null,
        status: "active",
        studentClass: { $in: names },
      },
    },
    { $group: { _id: "$studentClass", count: { $sum: 1 } } },
  ]);
  const studentsByClass = new Map(studentCounts.map((r) => [r._id, r.count]));

  const teacherCounts = await User.aggregate([
    {
      $match: {
        schoolId: schoolObjectId,
        deletedAt: null,
        "assignedClasses.className": { $in: names },
      },
    },
    { $unwind: "$assignedClasses" },
    { $match: { "assignedClasses.className": { $in: names } } },
    {
      $group: {
        _id: "$assignedClasses.className",
        teachers: { $addToSet: "$_id" },
      },
    },
    { $project: { _id: 1, count: { $size: "$teachers" } } },
  ]);
  const teachersByClass = new Map(teacherCounts.map((r) => [r._id, r.count]));

  return {
    classes: names.map((className) => ({
      className,
      studentCount: studentsByClass.get(className) || 0,
      teacherCount: teachersByClass.get(className) || 0,
    })),
  };
};

/**
 * Create a class by adding its name to the school's list.
 *
 * A duplicate name is a 409 — two "JHS 2A"s would make every `className` read
 * ambiguous, because the name *is* the address. `room`, `capacity`, `level` and
 * a `subjects` list are deliberately not accepted: they are fields a Class
 * *document* would hold, and this product has none. Retiring them is what keeps
 * the one-list invariant.
 */
export const createClass = async (schoolId, userId, payload) => {
  const { className } = payload;
  if (!className || className.trim().length < 2) {
    throw new ApiError("className is required", 400, "VALIDATION_ERROR");
  }
  const name = className.trim();

  const names = await readClassNames(schoolId);
  if (names.includes(name)) {
    throw new ApiError("A class with that name already exists", 409, "DUPLICATE");
  }

  await School.updateOne(
    { _id: schoolId },
    { $addToSet: { "academic.classes": name } }
  );

  await auditLog({
    action: AUDIT_ACTIONS.CLASS_CREATE,
    entity: "Class",
    userId,
    schoolId,
    meta: { className: name },
  });

  return { className: name, studentCount: 0, teacherCount: 0 };
};

/**
 * Retire a class by removing its name from the school's list.
 *
 * A class with active students cannot be retired: doing so would strand them on
 * a `studentClass` that no longer exists, and every roster read would quietly
 * drop them. Move the students first, then retire the name. Any teacher
 * assignments pointing at the retired class are pulled in the same breath, so
 * the class leaves no dangling assignment rows behind.
 */
export const archiveClass = async (schoolId, userId, className) => {
  await assertClassExists(schoolId, className);

  const activeStudents = await Student.countDocuments({
    schoolId,
    studentClass: className,
    deletedAt: null,
    status: "active",
  });
  if (activeStudents > 0) {
    throw new ApiError(
      `Cannot archive a class with ${activeStudents} students. Move them first.`,
      400,
      "CLASS_NOT_EMPTY"
    );
  }

  await School.updateOne(
    { _id: schoolId },
    { $pull: { "academic.classes": className } }
  );
  const assignmentClear = await User.updateMany(
    { schoolId, "assignedClasses.className": className },
    { $pull: { assignedClasses: { className } } }
  );

  await auditLog({
    action: AUDIT_ACTIONS.CLASS_ARCHIVE,
    entity: "Class",
    userId,
    schoolId,
    meta: { className, assignmentsCleared: assignmentClear.modifiedCount },
  });

  return { success: true, className };
};

/**
 * Assign the class teacher — the empty-subject slot for the class.
 *
 * Overwrites any existing class teacher: the previous holder's slot is pulled
 * and the new teacher's is added, so exactly one teacher holds it. The previous
 * holder is recorded in the audit trail rather than notified — that is a product
 * decision, and the trail is where the change lives.
 */
export const assignClassTeacher = async (schoolId, userId, className, teacherUserId) => {
  await assertClassExists(schoolId, className);
  const teacher = await loadTeacher(schoolId, teacherUserId);

  /**
   * `syncClassTeacher` writes *both* representations.
   *
   * This used to be `moveAssignment` alone — `assignedClasses` only, with no
   * `TeacherAssignment` rows. The admin's Teacher Assignment page therefore
   * showed a teacher as having no students while the teacher's own portal
   * worked perfectly, because the two surfaces read different stores.
   */
  const { previous } = await syncClassTeacher(schoolId, className, teacher._id);

  await auditLog({
    action: AUDIT_ACTIONS.CLASS_ASSIGN_TEACHER,
    entity: "User",
    entityId: teacher._id,
    userId,
    schoolId,
    meta: {
      className,
      subject: null,
      previousTeacherId: previous?._id || null,
      teacherId: teacher._id,
      teacherName: teacher.name,
    },
  });

  return {
    className,
    classTeacher: { teacherId: teacher._id, name: teacher.name, role: teacher.role },
  };
};

/**
 * Assign a subject teacher for one subject in one class.
 *
 * Replaces whatever teacher holds that `{ className, subject }` slot and leaves
 * every other subject's teacher untouched — English's teacher is not affected by
 * a change to Mathematics. `moveClassSlot` does the replace-or-add.
 */
export const assignSubjectTeacher = async (
  schoolId,
  userId,
  className,
  { subject, teacherUserId }
) => {
  await assertClassExists(schoolId, className);
  if (!subject || subject.trim().length < 2) {
    throw new ApiError("subject is required", 400, "VALIDATION_ERROR");
  }
  const subj = subject.trim();
  const teacher = await loadTeacher(schoolId, teacherUserId);
  const previous = await currentSlotHolder(schoolId, className, subj);

  await moveClassSlot(schoolId, className, subj, teacher._id);

  await auditLog({
    action: AUDIT_ACTIONS.CLASS_ASSIGN_SUBJECT_TEACHER,
    entity: "User",
    entityId: teacher._id,
    userId,
    schoolId,
    meta: {
      className,
      subject: subj,
      previousTeacherId: previous?._id || null,
      teacherId: teacher._id,
      teacherName: teacher.name,
    },
  });

  return {
    className,
    subject: subj,
    subjectTeacher: { teacherId: teacher._id, name: teacher.name, role: teacher.role },
  };
};

/**
 * Remove the subject teacher for one subject in one class.
 *
 * The one-subject removal the acceptance criteria call for: the
 * `{ className, subject }` row is pulled from whoever holds it, and only that
 * row. Removing a subject teacher who never existed removes zero rows and
 * answers `{ removed: 0 }` rather than erroring — it is an idempotent unpin, not
 * a "delete this teacher" operation.
 */
export const unassignSubjectTeacher = async (schoolId, userId, className, subject) => {
  await assertClassExists(schoolId, className);
  const subj = String(subject || "").trim();
  if (!subj) {
    throw new ApiError("subject is required", 400, "VALIDATION_ERROR");
  }

  const result = await User.updateMany(
    {
      schoolId,
      "assignedClasses.className": className,
      "assignedClasses.subject": subj,
    },
    { $pull: { assignedClasses: { className, subject: subj } } }
  );

  await auditLog({
    action: AUDIT_ACTIONS.CLASS_UNASSIGN_SUBJECT_TEACHER,
    entity: "User",
    userId,
    schoolId,
    meta: { className, subject: subj, removed: result.modifiedCount },
  });

  return { className, subject: subj, removed: result.modifiedCount };
};

/**
 * Who teaches this class — the read that goes with the assignment writes above.
 *
 * One row per `{ className, subject }` assignment in the class, so a class
 * teacher and a subject teacher both appear, and a single teacher who takes two
 * subjects appears twice. The empty `subject` is rendered as the class-teacher
 * slot rather than dropped.
 */
export const getClassAssignments = async (schoolId, className) => {
  await assertClassExists(schoolId, className);

  const teachers = await User.find({
    schoolId,
    "assignedClasses.className": className,
    deletedAt: null,
  })
    .select("name role assignedClasses")
    .lean();

  const assignments = [];
  for (const teacher of teachers) {
    for (const entry of teacher.assignedClasses || []) {
      if (entry.className !== className) continue;
      assignments.push({
        teacherId: teacher._id,
        name: teacher.name,
        role: teacher.role,
        subject: entry.subject || "",
        isClassTeacher: !entry.subject,
      });
    }
  }
  assignments.sort((a, b) => (a.isClassTeacher ? -1 : 1) || a.subject.localeCompare(b.subject));

  return { className, assignments };
};
