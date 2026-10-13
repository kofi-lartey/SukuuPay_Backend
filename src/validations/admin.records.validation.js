import Joi from "joi";
import { ACADEMIC_TERMS } from "../config/constants.js";

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** `2026/2027` — the academic year's one written form, matching `Student.academicYear`. */
const ACADEMIC_YEAR = /^\d{4}\/\d{4}$/;

/**
 * Compiling a class's report cards.
 *
 * `scores` is keyed by student id, so the schema keys it on the ObjectId pattern
 * rather than accepting arbitrary strings — a typo'd key would otherwise compile
 * an empty card for a student and the class teacher would have no way to see it.
 *
 * `maxScore` defaults to 100 rather than being required: most Ghanaian subjects
 * are marked out of 100 and a schema that demanded it on every subject would
 * make a 40-subject form repeat itself.
 */
export const compileReportCardsSchema = Joi.object({
  className: Joi.string().trim().min(2).max(50).required(),
  term: Joi.string()
    .valid(...ACADEMIC_TERMS)
    .required(),
  academicYear: Joi.string()
    .trim()
    .pattern(ACADEMIC_YEAR)
    .required(),
  scores: Joi.object()
    .pattern(
      OBJECT_ID,
      Joi.array().items(
        Joi.object({
          subject: Joi.string().trim().min(2).max(80).required(),
          score: Joi.number().min(0).required(),
          maxScore: Joi.number().min(1).default(100),
          remark: Joi.string().trim().max(200).allow("").optional(),
          teacher: Joi.string().trim().max(100).allow("").optional(),
        })
      )
    )
    .required(),
  teacherRemark: Joi.object({
    text: Joi.string().trim().max(500).allow("").optional(),
    author: Joi.string().trim().max(100).allow("").optional(),
  }).optional(),
  headRemark: Joi.object({
    text: Joi.string().trim().max(500).allow("").optional(),
    author: Joi.string().trim().max(100).allow("").optional(),
  }).optional(),
  conductByStudent: Joi.object()
    .pattern(OBJECT_ID, Joi.string().trim().max(50))
    .optional(),
});

export const publishReportCardsSchema = Joi.object({
  className: Joi.string().trim().min(2).max(50).required(),
  term: Joi.string()
    .valid(...ACADEMIC_TERMS)
    .required(),
  academicYear: Joi.string()
    .trim()
    .pattern(ACADEMIC_YEAR)
    .required(),
});
