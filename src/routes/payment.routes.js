import { Router } from "express";
import {
  getStudentByPayTokenController,
  initiatePaymentController,
  verifyPaymentController,
  getReceiptController,
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
import {
  payTokenParamSchema,
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
// GET /pay/:token - View student + balance
paymentRoute.get(
  "/pay/:token",
  validate(payTokenParamSchema, "params"),
  getStudentByPayTokenController
);

// POST /pay/:token/initiate - Initiate MoMo payment
paymentRoute.post(
  "/pay/:token/initiate",
  validate(payTokenParamSchema, "params"),
  validate(initiatePaymentSchema),
  initiatePaymentController
);

// POST /pay/:token/verify - Verify payment status
paymentRoute.post(
  "/pay/:token/verify",
  validate(payTokenParamSchema, "params"),
  validate(verifyPaymentSchema),
  verifyPaymentController
);

// GET /pay/:token/receipt/:paymentId - Download PDF receipt
paymentRoute.get(
  "/pay/:token/receipt/:paymentId",
  validate(payTokenParamSchema, "params"),
  validate(paymentIdParamSchema, "params"),
  getReceiptController
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