import mongoose from "mongoose";
import { School } from "../models/schoolModel.js";
import { Student } from "../models/studentModel.js";
import ApiError from "./ApiError.js";

/**
 * Teacher scope: which classes a signed-in account may act on.
 *
 * Every teacher endpoint resolves this before it reads a class, a roster or a
 * student, because a class *name* is the only address a class has in this
 * product. There is no `Class` collection to hold a `teacherId`, so the link
 * lives on the teacher's own account: `User.assignedClasses` is a list of
 * `{ className, subject }` pairs, and `School.academic.classes` is the set of
 * names the school actually runs.
 *
 * ## Why the school's list is consulted, not just the teacher's
 *
 * A teacher keeps `JHS 2A` from last year and the school retires it. Trusting
 * the teacher's list alone would render a class whose roster no longer exists
 * and a summary built from an empty `className` filter, both of which read as
 * "this class has no students" rather than "this class is gone". Intersecting
 * the two makes a stale assignment silently disappear from the UI, which is the
 * answer a teacher needs.
 *
 * ## Why admins resolve to every class
 *
 * A headteacher who wants to look at JHS 3B's summary is not a data bug, it is
 * the job. `requireTeacher` admits `school_admin` and `super_admin`
 * deliberately (see `middleware/roles.js`), so this helper grants them the
 * school's whole class list rather than sending them through an assignment
 * screen an admin would have to maintain by hand.
 */

/** Roles that may act on every class in their own school. */
const ADMIN_ROLES = ["school_admin", "super_admin"];

/**
 * The actor every teacher endpoint operates as: the caller, plus the school
 * their request is scoped to.
 *
 * ## Why the school is resolved here rather than read as `user.schoolId`
 *
 * `requireTeacher` admits a `super_admin` (`middleware/roles.js`), and
 * `requireSchool` lets one through as platform staff — but a super admin's own
 * `schoolId` is **null by design** (`middleware/impersonation.js:141`) so that
 * their console reads stay platform-wide. Reading `user.schoolId` directly
 * therefore produced a 401 from `loadTeacherScope` for the one caller
 * `requireTeacher` explicitly invited in: a platform owner impersonating a
 * school wanted to see that school's register.
 *
 * The impersonation target is `user.impersonatingSchoolId`, the pointer
 * `middleware/impersonation.js` re-validates against a live session on *every*
 * request before allowing the call to continue — so it is not a stale claim,
 * and it is only ever set by the `super_admin`-gated impersonation route
 * (`impersonation.service.js`). Preferring it over `user.schoolId` is safe
 * precisely because a school-admin account can never carry it.
 *
 * ## Why the returned object is not the Mongoose document
 *
 * `user.schoolId` is read by every service below, and a document's path cannot
 * be reassigned without `doc.set()`, which would mark it modified — a latent
 * bug the moment anything saves the user. Building a plain actor instead keeps
 * the services' `user.schoolId` API unchanged and leaves the document alone.
 * Only the fields the teacher services actually read are carried, so an
 * accidental dependency on some other path fails loudly rather than silently
 * picking up a stale value.
 */
export const resolveTeacherActor = (user) => {
  if (!user?._id) {
    throw new ApiError("A signed-in account is required", 401, "UNAUTHENTICATED");
  }

  const schoolId = user.schoolId || user.impersonatingSchoolId || null;
  if (!schoolId) {
    throw new ApiError(
      "A platform owner must be impersonating a school to open the teacher portal",
      403,
      "NO_SCHOOL_SCOPE"
    );
  }

  return {
    _id: user._id,
    role: user.role,
    name: user.name,
    assignedClasses: user.assignedClasses,
    schoolId,
  };
};

const asObjectId = (value) => new mongoose.Types.ObjectId(String(value));

/**
 * Load the school's academic context and the caller's classes together.
 *
 * Returned together because every caller wants both: the classes to scope the
 * read, and the school to resolve which term and academic year the read is for.
 * Loading them separately would double the school query on every endpoint.
 *
 * @param {object} user      the authenticated User document (`req.user`)
 * @param {string|ObjectId} schoolId
 * @returns {Promise<{ school: object, classes: Array<{ className: string, subject: string, subjects: string[], studentCount: number }> }>}
 */
export const loadTeacherScope = async (user, schoolId) => {
  if (!user || !schoolId) {
    throw new ApiError(
      "A signed-in account with a school is required",
      401,
      "UNAUTHENTICATED"
    );
  }

  const school = await School.findById(schoolId).select("academic").lean();
  if (!school) {
    throw new ApiError("School not found", 404, "SCHOOL_NOT_FOUND");
  }

  const schoolClasses = Array.isArray(school.academic?.classes)
    ? school.academic.classes
    : [];

  // An admin acting as a teacher gets the school's whole list; a teacher gets
  // their own. Both paths land in the same shape below.
  const assigned = ADMIN_ROLES.includes(user.role)
    ? schoolClasses.map((className) => ({ className, subject: "" }))
    : Array.isArray(user.assignedClasses)
      ? user.assignedClasses
      : [];

  // One entry per class, with the subjects merged. A teacher who takes both
  // Mathematics and English in JHS 2A is one class on every screen that counts
  // classes, and two subjects on every screen that fills a grade book.
  const byClass = new Map();
  for (const entry of assigned) {
    const className = String(entry?.className || "").trim();
    if (!className || !schoolClasses.includes(className)) continue;

    const merged = byClass.get(className) || { className, subjects: [] };
    const subject = String(entry?.subject || "").trim();
    if (subject && !merged.subjects.includes(subject)) {
      merged.subjects.push(subject);
    }
    byClass.set(className, merged);
  }

  const entries = [...byClass.values()];
  if (!entries.length) {
    return { school, classes: [] };
  }

  // One student-count query for the whole list, not one per class: a teacher
  // with six classes reads this on every dashboard load.
  const counts = await Student.aggregate([
    {
      $match: {
        schoolId: asObjectId(schoolId),
        deletedAt: null,
        // `status: "active"` is the liveness pair the student module uses
        // everywhere a class headcount is reported (`student.service.js`),
        // so a teacher's count and the admin's count are the same number.
        status: "active",
        studentClass: { $in: entries.map((entry) => entry.className) },
      },
    },
    { $group: { _id: "$studentClass", count: { $sum: 1 } } },
  ]);
  const countByClass = new Map(counts.map((row) => [row._id, row.count]));

  return {
    school,
    classes: entries.map((entry) => ({
      className: entry.className,
      // Empty when the teacher is a class teacher with no subject attached —
      // the UI labels that "Class teacher". Storing a UI label here instead
      // would make a class teacher indistinguishable from one who teaches "".
      subject: entry.subjects[0] || "",
      subjects: entry.subjects,
      studentCount: countByClass.get(entry.className) || 0,
    })),
  };
};

/**
 * Just the classes. The narrow read for endpoints that do not need the term or
 * the academic year.
 */
export const resolveTeacherClasses = async (user, schoolId) =>
  (await loadTeacherScope(user, schoolId)).classes;

/**
 * Assert that a caller may act on a class, throwing rather than returning.
 *
 * This is the load-bearing helper of the whole module. It throws 403 rather
 * than letting an endpoint resolve to an empty list, because "you are not
 * assigned to this class" and "this class has no students" are different facts:
 * the first is an authorisation answer that must be loud, the second is a data
 * answer the UI renders as an empty state. Collapsing the two turns a
 * permissions bug into a silent blank screen.
 */
export const assertTeacherScope = async (user, schoolId, className) => {
  const classes = await resolveTeacherClasses(user, schoolId);
  if (!classes.some((entry) => entry.className === className)) {
    throw new ApiError(
      "You are not assigned to this class",
      403,
      "FORBIDDEN_SCOPE"
    );
  }
};

/**
 * Load one student and assert the caller is assigned to that student's class.
 *
 * The student is loaded here rather than in each service so the 404 and the 403
 * cannot disagree: a student who does not exist is a 404, and a student who
 * exists in someone else's class is a 403. Both are `{ _id: studentId }`
 * lookups from the caller's side, so the distinction has to be made in one
 * place.
 *
 * Not filtered on `status: "active"` — a direct read of a named student is a
 * question about *that* student, and a graduated or transferred one still has a
 * record worth showing. The class-wide roster is the surface that filters.
 */
export const loadStudentScope = async (user, schoolId, studentId) => {
  const student = await Student.findOne({
    _id: studentId,
    schoolId,
    deletedAt: null,
  })
    .select("_id studentId studentName studentClass academicYear")
    .lean();

  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  const { school, classes } = await loadTeacherScope(user, schoolId);
  if (!classes.some((entry) => entry.className === student.studentClass)) {
    throw new ApiError(
      "You are not assigned to this student",
      403,
      "FORBIDDEN_SCOPE"
    );
  }

  return { student, school, classes };
};
