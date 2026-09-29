import { Router } from "express";
import {
  createPaymentPlanController,
  getPaymentPlanController,
  updatePaymentPlanController,
  cancelPaymentPlanController,
  acceptPaymentPlanController,
  updateInstallmentController,
  prepayPlanController,
  getSchoolComplianceController,
} from "../controllers/paymentPlan.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  createPlanSchema,
  updatePlanSchema,
  cancelPlanSchema,
  acceptPlanSchema,
  acceptPlanQuerySchema,
  installmentActionSchema,
  prepaySchema,
  prepayQuerySchema,
  planIdParamSchema,
  studentIdParamSchema,
  schoolIdParamSchema,
  installmentParamSchema,
  complianceQuerySchema,
} from "../validations/paymentPlan.validation.js";

export const paymentPlanRoute = Router();

const requireSchoolAdmin = authorize("super_admin", "school_admin");

// ──────────────────── Public endpoints (parent-facing, no auth) ────────────────────

// POST /payment-plans/:planId/accept - Parent activates a plan with the SMS token
paymentPlanRoute.post(
  "/payment-plans/:planId/accept",
  validate(planIdParamSchema, "params"),
  validate(acceptPlanQuerySchema, "query"),
  validate(acceptPlanSchema),
  acceptPaymentPlanController
);

// POST /payment-plans/:planId/prepay - Parent pays an installment up front
paymentPlanRoute.post(
  "/payment-plans/:planId/prepay",
  validate(planIdParamSchema, "params"),
  validate(prepayQuerySchema, "query"),
  validate(prepaySchema),
  prepayPlanController
);

// ──────────────────── Admin endpoints (auth required) ────────────────────

// GET /payment-plans/school/:schoolId/compliance
// Registered before the /:studentId route so the literal path always wins.
paymentPlanRoute.get(
  "/payment-plans/school/:schoolId/compliance",
  authenticate,
  requireSchoolAdmin,
  validate(schoolIdParamSchema, "params"),
  validate(complianceQuerySchema, "query"),
  getSchoolComplianceController
);

// POST /payment-plans/create/:studentId
paymentPlanRoute.post(
  "/payment-plans/create/:studentId",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(createPlanSchema),
  createPaymentPlanController
);

// GET /payment-plans/:studentId - Active plan, else the most recent one
paymentPlanRoute.get(
  "/payment-plans/:studentId",
  authenticate,
  validate(studentIdParamSchema, "params"),
  getPaymentPlanController
);

// PUT /payment-plans/:planId
paymentPlanRoute.put(
  "/payment-plans/:planId",
  authenticate,
  requireSchoolAdmin,
  validate(planIdParamSchema, "params"),
  validate(updatePlanSchema),
  updatePaymentPlanController
);

// DELETE /payment-plans/:planId - Soft cancel
paymentPlanRoute.delete(
  "/payment-plans/:planId",
  authenticate,
  requireSchoolAdmin,
  validate(planIdParamSchema, "params"),
  validate(cancelPlanSchema),
  cancelPaymentPlanController
);

// PUT /payment-plans/:planId/installment/:num
paymentPlanRoute.put(
  "/payment-plans/:planId/installment/:num",
  authenticate,
  requireSchoolAdmin,
  validate(installmentParamSchema, "params"),
  validate(installmentActionSchema),
  updateInstallmentController
);
