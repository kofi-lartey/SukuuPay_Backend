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
import { trialExpiryMiddleware } from "../middleware/trialExpiry.js";
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
import {
  initiateSubscriptionPaymentController,
} from "../controllers/subscriptionPayment.controller.js";

export const schoolRoute = Router();

/**
 * Trial expiry check runs for every school-scoped request on this router.
 * It is placed after `authenticate` so `req.user` is populated, and it
 * no-ops when `req.user.schoolId` is null (accounts without a school yet).
 */
schoolRoute.use(authenticate, trialExpiryMiddleware);

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

/**
 * `POST /schools/me/subscription/payment` — initiate a manual subscription
 * payment. The school is on trial or expired, selects a paid tier, and the
 * endpoint creates a pending `ManualPayment` and suspends the subscription
 * until an administrator approves it.
 */
schoolRoute.post(
  "/schools/me/subscription/payment",
  authenticate,
  initiateSubscriptionPaymentController
);

schoolRoute.post("/schools/join", authenticate, validate(joinSchoolSchema), joinSchoolController);

/**
 * The approval queue, and the decision on it.
 *
 * Gated on `school_admin` (plus `super_admin`, the platform owner acting across
 * tenants) because that is the role the joining staff have to be approved *by*:
 * a teacher or an accountant signals intent with a school code, and the person
 * who owns the school's SukuuPay account decides whether that person gets in.
 * `requireSchool` runs ahead of the role check so an admin whose own school is
 * missing gets the provisioning 409 rather than a misleading 403.
 *
 * Both routes are the backend half of the admin dashboard's user-approval
 * module; `frontend/src/components/user-management/PendingApprovals.jsx` is the
 * other half.
 */
schoolRoute.get(
  "/schools/join-requests",
  authenticate,
  requireSchool,
  authorize("super_admin", "school_admin"),
  listJoinRequestsController
);

schoolRoute.put(
  "/schools/join-requests/:requestId",
  authenticate,
  requireSchool,
  authorize("super_admin", "school_admin"),
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
