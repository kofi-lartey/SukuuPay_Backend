import mongoose from "mongoose";
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
export const COMMUNITY_ALLOWED_ROLES = ["super_admin", "school_admin", "teacher", "student", "accountant"];

/**
 * The token is a bearer credential, so it is masked rather than printed whole.
 * A full token in a log file is a session an attacker can replay; a prefix is
 * enough to correlate a request with a login without handing over the session.
 */
const maskToken = (header) => {
  if (!header || typeof header !== "string") return "(none)";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : header;
  if (!token) return "(empty)";
  return `${token.slice(0, 8)}…${token.slice(-4)} (len ${token.length})`;
};

/**
 * Resolves the role from the authenticated principal.
 *
 * `User.role` is the stored role for staff/platform accounts (see
 * `models/userModel.js`), while `authenticate` builds a student principal from
 * the `Student` collection and stamps `role: 'student'` on it. `userType` is
 * accepted as a fallback only because older tokens minted before that field was
 * standardised can still be in circulation; `role` always wins when present.
 */
export const resolveRole = (user) => user?.role || user?.userType || null;

export const communityAuth = (req, res, next) => {
  const role = resolveRole(req.user);

  console.log(
    "[CommunityAuth]",
    req.method,
    req.originalUrl,
    "| Header:",
    maskToken(req.headers.authorization),
    "| User:",
    req.user
      ? { _id: String(req.user._id), role: req.user.role, userType: req.user.userType, schoolId: req.user.schoolId }
      : null,
    "| Resolved role:",
    role
  );

  /*
   * No authenticated principal at all is an *authentication* failure, not an
   * authorisation one. `authenticate` normally answers 401 itself, so reaching
   * here means the community router was mounted without it or a caller invoked
   * this middleware directly — either way a 403 would tell the client "you are
   * signed in but forbidden", which sends the refresh interceptor down the
   * wrong path. 401 is the honest answer: there is no session to evaluate.
   */
  if (!req.user || !role) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
      code: "AUTHENTICATION_REQUIRED",
    });
  }

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
  const role = resolveRole(user);

  if (role === "super_admin") {
    return explicitSchoolId && mongoose.Types.ObjectId.isValid(explicitSchoolId)
      ? new mongoose.Types.ObjectId(explicitSchoolId)
      : null;
  }
  return user?.schoolId && mongoose.Types.ObjectId.isValid(String(user.schoolId))
    ? new mongoose.Types.ObjectId(user.schoolId)
    : null;
};

export const assertCommunitySchool = (user, schoolIdParam) => {
  if (resolveRole(user) === "super_admin") return;
  if (!user?.schoolId) {
    throw new ApiError("Your account is not linked to a school", 403, "SCHOOL_ACCESS_DENIED");
  }
  if (schoolIdParam && String(user.schoolId) !== String(schoolIdParam)) {
    throw new ApiError("You do not have access to that school", 403, "SCHOOL_ACCESS_DENIED");
  }
};

export default communityAuth;