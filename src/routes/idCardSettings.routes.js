import { Router } from "express";
import {
  getIdCardSettingsController,
  updateIdCardSettingsController,
} from "../controllers/settings.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  schoolIdParamSchema,
  idCardSettingsUpdateSchema,
} from "../validations/settings.validation.js";

export const idCardSettingsRoute = Router({ mergeParams: true });

const requireSchoolAdmin = authorize("super_admin", "school_admin");

// GET /settings/:schoolId/id-cards — get ID card settings
idCardSettingsRoute.get(
  "/",
  authenticate,
  requireSchoolAdmin,
  validate(schoolIdParamSchema, "params"),
  getIdCardSettingsController
);

// PUT /settings/:schoolId/id-cards — update ID card settings
idCardSettingsRoute.put(
  "/",
  authenticate,
  requireSchoolAdmin,
  validate(schoolIdParamSchema, "params"),
  validate(idCardSettingsUpdateSchema),
  updateIdCardSettingsController
);
