import Joi from "joi";

/**
 * The teacher portal's request contracts.
 *
 * Every route on `/teacher/*` validates here. `validate` (middleware/validate.js)
 * runs the schema with `stripUnknown: true` and writes the result back, so a
 * handler never reads an unsanitised value — including `className`, which
 * arrives as a path segment and is used verbatim in a Mongo filter.
 *
 * `academicYear` is **optional**, unlike a naive reading of the screens would
 * suggest: `EnterGrades` and `ClassDetail` send the class name, the term and
 * the subject and nothing else, because the year is the school's business
 * rather than the teacher's. The service resolves it through
 * `resolveSchoolAcademicYear` (`utils/termDates.js`). Requiring it here would
 * answer 422 on every grade save the portal actually makes.
 */
const TERMS = ["Term 1", "Term 2", "Term 3"];
const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);
const academicYear = Joi.string().trim().pattern(/^\d{4}\/\d{4}$/);

export const classQuerySchema = Joi.object({
  className: Joi.string().trim().min(2).max(50).required(),
});

export const classSummaryParamsSchema = Joi.object({
  className: Joi.string().trim().min(2).max(50).required(),
});

export const classSummaryQuerySchema = Joi.object({
  term: Joi.string().valid(...TERMS).optional(),
});

/**
 * `className` and `date`, both required.
 *
 * `date` is an ISO date; the service normalises it to 00:00 UTC, so a request
 * carrying `07:00` on the 6th and one carrying `10:30` on the 6th read the same
 * register. Ghana is permanently UTC+0, so the UTC day is the Accra day.
 */
export const attendanceQuerySchema = Joi.object({
  className: Joi.string().trim().min(2).max(50).required(),
  date: Joi.date().iso().required(),
});

export const studentIdParamSchema = Joi.object({
  studentId: objectId.required().messages({
    "string.pattern.base": "Invalid student ID format",
  }),
});

export const studentAttendanceQuerySchema = Joi.object({
  term: Joi.string().valid(...TERMS).optional(),
});

export const classGradesQuerySchema = Joi.object({
  className: Joi.string().trim().min(2).max(50).required(),
  term: Joi.string().valid(...TERMS).optional(),
  subject: Joi.string().trim().max(80).allow("").optional(),
  academicYear: academicYear.optional(),
});

export const studentGradesQuerySchema = Joi.object({
  term: Joi.string().valid(...TERMS).optional(),
  academicYear: academicYear.optional(),
});

/**
 * One student's score.
 *
 * `score` is bounded only by 0 here — the upper bound is `maxScore`, which is
 * itself part of the payload, so Joi cannot compare the two. The service closes
 * that gap (`readScore`) and the endpoint re-checks it before writing, because
 * a mark above the maximum is not a validation detail but a 100+% grade.
 */
export const saveSingleGradeSchema = Joi.object({
  studentId: objectId.required(),
  className: Joi.string().trim().min(2).max(50).required(),
  subject: Joi.string().trim().min(2).max(80).required(),
  term: Joi.string().valid(...TERMS).required(),
  academicYear: academicYear.optional(),
  assessmentType: Joi.string()
    .valid("class_test", "quiz", "assignment", "exam")
    .default("class_test"),
  score: Joi.number().min(0).required(),
  maxScore: Joi.number().min(1).max(200).default(100),
});

/**
 * The whole class in one call.
 *
 * `min(1)` so an empty batch is a 422 rather than a silent no-op that reports
 * "saved 0 of 0" and looks like a success. `max(200)` keeps one request inside
 * the size a phone can reliably post on a Ghanaian mobile connection — the same
 * ceiling `bulkMarkAttendanceSchema` uses for a register.
 */
export const saveBulkGradesSchema = Joi.object({
  className: Joi.string().trim().min(2).max(50).required(),
  subject: Joi.string().trim().min(2).max(80).required(),
  term: Joi.string().valid(...TERMS).required(),
  academicYear: academicYear.optional(),
  assessmentType: Joi.string()
    .valid("class_test", "quiz", "assignment", "exam")
    .default("class_test"),
  maxScore: Joi.number().min(1).max(200).default(100),
  grades: Joi.array()
    .items(
      Joi.object({
        studentId: objectId.required(),
        score: Joi.number().min(0).required(),
      })
    )
    .min(1)
    .max(200)
    .required(),
});
