import { Router } from "express";
import {
  createStudentController,
  bulkCreateStudentsController,
  listStudentsController,
  getStudentController,
  updateStudentController,
  deleteStudentController,
  suspendStudentController,
  reactivateStudentController,
  removeStudentController,
  transferStudentController,
  regeneratePayLinkController,
  exportStudentsController,
  promoteStudentController,
  bulkPromoteStudentsController,
  previewPromotionController,
  repeatStudentController,
  graduateStudentController,
  bulkGraduateStudentsController,
  transferOutStudentController,
  getAlumniController,
  getCohortsController,
  getCohortDetailController,
  addParentController,
  getParentsController,
  updateParentController,
  setPrimaryParentController,
  removeParentController,
} from "../controllers/student.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { uploadBulk } from "../middleware/upload.js";
import {
  createStudentSchema,
  updateStudentSchema,
  bulkUploadMetaSchema,
  studentIdParamSchema,
  listStudentsQuerySchema,
  suspendStudentSchema,
  transferClassSchema,
  promoteStudentSchema,
  bulkPromoteSchema,
  previewPromotionSchema,
  repeatStudentSchema,
  graduateStudentSchema,
  bulkGraduateSchema,
  transferOutSchema,
  alumniQuerySchema,
  cohortsQuerySchema,
  cohortDetailQuerySchema,
  schoolIdParamSchema,
  cohortIdParamSchema,
  addParentSchema,
  updateParentSchema,
  parentIdParamSchema,
  setPrimaryParentSchema,
} from "../validations/student.validation.js";

export const studentRoute = Router();

// Manage who can manage students: school admins and super admins.
const requireSchoolAdmin = authorize("super_admin", "school_admin");

// ── Single create ──
studentRoute.post(
  "/students/single",
  authenticate,
  requireSchoolAdmin,
  validate(createStudentSchema),
  createStudentController
);

// ── Bulk create (multipart file) ──
// uploadBulk must run before the meta validator so the form fields land on
// req.body where Joi can read them.
studentRoute.post(
  "/students/bulk",
  authenticate,
  requireSchoolAdmin,
  uploadBulk,
  validate(bulkUploadMetaSchema, "body"),
  bulkCreateStudentsController
);

// ── List / search (scoped to the caller's school) ──
studentRoute.get(
  "/students",
  authenticate,
  validate(listStudentsQuerySchema, "query"),
  listStudentsController
);

// ── Export (must precede /:id so "/export" is not captured as an id) ──
studentRoute.get(
  "/students/export",
  authenticate,
  validate(listStudentsQuerySchema, "query"),
  exportStudentsController
);

// ── Single student ──
studentRoute.get(
  "/students/:id",
  authenticate,
  validate(studentIdParamSchema, "params"),
  getStudentController
);

studentRoute.put(
  "/students/:id",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(updateStudentSchema),
  updateStudentController
);

studentRoute.delete(
  "/students/:id",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  deleteStudentController
);

// ── State transitions ──
studentRoute.put(
  "/students/:id/suspend",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(suspendStudentSchema),
  suspendStudentController
);

studentRoute.put(
  "/students/:id/reactivate",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  reactivateStudentController
);

studentRoute.put(
  "/students/:id/remove",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  removeStudentController
);

// ── Transfer class ──
studentRoute.put(
  "/students/:id/transfer-class",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(transferClassSchema),
  transferStudentController
);

// ── Regenerate pay link ──
studentRoute.get(
  "/students/:id/pay-link",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  regeneratePayLinkController
);

// ── Promotion endpoints ──
studentRoute.post(
  "/students/:id/promote",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(promoteStudentSchema),
  promoteStudentController
);

studentRoute.post(
  "/students/bulk-promote/:schoolId",
  authenticate,
  requireSchoolAdmin,
  validate(schoolIdParamSchema, "params"),
  validate(bulkPromoteSchema),
  bulkPromoteStudentsController
);

studentRoute.post(
  "/students/promote/preview",
  authenticate,
  requireSchoolAdmin,
  validate(previewPromotionSchema),
  previewPromotionController
);

// ── Repeat student ──
studentRoute.post(
  "/students/:id/repeat",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(repeatStudentSchema),
  repeatStudentController
);

// ── Graduation endpoints ──
studentRoute.post(
  "/students/:id/graduate",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(graduateStudentSchema),
  graduateStudentController
);

studentRoute.post(
  "/students/bulk-graduate/:schoolId",
  authenticate,
  requireSchoolAdmin,
  validate(schoolIdParamSchema, "params"),
  validate(bulkGraduateSchema),
  bulkGraduateStudentsController
);

// ── Transfer out ──
studentRoute.post(
  "/students/:id/transfer-out",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(transferOutSchema),
  transferOutStudentController
);

// ── Parent management ──
studentRoute.post(
  "/students/:id/parents",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(addParentSchema),
  addParentController
);

studentRoute.get(
  "/students/:id/parents",
  authenticate,
  validate(studentIdParamSchema, "params"),
  getParentsController
);

studentRoute.put(
  "/parents/:parentId",
  authenticate,
  requireSchoolAdmin,
  validate(parentIdParamSchema, "params"),
  validate(updateParentSchema),
  updateParentController
);

studentRoute.put(
  "/parents/:parentId/primary",
  authenticate,
  requireSchoolAdmin,
  validate(parentIdParamSchema, "params"),
  validate(setPrimaryParentSchema),
  setPrimaryParentController
);

studentRoute.delete(
  "/parents/:parentId",
  authenticate,
  requireSchoolAdmin,
  validate(parentIdParamSchema, "params"),
  removeParentController
);

// ── Alumni & Cohorts ──
studentRoute.get(
  "/alumni/:schoolId",
  authenticate,
  validate(schoolIdParamSchema, "params"),
  validate(alumniQuerySchema, "query"),
  getAlumniController
);

studentRoute.get(
  "/cohorts/:schoolId",
  authenticate,
  validate(schoolIdParamSchema, "params"),
  validate(cohortsQuerySchema, "query"),
  getCohortsController
);

studentRoute.get(
  "/cohorts/:cohortId",
  authenticate,
  validate(cohortIdParamSchema, "params"),
  validate(cohortDetailQuerySchema, "query"),
  getCohortDetailController
);
