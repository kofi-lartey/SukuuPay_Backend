import { Router } from "express";
import {
  listAllSchoolsController,
  getPlatformRevenueController,
  getPlatformSmsBalanceController,
  getSchoolUsageController,
  suspendSchoolPlatformController,
  unsuspendSchoolPlatformController,
  getDashboardKpisController,
} from "../controllers/admin.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  schoolIdParamSchema,
  listAllSchoolsQuerySchema,
  revenueQuerySchema,
  suspendSchema,
} from "../validations/admin.validation.js";

export const adminRoute = Router();

adminRoute.use(authenticate, authorize("super_admin"));

// GET /admin/schools — list all schools on platform
adminRoute.get(
  "/schools",
  validate(listAllSchoolsQuerySchema, "query"),
  listAllSchoolsController
);

// GET /admin/dashboard — super admin KPIs
adminRoute.get("/dashboard", getDashboardKpisController);

// GET /admin/revenue — platform-wide revenue
adminRoute.get(
  "/revenue",
  validate(revenueQuerySchema, "query"),
  getPlatformRevenueController
);

// GET /admin/sms-balance — master SMS balance
adminRoute.get("/sms-balance", getPlatformSmsBalanceController);

// GET /admin/schools/:id/usage — school usage stats
adminRoute.get(
  "/schools/:id/usage",
  validate(schoolIdParamSchema, "params"),
  getSchoolUsageController
);

// PUT /admin/schools/:id/suspend — suspend school
adminRoute.put(
  "/schools/:id/suspend",
  validate(schoolIdParamSchema, "params"),
  validate(suspendSchema),
  suspendSchoolPlatformController
);

// PUT /admin/schools/:id/unsuspend — unsuspend school
adminRoute.put(
  "/schools/:id/unsuspend",
  validate(schoolIdParamSchema, "params"),
  unsuspendSchoolPlatformController
);
