import { Router } from "express";
import {
  getStudentByPayTokenController,
  initiatePaymentController,
  createCheckoutController,
  verifyPaymentController,
  verifyPaymentByReferenceController,
  getPaymentHistoryController,
  getPaymentPlanController,
  cancelPaymentPlanController,
  sendSupportMessageController,
  requestPaymentPlanController,
  notifySchoolController,
  listPaymentsController,
  getPaymentSummaryController,
  exportPaymentsController,
  getPaymentDetailController,
  getPaymentReceiptController,
  getAdminReceiptPdfController,
  getParentReceiptPdfController,
  emailReceiptController,
  whatsappReceiptController,
  moolreWebhookController,
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
  payCancelPlanLimit,
} from "../middleware/rateLimit.js";
import {
  payTokenParamSchema,
  payReferenceParamSchema,
  payPaymentsQuerySchema,
  payRequestPlanSchema,
  payPlanCancelSchema,
  paySupportSchema,
  payNotifySchoolSchema,
  payReceiptParamSchema,
  paymentIdParamSchema,
  receiptEmailSchema,
  receiptWhatsappSchema,
  initiatePaymentSchema,
  checkoutSchema,
  verifyPaymentSchema,
  moolreWebhookSchema,
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

// GET /pay/:token/payments - Full settled-payment history, paginated
//
// The path is the one the portal's own service calls and the one its mock
// contract records. It was `/history`, which the portal never asked for: the
// ledger the parent sees is a list of *payments*, and the route that served
// the old pay page is gone.
paymentRoute.get(
  "/pay/:token/payments",
  payLinkViewLimit,
  validate(payTokenParamSchema, "params"),
  validate(payPaymentsQuerySchema, "query"),
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

// POST /pay/:token/checkout - Hosted-checkout fallback
//
// The escape hatch for a parent whose handset never received the USSD prompt.
// The link is created on demand, not during initiation: Moolre requires the
// reference to be unique and the prompt has already claimed it.
paymentRoute.post(
  "/pay/:token/checkout",
  payInitiateLimit,
  validate(payTokenParamSchema, "params"),
  validate(checkoutSchema),
  createCheckoutController
);

// GET /pay/:token/plan - The live payment plan, or null
//
// A student with no plan is a state the page renders, not a 404: the empty
// state offers the request form. Answering 404 would tell a parent that the
// link is broken.
paymentRoute.get(
  "/pay/:token/plan",
  payLinkViewLimit,
  validate(payTokenParamSchema, "params"),
  getPaymentPlanController
);

// POST /pay/:token/plan/request - Parent asks the school to split the balance
paymentRoute.post(
  "/pay/:token/plan/request",
  payRequestPlanLimit,
  validate(payTokenParamSchema, "params"),
  validate(payRequestPlanSchema),
  requestPaymentPlanController
);

// POST /pay/:token/plan/cancel - Parent cancels their own plan
//
// The reason is optional and the plan is gone once this succeeds, so the
// limiter here is a backstop against a retry loop rather than a budget a
// parent spends.
paymentRoute.post(
  "/pay/:token/plan/cancel",
  payCancelPlanLimit,
  validate(payTokenParamSchema, "params"),
  validate(payPlanCancelSchema),
  cancelPaymentPlanController
);

// POST /pay/:token/support - The parent's letter to the school office
//
// **No rate limiter is mounted here**, for the same reason `notify-school` has
// none: the budget is consumed inside `pay.service.js`, only after the
// `ParentMessage` row is written. A message that was never recorded must never
// cost the parent their allowance — and the support form and the pay page's
// own message form share one budget, because they are one inbox.
paymentRoute.post(
  "/pay/:token/support",
  validate(payTokenParamSchema, "params"),
  validate(paySupportSchema),
  sendSupportMessageController
);

// POST /pay/:token/notify-school - Parent sends a message, a voice note, or both
//
// Order is load-bearing:
//   uploadParentAudioRoute        — `.single("audio")`, a no-op for a JSON body
//   exposeParentAudioToBody       — puts a marker in `req.body` so the schema below can
//                                   see that a file arrived (multer leaves it on
//                                   `req.file`); without this an audio-only submission
//                                   is rejected with 422 and the recorder cannot be
//                                   used on its own
//   validate                      — reads the marker, not the file
//
// **The rate limit is not mounted here.** It used to be, ahead of everything else,
// and that is precisely why a parent whose audio uploads kept failing could burn
// their whole daily allowance on messages that never reached the inbox: every
// attempt — successful or not — counted. The limit now lives in
// `pay.service.js:notifySchool`, consumed only after the `ParentMessage` row is
// written, so a message that was never recorded never costs budget. The parent
// sees "you have already sent several messages" only when several messages
// actually exist.
paymentRoute.post(
  "/pay/:token/notify-school",
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

// GET /pay/:token/receipt/:paymentId - Parent: PDF download
paymentRoute.get(
  "/pay/:token/receipt/:paymentId",
  payLinkViewLimit,
  validate(payReceiptParamSchema, "params"),
  getParentReceiptPdfController
);

// ─── Admin: JSON receipt (existing) ───
paymentRoute.get(
  "/payments/:paymentId/receipt",
  authenticate,
  requireSchoolAdmin,
  validate(paymentIdParamSchema, "params"),
  getPaymentReceiptController
);

// ─── Admin: PDF download ───
paymentRoute.get(
  "/payments/:paymentId/receipt.pdf",
  authenticate,
  requireSchoolAdmin,
  validate(paymentIdParamSchema, "params"),
  getAdminReceiptPdfController
);

// ─── Admin: Email the receipt as an attachment ───
//
// Registered after `/receipt.pdf` because the two suffixes are part of the
// path — Express matches the whole pattern, so `/receipt/email` and
// `/receipt.pdf` are distinct routes in any order. The body is optional in
// whole, so an absent body is not an error here (express.json() may still have
// run, and `email: ""` means "not supplied").
paymentRoute.post(
  "/payments/:paymentId/receipt/email",
  authenticate,
  requireSchoolAdmin,
  validate(paymentIdParamSchema, "params"),
  validate(receiptEmailSchema),
  emailReceiptController
);

// ─── Admin: WhatsApp the receipt as a document message ───
paymentRoute.post(
  "/payments/:paymentId/receipt/whatsapp",
  authenticate,
  requireSchoolAdmin,
  validate(paymentIdParamSchema, "params"),
  validate(receiptWhatsappSchema),
  whatsappReceiptController
);

// ──────────────────── Webhook (no auth, but validated) ────────────────────
// POST /pay/webhook/moolre - Moolre callback
//
// Moolre posts here when a transaction reaches a result. The handler
// re-verifies the transaction against Moolre's own status endpoint before any
// money moves, so the callback payload is only ever a notification.
//
// Registered below `/pay/:token/...` on purpose: Express matches `/pay/:token`
// as a single segment, and `/pay/webhook/moolre` is three, so the literal
// route cannot be shadowed by the token routes above.
paymentRoute.post(
  "/pay/webhook/moolre",
  validate(moolreWebhookSchema),
  moolreWebhookController
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

// POST /payments/:paymentId/refund - Refund payment
paymentRoute.post(
  "/payments/:paymentId/refund",
  authenticate,
  requireSchoolAdmin,
  validate(paymentIdParamSchema, "params"),
  validate(refundPaymentSchema),
  refundPaymentController
);
