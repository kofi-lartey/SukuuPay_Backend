import Joi from "joi";

// ──────────────────── Enums ────────────────────
const PAYMENT_STATUS_ENUM = ["pending", "processing", "completed", "failed", "cancelled", "refunded"];
const PAYMENT_METHOD_ENUM = ["momo", "card", "bank_transfer", "cash"];
const PAYMENT_PROVIDER_ENUM = ["hubtel", "arke", "mnotify", "manual"];
const MOMO_NETWORK_ENUM = ["MTN", "VODAFONE", "AIRTELTELIGO", "UNKNOWN"];

// ──────────────────── Validators ────────────────────
export const paymentIdParamSchema = Joi.object({
  paymentId: Joi.string().trim().min(5).max(50).required(),
});

export const payTokenParamSchema = Joi.object({
  token: Joi.string().pattern(/^STU-[A-F0-9]{8}$/).required()
    .messages({
      "string.pattern.base": "Invalid payment token format. Expected format: STU-XXXXXXXX",
    }),
});

export const initiatePaymentSchema = Joi.object({
  amount: Joi.number().integer().min(1).required()
    .messages({
      "number.base": "Amount must be a number",
      "number.integer": "Amount must be an integer (pesewas)",
      "number.min": "Amount must be at least 1 pesewa",
      "any.required": "Amount is required",
    }),
  phoneNumber: Joi.string().pattern(/^(0|233)[2-57][0-9]{8}$/).optional()
    .messages({
      "string.pattern.base": "Invalid Ghana phone number format",
    }),
  momoNetwork: Joi.string().valid(...MOMO_NETWORK_ENUM).optional(),
  description: Joi.string().trim().max(500).optional().allow("", null),
  feesBreakdown: Joi.array().items(Joi.object({
    label: Joi.string().trim().max(100).required(),
    amount: Joi.number().integer().min(0).required(),
  })).optional(),
  metadata: Joi.object().optional(),
});

export const verifyPaymentSchema = Joi.object({
  hubtelTransactionId: Joi.string().trim().max(100).optional(),
  hubtelOrderId: Joi.string().trim().max(100).optional(),
});

export const hubtelWebhookSchema = Joi.object({
  Status: Joi.string().valid("Success", "Failed", "Pending").required(),
  Message: Joi.string().optional(),
  ClientReference: Joi.string().optional(),
  TransactionId: Joi.string().optional(),
  OrderId: Joi.string().optional(),
  Amount: Joi.number().optional(),
  Currency: Joi.string().optional(),
  MobileNumber: Joi.string().optional(),
  Network: Joi.string().optional(),
  PaymentToken: Joi.string().optional(),
}).unknown(true);

export const paymentsQuerySchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  studentId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  status: Joi.string().valid(...PAYMENT_STATUS_ENUM, "all").default("all"),
  paymentMethod: Joi.string().valid(...PAYMENT_METHOD_ENUM).optional(),
  provider: Joi.string().valid(...PAYMENT_PROVIDER_ENUM).optional(),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
  minAmount: Joi.number().integer().min(0).optional(),
  maxAmount: Joi.number().integer().min(0).optional(),
  search: Joi.string().trim().max(100).allow("").optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string().valid("createdAt", "amount", "completedAt", "paymentId").default("createdAt"),
  sortOrder: Joi.string().valid("asc", "desc").default("desc"),
});

export const paymentDetailQuerySchema = Joi.object({
  includeWebhookData: Joi.boolean().default(false),
});

export const refundPaymentSchema = Joi.object({
  reason: Joi.string().trim().min(5).max(500).required(),
  amount: Joi.number().integer().min(1).optional(),
});

export const generateReceiptSchema = Joi.object({
  paymentId: Joi.string().trim().min(5).max(50).required(),
});