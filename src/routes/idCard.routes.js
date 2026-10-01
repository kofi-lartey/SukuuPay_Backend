import { Router } from "express";
import {
  createIdCardBatchController,
  getStudentIdCardController,
  getIdCardBatchPreviewController,
  getIdCardBatchPdfController,
  getQrLinksExportController,
} from "../controllers/idCard.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  studentIdParamSchema,
  batchIdParamSchema,
  schoolIdParamSchema,
  createBatchSchema,
  qrLinksQuerySchema,
} from "../validations/idCard.validation.js";

export const idCardRoute = Router();

const requireSchoolAdmin = authorize("super_admin", "school_admin");

// POST /id-cards/batch — generate a batch of ID cards
idCardRoute.post(
  "/batch",
  authenticate,
  requireSchoolAdmin,
  validate(createBatchSchema),
  createIdCardBatchController
);

// GET /id-cards/:studentId — single student ID card PDF
idCardRoute.get(
  "/:studentId",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  getStudentIdCardController
);

// GET /id-cards/batch/:batchId/pdf — download the generated batch PDF
//
// Registered before `/batch/:batchId` for the same reason the preview route is
// not: both are three segments, but this one is four, so it cannot collide with
// `/id-cards/:studentId` (two) regardless of order. It is placed adjacent to its
// sibling so the pair reads as the batch's two endpoints.
idCardRoute.get(
  "/batch/:batchId/pdf",
  authenticate,
  requireSchoolAdmin,
  validate(batchIdParamSchema, "params"),
  getIdCardBatchPdfController
);

// GET /id-cards/batch/:batchId — batch print preview (HTML)
idCardRoute.get(
  "/batch/:batchId",
  authenticate,
  requireSchoolAdmin,
  validate(batchIdParamSchema, "params"),
  getIdCardBatchPreviewController
);

// GET /id-cards/qr-links/:schoolId — export all student QR pay-links as CSV
idCardRoute.get(
  "/qr-links/:schoolId",
  authenticate,
  requireSchoolAdmin,
  validate(schoolIdParamSchema, "params"),
  validate(qrLinksQuerySchema, "query"),
  getQrLinksExportController
);
