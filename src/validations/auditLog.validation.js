import Joi from "joi";
import { AUDIT_ACTIONS as AUDIT_ACTION_ENUM } from "../models/AuditLog.js";

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

// Re-exported for the routes and for the frontend's filter list, but it is the
// MODEL's enum — not a copy of it.
//
// It was a hand-maintained duplicate of 14 actions while the model accepts 27.
// The model is the thing that actually decides what may be written to an audit
// log, so a filter narrower than it is a filter that 422s on a legitimate
// value: `GET /audit-logs/:schoolId?action=sms.template_create` was rejected as
// an invalid action even though that action is one the system writes, and the
// 13 `whatsapp.*` / `sms.*` / `sms.dlr_update` actions were unreachable through
// the only endpoint that can filter on them. Two lists of the same thing, in two
// files, with no import between them, is a drift that is guaranteed rather than
// merely likely.
export { AUDIT_ACTION_ENUM };

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

/**
 * Every optional query filter also accepts `""`.
 *
 * `.optional()` alone means "absent is fine" — it says nothing about present-but
 * empty, and Joi rejects `""` against `.valid(...)`, `.iso()` and a hex regex.
 * So `GET /audit-logs/:id?action=&from=` — which is exactly what a UI with six
 * filter dropdowns and two date inputs sends on its very first request, before
 * anyone has touched a filter — fails 422 on `"userId" is not allowed to be
 * empty` and the audit trail never loads at all.
 *
 * An empty filter and an absent filter mean the same thing, so they validate the
 * same way. `stripUnknown` then removes them, and the service sees `undefined`.
 */
const optionalId = () => objectId.optional().allow(null, "");
const optionalText = () => Joi.string().trim().max(200).optional().allow(null, "");
const optionalIsoDate = () => Joi.date().iso().optional().allow(null, "");

export const auditLogQuerySchema = Joi.object({
  userId: optionalId(),
  action: Joi.string()
    .valid(...AUDIT_ACTION_ENUM)
    .optional()
    .allow(null, ""),
  entity: optionalText(),
  entityId: optionalId(),
  from: optionalIsoDate(),
  to: optionalIsoDate(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

export const auditLogExportQuerySchema = Joi.object({
  userId: optionalId(),
  action: Joi.string()
    .valid(...AUDIT_ACTION_ENUM)
    .optional()
    .allow(null, ""),
  entity: optionalText(),
  entityId: optionalId(),
  from: optionalIsoDate(),
  to: optionalIsoDate(),
});

export const auditLogUserQuerySchema = Joi.object({
  from: optionalIsoDate(),
  to: optionalIsoDate(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});
