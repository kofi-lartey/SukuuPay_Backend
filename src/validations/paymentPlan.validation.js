import Joi from "joi";

const INTERVAL_ENUM = ["weekly", "biweekly", "monthly", "custom"];

const PLAN_STATUS_ENUM = [
  "pending_acceptance",
  "active",
  "completed",
  "defaulted",
  "cancelled",
  "expired",
];

// Compliance buckets returned by the overview endpoint.
const COMPLIANCE_STATUS_ENUM = [
  "pending_acceptance",
  "on_track",
  "approaching_due",
  "overdue",
  "completed",
  "defaulted",
];

const INSTALLMENT_ACTION_ENUM = [
  "mark_paid",
  "mark_unpaid",
  "adjust_amount",
  "waive",
];

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

// Acceptance codes are 6 uppercase alphanumerics (no ambiguous glyphs).
const acceptanceToken = Joi.string()
  .trim()
  .length(6)
  .uppercase()
  .pattern(/^[A-HJ-NP-Z2-9]{6}$/)
  .required()
  .messages({
    "string.pattern.base": "Acceptance token must be 6 uppercase letters or digits",
  });

// A due date may not sit in the past — a plan always starts in the future.
const notInPastDate = Joi.date()
  .custom((value, helpers) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (new Date(value) < today) {
      return helpers.error("any.custom");
    }
    return value;
  })
  .messages({ "any.custom": "Date cannot be in the past" });

const customInstallmentSchema = Joi.object({
  amount: Joi.number().integer().min(1).required(),
  dueDate: notInPastDate.optional(),
  notes: Joi.string().trim().max(500).optional().allow("", null),
});

export const createPlanSchema = Joi.object({
  numberOfInstallments: Joi.number().integer().min(2).max(6).required(),
  interval: Joi.string()
    .valid(...INTERVAL_ENUM)
    .default("monthly"),
  startDate: notInPastDate.required(),
  planName: Joi.string().trim().max(100).optional().allow("", null),
  adminNotes: Joi.string().trim().max(1000).optional().allow("", null),
  // Explicit per-installment amounts/dates; overrides the even split.
  customInstallments: Joi.array().items(customInstallmentSchema).min(2).max(6).optional(),
  // schoolId is derived server-side; only honoured for super_admin.
  schoolId: objectId.optional(),
}).custom((value, helpers) => {
  // The installments array must line up with numberOfInstallments.
  if (
    value.customInstallments &&
    value.customInstallments.length !== value.numberOfInstallments
  ) {
    return helpers.message({
      custom:
        "customInstallments must contain exactly numberOfInstallments entries",
    });
  }
  return value;
});

export const updatePlanSchema = Joi.object({
  planName: Joi.string().trim().min(1).max(100).optional(),
  adminNotes: Joi.string().trim().max(1000).optional().allow("", null),
  startDate: notInPastDate.optional(),
  interval: Joi.string().valid(...INTERVAL_ENUM).optional(),
  installments: Joi.array()
    .items(
      Joi.object({
        installmentNumber: Joi.number().integer().min(1).max(6).required(),
        amount: Joi.number().integer().min(1).required(),
        notes: Joi.string().trim().max(500).optional().allow("", null),
      })
    )
    .min(2)
    .max(6)
    .optional(),
}).min(1);

export const cancelPlanSchema = Joi.object({
  reason: Joi.string().trim().max(300).optional().allow("", null),
});

export const acceptPlanSchema = Joi.object({
  token: acceptanceToken.optional(),
  via: Joi.string().valid("sms", "whatsapp").default("sms"),
});

export const acceptPlanQuerySchema = Joi.object({
  token: acceptanceToken.optional(),
  via: Joi.string().valid("sms", "whatsapp").default("sms"),
});

export const installmentActionSchema = Joi.object({
  action: Joi.string().valid(...INSTALLMENT_ACTION_ENUM).required(),
  // Required by adjust_amount; optional elsewhere (defaults to the
  // installment's own amount).
  amount: Joi.number().integer().min(1).optional(),
  notes: Joi.string().trim().max(500).optional().allow("", null),
}).custom((value, helpers) => {
  if (value.action === "adjust_amount" && !value.amount) {
    return helpers.message({ custom: "amount is required for the adjust_amount action" });
  }
  return value;
});

export const prepaySchema = Joi.object({
  amount: Joi.number().integer().min(100).required(),
  installmentNumber: Joi.number().integer().min(1).max(6).optional(),
  phoneNumber: Joi.string().trim().max(20).optional().allow("", null),
  momoNetwork: Joi.string()
    .valid("MTN", "VODAFONE", "AIRTELTELIGO", "UNKNOWN")
    .default("UNKNOWN"),
  // Public route: the student's pay-link token proving ownership of the plan.
  planToken: Joi.string().trim().max(120).optional().allow("", null),
});

export const prepayQuerySchema = Joi.object({
  planToken: Joi.string().trim().max(120).optional().allow("", null),
});

export const planIdParamSchema = Joi.object({
  planId: objectId.required().messages({ "string.pattern.base": "Invalid plan ID format" }),
});

export const studentIdParamSchema = Joi.object({
  studentId: objectId
    .required()
    .messages({ "string.pattern.base": "Invalid student ID format" }),
});

export const schoolIdParamSchema = Joi.object({
  schoolId: objectId
    .required()
    .messages({ "string.pattern.base": "Invalid school ID format" }),
});

export const installmentParamSchema = Joi.object({
  planId: objectId.required().messages({ "string.pattern.base": "Invalid plan ID format" }),
  num: Joi.number().integer().min(1).max(6).required(),
});

export const complianceQuerySchema = Joi.object({
  class: Joi.string().trim().max(50).optional().allow("", null),
  status: Joi.string()
    .valid(...COMPLIANCE_STATUS_ENUM, "all")
    .optional(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string()
    .valid("createdAt", "endDate", "progressPercent", "totalAmount")
    .default("endDate"),
  sortOrder: Joi.string().valid("asc", "desc").default("asc"),
});

export { INTERVAL_ENUM, PLAN_STATUS_ENUM, COMPLIANCE_STATUS_ENUM, INSTALLMENT_ACTION_ENUM };
