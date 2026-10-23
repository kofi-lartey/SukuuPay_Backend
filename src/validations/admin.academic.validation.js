import Joi from "joi";
import { ACADEMIC_TERMS } from "../config/constants.js";
import { upsertTimetableSchema } from "./admin.timetable.validation.js";

/**
 * Validation for the headmaster's academic console — grade approval, report
 * card review, class management, timetables and the overview.
 *
 * The house rules carried through from the sibling schema files: term values
 * come from `ACADEMIC_TERMS` rather than being re-typed, the academic year is
 * locked to the platform's single written form `YYYY/YYYY`, ids are validated
 * against the ObjectId shape before they ever reach a cast, and every schema
 * uses `stripUnknown` (set by `middleware/validate.js`) so an unexpected field
 * is dropped rather than trusted. The timetable body schema is *imported* from
 * `admin.timetable.validation.js` rather than copied, so the two write paths for
 * a timetable cannot drift.
 */

const ACADEMIC_YEAR = /^\d{4}\/\d{4}$/;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** The three fields every grade- and report-block operation is scoped by. */
const classScope = {
  className: Joi.string().trim().min(2).max(50),
  term: Joi.string()
    .valid(...ACADEMIC_TERMS)
    .required(),
  academicYear: Joi.string()
    .trim()
    .pattern(ACADEMIC_YEAR)
    .required(),
};

// ── Grade approval ──────────────────────────────────────────────────────

/** A teacher submits a class's drafts. `subject` is optional (submit all). */
export const submitGradesSchema = Joi.object({
  ...classScope,
  className: classScope.className.required(),
  subject: Joi.string().trim().min(2).max(80).optional(),
});

/**
 * Approve is scoped by term and year always, and optionally narrowed to one
 * class, one subject, or an explicit set of grade ids — so a headmaster can
 * approve a whole block or a hand-picked slice of a mixed one.
 */
export const approveGradesSchema = Joi.object({
  className: classScope.className.optional(),
  subject: Joi.string().trim().min(2).max(80).optional(),
  ...classScope,
  ids: Joi.array().items(Joi.string().pattern(OBJECT_ID)).max(500).optional(),
});

/** Reject carries the same scope plus the reason the teacher will read. */
export const rejectGradesSchema = Joi.object({
  className: classScope.className.optional(),
  subject: Joi.string().trim().min(2).max(80).optional(),
  ...classScope,
  reason: Joi.string().trim().min(5).max(500).required(),
});

/** Reopening a rejected block is scoped exactly as submitting it was. */
export const reopenGradesSchema = submitGradesSchema;

// ── Overview query ───────────────────────────────────────────────────────

export const overviewQuerySchema = Joi.object({
  term: Joi.string().valid(...ACADEMIC_TERMS).optional(),
  academicYear: Joi.string()
    .trim()
    .pattern(ACADEMIC_YEAR)
    .optional(),
});

// ── Classes ──────────────────────────────────────────────────────────────

/**
 * A class is a name — there is no Class document to carry `room`, `capacity`
 * or a `subjects` list. Only the name is accepted; the rest are the fields a Class
 * model *would* hold and are deliberately refused to keep the one-list rule
 * (`School.academic.classes`) intact.
 */
export const createClassSchema = Joi.object({
  className: Joi.string().trim().min(2).max(50).required(),
});

/** A class is addressed by its name in the path, URL-encoded. */
export const classNameParamSchema = Joi.object({
  className: Joi.string().min(2).max(50).required(),
});

export const assignClassTeacherSchema = Joi.object({
  teacherId: Joi.string().pattern(OBJECT_ID).required(),
});

export const assignSubjectTeacherSchema = Joi.object({
  subject: Joi.string().trim().min(2).max(80).required(),
  teacherId: Joi.string().pattern(OBJECT_ID).required(),
  canMarkAttendance: Joi.boolean().default(false),
});

export const subjectTeacherParamsSchema = Joi.object({
  className: Joi.string().min(2).max(50).required(),
  subject: Joi.string().trim().min(2).max(80).required(),
});

// ── Report card review ────────────────────────────────────────────────────

export const compileReportsSchema = Joi.object({
  ...classScope,
  className: classScope.className.required(),
});

export const setHeadRemarkSchema = Joi.object({
  ...classScope,
  className: classScope.className.required(),
  text: Joi.string().trim().min(3).max(500).required(),
  author: Joi.string().trim().max(100).allow("").optional(),
});

export const publishReportsSchema = compileReportsSchema;

// ── Timetables ────────────────────────────────────────────────────────────

/**
 * The console's save reuses the timetable body schema verbatim, so a class
 * list guard and a consistent body shape are the only differences from the
 * base route. See `admin.timetable.validation.js` for the `days` shape.
 */
export const saveTimetableSchema = upsertTimetableSchema;

export const timetableQuerySchema = Joi.object({
  term: Joi.string().valid(...ACADEMIC_TERMS).optional(),
  academicYear: Joi.string()
    .trim()
    .pattern(ACADEMIC_YEAR)
    .optional(),
  status: Joi.string().valid("draft", "published").optional(),
});

export const publishTimetableSchema = Joi.object({
  ...classScope,
  className: classScope.className.required(),
});
