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
  createMySchoolController,
  joinSchoolController,
  listJoinRequestsController,
  decideJoinRequestController,
} from "../controllers/school.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { requireSchool } from "../middleware/requireSchool.js";
import { validate } from "../middleware/validate.js";
import { uploadLogo, uploadStamp } from "../middleware/upload.js";
import {
  createSchoolSchema,
  updateSchoolSchema,
  suspendSchoolSchema,
  schoolIdParamSchema,
  joinRequestIdParamSchema,
  listSchoolsQuerySchema,
  provisionMySchoolSchema,
  joinSchoolSchema,
  decideJoinRequestSchema,
} from "../validations/school.validation.js";

export const schoolRoute = Router();

/**
 * Self-service routes, declared before the `:schoolId` patterns so the intent is
 * obvious reading top to bottom. Express matches in registration order, and
 * neither of these paths collides with `/schools/:schoolId` anyway — "me" and
 * "join" are not ObjectIds, and `schoolIdParamSchema` would reject them.
 *
 * Neither carries `requireSchool`: both exist precisely for accounts that do not
 * have one.
 */
schoolRoute.post("/schools/me", authenticate, validate(provisionMySchoolSchema), createMySchoolController);

schoolRoute.post("/schools/join", authenticate, validate(joinSchoolSchema), joinSchoolController);

schoolRoute.get(
  "/schools/join-requests",
  authenticate,
  requireSchool,
  listJoinRequestsController
);

schoolRoute.put(
  "/schools/join-requests/:requestId",
  authenticate,
  requireSchool,
  validate(joinRequestIdParamSchema, "params"),
  validate(decideJoinRequestSchema),
  decideJoinRequestController
);

/**
 * The super_admin-only admin-tool route. Unchanged in intent: it can create a
 * school on behalf of someone else, which is why it is not the route a
 * self-service signup uses.
 */
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

/**
 * `requireSchool` runs ahead of the `:schoolId` check so an unlinked caller
 * gets `409 SCHOOL_NOT_LINKED` — naming the step that would fix it — instead of
 * the `403 You do not have access to this school` the service would produce.
 * For a brand-new admin that 403 is actively misleading: nothing is being
 * denied to them, they simply have no school to edit yet.
 */
schoolRoute.put(
  "/schools/:schoolId",
  authenticate,
  requireSchool,
  validate(schoolIdParamSchema, "params"),
  validate(updateSchoolSchema),
  updateSchoolController
);

schoolRoute.put(
  "/schools/:schoolId/logo",
  authenticate,
  requireSchool,
  validate(schoolIdParamSchema, "params"),
  uploadLogo,
  updateSchoolLogoController
);

schoolRoute.put(
  "/schools/:schoolId/stamp",
  authenticate,
  authorize("super_admin"),
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
