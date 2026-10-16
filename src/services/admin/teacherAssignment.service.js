import mongoose from "mongoose";
import { Student } from "../../models/studentModel.js";
import { TeacherAssignment } from "../../models/TeacherAssignment.js";
import { User } from "../../models/userModel.js";
import { log as auditLog } from "../../utils/auditService.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import ApiError from "../../utils/ApiError.js";
import { linkStudents, moveClassSlot, syncClassTeacher } from "./teacherClassLink.js";

/**
 * Which students a teacher is responsible for, and the writes that change it.
 *
 * ## The two things this file must never do
 *
 * 1. **Invent a teacher.** `loadTeacher` re-reads the account from the database
 *    on every request and checks school, role and `deletedAt`. A caller-supplied
 *    role is not evidence of anything — the UI shows `school_admin` in the
 *    picker because a head teacher can be assigned students too, and trusting
 *    the client's copy of that is how an accountant ends up with a roster.
 *
 * 2. **Trust a client's list of students.** `assignByClass` resolves the class
 *    roster server-side. The count on the confirmation modal has to be the count
 *    that gets written, and "34 selected" followed by 3 rows is a bug report
 *    that reads as data loss.
 *
 * ## Idempotency, and why it is the default
 *
 * A duplicate `POST` — a double-clicked Assign, or two admins on one school at
 * the same desk — is a success, not an error. The unique partial index already
 * makes it a no-op at the storage layer; the service answers 200 with the count
 * it *actually* changed, so the caller never has to distinguish "already done"
 * from "just done".
 */

/** Roles that may be given students. Mirrors `class.service.js`'s `TEACHING_ROLES`. */
const TEACHING_ROLES = ["teacher", "school_admin"];

/**
 * A ceiling on one request's writes.
 *
 * A school of 2,000 students assigning a whole class is legitimate; the same
 * school assigning *every* student to one teacher in one POST is not an
 * operation anybody meant to do, and it is the shape of the mistake that takes
 * the page down with it.
 */
const MAX_BATCH = 500;

/** Load and authorise the teacher, or throw. Same guards as `class.service.js`. */
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
    .select("_id name role position")
    .lean();
  if (!teacher) {
    throw new ApiError("Teacher not found in this school", 404, "TEACHER_NOT_FOUND");
  }
  return teacher;
};

/**
 * The students the caller named, verified against this school.
 *
 * A stale selection is the common failure: an admin ticks 20 rows, another admin
 * archives three of them, and the first presses Assign. Returning the count that
 * was *actually* linked — rather than the count they ticked — is what makes the
 * toast truthful, and the `skipped` entry is what lets the panel update the
 * rows it knows changed.
 */
const loadStudents = async (schoolId, studentIds) => {
  const unique = [...new Set((studentIds || []).map(String))];
  const valid = unique.filter((id) => /^[0-9a-fA-F]{24}$/.test(id));
  if (!valid.length) {
    throw new ApiError("Select at least one valid student", 400, "VALIDATION_ERROR");
  }
  if (valid.length > MAX_BATCH) {
    throw new ApiError(
      `Select at most ${MAX_BATCH} students at a time`,
      400,
      "VALIDATION_ERROR"
    );
  }

  const students = await Student.find({
    _id: { $in: valid.map((id) => new mongoose.Types.ObjectId(id)) },
    schoolId,
    deletedAt: null,
  })
    .select("_id studentName studentClass")
    .lean();

  // Every row the caller asked about, with the ones that could not be used kept
  // as `null` so the response count matches the request order rather than
  // collapsing silently.
  const byId = new Map(students.map((s) => [String(s._id), s]));
  return { students, byId, requested: valid };
};

/**
 * A class name is validated here and the roster resolved in
 * `teacherClassLink.js`, which owns server-side roster resolution for both
 * assignment routes. This function used to be the class path's own private copy,
 * which is how the two paths ended up with different behaviour.
 */
const assertValidClassName = (className) => {
  const name = String(className || "").trim();
  if (name.length < 2 || name.length > 50) {
    throw new ApiError("A valid className is required", 400, "VALIDATION_ERROR");
  }
  return name;
};

/**
 * The filter the roster panel sends, as a Mongo filter.
 *
 * Only the three the assignment panel actually offers: search, class and status
 * (plus gender, which `RosterFilterBar` supplies). The fee and plan filters from
 * `listStudentsQuerySchema` are deliberately absent — this page is about who a
 * teacher looks after, and filtering that by whether a parent owes fees is a
 * question with an easy way to be misread.
 */
const rosterFilter = (schoolId, { search, class: className, status, gender }) => {
  const filter = { schoolId, deletedAt: null };

  if (className) filter.studentClass = className;
  if (gender) filter.gender = gender;
  if (status && status !== "all") filter.status = status;
  else filter.status = "active";

  if (search) {
    // Escaped, so a search for a character that is special to a regex — or the
    // `(...)` that a phone number in the search box is full of — is matched
    // literally instead of refusing to compile, or worse, matching everything.
    const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { studentName: new RegExp(escaped, "i") },
      { studentId: new RegExp(escaped, "i") },
      { "parents.phone": new RegExp(escaped, "i") },
    ];
  }

  return filter;
};

/**
 * `GET /users/:teacherId/students` — the teacher's students, with the roster's
 * own filters applied on top.
 *
 * ## Why two queries and not one
 *
 * The panel shows the *school's* students with the selected teacher's
 * assignments marked on them, because the admin's question is "who else can I
 * add?" as much as "who is already there?" — a list of only the assigned shows
 * nothing to add. So the roster is read first, and the set of assigned ids is
 * read second and merged in memory: assigning is per-teacher and bounded by the
 * page size, while the roster is the paginated query.
 *
 * The `assignedToTeacher` flag is what the checkbox column renders, which is
 * what stops the page's main failure mode: an admin who does not know whether a
 * tick is adding or re-showing.
 */
export const listTeacherStudents = async (schoolId, teacherUserId, query = {}) => {
  const teacher = await loadTeacher(schoolId, teacherUserId);

  const { page = 1, perPage = 20, sortBy = "studentName", sortOrder = "asc" } = query;
  const filter = rosterFilter(schoolId, query);

  // `studentName` is the roster's own sort default and the only one this page
  // sends; the rest are refused rather than silently ignored, so a typo in a
  // sort key is a 400 rather than a list in an unexpected order.
  const sort = {};
  sort[sortBy] = sortOrder === "desc" ? -1 : 1;

  const [rows, total, assignedIds] = await Promise.all([
    Student.find(filter)
      .select("_id studentId studentName studentClass gender status parents")
      .sort(sort)
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean(),
    Student.countDocuments(filter),
    // Only this teacher's live rows, and only the ids.
    TeacherAssignment.find({ schoolId, teacherId: teacher._id })
      .live()
      .select("studentId classMediated assignedAt")
      .lean(),
  ]);

  const assignedByStudent = new Map(
    assignedIds.map((row) => [String(row.studentId), row])
  );

  return {
    teacher,
    pagination: { page, perPage, total, pages: Math.ceil(total / perPage) || 1 },
    rows: rows.map((student) => {
      const assigned = assignedByStudent.get(String(student._id));
      return {
        _id: student._id,
        studentId: student.studentId,
        name: student.studentName,
        studentClass: student.studentClass,
        gender: student.gender,
        status: student.status,
        parentPhone: student.parents?.[0]?.phone || null,
        assignedToTeacher: Boolean(assigned),
        classMediated: Boolean(assigned?.classMediated),
        assignedAt: assigned?.assignedAt || null,
      };
    }),
  };
};

/**
 * Per-teacher student counts, for the picker's live tally.
 *
 * One aggregation over the assignment collection rather than a count per teacher:
 * a school of forty staff is forty `countDocuments` in a loop, and they are all
 * issued on the same page load.
 *
 * Teachers with no students are absent from the result, by design of `$group` —
 * `useTeachers` already holds the full roster, so the hook merges the counts onto
 * it and a teacher with no assignments reads `0` from the merge rather than from
 * an extra round trip that would have to join two collections.
 */
export const listTeacherAssignmentCounts = async (schoolId) => {
  const rows = await TeacherAssignment.aggregate([
    { $match: { schoolId: new mongoose.Types.ObjectId(String(schoolId)), removedAt: null } },
    { $group: { _id: "$teacherId", count: { $sum: 1 }, classMediated: { $sum: { $cond: ["$classMediated", 1, 0] } } } },
    { $project: { _id: 0, teacherId: "$_id", count: 1, classMediated: 1 } },
  ]);

  return rows;
};

/**
 * The write path shared by both assignment routes.
 *
 * Moved to `teacherClassLink.js` — its own module, because the class path has to
 * write `User.assignedClasses` *and* these rows, and putting the shared bulkWrite
 * under one roof is what stops the two from drifting again.
 */

/**
 * `POST /users/:teacherId/students` — assign the students the admin picked.
 */
export const assignStudents = async (schoolId, adminUserId, teacherUserId, studentIds) => {
  const teacher = await loadTeacher(schoolId, teacherUserId);
  const { students, requested } = await loadStudents(schoolId, studentIds);

  const written = await linkStudents({
    schoolId,
    teacherId: teacher._id,
    students,
    classMediated: false,
  });

  /**
   * Individual picks sit in TeacherAssignment rows, but the Classes page and the
   * teacher portal count from `User.assignedClasses`. When every student the
   * admin just picked belongs to the same class, move the class-teacher slot to
   * this teacher so the Classes page shows them as assigned and the portal can
   * open the class — instead of the admin having to re-run "assign by class".
   */
  const classNames = new Set(students.map((s) => s.studentClass).filter(Boolean));
  if (classNames.size === 1 && written.assigned) {
    await moveClassSlot(schoolId, [...classNames][0], "", teacher._id);
  }

  await auditLog({
    action: AUDIT_ACTIONS.CLASS_ASSIGN_TEACHER,
    entity: "User",
    entityId: teacher._id,
    userId: adminUserId,
    schoolId,
    meta: {
      className: requested.length === 1 ? students[0]?.studentClass || null : null,
      studentCount: written.assigned,
      individual: true,
    },
  });

  return {
    ...written,
    teacher: { _id: teacher._id, name: teacher.name, role: teacher.role },
    assignedIds: students.map((s) => String(s._id)),
  };
};

/**
 * `Workflow C`: assign every active student in a class.
 *
 * ## Why this writes `assignedClasses` too
 *
 * **This is the bug that had a teacher seeing an empty dashboard.** The class
 * path used to write only the per-student rows. The teacher portal reads
 * `User.assignedClasses` — `utils/teacherScope.js` resolves every class list,
 * roster, register and dashboard headcount from it, because it is the
 * authorisation path — so a teacher assigned through this route had rows the
 * console could see and no class the portal could show. The child was not
 * missing; the teacher had no way in.
 *
 * `syncClassTeacher` writes both representations and withdraws the previous
 * class teacher's mediated rows, so one call keeps the console and the portal in
 * step. The per-student path above deliberately does not do this: picking one
 * child does not put a whole class on somebody's timetable.
 */
export const assignStudentsByClass = async (schoolId, adminUserId, teacherUserId, className) => {
  const teacher = await loadTeacher(schoolId, teacherUserId);

  // Refused here rather than in the link step, so a malformed name never reaches
  // a roster read that would answer "no students" and look like an empty class.
  const name = assertValidClassName(className);

  const { previous, linked } = await syncClassTeacher(schoolId, name, teacher._id);

  await auditLog({
    action: AUDIT_ACTIONS.CLASS_ASSIGN_TEACHER,
    entity: "User",
    entityId: teacher._id,
    userId: adminUserId,
    schoolId,
    meta: {
      className,
      studentCount: linked,
      individual: false,
      previousTeacherId: previous?._id || null,
    },
  });

  return {
    assigned: linked,
    className,
    teacher: { _id: teacher._id, name: teacher.name, role: teacher.role },
    previousTeacherId: previous?._id || null,
  };
};

/**
 * `DELETE /users/:teacherId/students` — withdraw a teacher's responsibility for
 * the students named.
 *
 * ## `force` is not a nicety
 *
 * A row written by a class assignment (`classMediated: true`) is not this
 * teacher's individual pick, and dropping it would orphan a class's children
 * while the class teacher still stands — the roster on screen would say one thing
 * and the audit trail another. So the default answer is to remove only the
 * individual rows and report how many class rows were *left alone*, which the
 * panel shows as "2 skipped (assigned with a class)".
 *
 * `force` is the explicit override, and it is a separate request so it can only
 * be sent deliberately.
 */
export const unassignStudents = async (
  schoolId,
  adminUserId,
  teacherUserId,
  { studentIds, force = false } = {}
) => {
  const teacher = await loadTeacher(schoolId, teacherUserId);
  const { byId, requested } = await loadStudents(schoolId, studentIds);

  const ids = [...byId.values()].map((s) => s._id);

  // Class rows are refusable, so they are read before the write rather than
  // filtered out of it — the count of what was skipped is part of the answer.
  const classMediatedRows = await TeacherAssignment.find({
    schoolId,
    teacherId: teacher._id,
    studentId: { $in: ids },
  })
    .live()
    .select("studentId classMediated")
    .lean();

  const classHeld = new Set(
    classMediatedRows.filter((row) => row.classMediated).map((row) => String(row.studentId))
  );

  const removable = ids.filter((id) => !classHeld.has(String(id)));
  const skipped = ids.filter((id) => classHeld.has(String(id)));

  let removed = 0;
  let slotsDropped = 0;
  if (force || removable.length) {
    const targets = force ? ids : removable;
    const result = await TeacherAssignment.updateMany(
      { schoolId, teacherId: teacher._id, studentId: { $in: targets } },
      { $set: { removedAt: new Date() } }
    );
    removed = result.modifiedCount || 0;

    /**
     * The class-teacher slot is dropped when its last mediated child goes.
     *
     * Without this the two representations drift the other way: the console
     * would read "Sir Ciblah has no students in JHS 2" while his portal still
     * showed JHS 2 on every screen, because `assignedClasses` still granted him
     * the scope. The invariant is one sentence and it is enforced here: a
     * teacher holds a class-teacher slot for a class **iff** they hold a live
     * mediated row in it.
     *
     * Individual rows are untouched — a remedial teacher's picks survive.
     */
    const touched = await TeacherAssignment.find({
      schoolId,
      teacherId: teacher._id,
      studentId: { $in: targets },
    });
    for (const className of new Set(touched.map((row) => row.className).filter(Boolean))) {
      const remaining = await TeacherAssignment.countDocuments({
        schoolId,
        teacherId: teacher._id,
        className,
        classMediated: true,
        removedAt: null,
      });
      if (remaining === 0) {
        const slot = await User.updateOne(
          { _id: teacher._id },
          { $pull: { assignedClasses: { className, subject: "" } } }
        );
        if (slot.modifiedCount) slotsDropped += 1;
      }
    }
  }

  await auditLog({
    action: AUDIT_ACTIONS.CLASS_UNASSIGN_SUBJECT_TEACHER,
    entity: "User",
    entityId: teacher._id,
    userId: adminUserId,
    schoolId,
    meta: {
      removed,
      skippedClassMediated: skipped.length,
      force: Boolean(force),
      slotsDropped,
    },
  });

  return {
    removed,
    requested: requested.length,
    skipped: skipped.length,
    skippedReason: skipped.length ? "assigned with a class" : null,
    slotsDropped,
    removedIds: removed ? (force ? ids : removable).map(String) : [],
    teacher: { _id: teacher._id, name: teacher.name, role: teacher.role },
  };
};
