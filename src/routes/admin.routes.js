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
import {
  listSchoolAds,
  createSchoolAd,
  updateSchoolAd,
  reviewSchoolAd,
  deleteSchoolAd,
} from "../controllers/schoolAd.controller.js";
import { uploadSchoolAd } from "../middleware/upload.js";
import {
  createSchoolAdSchema,
  updateSchoolAdSchema,
  schoolAdIdParamSchema,
  listSchoolAdsQuerySchema,
  approveSchoolAdSchema,
} from "../validations/schoolAd.validation.js";

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

// GET /admin/school-ads — moderation queue across every placement
adminRoute.get(
  "/school-ads",
  validate(listSchoolAdsQuerySchema, "query"),
  listSchoolAds
);

// POST /admin/school-ads — submit a creative. Filed as "pending"; an explicit
// approval call is required before it can reach the public slider.
adminRoute.post(
  "/school-ads",
  uploadSchoolAd,
  validate(createSchoolAdSchema),
  createSchoolAd
);

// PUT /admin/school-ads/:adId — edit copy, dates, weight or swap the creative
adminRoute.put(
  "/school-ads/:adId",
  uploadSchoolAd,
  validate(schoolAdIdParamSchema, "params"),
  validate(updateSchoolAdSchema),
  updateSchoolAd
);

// PUT /admin/school-ads/:adId/approve — the only path that can change status
adminRoute.put(
  "/school-ads/:adId/approve",
  validate(schoolAdIdParamSchema, "params"),
  validate(approveSchoolAdSchema),
  reviewSchoolAd
);

// DELETE /admin/school-ads/:adId — soft delete, also purges the Cloudinary asset
adminRoute.delete(
  "/school-ads/:adId",
  validate(schoolAdIdParamSchema, "params"),
  deleteSchoolAd
);
