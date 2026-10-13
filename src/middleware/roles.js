import { authorize } from "./authenticate.js";

/**
 * The gate on every `/teacher/*` route.
 *
 * ## Why this exists rather than a role list in the route file
 *
 * The role list is a security decision and belongs in one named place. The
 * admin console writes `authorize("super_admin", "school_admin", "teacher")`
 * inline on each route (`admin.attendance.routes.js:39`), and that is fine for
 * four routes; the teacher portal's routes would each repeat the same four-word
 * string and drift one word at a time. This file is the single reader of that
 * decision.
 *
 * ## Who is allowed, and why
 *
 * A `teacher`, because the register and the grade book *are* a teacher's job —
 * the class teacher is the only person in the building who knows the child was
 * at the clinic this morning. A `school_admin`, because a headteacher asking
 * what JHS 3B is averaging is the job too, and `teacherScope` grants them the
 * school's whole class list rather than sending them through an assignment
 * screen they would have to maintain. A `super_admin`, for the same reason the
 * admin console allows one: they can act across every tenant.
 *
 * `accountant` and `viewer` are excluded — attendance is not money, and a
 * read-only guest has no business in a grade book. `class_teacher` is
 * deliberately absent: the `User.role` enum has no such value
 * (`userModel.js:54`), so listing it would be configuration that can never
 * match.
 */
export const requireTeacher = authorize(
  "super_admin",
  "school_admin",
  "teacher"
);

/**
 * The gate on the headmaster side of the academic console.
 *
 * The complement of `requireTeacher`: the disclosure and governance actions —
 * approving marks, publishing report cards, creating classes, assigning
 * teachers — belong to `school_admin` (the role every headmaster, assistant
 * headmaster and academic head holds; SukuuPay models the seniority in
 * `User.position`, not in a second role) and to `super_admin` for the platform
 * owner acting across tenants.
 *
 * A `teacher` is deliberately excluded. The teacher enters marks and compiles
 * the numbers; the headmaster decides they are final. They are two people on
 * purpose — the class teacher marks, the head signs — and this is the line
 * between them. `accountant` and `viewer` are excluded for the same reason
 * they are from `requireTeacher`: neither has any business in a grade book.
 *
 * Named here rather than written inline so the role list is a decision read in
 * one place, exactly as `requireTeacher` is. `authorize` lives in
 * `middleware/authenticate.js`.
 */
export const requireSchoolAdmin = authorize(
  "super_admin",
  "school_admin"
);

export default requireTeacher;
