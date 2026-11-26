import { Router } from "express";
import {
  listCampusesController,
  createCampusController,
  getCampusController,
  updateCampusController,
  archiveCampusController,
} from "../controllers/campus.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { requireCampusTier, requireCampusAccess } from "../middleware/campus.middleware.js";

export const campusRoute = Router();

/**
 * Roles that may manage campuses: the platform owner acting across tenants, and
 * the school's own admins/accountants. requireCampusTier additionally locks the
 * actor's school to the Campus subscription plan.
 */
const requireCampusRole = authorize("super_admin", "school_admin", "accountant");

/**
 * Wraps the service-level `requireCampusAccess(user, campusId)` predicate as
 * Express middleware for the `:id` routes.
 */
const requireCampusAccessMiddleware = async (req, res, next) => {
  try {
    await requireCampusAccess(req.user, req.params.id);
    return next();
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/* Auth, role, and campus-tier entitlement gate every campus route. */
campusRoute.use(authenticate);
campusRoute.use(requireCampusRole);
campusRoute.use(requireCampusTier);

/**
 * GET /api/v2/campuses
 * List campuses for a school. Query: schoolId (defaults to the caller's school),
 * plus optional status/region/page/perPage filters.
 */
campusRoute.get("/", listCampusesController);

/**
 * POST /api/v2/campuses
 * Create a campus. Body: name, code, address, region, bursarEmail.
 * The campus is created under the caller's school (req.user.schoolId).
 */
campusRoute.post("/", createCampusController);

/**
 * GET /api/v2/campuses/:id
 * Get campus detail. Gated on requireCampusAccess for the resolved campus.
 */
campusRoute.get("/:id", requireCampusAccessMiddleware, getCampusController);

/**
 * PUT /api/v2/campuses/:id
 * Update campus. Gated on requireCampusAccess for the resolved campus.
 */
campusRoute.put("/:id", requireCampusAccessMiddleware, updateCampusController);

/**
 * DELETE /api/v2/campuses/:id
 * Soft archive (sets status: "archived"). Gated on requireCampusAccess.
 */
campusRoute.delete("/:id", requireCampusAccessMiddleware, archiveCampusController);

export default campusRoute;
