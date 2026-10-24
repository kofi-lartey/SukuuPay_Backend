import Joi from "joi";

/** A class name is the same shape `class.service.js` accepts. */
const classNameValidator = Joi.string().trim().min(2).max(50);

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * Validation for the teacher-assignment surface.
 *
 * The body schemas shape the *two* ways an assignment happens and no others:
 * picking individual students, or naming a class. Anything else — an empty body,
 * a client-computed list of a class's students — is refused rather than
 * half-honoured, because a request that names a class and a list at once has an
 * ambiguity nobody can resolve later.
 */

/** `:teacherId` in the path. Validated here so a malformed id is a 400, not a cast error. */
export const teacherIdParamSchema = Joi.object({
  teacherId: Joi.string().pattern(OBJECT_ID).required(),
});

/**
 * The roster query, narrow on purpose.
 *
 * Search, class, status and gender — the four the panel offers. Fee and plan
 * filters are deliberately absent: filtering "who a teacher looks after" by
 * whether a parent owes fees is a question with an easy way to be misread, and
 * one that has nothing to do with assignment.
 */
export const listTeacherStudentsQuerySchema = Joi.object({
  search: Joi.string().trim().max(100).allow("").optional(),
  class: classNameValidator.allow("").optional(),
  gender: Joi.string().valid("male", "female").allow("").optional(),
  tag: Joi.string().valid("CT", "ST", "unassigned", "").allow("").optional(),
  status: Joi.string()
    .valid("active", "suspended", "graduated", "transferred", "archived", "all")
    .default("active"),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
  // The only sort the panel sends. Anything else is a 400 rather than a
  // silently-different order, so a typo surfaces as a bug rather than as a list
  // in an order nobody can explain.
  sortBy: Joi.string().valid("studentName", "studentId", "createdAt").default("studentName"),
  sortOrder: Joi.string().valid("asc", "desc").default("asc"),
});

/**
 * The one assignment body, in either of its two shapes.
 *
 * `.xor` — exactly one, not at least one — is the load-bearing part: a request
 * naming *both* a list of students and a class is ambiguous in a way nobody can
 * resolve after the fact, so it is a 400 rather than a decision made by whichever
 * key the handler happens to read first. An empty body is caught by the same
 * rule, and so is a body naming neither.
 */
export const assignStudentsSchema = Joi.object({
  studentIds: Joi.array()
    .items(Joi.string().pattern(OBJECT_ID))
    .min(1)
    .max(500)
    .optional(),
  className: classNameValidator.optional(),
  role: Joi.string().valid('subject', 'class').optional(),
  subjects: Joi.array().items(Joi.string().trim().min(1).max(50)).optional(),
  canMarkAttendance: Joi.boolean().optional(),
})
  .xor("studentIds", "className")
  .unknown(false);

/** Withdrawing individual picks, with an explicit override for class rows. */
export const unassignStudentsSchema = Joi.object({
  studentIds: Joi.array()
    .items(Joi.string().pattern(OBJECT_ID))
    .min(1)
    .max(500)
    .required(),
  // `force` is spelled out on every call rather than folded into a second
  // endpoint: one route, and the flag is visible in the audit row either way.
  force: Joi.boolean().default(false),
}).unknown(false);

/**
 * `POST /admin/users/teacher-assignment-drift/repair`
 *
 * `teacherId` absent means every teacher in the school, which is the case the
 * repair exists for: drift is a property of a deployment, not of one account.
 */
export const repairAssignmentDriftSchema = Joi.object({
  teacherId: Joi.string().pattern(OBJECT_ID).optional(),
}).unknown(false);
