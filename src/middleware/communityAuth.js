import ApiError from "../utils/ApiError.js";

/**
 * Middleware that gates the community module.
 *
 * `parent` is rejected outright with a 403: the parent pay portal is a
 * token-based, fee-focused surface and the community module is not part of it.
 * This is the *presentation* half of the exclusion; the route-level
 * `authenticate` + `authorize` below is the enforcement.
 *
 * The check happens before any other community middleware so a parent's
 * request never reaches a controller that would otherwise scope a query.
 */
const COMMUNITY_ALLOWED_ROLES = ["super_admin", "school_admin", "teacher", "student"];

export const communityAuth = (req, res, next) => {
  const role = req.user?.role;
  if (role === "parent") {
    return res.status(403).json({
      success: false,
      message: "Community access is not available for parents",
      code: "COMMUNITY_PARENT_RESTRICTED",
    });
  }
  if (!COMMUNITY_ALLOWED_ROLES.includes(role)) {
    return res.status(403).json({
      success: false,
      message: "You do not have access to the community module",
      code: "COMMUNITY_ACCESS_DENIED",
    });
  }
  next();
};

/**
 * Resolves the school scope for a community request.
 *
 * `super_admin` may pass an explicit schoolId (the platform console's job);
 * everyone else is pinned to their own school. A user with no school is
 * refused with the same code the rest of the product uses, so the client's
 * provisioning redirect fires instead of a generic 403.
 */
export const resolveCommunitySchool = (user, explicitSchoolId) => {
  if (user?.role === "super_admin") {
    return explicitSchoolId && mongoose.Types.ObjectId.isValid(explicitSchoolId)
      ? new mongoose.Types.ObjectId(explicitSchoolId)
      : null;
  }
  return user?.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

export const assertCommunitySchool = (user, schoolIdParam) => {
  if (user?.role === "super_admin") return;
  if (!user?.schoolId) {
    throw new ApiError("Your account is not linked to a school", 403, "SCHOOL_ACCESS_DENIED");
  }
  if (schoolIdParam && String(user.schoolId) !== String(schoolIdParam)) {
    throw new ApiError("You do not have access to that school", 403, "SCHOOL_ACCESS_DENIED");
  }
};

import mongoose from "mongoose";