import { School } from "../models/schoolModel.js";
import { Campus } from "../models/Campus.js";
import ApiError from "../utils/ApiError.js";
import { CAMPUS_PLAN, normalizePlan } from "../config/constants.js";

/**
 * Resolve the campus id a request is targeting.
 *
 * The caller may name a campus as a query param (`?campusId=`), a body field
 * (`campusId`), or a route param (`/campuses/:campusId`). A campus-scoped read
 * or write that names none is treated as school-wide (`null`), which is the
 * "visible to every campus" default every list endpoint relies on.
 *
 * Returns `null` when no campus is named, an ObjectId-ready string otherwise.
 */
const resolveCampusId = (req) => {
  const raw =
    req.query?.campusId ??
    req.body?.campusId ??
    req.params?.campusId ??
    null;

  if (raw === null || raw === "" || raw === "null") return null;
  return String(raw);
};

/**
 * Express middleware asserting the caller belongs to the targeted campus.
 *
 * `requireCampusAccess(user, campusId)` (Wave 2) is the predicate; this is the
 * request-shape wrapper around it. It runs after `authenticate`, resolves the
 * campus the request targets, and rejects with `403 CAMPUS_ACCESS_DENIED` when
 * the caller's `assignedCampuses` does not include it (super_admin bypasses, as
 * in the predicate). A request with no campus id is allowed through — it is a
 * school-wide read/write, not a campus-scoped one, and the list endpoints
 * apply the visibility filter instead.
 *
 * On success the resolved id is stashed as `req.campusId` so controllers do not
 * re-parse the query/body/params three more times.
 */
export const requireCampusMembership = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const campusId = resolveCampusId(req);
    req.campusId = campusId;

    if (campusId === null) {
      return next();
    }

    await requireCampusAccess(req.user, campusId);
    return next();
  } catch (err) {
    const status = err.status || (err.name === "CastError" ? 400 : 500);
    const code = err.code || (err.name === "CastError" ? "INVALID_CAMPUS_ID" : "CAMPUS_ERROR");
    return res.status(status).json({ success: false, message: err.message, code });
  }
};

/**
 * Resolve the caller's own campus id, for student-facing routes.
 *
 * A student reads LMS content scoped to the campus they belong to. `Student`
 * carries `campusId` directly, so this looks it up from the authenticated
 * student token and returns it (or `null` for a school-wide student). Throws
 * `ApiError(404)` when the student cannot be found, matching the convention
 * used elsewhere in the student controller.
 */
export const resolveStudentCampusId = async (user) => {
  if (!user || user.role !== "student" || !user.studentId) return null;
  const { Student } = await import("../models/studentModel.js");
  const student = await Student.findById(user.studentId).select("campusId").lean();
  return student?.campusId ? String(student.campusId) : null;
};

export const requireCampusTier = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    let schoolId = req.user.schoolId || req.body?.schoolId || req.params?.schoolId;
    if (!schoolId) {
      return res.status(400).json({ success: false, message: "schoolId required" });
    }

    const school = await School.findById(schoolId).select("subscription.plan");
    const plan = normalizePlan(school?.subscription?.plan);

    if (plan !== CAMPUS_PLAN) {
      return res.status(403).json({
        success: false,
        message: "Campus tier required",
        code: "CAMPUS_TIER_REQUIRED",
        meta: { required: CAMPUS_PLAN, current: plan || null },
      });
    }

    req.school = school;
    return next();
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const requireCampusAccess = async (user, campusId) => {
  if (!user) throw new ApiError("Authentication required", 401, "UNAUTHENTICATED");
  if (user.role === "super_admin") return true;

  if (Array.isArray(user.assignedCampuses) && user.assignedCampuses.map(String).includes(String(campusId))) {
    return true;
  }

  // campusId may represent a school/campus; check school match for school_admin/accountant
  const campus = await School.findById(campusId).select("schoolId _id").catch(() => null);
  const schoolId = campus ? (campus.schoolId || campus._id) : campusId;

  if (
    (user.role === "school_admin" || user.role === "accountant") &&
    user.schoolId &&
    String(user.schoolId) === String(schoolId)
  ) {
    return true;
  }

  throw new ApiError("Campus access denied", 403, "CAMPUS_ACCESS_DENIED");
};

export const requireSignatoryCount = (batch, userId) => {
  const signers = Array.isArray(batch?.signatures) ? batch.signatures : [];
  const alreadySigned = signers.some((s) => String(s.userId || s) === String(userId));
  const remainingSignatures = Math.max(0, (batch?.requiredSignatures || 0) - signers.length);
  return { alreadySigned, remainingSignatures };
};

export default requireCampusTier;
