import Joi from "joi";
import { ACADEMIC_TERMS } from "../config/constants.js";
import { PAY_TOKEN_PATTERN } from "./payment.validation.js";

/**
 * The parent portal's academic reads.
 *
 * The term list is `ACADEMIC_TERMS` from `config/constants.js` and the token
 * pattern is `PAY_TOKEN_PATTERN` from `payment.validation.js` — both imported
 * rather than restated. A second copy of the token pattern would be a schema the
 * real tokens fail: the generator emits `STU-` + 8 uppercase hex characters, and
 * a looser local copy would 422 on tokens the payment surface accepts.
 */

export const attendanceQuerySchema = Joi.object({
  term: Joi.string()
    .valid(...ACADEMIC_TERMS)
    .optional(),
});

export const recordsQuerySchema = Joi.object({
  term: Joi.string()
    .valid(...ACADEMIC_TERMS)
    .optional(),
});

export const timetableQuerySchema = Joi.object({
  weekOf: Joi.date().iso().optional(),
});

export const parentTokenParamSchema = Joi.object({
  token: Joi.string()
    .trim()
    .pattern(PAY_TOKEN_PATTERN)
    .required()
    .messages({
      "string.pattern.base": "Invalid payment link token",
    }),
});

/**
 * The parent message send body. Mirrors `payNotifySchoolSchema`: `subject` and
 * `message` are text fields, `threadId` is the student's `studentId` (already
 * implied by the token, so accepted but not required), and `audio` is a truthy
 * marker placed by `exposeParentAudioToBody` when a recording was attached —
 * declared as `any` because only its presence matters, and declared at all so
 * `stripUnknown` does not discard it. A message needs text *or* audio.
 */
export const parentMessageSchema = Joi.object({
  subject: Joi.string().max(120).optional().allow(""),
  body: Joi.string().max(1000).optional().allow(""),
  threadId: Joi.string().trim().optional(),
  // A marker placed by `exposeParentAudioToBody` when a recording was attached.
  audio: Joi.any().optional(),
}).or("body", "audio");

/**
 * Shared by the conversations list and the notifications list — both take the
 * same `?filter=&page=&perPage=` shape.
 */
export const parentNotificationQuerySchema = Joi.object({
  filter: Joi.string().trim().optional().allow("all", ""),
  page: Joi.number().integer().min(1).optional(),
  perPage: Joi.number().integer().min(1).max(100).optional(),
});
