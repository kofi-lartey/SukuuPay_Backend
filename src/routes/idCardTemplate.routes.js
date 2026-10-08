import { Router } from "express";
import {
  listIdCardTemplatesController,
  getIdCardTemplateController,
  createIdCardTemplateController,
  updateIdCardTemplateController,
  deleteIdCardTemplateController,
  duplicateIdCardTemplateController,
  setDefaultIdCardTemplateController,
} from "../controllers/idCardTemplate.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  templateIdParamSchema,
  schoolIdParamSchema,
  createTemplateSchema,
  updateTemplateSchema,
  duplicateTemplateSchema,
} from "../validations/idCardTemplate.validation.js";

export const idCardTemplateRoute = Router();

const requireSchoolAdmin = authorize("super_admin", "school_admin");

// GET /id-card-templates/:schoolId — list all templates for a school
idCardTemplateRoute.get(
  "/:schoolId",
  authenticate,
  requireSchoolAdmin,
  validate(schoolIdParamSchema, "params"),
  listIdCardTemplatesController
);

// POST /id-card-templates/:schoolId — create a new template
idCardTemplateRoute.post(
  "/:schoolId",
  authenticate,
  requireSchoolAdmin,
  validate(schoolIdParamSchema, "params"),
  validate(createTemplateSchema),
  createIdCardTemplateController
);

// GET /id-card-templates/template/:templateId — get a single template
idCardTemplateRoute.get(
  "/template/:templateId",
  authenticate,
  requireSchoolAdmin,
  validate(templateIdParamSchema, "params"),
  getIdCardTemplateController
);

// PUT /id-card-templates/template/:templateId — update a template
idCardTemplateRoute.put(
  "/template/:templateId",
  authenticate,
  requireSchoolAdmin,
  validate(templateIdParamSchema, "params"),
  validate(updateTemplateSchema),
  updateIdCardTemplateController
);

// DELETE /id-card-templates/template/:templateId — soft delete a template
idCardTemplateRoute.delete(
  "/template/:templateId",
  authenticate,
  requireSchoolAdmin,
  validate(templateIdParamSchema, "params"),
  deleteIdCardTemplateController
);

// POST /id-card-templates/template/:templateId/duplicate — clone a template
idCardTemplateRoute.post(
  "/template/:templateId/duplicate",
  authenticate,
  requireSchoolAdmin,
  validate(templateIdParamSchema, "params"),
  validate(duplicateTemplateSchema),
  duplicateIdCardTemplateController
);

// PUT /id-card-templates/template/:templateId/set-default — set as default
idCardTemplateRoute.put(
  "/template/:templateId/set-default",
  authenticate,
  requireSchoolAdmin,
  validate(templateIdParamSchema, "params"),
  setDefaultIdCardTemplateController
);
