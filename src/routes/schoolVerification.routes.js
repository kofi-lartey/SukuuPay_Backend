import { Router } from "express";
import {
  searchDirectoryController,
  uploadVerificationDocumentController,
  getVerificationStatusController,
  adminVerifySchoolController,
  linkDirectoryMatchController,
  clearDirectoryCacheController,
} from "../controllers/schoolVerification.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { requireSchool } from "../middleware/requireSchool.js";
import { validate } from "../middleware/validate.js";
import { uploadVerificationDocumentRoute } from "../middleware/uploadVerification.js";
import {
  schoolDirectorySearchQuerySchema,
  uploadVerificationDocumentSchema,
  adminVerifySchoolSchema,
  linkDirectoryMatchSchema,
  schoolIdParamSchema,
} from "../validations/schoolVerification.validation.js";

export const schoolVerificationRoute = Router();

// Public: search directory (no auth needed)
schoolVerificationRoute.get(
  "/schools/directory/search",
  validate(schoolDirectorySearchQuerySchema, "query"),
  searchDirectoryController
);

// Protected routes - require authentication per route
schoolVerificationRoute.post(
  "/schools/:schoolId/verification/documents",
  authenticate,
  requireSchool,
  validate(schoolIdParamSchema, "params"),
  uploadVerificationDocumentRoute,
  validate(uploadVerificationDocumentSchema),
  uploadVerificationDocumentController
);

schoolVerificationRoute.get(
  "/schools/:schoolId/verification/status",
  authenticate,
  validate(schoolIdParamSchema, "params"),
  getVerificationStatusController
);

schoolVerificationRoute.post(
  "/schools/:schoolId/verification/link-directory",
  authenticate,
  requireSchool,
  validate(schoolIdParamSchema, "params"),
  validate(linkDirectoryMatchSchema),
  linkDirectoryMatchController
);

schoolVerificationRoute.post(
  "/admin/schools/directory/cache/clear",
  authenticate,
  authorize("super_admin"),
  clearDirectoryCacheController
);

schoolVerificationRoute.patch(
  "/admin/schools/:schoolId/verify",
  authenticate,
  authorize("super_admin"),
  validate(schoolIdParamSchema, "params"),
  validate(adminVerifySchoolSchema),
  adminVerifySchoolController
);