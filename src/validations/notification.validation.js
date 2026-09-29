import Joi from "joi";

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

export const notificationIdParamSchema = Joi.object({
  id: objectId.required().messages({
    "string.pattern.base": "Invalid notification ID format",
  }),
});

export const notificationQuerySchema = Joi.object({
  read: Joi.boolean().optional(),
  type: Joi.string()
    .valid(
      "payment.received",
      "plan.created",
      "plan.accepted",
      "plan.overdue",
      "student.imported",
      "sms.sent",
      "subscription.expiring",
      "system.alert"
    )
    .optional(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

export const createNotificationSchema = Joi.object({
  userId: objectId.required(),
  schoolId: objectId.optional().allow(null),
  type: Joi.string()
    .valid(
      "payment.received",
      "plan.created",
      "plan.accepted",
      "plan.overdue",
      "student.imported",
      "sms.sent",
      "subscription.expiring",
      "system.alert"
    )
    .required(),
  title: Joi.string().trim().max(120).required(),
  message: Joi.string().trim().max(500).required(),
  link: Joi.string().trim().max(500).optional().allow(null),
  meta: Joi.object().optional().allow(null),
});
