import { Router } from "express";
import {
  createSchoolController,
  listSchoolsController,
  getSchoolController,
  updateSchoolController,
  updateSchoolLogoController,
  updateSchoolStampController,
  suspendSchoolController,
  archiveSchoolController,
} from "../controllers/school.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { uploadLogo, uploadStamp } from "../middleware/upload.js";
import {
  createSchoolSchema,
  updateSchoolSchema,
  suspendSchoolSchema,
  schoolIdParamSchema,
  listSchoolsQuerySchema,
} from "../validations/school.validation.js";

export const schoolRoute = Router();

schoolRoute.post(
  "/schools",
  authenticate,
  authorize("super_admin"),
  validate(createSchoolSchema),
  uploadStamp,
  createSchoolController
);

schoolRoute.get(
  "/schools",
  authenticate,
  authorize("super_admin"),
  validate(listSchoolsQuerySchema, "query"),
  listSchoolsController
);

schoolRoute.get(
  "/schools/:schoolId",
  authenticate,
  validate(schoolIdParamSchema, "params"),
  getSchoolController
);

schoolRoute.put(
  "/schools/:schoolId",
  authenticate,
  validate(schoolIdParamSchema, "params"),
  validate(updateSchoolSchema),
  updateSchoolController
);

schoolRoute.put(
  "/schools/:schoolId/logo",
  authenticate,
  validate(schoolIdParamSchema, "params"),
  uploadLogo,
  updateSchoolLogoController
);

schoolRoute.put(
  "/schools/:schoolId/stamp",
  authenticate,
  validate(schoolIdParamSchema, "params"),
  uploadStamp,
  updateSchoolStampController
);

schoolRoute.put(
  "/schools/:schoolId/suspend",
  authenticate,
  authorize("super_admin"),
  validate(schoolIdParamSchema, "params"),
  validate(suspendSchoolSchema),
  suspendSchoolController
);

schoolRoute.delete(
  "/schools/:schoolId",
  authenticate,
  authorize("super_admin"),
  validate(schoolIdParamSchema, "params"),
  archiveSchoolController
);