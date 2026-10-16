import Joi from "joi";
import { ACADEMIC_TERMS } from "../config/constants.js";

const ACADEMIC_YEAR = /^\d{4}\/\d{4}$/;

/**
 * One lesson slot.
 *
 * `startTime` and `endTime` are wall-clock strings, so they are validated as
 * strings rather than as dates — `Joi.date()` would coerce `"8:00 am"` into a
 * 2001-01-01 instant and then the stored value would no longer read as a lesson
 * time on the parent's timetable.
 *
 * `period` is the ordering key the portal renders by. It is capped at 20 because
 * a Ghanaian school day is 8–10 periods and a payload asking for 40 is a client
 * bug rather than a school with a long morning.
 */
const periodSchema = Joi.object({
  period: Joi.number().integer().min(1).max(20).required(),
  startTime: Joi.string().trim().max(30).required(),
  endTime: Joi.string().trim().max(30).required(),
  subject: Joi.string().trim().min(2).max(80).required(),
  teacher: Joi.string().trim().max(100).allow("").optional(),
  room: Joi.string().trim().max(50).allow("").optional(),
});

/**
 * A class timetable.
 *
 * Every weekday defaults to `[]`, so a `PUT` that names only Monday is a valid
 * timetable with lessons on Monday alone — not a 422. A form that submits an
 * empty day must produce an empty day, which is exactly what a default array of
 * empty reads as once the service normalises it.
 */
export const upsertTimetableSchema = Joi.object({
  className: Joi.string().trim().min(2).max(50).required(),
  term: Joi.string()
    .valid(...ACADEMIC_TERMS)
    .required(),
  academicYear: Joi.string()
    .trim()
    .pattern(ACADEMIC_YEAR)
    .required(),
  status: Joi.string().valid("draft", "published").default("draft"),
  days: Joi.object({
    Monday: Joi.array().items(periodSchema).default([]),
    Tuesday: Joi.array().items(periodSchema).default([]),
    Wednesday: Joi.array().items(periodSchema).default([]),
    Thursday: Joi.array().items(periodSchema).default([]),
    Friday: Joi.array().items(periodSchema).default([]),
  }).required(),
});

/** The term and year a timetable belongs to — both narrow a single document. */
export const timetableTermSchema = Joi.object({
  term: Joi.string().valid(...ACADEMIC_TERMS).required(),
  academicYear: Joi.string().trim().pattern(ACADEMIC_YEAR).required(),
});

/** Approve carries an optional comment; reject requires a reason. */
export const timetableApproveSchema = timetableTermSchema.keys({
  comment: Joi.string().trim().max(300).allow("").optional(),
});

export const timetableRejectSchema = timetableTermSchema.keys({
  reason: Joi.string().trim().min(3).max(300).required(),
});
