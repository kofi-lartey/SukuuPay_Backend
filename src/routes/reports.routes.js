import { Router } from "express";
import {
  getDailyReportController,
  getTermReportController,
  getOutstandingReportController,
  getComplianceReportController,
  getPaymentMethodsReportController,
  getClassCollectionsReportController,
  getParentContactsReportController,
  getOverdueReportController,
  getHeadmasterMonthlyReportController,
} from "../controllers/reports.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import rateLimit from "../middleware/rateLimit.js";
import {
  schoolIdParamSchema,
  dailyQuerySchema,
  termQuerySchema,
  outstandingQuerySchema,
  complianceQuerySchema,
  paymentMethodsQuerySchema,
  classCollectionsQuerySchema,
  parentContactsQuerySchema,
  overdueQuerySchema,
  headmasterMonthlyQuerySchema,
} from "../validations/reports.validation.js";

export const reportsRoute = Router();

const requireSchoolAdmin = authorize("super_admin", "school_admin", "accountant");

// Reports back a report view/export, and exports run the same aggregation
// before rendering it to a file, so the budget is tighter than analytics.
const reportsRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: "Too many report requests. Please try again later.",
  keyBy: "user",
});

const validateSchoolId = validate(schoolIdParamSchema, "params");

reportsRoute.use("/reports", authenticate, requireSchoolAdmin, reportsRateLimit);

reportsRoute.get(
  "/reports/daily/:schoolId",
  validateSchoolId,
  validate(dailyQuerySchema, "query"),
  getDailyReportController
);

reportsRoute.get(
  "/reports/term/:schoolId",
  validateSchoolId,
  validate(termQuerySchema, "query"),
  getTermReportController
);

reportsRoute.get(
  "/reports/outstanding/:schoolId",
  validateSchoolId,
  validate(outstandingQuerySchema, "query"),
  getOutstandingReportController
);

reportsRoute.get(
  "/reports/compliance/:schoolId",
  validateSchoolId,
  validate(complianceQuerySchema, "query"),
  getComplianceReportController
);

reportsRoute.get(
  "/reports/payment-methods/:schoolId",
  validateSchoolId,
  validate(paymentMethodsQuerySchema, "query"),
  getPaymentMethodsReportController
);

reportsRoute.get(
  "/reports/class-collections/:schoolId",
  validateSchoolId,
  validate(classCollectionsQuerySchema, "query"),
  getClassCollectionsReportController
);

reportsRoute.get(
  "/reports/parent-contacts/:schoolId",
  validateSchoolId,
  validate(parentContactsQuerySchema, "query"),
  getParentContactsReportController
);

reportsRoute.get(
  "/reports/overdue/:schoolId",
  validateSchoolId,
  validate(overdueQuerySchema, "query"),
  getOverdueReportController
);

reportsRoute.get(
  "/reports/headmaster-monthly/:schoolId",
  validateSchoolId,
  validate(headmasterMonthlyQuerySchema, "query"),
  getHeadmasterMonthlyReportController
);
