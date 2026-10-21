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
 * A subject row carries **either** the Ghanaian breakdown (`classScore` and
 * `examScore`, which the server adds into the total) **or** the pre-split
 * single figure (`score` out of `maxScore`). `.or(...)` makes one of them
 * mandatory, so a row with neither is a 422 rather than a subject that compiles
 * to an empty row on the report card.
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
          // The pre-split single figure.
          score: Joi.number().min(0).optional(),
          maxScore: Joi.number().min(1).max(200).optional(),
          // The Ghanaian breakdown.
          classScore: Joi.number().min(0).optional(),
          classMaxScore: Joi.number().min(1).max(200).optional(),
          examScore: Joi.number().min(0).optional(),
          examMaxScore: Joi.number().min(1).max(200).optional(),
          remark: Joi.string().trim().max(200).allow("").optional(),
          teacher: Joi.string().trim().max(100).allow("").optional(),
        }).or("score", "classScore", "examScore")
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
