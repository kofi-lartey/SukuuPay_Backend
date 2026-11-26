import { Router } from "express";
import {
  getOverviewController,
  getRevenueController,
  getPaidOwedController,
  getPersonsController,
  getRevenueChartController,
  getOverdueController,
  getCashflowController,
  getCashflowVelocityController,
  getComplianceController,
  getDefaultRateController,
  getClassPerformanceController,
} from "../controllers/analytics.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import rateLimit from "../middleware/rateLimit.js";
import {
  schoolIdParamSchema,
  overviewQuerySchema,
  revenueQuerySchema,
  paidOwedQuerySchema,
  personsQuerySchema,
  revenueChartQuerySchema,
  overdueQuerySchema,
  cashflowQuerySchema,
  cashflowVelocityQuerySchema,
  complianceQuerySchema,
  defaultRateQuerySchema,
  classPerformanceQuerySchema,
} from "../validations/analytics.validation.js";

export const analyticsRoute = Router();

const requireSchoolAdmin = authorize("super_admin", "school_admin");

const analyticsRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: "Too many analytics requests. Please try again later.",
  keyBy: "user",
});

const validateSchoolId = validate(schoolIdParamSchema, "params");

analyticsRoute.use("/analytics", authenticate, requireSchoolAdmin, analyticsRateLimit);

analyticsRoute.get(
  "/analytics/overview/:schoolId",
  validateSchoolId,
  validate(overviewQuerySchema, "query"),
  getOverviewController
);

analyticsRoute.get(
  "/analytics/revenue/:schoolId",
  validateSchoolId,
  validate(revenueQuerySchema, "query"),
  getRevenueController
);

analyticsRoute.get(
  "/analytics/paid-owed/:schoolId",
  validateSchoolId,
  validate(paidOwedQuerySchema, "query"),
  getPaidOwedController
);

analyticsRoute.get(
  "/analytics/persons/:schoolId",
  validateSchoolId,
  validate(personsQuerySchema, "query"),
  getPersonsController
);

analyticsRoute.get(
  "/analytics/revenue-chart/:schoolId",
  validateSchoolId,
  validate(revenueChartQuerySchema, "query"),
  getRevenueChartController
);

analyticsRoute.get(
  "/analytics/overdue/:schoolId",
  validateSchoolId,
  validate(overdueQuerySchema, "query"),
  getOverdueController
);

analyticsRoute.get(
  "/analytics/cashflow/:schoolId",
  validateSchoolId,
  validate(cashflowQuerySchema, "query"),
  getCashflowController
);

analyticsRoute.get(
  "/analytics/cashflow/:schoolId/velocity",
  validateSchoolId,
  validate(cashflowVelocityQuerySchema, "query"),
  getCashflowVelocityController
);

analyticsRoute.get(
  "/analytics/compliance/:schoolId",
  validateSchoolId,
  validate(complianceQuerySchema, "query"),
  getComplianceController
);

analyticsRoute.get(
  "/analytics/default-rate/:schoolId",
  validateSchoolId,
  validate(defaultRateQuerySchema, "query"),
  getDefaultRateController
);

analyticsRoute.get(
  "/analytics/class-performance/:schoolId",
  validateSchoolId,
  validate(classPerformanceQuerySchema, "query"),
  getClassPerformanceController
);
