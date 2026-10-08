import { Router } from "express";
import {
  getSchoolSettingsController,
  updateSchoolSettingsController,
  updateAcademicYearController,
  updateNotificationPrefsController,
  getSchoolBillingController,
  getIdCardSettingsController,
  updateIdCardSettingsController,
} from "../controllers/settings.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { schoolIdParamSchema } from "../validations/school.validation.js";
import {
  updateSettingsSchema,
  updateAcademicYearSchema,
  updateNotificationPrefsSchema,
  billingQuerySchema,
  idCardSettingsUpdateSchema,
} from "../validations/settings.validation.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const settingsRoute = Router();

const requireSchoolAdmin = authorize("super_admin", "school_admin");
const settingsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: "Too many settings requests, please try again later.",
});

// GET /settings/:schoolId — get all settings
settingsRoute.get(
  "/:schoolId",
  authenticate,
  requireSchoolAdmin,
  settingsRateLimit,
  validate(schoolIdParamSchema, "params"),
  getSchoolSettingsController
);

// PUT /settings/:schoolId — update general settings
settingsRoute.put(
  "/:schoolId",
  authenticate,
  requireSchoolAdmin,
  settingsRateLimit,
  validate(schoolIdParamSchema, "params"),
  validate(updateSettingsSchema),
  updateSchoolSettingsController
);

// PUT /settings/:schoolId/academic-year — set current academic year & term
settingsRoute.put(
  "/:schoolId/academic-year",
  authenticate,
  requireSchoolAdmin,
  settingsRateLimit,
  validate(schoolIdParamSchema, "params"),
  validate(updateAcademicYearSchema),
  updateAcademicYearController
);

// PUT /settings/:schoolId/notifications — set notification preferences
settingsRoute.put(
  "/:schoolId/notifications",
  authenticate,
  requireSchoolAdmin,
  settingsRateLimit,
  validate(schoolIdParamSchema, "params"),
  validate(updateNotificationPrefsSchema),
  updateNotificationPrefsController
);

// GET /settings/:schoolId/billing — get subscription + billing info
settingsRoute.get(
  "/:schoolId/billing",
  authenticate,
  requireSchoolAdmin,
  settingsRateLimit,
  validate(schoolIdParamSchema, "params"),
  validate(billingQuerySchema, "query"),
  getSchoolBillingController
);

// GET /settings/:schoolId/id-cards — get ID card settings
settingsRoute.get(
  "/:schoolId/id-cards",
  authenticate,
  requireSchoolAdmin,
  settingsRateLimit,
  validate(schoolIdParamSchema, "params"),
  getIdCardSettingsController
);

// PUT /settings/:schoolId/id-cards — update ID card settings
settingsRoute.put(
  "/:schoolId/id-cards",
  authenticate,
  requireSchoolAdmin,
  settingsRateLimit,
  validate(schoolIdParamSchema, "params"),
  validate(idCardSettingsUpdateSchema),
  updateIdCardSettingsController
);
