import { User } from "../../models/userModel.js";
import { School } from "../../models/schoolModel.js";
import { Payment } from "../../models/paymentModel.js";
import { AuditLog } from "../../models/AuditLog.js";
import { sendEmail } from "../emailService.js";
import { passwordResetEmail, verificationEmail } from "../../templates/emails.js";
import { generateResetToken, hashToken, emailOtpExpiry, generateEmailOtp, passwordResetExpiry } from "../../utils/tokens.js";
import {
  EMAIL_OTP_EXPIRE_MINUTES,
  PASSWORD_RESET_EXPIRE_MINUTES,
  NODE_ENV,
} from "../../config/env.js";
import { ASSIGNABLE_ROLES } from "../../validators/userValidators.js";
import ApiError from "../../utils/ApiError.js";
import { optionalId, resolvePagination, buildMeta } from "../../utils/platformQuery.js";

/**
 * Platform-owner operations on a single user.
 *
 * Separate from `controllers/userController.js` on purpose. That file is the
 * *school's* user management: every handler there is scoped by
 * `sameSchoolOrAdmin`, several of them carry no `authorize` middleware at all, and
 * its `changeUserRole` / `updateUser` were the two endpoints that could once mint a
 * second `super_admin` (see `tests/platformOwner.test.js`). This module is the
 * console's view — cross-tenant, `super_admin`-only by virtue of the router — and
 * it re-derives the owner guard from scratch rather than importing a helper, on
 * the principle that a rule protecting the single-owner invariant should not depend
 * on another file continuing to export it.
 *
 * **The invariant.** Exactly one `super_admin` exists. It is provisioned from the
 * environment by `boot/ensureSuperAdmin.js`, it carries `isPlatformOwner === true`,
 * and it must never be demoted, suspended, deactivated or deleted through any API.
 * Every guard below is written so that the owner cannot reach any of those states:
 * a target that `isPlatformOwner` is refused outright, and the caller cannot point
 * the endpoint at themselves. Failing open here does not merely inconvenience the
 * operator — it produces a deployment with no owner, where `ensureSuperAdmin`
 * refuses to start and the whole console answers 403 to the one person who could
 * fix it.
 */

/**
 * The only projection any of these endpoints returns.
 *
 * An **allowlist**, and the point of naming it here is that it is not a typo for
 * the denylist it replaced in spirit. `User`'s `toJSON` transform already deletes
 * `password`, `passwordResetToken`, `passwordResetExpires`,
 * `emailVerificationToken`, `emailVerificationExpires`, `refreshToken` and
 * `refreshTokenExpires` — but that transform only runs on a *document*, so a
 * `.lean()` (which this module uses everywhere) bypasses it entirely and returns
 * every `select: false` field that a query happened to ask for. The
 * `select: false` flags are a second line of defence that only holds while nobody
 * adds a `.select("+password")`; the allowlist is the one that does not depend on a
 * field continuing to be secret-shaped.
 *
 * `isPlatformOwner` *is* projected deliberately: the console's user list is where
 * an operator confirms which account is the owner, and the field is a flag, not a
 * credential.
 */
const SAFE_USER_SELECT =
  "name email phone role position status schoolId isPlatformOwner isEmailVerified emailVerifiedAt lastLoginAt inviteCount invitedAt invitedBy inviteEmailSentAt mustChangePassword onboardingCompleted onboardingHighestStep impersonatingSchoolId impersonationSessionId schoolIntent createdAt updatedAt";

/**
 * Credentials stripped from the school summary embedded in a user read.
 *
 * The same four as everywhere else. A user detail view shows a school's name and
 * region; it has no reason to carry that school's gateway credentials.
 */
const SAFE_SCHOOL_SELECT = "name region status schoolCode subscription.status";

/**
 * Roles a caller may *ask for*.
 *
 * Imported rather than restated: `ASSIGNABLE_ROLES`
 * (`validators/userValidators.js`) is the single copy of the grantable set and its
 * own comment explains why it excludes `super_admin`. A second list here would be
 * a third place for the single-owner rule to be enforced, and the place that
 * matters least is the one somebody forgets.
 */
const GRANTABLE_ROLES = new Set(ASSIGNABLE_ROLES);

/** Statuses this endpoint may set. Narrower than the model's four-value enum. */
const ASSIGNABLE_STATUSES = ["active", "suspended", "deactivated"];

const requireObjectId = (value, label = "ID") => {
  const id = optionalId(value, label);
  if (!id) throw new ApiError(`Missing ${label}`, 400, "INVALID_ID");
  return id;
};

const findUserOrFail = async (userId) => {
  const id = requireObjectId(userId, "user ID");
  const user = await User.findOne({ _id: id, deletedAt: null });
  if (!user) throw new ApiError("User not found", 404, "USER_NOT_FOUND");
  return user;
};

/**
 * Refuse any target that is the platform owner.
 *
 * `isPlatformOwner` rather than `role === 'super_admin'`, and the distinction is
 * the whole reason this helper exists. The role is what the console can *set*; the
 * flag is what `boot/ensureSuperAdmin.js` writes on the one account it provisions
 * and clears on everything it demotes. Guarding on the flag means an account that
 * has been demoted to `school_admin` but not yet re-boot-reconciled is still
 * protected, and — the direction that matters — an account carrying the role
 * through some future code path is caught too. Either signal alone leaves a gap;
 * the flag is the one that is written by the provisioner and therefore the one that
 * is true.
 */
const refusePlatformOwner = (user) => {
  if (user.isPlatformOwner === true) {
    throw new ApiError(
      "This is the platform owner account. It cannot be modified through the platform console — demoting, suspending or deactivating it would leave the deployment with no owner, and boot/ensureSuperAdmin.js refuses to start without one.",
      403,
      "PLATFORM_OWNER_PROTECTED"
    );
  }
};

/**
 * Refuse a caller acting on themselves.
 *
 * The invariant is enforced on the *caller* as well as the target because the two
 * are the same row whenever `userId === actor._id`, and a platform owner who
 * deactivates their own account cannot undo it: they cannot sign in to reach
 * `updateUserStatusAsPlatform` to set it back to `active`. The account is the only
 * key to the room it locks.
 */
const refuseSelf = (userId, actor, what) => {
  if (!actor?._id) return;
  if (String(userId) === String(actor._id)) {
    throw new ApiError(
      `You cannot ${what} your own account from the platform console.`,
      403,
      "SELF_TARGET_FORBIDDEN"
    );
  }
};

/**
 * `GET /admin/users` — every account on the platform.
 *
 * Cross-tenant by construction: `deletedAt: null` only. `super_admin` accounts are
 * included and are exactly the rows where `schoolId` is null — the platform-staff
 * convention a dozen services branch on (`req.user.schoolId ? … : platform-wide`),
 * so filtering them out here would make the console's user list disagree with what
 * every service believes exists.
 *
 * Pagination goes through `utils/platformQuery.js` rather than arithmetic inline,
 * so the page size is bounded by `MAX_PER_PAGE` (200) instead of being whatever the
 * caller asked for, and `meta` has the one shape the console's `Pagination`
 * component expects.
 */
export const listAllUsers = async (query = {}) => {
  const { role, status, search, schoolId, sortBy = "createdAt", sortOrder = "desc" } = query;
  const { page, perPage, skip, limit } = resolvePagination(query);

  const filter = { deletedAt: null };

  if (role) filter.role = role;
  if (status) filter.status = status;
  if (schoolId) filter.schoolId = requireObjectId(schoolId, "school ID");

  if (search) {
    // Escaped rather than interpolated. The value is operator-supplied and ends up
    // inside a `$regex`, so an unescaped `(` is both a pattern error and a cheap
    // way to ask the server to run a pathological alternation over every account.
    const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { name: { $regex: safe, $options: "i" } },
      { email: { $regex: safe, $options: "i" } },
      { phone: { $regex: safe, $options: "i" } },
    ];
  }

  // Allowlisted for the same reason as the projection: sorting on an arbitrary
  // client-supplied key is an open door onto fields nobody chose to make sortable,
  // and onto a typo that silently sorts by `_id`.
  const SORTABLE = ["createdAt", "updatedAt", "name", "role", "status", "lastLoginAt"];
  const sortField = SORTABLE.includes(sortBy) ? sortBy : "createdAt";
  const sort = { [sortField]: sortOrder === "asc" ? 1 : -1 };

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select(SAFE_USER_SELECT)
      // Name only. A user's row carries a `schoolId`, and the list is
      // cross-tenant — populating the whole School document here would pull every
      // credential-bearing subdocument in the platform into a table of 200 rows.
      .populate("schoolId", "name")
      .lean(),
    User.countDocuments(filter),
  ]);

  return {
    data: users,
    meta: buildMeta({ page, perPage, total, extra: { sortBy: sortField, sortOrder: sortOrder === "asc" ? 1 : -1 } }),
  };
};

/**
 * `GET /admin/users/:id` — one account, in full.
 *
 * The "payments they created" count is a `Payment.createdBy` count, because that
 * is the column that records it and it is the only one that answers the question an
 * auditor is asking — "how much money has this bursar's login moved" — as opposed
 * to a parent's payments, which are counted per student and have no creator.
 *
 * `createdBy` is `required` on `Payment`, so the count is always a real number; a
 * `0` means the account has never recorded a payment, which is a fact about a
 * teacher and not a missing join.
 */
export const getAdminUserDetail = async (userId) => {
  const id = requireObjectId(userId, "user ID");

  const user = await User.findOne({ _id: id, deletedAt: null }).select(SAFE_USER_SELECT).lean();
  if (!user) throw new ApiError("User not found", 404, "USER_NOT_FOUND");

  const school = user.schoolId
    ? await School.findById(user.schoolId).select(SAFE_SCHOOL_SELECT).lean()
    : null;

  const [paymentsCreated, recentAudit] = await Promise.all([
    Payment.countDocuments({ createdBy: id, deletedAt: null }),
    // Filtered on `entity: 'User'` as well as `entityId`. The id space is shared
    // across every entity in the audit log, so matching the id alone would pull in
    // a school's audit entries whenever a User id and a School id collide —
    // possible, because they are separate collections with separate counters.
    AuditLog.find({ entity: "User", entityId: id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
  ]);

  return {
    user,
    school: school
      ? {
          _id: school._id,
          name: school.name,
          region: school.region,
          status: school.status,
          schoolCode: school.schoolCode,
          subscriptionStatus: school.subscription?.status ?? null,
        }
      : null,
    lastLoginAt: user.lastLoginAt ?? null,
    paymentsCreated,
    recentAudit,
  };
};

/**
 * `PUT /admin/users/:id/role` — change what an account may do.
 *
 * The most security-sensitive write in this module, and it carries four refusals in
 * a fixed order. The order is the design: the cheapest, most absolute rule is
 * checked first, so a caller cannot learn anything about the rest of the system
 * from which one trips.
 *
 *   1. **`role === 'super_admin'` → 403.** Before anything else, and before the
 *      caller's own privilege is considered. There is exactly one platform owner
 *      and it is provisioned from the environment; a role change that could
 *      produce a second one is the failure this whole rule exists to prevent. The
 *      Joi schema (`ASSIGNABLE_ROLES`) already refuses the value, so this is the
 *      second gate — and it is kept anyway because it is the one that makes the
 *      refusal legible (`PLATFORM_ROLE_NOT_GRANTABLE`) instead of a 422 naming a
 *      role the caller was never going to be allowed to set. The same shape is
 *      already in `userController.changeUserRole`, and for the same reason.
 *   2. **target `isPlatformOwner` → 403.** Demoting the owner ends the deployment's
 *      only console access.
 *   3. **caller targeting themselves → 403.** A caller who can demote themselves can
 *      lock themselves out of the endpoint that would have restored them.
 *   4. **target already holds the role → no-op, 200.** Not an error: the console's
 *      role picker submits on blur and an operator moving a slider back and forth
 *      should not collect 409s. The audit entry is skipped in that case so the log
 *      records transitions, not clicks.
 */
export const updateUserRoleAsPlatform = async (userId, role, actor) => {
  if (role === "super_admin") {
    throw new ApiError(
      "The platform admin role cannot be granted. It is assigned to a single account from the server environment.",
      403,
      "PLATFORM_ROLE_NOT_GRANTABLE"
    );
  }

  if (!GRANTABLE_ROLES.has(role)) {
    throw new ApiError(
      `Unknown role "${role}". Grantable roles are ${ASSIGNABLE_ROLES.join(", ")}.`,
      400,
      "INVALID_ROLE"
    );
  }

  const user = await findUserOrFail(userId);
  refusePlatformOwner(user);
  refuseSelf(userId, actor, "change the role of");

  const before = { role: user.role };
  if (user.role === role) {
    return { user: user.toJSON(), before, after: { role: user.role }, changed: false };
  }

  user.role = role;
  await user.save();

  return {
    user: user.toJSON(),
    before,
    after: { role: user.role },
    changed: true,
  };
};

/**
 * `PUT /admin/users/:id/status` — active, suspended or deactivated.
 *
 * `active | suspended | deactivated` rather than the model's four-value enum: the
 * fourth model status is `invited`, which is set by the invitation flow and is not
 * a state the platform should be able to put somebody into. Accepting it here
 * would let an operator manufacture an account that has never been invited and
 * cannot sign in.
 *
 * **`suspended` records the timestamp in the audit entry, not on the document.**
 * `User` has no `suspensionAt` column — its status block is `status`,
 * `isEmailVerified` and `lastLoginAt` — and one is not invented here. A suspension
 * is a decision with a date attached, and the audit log is where every other dated
 * platform decision lives; adding a column to the most-read model in the product
 * to duplicate it would create two answers to "when was this account suspended",
 * one of which nothing updates.
 *
 * **No `tokenVersion` bump is needed, and the reason is worth stating.** A
 * suspended account must stop working *immediately*, and it does:
 * `middleware/authenticate.js` re-reads the user on every authenticated request
 * and refuses anything whose `status !== 'active'`, so the next request from any
 * live token fails. `authController.refresh` refuses the same way. Bumping
 * `tokenVersion` would add a second, slower mechanism for the same guarantee —
 * and would wrongly revoke the operator's ability to act on an accidental
 * suspension until they re-signed-in.
 */
export const updateUserStatusAsPlatform = async (userId, status, actor) => {
  if (!ASSIGNABLE_STATUSES.includes(status)) {
    throw new ApiError(
      `Status must be one of ${ASSIGNABLE_STATUSES.join(", ")}.`,
      400,
      "INVALID_STATUS"
    );
  }

  const user = await findUserOrFail(userId);
  refusePlatformOwner(user);

  /*
   * Self-targeting is refused for `suspended` and `deactivated`, and allowed for
   * `active`.
   *
   * Not just `deactivated`, as a literal reading of "refuse a caller deactivating
   * themselves" would be — because `authenticate` refuses *any* status that is not
   * `active`, so a caller who suspends themselves has locked themselves out
   * exactly as thoroughly. Refusing both lock-outs is the rule that matches the
   * failure. `active` stays permitted because it is the only self-targeting write
   * that grants rather than removes access, and it is occasionally the correct
   * response to having suspended oneself from the school side.
   */
  if (status !== "active") {
    refuseSelf(userId, actor, `set your own account to ${status}`);
  }

  const before = { status: user.status };

  if (user.status === status) {
    return { user: user.toJSON(), before, after: { status: user.status }, changed: false };
  }

  const suspendedAt = status === "suspended" ? new Date() : null;

  user.status = status;
  await user.save();

  return {
    user: user.toJSON(),
    before,
    after: { status: user.status, suspendedAt },
    changed: true,
    suspendedAt,
  };
};

/**
 * `POST /admin/users/:id/reset-password` — mint a fresh reset token and mail it.
 *
 * **This reuses `POST /auth/forgot-password`'s flow exactly** — `generateResetToken`
 * → store `hashToken(token)` → `passwordResetExpiry()` → `passwordResetEmail` →
 * `sendEmail` — rather than inventing a second one. Two implementations of "email
 * someone a reset link" is two expiry policies, and the one nobody updates is the
 * one that ends up minting a link that expires in a week.
 *
 * **Sessions are deliberately *not* revoked here.** This endpoint changes no
 * credential: it mints a *link*. Revoking would lock the user out of the account
 * before they had a chance to use the link that was just emailed to them, and
 * would leave them needing this same endpoint — which needs the console — to get
 * back in. `authController.resetPassword` performs the revocation, at the moment
 * the token is actually redeemed, which is where it belongs.
 *
 * **The token is returned outside production only.** The console's value-add over
 * `forgot-password` is precisely that the operator has verified the address
 * themselves, so returning the token lets a support call be finished when the
 * mailbox is unreachable. In production the token exists only as its SHA-256 in
 * the document: `hashToken` is one-way, so an operator who could read the stored
 * value could not use it, and an operator who could read the response body would
 * not need it. A console with a token on screen is a console whose support
 * screenshots carry live credentials.
 *
 * `generateDefaultPassword` (`utils/defaultPassword.js`) is *not* used here, on
 * purpose: it would mint a second live credential for the same account, and two
 * credentials for one user means an audit trail that cannot say which one was
 * used. A default password belongs to the invitation flow
 * (`userController.inviteUser`), which sets `mustChangePassword` for exactly this
 * reason.
 */
export const resetUserPasswordAsPlatform = async (userId) => {
  const user = await findUserOrFail(userId);

  const token = generateResetToken();
  user.passwordResetToken = hashToken(token);
  user.passwordResetExpires = passwordResetExpiry();
  await user.save();

  const { subject, html, text } = passwordResetEmail({
    name: user.name,
    token,
    expiresInMinutes: PASSWORD_RESET_EXPIRE_MINUTES,
  });

  // Reported, not thrown. The account is untouched by a mail failure — no password
  // has changed and no session has been revoked — so a 500 here would tell the
  // operator the reset failed when the only thing that failed is the notification.
  // `emailSent: false` is the honest answer, and it is what the caller needs in
  // order to decide whether to retry.
  let emailSent = true;
  let emailError = null;
  try {
    await sendEmail({ to: user.email, toName: user.name, subject, html, text });
  } catch (error) {
    emailSent = false;
    emailError = error.message;
    console.error("[admin] password reset email failed:", error.message);
  }

  const isProduction = NODE_ENV === "production";

  return {
    userId: user._id,
    // Carried so the controller can attribute the audit entry to the user's school
    // without a second read. `logRequest` falls back to `req.user.schoolId`, which
    // is `null` for every platform operator — so without this, the audit would be
    // filed platform-wide and would never appear in the affected school's own log.
    schoolId: user.schoolId ?? null,
    email: user.email,
    emailSent,
    emailError,
    expiresInMinutes: PASSWORD_RESET_EXPIRE_MINUTES,
    // Omitted entirely in production — not nulled, not emptied. A key that is
    // present and null in a JSON response trains every client to read it anyway.
    ...(isProduction ? {} : { resetToken: token }),
  };
};

/**
 * `POST /admin/users/:id/resend-verification` — re-issue the email OTP.
 *
 * **Idempotent in the direction that matters: an already-verified account is a
 * success, not an error.** `authController.resendVerification` has to answer
 * neutrally because it takes an email address from an unauthenticated caller and
 * cannot confirm the account exists. This endpoint already *knows* the account —
 * it is addressed by id, behind `authorize('super_admin')` — so a 409 here would be
 * the API refusing to tell the operator something they are entitled to know, and
 * would make the console's "resend" button fail on the one account it most often
 * needs to be idempotent for. The response says plainly that nothing was sent and
 * why.
 *
 * Same OTP primitives as the auth path (`generateEmailOtp`, `hashToken`,
 * `emailOtpExpiry`, `verificationEmail`), so the two cannot drift on OTP length or
 * lifetime.
 */
export const resendUserVerificationAsPlatform = async (userId) => {
  const user = await findUserOrFail(userId);

  if (user.isEmailVerified) {
return {
    userId: user._id,
    schoolId: user.schoolId ?? null,
    email: user.email,
    alreadyVerified: true,
    emailSent: false,
    message: `${user.email} is already verified — no verification email was sent.`,
  };
}

  const otp = generateEmailOtp();
  user.emailVerificationToken = hashToken(otp);
  user.emailVerificationExpires = emailOtpExpiry();
  await user.save();

  const { subject, html, text } = verificationEmail({
    name: user.name,
    otp,
    expiresInMinutes: EMAIL_OTP_EXPIRE_MINUTES,
  });

  let emailSent = true;
  let emailError = null;
  try {
    await sendEmail({ to: user.email, toName: user.name, subject, html, text });
  } catch (error) {
    emailSent = false;
    emailError = error.message;
    console.error("[admin] verification email failed:", error.message);
  }

  const isProduction = NODE_ENV === "production";

  return {
    userId: user._id,
    schoolId: user.schoolId ?? null,
    email: user.email,
    alreadyVerified: false,
    emailSent,
    emailError,
    expiresInMinutes: EMAIL_OTP_EXPIRE_MINUTES,
    // Same rule as the reset token: the OTP is a one-shot login credential, so it
    // is only echoed outside production.
    ...(isProduction ? {} : { otp }),
  };
};