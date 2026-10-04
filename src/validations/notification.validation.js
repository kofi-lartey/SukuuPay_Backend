import Joi from "joi";
import {
  NOTIFICATION_TYPE_VALUES,
} from "../config/constants.js";

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

/**
 * `?type=` is validated against the shared enum rather than a list written out here.
 *
 * This schema used to carry its own copy of the eight notification types, written
 * before the pay portal added `school.join_request`, `plan.requested` and
 * `parent.message`. Nothing complained: `Notification.type` is checked against the
 * *model's* enum, which was the longer list, so every parent message was stored
 * successfully and the school could not filter for it. `GET /notifications?type=parent.message`
 * answered 422 — "must be one of …" — for a type that was sitting in the collection.
 *
 * Importing the values means a type added to `constants.js` is filterable the moment
 * it is added, and the one that has to stay in step is the model's enum, which the
 * model file's own comment already calls out.
 */
const notificationType = Joi.string().valid(...NOTIFICATION_TYPE_VALUES);

export const notificationIdParamSchema = Joi.object({
  id: objectId.required().messages({
    "string.pattern.base": "Invalid notification ID format",
  }),
});

export const notificationQuerySchema = Joi.object({
  read: Joi.boolean().optional(),
  type: notificationType.optional(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

export const createNotificationSchema = Joi.object({
  userId: objectId.required(),
  schoolId: objectId.optional().allow(null),
  type: notificationType.required(),
  title: Joi.string().trim().max(120).required(),
  message: Joi.string().trim().max(500).required(),
  link: Joi.string().trim().max(500).optional().allow(null),
  meta: Joi.object().optional().allow(null),
});
