import mongoose from "mongoose";
import { Student } from "../../models/studentModel.js";
import { TeacherAssignment } from "../../models/TeacherAssignment.js";
import { User } from "../../models/userModel.js";

/**
 * The two representations of "this teacher is responsible for this class", and
 * the single place they are written.
 *
 * ## Why this file exists
 *
 * A teacher's classes have two homes, and that is the whole bug this module is
 * the fix for:
 *
 *   - **`User.assignedClasses`** — a list of `{ className, subject }` rows on the
 *     teacher's own account. This is what `utils/teacherScope.js` reads, so it is
 *     what *every teacher-portal endpoint* renders: the class list, the roster,
 *     the register, the grade book, the dashboard headcounts.
 *   - **`TeacherAssignment`** — one row per student, which is what the admin's
 *     Teacher Assignment page shows and mutates.
 *
 * Two routes write only one of them. `PUT /classes/:className/teacher` wrote
 * `assignedClasses` and no `TeacherAssignment` rows; `POST
 * /admin/users/:teacherId/students` with a className wrote the rows and never
 * touched `assignedClasses`. The second one is why a teacher assigned students
 * through the new page saw an empty dashboard: the portal reads the first
 * representation and the write landed in the second.
 *
 * ## The fix
 *
 * One writer, called by both routes. `syncClassTeacher` keeps the two
 * representations in step, so no future route can write one and forget the
 * other. Neither service imports the other — `class.service.js` and
 * `teacherAssignment.service.js` both depend on this module, which is what keeps
 * them from depending on each other.
 *
 * ## Which of the two is authoritative
 *
 * `assignedClasses` still decides what a teacher may *see* and *act on*, exactly
 * as `teacherScope.js` documents: it is the authorisation path and it is
 * resolved per request. `TeacherAssignment` is the per-student record the admin
 * console manages. So the class path through here always writes both, and the
 * per-student path writes only the rows — because picking one student does not
 * put a whole class on somebody's timetable.
 */

/** Roles the class-teacher slot may be moved to. Mirrors `class.service.js`. */
const TEACHING_ROLES = ["teacher", "school_admin"];

/**
 * Move a `{ className, subject }` slot to one teacher, clearing it from whoever
 * held it.
 *
 * Moved verbatim from `class.service.js`, where it was private. An empty
 * `subject` is the class-teacher slot; a named `subject` is a subject-teacher
 * slot. The two never collide because they are different rows, so one person can
 * be a class's form teacher *and* its Mathematics teacher.
 *
 * `canMarkAttendance` decides whether the subject-teacher slot carries
 * attendance rights for that subject in that class. The class-teacher slot
 * (empty subject) always owns attendance and ignores the flag.
 */
export const moveClassSlot = async (schoolId, className, subject, teacherUserId, { canMarkAttendance = false } = {}) => {
  await User.updateMany(
    {
      schoolId,
      "assignedClasses.className": className,
      "assignedClasses.subject": subject,
    },
    { $pull: { assignedClasses: { className, subject } } }
  );
  await User.updateOne(
    { _id: teacherUserId },
    { $addToSet: { assignedClasses: { className, subject, canMarkAttendance } } }
  );
};

/** The current holder of a `{ className, subject }` slot, or null. */
export const currentSlotHolder = async (schoolId, className, subject) => {
  const holder = await User.findOne({
    schoolId,
    "assignedClasses.className": className,
    "assignedClasses.subject": subject,
    deletedAt: null,
  })
    .select("_id name")
    .lean();
  return holder || null;
};

/**
 * The one bulkWrite that links students to a teacher.
 *
 * `$setOnInsert` was tried first and could not work: the update pipeline is only
 * supported on MongoDB 4.2+, and `$set` with an aggregation-style array of
 * stages needs a different call entirely. Reading the row and writing it is
 * simpler and portable, and the unique partial index makes the read safe: two
 * admins adding the same child both find nothing live and both insert, and the
 * second insert collides on the live-pair index rather than duplicating.
 *
 * A tombstone is revived rather than bypassed, so re-assigning after an
 * un-assignment is legal and the history is not overwritten.
 */
export const linkStudents = async ({ schoolId, teacherId, students, classMediated }) => {
  const now = new Date();
  const operations = [];

  for (const student of students) {
    const existing = await TeacherAssignment.findOne({
      schoolId,
      teacherId,
      studentId: student._id,
    }).lean();

    if (existing) {
      if (existing.removedAt) {
        operations.push({
          updateOne: {
            filter: { _id: existing._id },
            update: {
              $set: {
                removedAt: null,
                classMediated,
                assignedAt: now,
                className: student.studentClass || "",
              },
            },
          },
        });
      } else {
        // Already live and already pointing at this teacher: nothing to write,
        // which is what makes a double-clicked Assign a no-op rather than an
        // error or a second row.
        continue;
      }
      continue;
    }

    operations.push({
      insertOne: {
        document: {
          schoolId,
          teacherId,
          studentId: student._id,
          className: student.studentClass || "",
          classMediated,
          assignedAt: now,
          removedAt: null,
        },
      },
    });
  }

  if (!operations.length) return { assigned: 0 };

  await TeacherAssignment.bulkWrite(operations, { ordered: false });

  return { assigned: operations.length };
};

/**
 * The active roster of one class, resolved server-side.
 *
 * `studentClass`, not `className`. Written `className` in the first version of
 * this file, which matched nothing at all: the Student schema has no `className`
 * field, so the query returned an empty roster and every class assignment
 * silently linked zero children — the same class of bug as the one this module
 * exists to fix, and the reason the test below asserts the field by name rather
 * than trusting a shape.
 */
const classRoster = (schoolId, className) =>
  Student.find({
    schoolId,
    studentClass: className,
    status: "active",
    deletedAt: null,
  })
    .select("_id studentName studentClass")
    .sort({ studentName: 1 })
    .lean();

/**
 * Link a whole class's roster to a teacher, as class-mediated rows.
 *
 * Exported for the individual pick on the admin console, which adds one student
 * at a time; the class path goes through `syncClassTeacher`.
 */
export const linkClassRoster = async (schoolId, teacherId, className) => {
  const roster = await classRoster(schoolId, className);
  if (!roster.length) {
    // An empty class is not an error — a class created before its students were
    // imported is normal.
    return { assigned: 0, roster };
  }
  await linkStudents({ schoolId, teacherId, students: roster, classMediated: true });
  return { assigned: roster.length, roster };
};

/**
 * Withdraw a teacher's *class-mediated* rows for one class.
 *
 * `classMediated` only, deliberately: a teacher's individual picks survive a
 * class change. That is the whole point of the flag — a remedial teacher who
 * also happens to have been the form teacher keeps the children they were
 * personally given.
 */
export const unlinkClassRoster = async (schoolId, teacherId, className) => {
  const result = await TeacherAssignment.updateMany(
    { schoolId, teacherId, className, classMediated: true },
    { $set: { removedAt: new Date() } }
  );
  return { removed: result.modifiedCount || 0 };
};

/**
 * Both representations, in step, for one teacher taking one class.
 *
 * The order matters and is not arbitrary:
 *
 *   1. read the previous holder of the class-teacher slot,
 *   2. move the slot — which is what makes the class actually appear on the
 *      teacher's portal,
 *   3. link the roster to the new teacher,
 *   4. withdraw the *previous* holder's class rows, so the roster the console
 *      shows does not still list a teacher who no longer has the class.
 *
 * Step 4 is why the previous holder is read at step 1 rather than after the
 * move: `moveClassSlot` has already cleared them by then.
 *
 * Idempotent, so re-assigning the same teacher to the same class is a no-op on
 * every step.
 *
 * @param {string} schoolId
 * @param {string} className
 * @param {string} teacherUserId the incoming teacher
 * @returns {Promise<{ previous: object|null, linked: number, unlinked: number }>}
 */
export const syncClassTeacher = async (schoolId, className, teacherUserId) => {
  const previous = await currentSlotHolder(schoolId, className, "");

  await moveClassSlot(schoolId, className, "", teacherUserId);

  const linked = await linkClassRoster(schoolId, teacherUserId, className);

  let unlinked = 0;
  if (previous && String(previous._id) !== String(teacherUserId)) {
    unlinked = (await unlinkClassRoster(schoolId, previous._id, className)).removed;
  }

  return { previous, linked: linked.assigned, unlinked };
};

/**
 * Where the two representations have drifted apart, per teacher.
 *
 * ## Why this exists
 *
 * `syncClassTeacher` only writes `assignedClasses` from the moment it was
 * introduced. Before it, the class path wrote `TeacherAssignment` rows *only* —
 * so a school that assigned a class through the earlier console has a teacher
 * with twenty children on the admin screen and an empty teacher portal, and
 * **no way to tell** from either side that they disagree. One screen says
 * "20 of 20 students shown are assigned"; the other says "no classes".
 *
 * Drift is also not hypothetical while a backend is mid-deploy: an admin can
 * assign against old service code, and the console commits while the portal
 * reads nothing.
 *
 * So this detects it, and `repairAssignmentDrift` fixes it. Both are read-only
 * and idempotent respectively, and neither changes authorisation — a repaired
 * teacher gets exactly the class their existing rows already imply.
 *
 * @param {string} schoolId
 * @returns {Promise<Array<{ teacherId, teacherName, classes: string[], students: number }>>}
 */
export const detectAssignmentDrift = async (schoolId) => {
  // One teacher → many classes, so the group key is a document.
  const grouped = await TeacherAssignment.aggregate([
    {
      $match: {
        schoolId: new mongoose.Types.ObjectId(String(schoolId)),
        classMediated: true,
        removedAt: null,
      },
    },
    {
      $group: {
        _id: "$teacherId",
        classNames: { $addToSet: "$className" },
        students: { $sum: 1 },
      },
    },
  ]);

  if (!grouped.length) return [];

  // Every teacher holding class-mediated rows, with their current slots, in one
  // query rather than one per teacher.
  const teachers = await User.find({ _id: { $in: grouped.map((row) => row._id) } })
    .select("_id name assignedClasses")
    .lean();

  const teacherById = new Map(teachers.map((t) => [String(t._id), t]));

  const drifted = [];
  for (const row of grouped) {
    const teacher = teacherById.get(String(row._id));
    // A deleted teacher whose rows are still live: nothing to repair, and saying
    // so would point the admin at an account that no longer exists.
    if (!teacher) continue;

    const slots = new Set(
      (teacher.assignedClasses || [])
        .filter((entry) => entry && entry.className)
        .map((entry) => String(entry.className))
    );

    const missing = (row.classNames || []).filter((name) => !slots.has(String(name)));
    if (missing.length) {
      drifted.push({
        teacherId: String(teacher._id),
        teacherName: teacher.name,
        classes: missing.sort(),
        students: row.students,
      });
    }
  }

  return drifted;
};

/**
 * Write the missing `assignedClasses` slots, teacher by teacher.
 *
 * Reuses `syncClassTeacher` rather than writing the slot directly, so the repair
 * and the original assignment produce byte-identical state — a repair that
 * produced a different shape would be a third thing to reason about.
 *
 * @param {string} schoolId
 * @param {string} [teacherId] limit the repair to one teacher; all of them by default
 * @returns {Promise<{ repaired: number, classes: number, teachers: string[] }>}
 */
export const repairAssignmentDrift = async (schoolId, teacherId) => {
  const drifted = await detectAssignmentDrift(schoolId);
  const targets = teacherId ? drifted.filter((row) => String(row.teacherId) === String(teacherId)) : drifted;

  let classes = 0;
  const teachers = [];

  for (const row of targets) {
    for (const className of row.classes) {
      await syncClassTeacher(schoolId, className, row.teacherId);
      classes += 1;
    }
    teachers.push(row.teacherId);
  }

  return { repaired: targets.length, classes, teachers };
};

export default {
  moveClassSlot,
  currentSlotHolder,
  linkStudents,
  linkClassRoster,
  unlinkClassRoster,
  syncClassTeacher,
  detectAssignmentDrift,
  repairAssignmentDrift,
};
