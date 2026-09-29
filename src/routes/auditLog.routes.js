import { Router } from "express";
import {
  getAuditLogsController,
  exportAuditLogsController,
  getUserAuditLogsController,
} from "../controllers/auditLog.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  schoolIdParamSchema,
  userIdParamSchema,
  auditLogQuerySchema,
  auditLogExportQuerySchema,
  auditLogUserQuerySchema,
} from "../validations/auditLog.validation.js";

export const auditLogRoute = Router();

const requireSchoolAdmin = authorize("super_admin", "school_admin");

// GET /audit-logs/user/:userId — activity for a specific user
// Registered BEFORE /:schoolId so the literal "user" segment is not
// captured as a schoolId.
auditLogRoute.get(
  "/user/:userId",
  authenticate,
  requireSchoolAdmin,
  validate(userIdParamSchema, "params"),
  validate(auditLogUserQuerySchema, "query"),
  getUserAuditLogsController
);

// GET /audit-logs/:schoolId — list with filters
auditLogRoute.get(
  "/:schoolId",
  authenticate,
  requireSchoolAdmin,
  validate(schoolIdParamSchema, "params"),
  validate(auditLogQuerySchema, "query"),
  getAuditLogsController
);

// GET /audit-logs/:schoolId/export — export as CSV
auditLogRoute.get(
  "/:schoolId/export",
  authenticate,
  requireSchoolAdmin,
  validate(schoolIdParamSchema, "params"),
  validate(auditLogExportQuerySchema, "query"),
  exportAuditLogsController
);
