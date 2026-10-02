import {
  listAllUsers,
  getAdminUserDetail,
  updateUserRoleAsPlatform,
  updateUserStatusAsPlatform,
  resetUserPasswordAsPlatform,
  resendUserVerificationAsPlatform,
} from "../../services/admin/users.service.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import { logRequest as auditLog } from "../../utils/auditService.js";

/*
 * Platform-owner controllers for a single user.
 *
 * Same fixed shape as the other admin controllers: try/catch, one service call,
 * `return res…`, never `next(error)`, never a throw out of the handler.
 *
 * The audit entries here carry `schoolId: user.schoolId` explicitly. `logRequest`
 * would otherwise fall back to `req.user?.schoolId`, which is `null` for every
 * platform operator by design — so without the explicit value, every one of these
 * actions would land in the platform-wide log and **none of them would appear in
 * the affected school's own activity log**. That log is the record a school has of
 * who could see its data, and a platform owner's role change or suspension of a
 * bursar is exactly the kind of thing it exists to show.
 */

/** `schoolId` for the audit entry, so the school's own activity log records it. */
const auditTarget = (user) => ({ entity: "User", entityId: user?._id, schoolId: user?.schoolId ?? null });

// ─────────────────────────────────────────────
// GET /admin/users — every account on the platform
// ─────────────────────────────────────────────
export const listAllUsersController = async (req, res) => {
  try {
    const result = await listAllUsers(req.query);

    return res.status(200).json({
      success: true,
      message: "Users retrieved successfully",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /admin/users/:id — one account in full
// ─────────────────────────────────────────────
export const getAdminUserDetailController = async (req, res) => {
  try {
    const result = await getAdminUserDetail(req.params.id);

    return res.status(200).json({
      success: true,
      message: "User retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// PUT /admin/users/:id/role
// ─────────────────────────────────────────────
export const updateUserRoleAsPlatformController = async (req, res) => {
  try {
    const result = await updateUserRoleAsPlatform(req.params.id, req.body?.role, req.user);

    // Only real transitions are logged. A console role picker that submits on blur
    // produces a no-op write every time an operator opens and closes the dropdown,
    // and a log full of `accountant → accountant` entries is how the one genuine
    // demotion becomes the thing you have to find.
    if (result.changed) {
      await auditLog(req, {
        ...auditTarget(result.user),
        action: AUDIT_ACTIONS.USER_ROLE_CHANGE,
        // `user.role_change` rather than an `admin.*` key: this is the same
        // transition `userController.changeUserRole` records, and a school's
        // activity log that listed it under two different actions would need two
        // filters to answer "who changed this person's role".
        before: result.before,
        after: result.after,
        meta: {
          before: result.before,
          after: result.after,
          // `assignedByPlatformOwner: true` is what distinguishes this route from
          // the school's own role change — same action, different actor, and the
          // question a school is really asking about an unexpected promotion is
          // whether the *platform* did it.
          assignedByPlatformOwner: true,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: result.changed
        ? `Role updated to ${result.after.role}`
        : "That user already holds this role",
      data: result.after,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ─────────────────────────────────────────────
// PUT /admin/users/:id/status
// ─────────────────────────────────────────────
export const updateUserStatusAsPlatformController = async (req, res) => {
  try {
    const result = await updateUserStatusAsPlatform(req.params.id, req.body?.status, req.user);

    if (result.changed) {
      await auditLog(req, {
        ...auditTarget(result.user),
        action: AUDIT_ACTIONS.ADMIN_USER_STATUS_UPDATE,
        before: result.before,
        after: result.after,
        meta: {
          before: result.before,
          after: result.after,
          // `User` has no `suspensionAt` column, so the date lives here. See the
          // service for why it was not invented as a field.
          suspendedAt: result.suspendedAt ?? null,
          setByPlatformOwner: true,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: result.changed
        ? `Account status updated to ${result.after.status}`
        : "That account already has this status",
      data: result.after,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ─────────────────────────────────────────────
// POST /admin/users/:id/reset-password
// ─────────────────────────────────────────────
export const resetUserPasswordAsPlatformController = async (req, res) => {
  try {
    const result = await resetUserPasswordAsPlatform(req.params.id);

    // Audited on **both** outcomes. A mint that produced no email is a credential
    // that exists and was never communicated — the user cannot use it and nobody
    // knows why — and that is precisely the gap an audit trail exists to surface.
    // An `emailSent: false` recorded at the time is the whole difference between
    // "we emailed them and it bounced" and a support thread that starts with "we
    // never got anything".
    await auditLog(req, {
      ...auditTarget(result),
      action: AUDIT_ACTIONS.ADMIN_USER_PASSWORD_RESET,
      meta: {
        email: result.email,
        emailSent: result.emailSent,
        expiresInMinutes: result.expiresInMinutes,
        ...(result.emailError ? { failureReason: result.emailError } : {}),
        // Deliberately absent: the token itself. It is a live credential for the
        // next `PASSWORD_RESET_EXPIRE_MINUTES`, and an audit log is the one place
        // in this product that is read by more people than wrote to it.
        tokenReturned: Boolean(result.resetToken),
      },
    });

    return res.status(200).json({
      success: true,
      message: result.emailSent
        ? `Password reset link sent to ${result.email}`
        : `The reset link was created but the email to ${result.email} could not be sent.`,
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ─────────────────────────────────────────────
// POST /admin/users/:id/resend-verification
// ─────────────────────────────────────────────
export const resendUserVerificationAsPlatformController = async (req, res) => {
  try {
    const result = await resendUserVerificationAsPlatform(req.params.id);

    /*
     * `schoolId` comes back on the service result rather than from a second query.
     *
     * `logRequest`'s fallback is `req.user.schoolId`, which is `null` for every
     * platform operator, so an entry filed without the explicit value would be
     * platform-wide and a school's own activity log would never show the platform
     * re-sending its bursar's verification code. The service already holds the
     * document in both branches — including the already-verified one, which looks
     * like it does no read at all but does, at the top of the function — so it is
     * the right place to carry the id.
     */
    await auditLog(req, {
      ...auditTarget(result),
      action: AUDIT_ACTIONS.ADMIN_USER_VERIFICATION_RESEND,
      meta: {
        email: result.email,
        alreadyVerified: result.alreadyVerified,
        emailSent: result.emailSent,
        ...(result.emailError ? { failureReason: result.emailError } : {}),
        // Never the OTP. Same reason as the reset token above: it is a live login
        // credential, and the audit log has a wider readership than the console.
        otpReturned: Boolean(result.otp),
      },
    });

    return res.status(200).json({
      success: true,
      message: result.message
        ? result.message
        : result.emailSent
        ? `A new verification code was sent to ${result.email}`
        : `A code was created but the email to ${result.email} could not be sent.`,
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};