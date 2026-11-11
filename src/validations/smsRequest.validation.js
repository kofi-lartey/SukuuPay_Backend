import Joi from "joi";
import { SMS_REQUEST_STATUS_VALUES } from "../config/constants.js";

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

/**
 * The same MSISDN rule the parent portal uses, re-declared rather than imported.
 *
 * `payment.validation.js` already owns it, but importing a validator *file* from a
 * validator file pulls its whole import graph — the plans helpers, the network alias
 * map — into this module for one function. Two copies of a seven-line regex is cheaper
 * than a coupling, and the consequence of them drifting is a school being told its
 * number is invalid on one form and valid on another.
 */
const ghanaMsisdn = Joi.string()
  .pattern(/^(\+233|0)[0-9]{9}$/)
  .messages({
    "string.pattern.base":
      "Enter a valid Ghanaian mobile number, e.g. 0241234567 or +233241234567",
  });

/**
 * `POST /api/sms-requests/quote`
 *
 * No side effect, so it takes a bare count and nothing else — no phone, because a
 * price does not need one. The upper bound is the model's, duplicated here deliberately:
 * validation is what stops a 2-million-unit order reaching the service, and the model
 * is the backstop behind that, not the gate itself.
 */
export const quoteSmsRequestSchema = Joi.object({
  units: Joi.number().integer().min(1).max(200000).required(),
});

/**
 * `POST /api/sms-requests`
 *
 * Supports both current MoMo prompt flow (`paymentMethod: "mtn"`, requires phoneNumber)
 * and manual payment verification flow (`paymentMethod: "manual"`).
 */
export const createSmsRequestSchema = Joi.object({
  units: Joi.number().integer().min(1).max(200000).required(),
  paymentMethod: Joi.string().valid("mtn", "manual").default("mtn"),
  phoneNumber: Joi.when("paymentMethod", {
    is: "manual",
    then: ghanaMsisdn.allow("", null).optional(),
    otherwise: ghanaMsisdn.required(),
  }),
  paymentReference: Joi.when("paymentMethod", {
    is: "manual",
    then: Joi.string().trim().uppercase().pattern(/^[A-Z0-9]{4}$/).optional(),
    otherwise: Joi.forbidden(),
  }),
});

export const listSmsRequestsSchema = Joi.object({
  status: Joi.string()
    .valid(...SMS_REQUEST_STATUS_VALUES, "all")
    .default("all"),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

/**
 * `:requestId` is our public id (`SMS-REQ-…`), not an ObjectId.
 *
 * The console and the school both work from `requestId` — it is what a support
 * conversation quotes, and putting an ObjectId in a support ticket is a waste of a
 * channel. Validated as a shape rather than looked up, so a typo is a 422 naming the
 * format instead of a 404 after a database round trip.
 */
export const smsRequestIdParamSchema = Joi.object({
  requestId: Joi.string()
    .pattern(/^SMS-REQ-\d{8}-[A-Z0-9]{6}$/)
    .required()
    .messages({
      "string.pattern.base": "That does not look like an SMS request reference",
    }),
});

/**
 * `POST /admin/sms/pool/top-up`
 *
 * `amountPes` is optional and nullable on purpose. A top-up records what the platform
 * paid Arkesel — but credit also arrives from a migration or a goodwill gesture, and
 * forcing a figure for those would put a cost on a decision that had none. Null is the
 * honest value, and `PlatformSmsPoolEntry.amountPes` is nullable for the same reason.
 */
export const poolTopUpSchema = Joi.object({
  units: Joi.number().integer().min(1).max(10000000).required(),
  amountPes: Joi.number().integer().min(0).allow(null).optional(),
  provider: Joi.string().valid("arke", "moolre").default("arke"),
  reference: Joi.string().trim().max(200).allow("").optional(),
  note: Joi.string().trim().max(300).allow("").optional(),
});

/** `POST /api/sms-requests/:requestId/submit-payment` — manual payment proof. */
export const submitSmsPaymentProofSchema = Joi.object({
  submittedReference: Joi.string().trim().min(3).max(200).required().messages({
    "any.required": "Enter the payment reference/transaction ID from your payment.",
    "string.empty": "Enter the payment reference/transaction ID from your payment.",
    "string.min": "Enter the payment reference/transaction ID from your payment.",
  }),
  payerName: Joi.string().trim().max(120).allow("", null).optional(),
  proofNote: Joi.string().trim().max(500).allow("", null).optional(),
});

/**
 * `POST /admin/sms/requests/:requestId/reject`
 *
 * `reason` is required and floored. The school is told this text verbatim, so a
 * rejection with an empty reason renders as "declined:" followed by nothing — the
 * operator has taken the school's money and told them nothing about why.
 */
export const rejectSmsRequestSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(300).required().messages({
    "any.required": "Give a reason — the school is told what it is",
    "string.empty": "Give a reason — the school is told what it is",
    "string.min": "Give a reason — the school is told what it is",
  }),
});

/** `POST /admin/sms/requests/:requestId/refund` — recording that a refund went. */
export const markRefundedSchema = Joi.object({
  refundReference: Joi.string().trim().max(200).allow("").optional(),
});

export { objectId };