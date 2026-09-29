import { Router } from "express";
import {
  getStudentByPayTokenController,
  initiatePaymentController,
  verifyPaymentController,
  getReceiptController,
  listPaymentsController,
  getPaymentDetailController,
  getPaymentReceiptController,
  hubtelWebhookController,
  refundPaymentController,
} from "../controllers/payment.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  payTokenParamSchema,
  paymentIdParamSchema,
  initiatePaymentSchema,
  verifyPaymentSchema,
  hubtelWebhookSchema,
  paymentsQuerySchema,
  paymentDetailQuerySchema,
  refundPaymentSchema,
} from "../validations/payment.validation.js";

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
// GET /payments - List payments with filters
paymentRoute.get(
  "/payments",
  authenticate,
  requireSchoolAdmin,
  validate(paymentsQuerySchema, "query"),
  listPaymentsController
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