import { Router } from "express";
import {
  createIdCardBatchController,
  getStudentIdCardController,
  getIdCardBatchPreviewDataController,
  getIdCardBatchPdfController,
  getIdCardBatchStatusController,
  mergeIdCardBatchesController,
  listIdCardBatchesController,
  getLatestBatchController,
  getQrLinksExportController,
} from "../controllers/idCard.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  studentIdParamSchema,
  batchIdParamSchema,
  schoolIdParamSchema,
  createBatchSchema,
  mergeBatchSchema,
  qrLinksQuerySchema,
  batchesQuerySchema,
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

// POST /id-cards/batch/merge — merge multiple batches into a new batch
idCardRoute.post(
  "/batch/merge",
  authenticate,
  requireSchoolAdmin,
  validate(mergeBatchSchema),
  mergeIdCardBatchesController
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
idCardRoute.get(
  "/batch/:batchId/pdf",
  authenticate,
  requireSchoolAdmin,
  validate(batchIdParamSchema, "params"),
  getIdCardBatchPdfController
);

// GET /id-cards/batch/:batchId/preview-data — full card data for React print preview
idCardRoute.get(
  "/batch/:batchId/preview-data",
  authenticate,
  requireSchoolAdmin,
  validate(batchIdParamSchema, "params"),
  getIdCardBatchPreviewDataController
);

// GET /id-cards/batch/:batchId/status — batch status for polling
idCardRoute.get(
  "/batch/:batchId/status",
  authenticate,
  requireSchoolAdmin,
  validate(batchIdParamSchema, "params"),
  getIdCardBatchStatusController
);

// GET /id-cards/batches/latest — get the latest ready batch for preview
idCardRoute.get(
  "/batches/latest",
  authenticate,
  requireSchoolAdmin,
  getLatestBatchController
);

// GET /id-cards/batches/:schoolId — list batches for a school (admin)
idCardRoute.get(
  "/batches/:schoolId",
  authenticate,
  requireSchoolAdmin,
  validate(schoolIdParamSchema, "params"),
  validate(batchesQuerySchema, "query"),
  listIdCardBatchesController
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
