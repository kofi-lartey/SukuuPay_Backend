import { Router } from "express";
import {
  getStudentByPayTokenController,
  initiatePaymentController,
  verifyPaymentController,
  verifyPaymentByReferenceController,
  getPaymentHistoryController,
  requestPaymentPlanController,
  notifySchoolController,
  getReceiptDownloadController,
  listPaymentsController,
  getPaymentSummaryController,
  exportPaymentsController,
  getPaymentDetailController,
  getPaymentReceiptController,
  hubtelWebhookController,
  refundPaymentController,
} from "../controllers/payment.controller.js";
import { recordManualPaymentController } from "../controllers/manualPayment.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { uploadParentAudioRoute, exposeParentAudioToBody } from "../middleware/upload.js";
import {
  payLinkViewLimit,
  payInitiateLimit,
  payVerifyLimit,
  payRequestPlanLimit,
  payNotifySchoolLimit,
} from "../middleware/rateLimit.js";
import {
  payTokenParamSchema,
  payReferenceParamSchema,
  payHistoryQuerySchema,
  payRequestPlanSchema,
  payNotifySchoolSchema,
  payReceiptParamSchema,
  paymentIdParamSchema,
  initiatePaymentSchema,
  verifyPaymentSchema,
  hubtelWebhookSchema,
  paymentsQuerySchema,
  paymentExportQuerySchema,
  paymentDetailQuerySchema,
  refundPaymentSchema,
} from "../validations/payment.validation.js";
import { recordManualPaymentSchema } from "../validations/manualPayment.validation.js";

export const paymentRoute = Router();

const requireSchoolAdmin = authorize("super_admin", "school_admin");

// ──────────────────── Public endpoints (parent-facing, no auth) ────────────────────
//
// **Every route below is unauthenticated**, so every route below carries a rate
// limiter keyed on the pay token rather than on the caller's address. The reasoning
// is in `middleware/rateLimit.js`: these are reached over mobile networks where
// address-based limiting punishes an entire family behind one NAT, while the token
// is both the fair identity and a tighter abuse bound.
//
// The limiter runs *after* `validate` on the routes below. That ordering is
// deliberate and not interchangeable: `validate` rejects a malformed token with a
// 422 without touching the limiter, so an attacker cannot burn a legitimate family's
// budget by guessing token shapes, and a typo costs nothing. A well-formed token is
// then counted, which is exactly the traffic worth limiting.
//
// GET /pay/:token - View student + balance
paymentRoute.get(
  "/pay/:token",
  payLinkViewLimit,
  validate(payTokenParamSchema, "params"),
  getStudentByPayTokenController
);

// GET /pay/:token/history - Full settled-payment history, paginated
paymentRoute.get(
  "/pay/:token/history",
  payLinkViewLimit,
  validate(payTokenParamSchema, "params"),
  validate(payHistoryQuerySchema, "query"),
  getPaymentHistoryController
);

// GET /pay/:token/verify/:reference - Poll status while the parent approves on
// their handset. Registered before `/pay/:token/receipt/:paymentId` and the other
// sub-routes only because it is a distinct path shape; Express matches the exact
// segment count, so there is no shadowing either way.
paymentRoute.get(
  "/pay/:token/verify/:reference",
  payVerifyLimit,
  validate(payReferenceParamSchema, "params"),
  verifyPaymentByReferenceController
);

// POST /pay/:token/initiate - Initiate MoMo payment
//
// One schema for both callers of this route. The admin flow and the parent portal
// differ only in the field names they use (`phoneNumber`/`momoNetwork` versus
// `phone`/`network`) and `initiatePaymentSchema` accepts either — `validate` aborts
// on the first schema it fails, so listing two schemas on one route would just mean
// whichever came first became the contract.
paymentRoute.post(
  "/pay/:token/initiate",
  payInitiateLimit,
  validate(payTokenParamSchema, "params"),
  validate(initiatePaymentSchema),
  initiatePaymentController
);

// POST /pay/:token/request-plan - Parent asks the school to split the balance
paymentRoute.post(
  "/pay/:token/request-plan",
  payRequestPlanLimit,
  validate(payTokenParamSchema, "params"),
  validate(payRequestPlanSchema),
  requestPaymentPlanController
);

// POST /pay/:token/notify-school - Parent sends a message, a voice note, or both
//
// Order is load-bearing:
//   payNotifySchoolLimit          — a 5 MB upload costs far more to receive than a
//                                   300-byte one, and this route is unauthenticated
//   uploadParentAudioRoute        — `.single("audio")`, a no-op for a JSON body
//   exposeParentAudioToBody       — puts a marker in `req.body` so the schema below can
//                                   see that a file arrived (multer leaves it on
//                                   `req.file`); without this an audio-only submission
//                                   is rejected with 422 and the recorder cannot be
//                                   used on its own
//   validate                      — reads the marker, not the file
paymentRoute.post(
  "/pay/:token/notify-school",
  payNotifySchoolLimit,
  uploadParentAudioRoute,
  exposeParentAudioToBody,
  validate(payTokenParamSchema, "params"),
  validate(payNotifySchoolSchema),
  notifySchoolController
);

// POST /pay/:token/verify - Verify payment status
paymentRoute.post(
  "/pay/:token/verify",
  validate(payTokenParamSchema, "params"),
  validate(verifyPaymentSchema),
  verifyPaymentController
);

// GET /pay/:token/receipt/:paymentId - Receipt, as JSON or as a PDF file
//
// One `params` schema, not two. `validate` writes back the validated value and
// strips unknown keys, so a chain of `payTokenParamSchema` then
// `paymentIdParamSchema` on the same segment deleted `paymentId` before the second
// ran and 422'd every request — this endpoint had never served a receipt. See
// `payReceiptParamSchema`.
paymentRoute.get(
  "/pay/:token/receipt/:paymentId",
  payLinkViewLimit,
  validate(payReceiptParamSchema, "params"),
  getReceiptDownloadController
);

// ──────────────────── Webhook (no auth, but validated) ────────────────────
// POST /pay/webhook/hubtel - Hubtel webhook
paymentRoute.post(
  "/pay/webhook/hubtel",
  validate(hubtelWebhookSchema),
  hubtelWebhookController
);

// ──────────────────── Admin endpoints (auth required) ────────────────────

// POST /payments/record - Cash, cheque or bank transfer taken at the desk
//
// Registered before `/payments/:paymentId` so the literal segment is not
// captured as an id. It had no endpoint at all, which is why the dashboard's
// "Record Manual Payment" button had nothing to call.
paymentRoute.post(
  "/payments/record",
  authenticate,
  requireSchoolAdmin,
  validate(recordManualPaymentSchema),
  recordManualPaymentController
);

// GET /payments - List payments with filters
paymentRoute.get(
  "/payments",
  authenticate,
  requireSchoolAdmin,
  validate(paymentsQuerySchema, "query"),
  listPaymentsController
);

// GET /payments/summary - Collection KPIs for the dashboard
//
// Declared before `/payments/:paymentId` for the same reason `/payments/record`
// is, and with the same consequence: `paymentIdParamSchema` demands at least 5
// characters, so a `summary` request that reached the detail route would have
// 422'd with a message about a payment id. Express matches in registration
// order, so moving either literal route below the parameterised one silently
// breaks it and the dashboard's KPI band reports a validation error.
//
// It validates against `paymentsQuerySchema` rather than a narrower schema, so
// `page`/`limit`/`sortBy`/`sortOrder` arrive with their defaults and are simply
// unused: the summary aggregates the whole filtered set, and a client that
// deep-links its current page must not have to strip it first.
paymentRoute.get(
  "/payments/summary",
  authenticate,
  requireSchoolAdmin,
  validate(paymentsQuerySchema, "query"),
  getPaymentSummaryController
);

// GET /payments/export - The filtered payment list as a CSV file
//
// Same ordering constraint as `/payments/summary` above: declared ahead of
// `/payments/:paymentId` so "export" is a route and not a payment id.
paymentRoute.get(
  "/payments/export",
  authenticate,
  requireSchoolAdmin,
  validate(paymentExportQuerySchema, "query"),
  exportPaymentsController
);

// GET /payments/:paymentId - Payment detail
paymentRoute.get(
  "/payments/:paymentId",
  authenticate,
  requireSchoolAdmin,
  validate(paymentIdParamSchema, "params"),
  validate(paymentDetailQuerySchema, "query"),
  getPaymentDetailController
);

// GET /payments/:paymentId/receipt - Download receipt
paymentRoute.get(
  "/payments/:paymentId/receipt",
  authenticate,
  requireSchoolAdmin,
  validate(paymentIdParamSchema, "params"),
  getPaymentReceiptController
);

// POST /payments/:paymentId/refund - Refund payment
paymentRoute.post(
  "/payments/:paymentId/refund",
  authenticate,
  requireSchoolAdmin,
  validate(paymentIdParamSchema, "params"),
  validate(refundPaymentSchema),
  refundPaymentController
);