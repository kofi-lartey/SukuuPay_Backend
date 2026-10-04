import Joi from "joi";
import { PARENT_MESSAGE_STATUS_VALUES } from "../models/ParentMessage.js";

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

/**
 * `GET /parent-messages`.
 *
 * `status` accepts the schema's own enum rather than a copy of it. The copy is how
 * `notification.validation.js` came to reject `?type=parent.message` — the list there
 * was written before the pay portal had one — so this imports the values instead.
 */
export const listParentMessagesSchema = Joi.object({
  status: Joi.string()
    .valid(...PARENT_MESSAGE_STATUS_VALUES, "all")
    .default("all"),
  q: Joi.string().trim().max(80).allow(""),
  hasAudio: Joi.boolean().optional(),
  studentId: objectId.optional(),
  schoolId: objectId.optional(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

export const parentMessageIdParamSchema = Joi.object({
  id: objectId.required().messages({
    "string.pattern.base": "Invalid message ID format",
  }),
});

export const studentMessageParamSchema = Joi.object({
  studentId: objectId.required().messages({
    "string.pattern.base": "Invalid student ID format",
  }),
});

/**
 * `PUT /parent-messages/:id/resolve`.
 *
 * `resolutionNote` is required and floored. Resolving a parent message is the only
 * thing this product does about it, and a resolution with nothing written down is
 * indistinguishable from an unanswered one the next time the parent asks.
 */
export const resolveParentMessageSchema = Joi.object({
  resolutionNote: Joi.string()
    .trim()
    .min(3)
    .max(500)
    .required()
    .messages({
      // `any.required` is the one that actually fires for an omitted field, and it is
      // listed first here because leaving it at Joi's default produced
      // `"resolutionNote" is required` — a field name in a sentence addressed to a
      // bursar. Both the omitted and the present-but-blank case have to read as the
      // same instruction, because they are the same mistake.
      "any.required": "Say what was done about it, so there is a record",
      "string.empty": "Say what was done about it, so there is a record",
      "string.min": "Say what was done about it, so there is a record",
      "string.max": "Please keep the note under 500 characters",
    }),
});