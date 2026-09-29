import Joi from "joi";

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

// ── Audit action enum ──
export const AUDIT_ACTION_ENUM = [
  "student.create",
  "student.update",
  "student.delete",
  "payment.success",
  "payment.failed",
  "plan.create",
  "plan.accept",
  "plan.cancel",
  "sms.send",
  "school.update",
  "user.login",
  "user.invite",
  "settings.update",
  "markup.update",
  "gateway_mode.update",
];

export const schoolIdParamSchema = Joi.object({
  schoolId: objectId.required().messages({
    "string.pattern.base": "Invalid school ID format",
  }),
});

export const userIdParamSchema = Joi.object({
  userId: objectId.required().messages({
    "string.pattern.base": "Invalid user ID format",
  }),
});

export const auditLogQuerySchema = Joi.object({
  userId: objectId.optional().allow(null),
  action: Joi.string()
    .valid(...AUDIT_ACTION_ENUM)
    .optional(),
  entity: Joi.string().trim().max(50).optional(),
  entityId: objectId.optional().allow(null),
  from: Joi.date().iso().optional().allow(null),
  to: Joi.date().iso().optional().allow(null),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

export const auditLogExportQuerySchema = Joi.object({
  userId: objectId.optional().allow(null),
  action: Joi.string().valid(...AUDIT_ACTION_ENUM).optional(),
  entity: Joi.string().trim().max(50).optional(),
  entityId: objectId.optional().allow(null),
  from: Joi.date().iso().optional().allow(null),
  to: Joi.date().iso().optional().allow(null),
});

export const auditLogUserQuerySchema = Joi.object({
  from: Joi.date().iso().optional().allow(null),
  to: Joi.date().iso().optional().allow(null),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});
