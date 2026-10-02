import {
  getAdminSchoolDetail,
  createSchoolAsPlatform,
  updateSchoolAsPlatform,
  updateSchoolMarkup,
  updateSchoolPlatformFee,
  updateSchoolGatewayMode,
  updateSchoolSubscription,
  updateSchoolFeatureFlags,
  updateSchoolTags,
  updateSchoolInternalNotes,
  archiveSchool,
} from "../../services/admin/schools.service.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import { logRequest as auditLog } from "../../utils/auditService.js";

/*
 * Platform-owner controllers for a single school.
 *
 * Shape is fixed by the conventions: try/catch, one service call, `return res…`,
 * never `next(error)`, never a throw out of the handler. Express 5 does not
 * forward a rejected promise, so a handler without its own catch turns every
 * failure inside it into a request that hangs until the client times out — which is
 * strictly worse than a 500, because the client cannot tell the difference between
 * "the server is broken" and "the write is still running".
 *
 * **Auditing lives here, not in the service.** Two reasons, both load-bearing:
 *
 *   - `logRequest(req, …)` fills `userId`, `ip` and `userAgent` from the request.
 *     A service has no request, so a service-side audit entry is a write with no
 *     author and no origin — which is precisely the gap `admin.school_update` and
 *     its siblings were added to close.
 *   - the services here return `{ before, after }` but never call `logRequest`
 *     themselves, which keeps them callable from a script without manufacturing a
 *     fake request object to audit through.
 *
 * `before`/`after` are passed **twice** on purpose. `AuditLog` has `before` and
 * `after` columns, but `utils/auditService.log` destructures a fixed key list and
 * does not forward them into `AuditLog.create` — so a top-level pair is currently
 * discarded and the entry would record only *that* a rate changed, which is the
 * failure the convention is written against. They are therefore carried in `meta`
 * as well, where they are actually stored. The top-level pair is kept so the entry
 * is correct by shape the moment `log` forwards them, and so a future reader
 * looking at `AuditLog` finds the pair where the schema says it is.
 */

/** `schoolId` for the audit entry, so the school's own activity log records it. */
const auditTarget = (schoolId) => ({ entity: "School", entityId: schoolId, schoolId });

// ─────────────────────────────────────────────
// GET /admin/schools/:id — full school detail
// ─────────────────────────────────────────────
export const getAdminSchoolDetailController = async (req, res) => {
  try {
    const result = await getAdminSchoolDetail(req.params.id);

    return res.status(200).json({
      success: true,
      message: "School retrieved successfully",
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
// POST /admin/schools — create a school by hand
// ─────────────────────────────────────────────
export const createSchoolAsPlatformController = async (req, res) => {
  try {
    const { school } = await createSchoolAsPlatform(req.body, req.user);

    await auditLog(req, {
      ...auditTarget(school._id),
      action: AUDIT_ACTIONS.ADMIN_SCHOOL_CREATE,
      after: {
        name: school.name,
        schoolCode: school.schoolCode,
        slug: school.slug,
        email: school.email,
        region: school.region,
        type: school.type,
        status: school.status,
        subscription: {
          plan: school.subscription?.plan,
          status: school.subscription?.status,
          trialEndsAt: school.subscription?.trialEndsAt,
          monthlyFee: school.subscription?.monthlyFee,
        },
        platformMarkupPercent: school.payment?.platformMarkupPercent,
      },
      meta: {
        after: {
          name: school.name,
          schoolCode: school.schoolCode,
          region: school.region,
          subscriptionStatus: school.subscription?.status,
        },
      },
    });

    return res.status(201).json({
      success: true,
      message: "School created successfully",
      data: school,
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
// PUT /admin/schools/:id — edit platform-owned fields
// ─────────────────────────────────────────────
export const updateSchoolAsPlatformController = async (req, res) => {
  try {
    const { before, after } = await updateSchoolAsPlatform(req.params.id, req.body, req.user);

    await auditLog(req, {
      ...auditTarget(req.params.id),
      action: AUDIT_ACTIONS.ADMIN_SCHOOL_UPDATE,
      before,
      after,
      meta: { before, after },
    });

    return res.status(200).json({
      success: true,
      message: "School updated successfully",
      data: after,
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
// PUT /admin/schools/:id/markup — platform cut per payment
// ─────────────────────────────────────────────
export const updateSchoolMarkupController = async (req, res) => {
  try {
    const { before, after, warnings } = await updateSchoolMarkup(
      req.params.id,
      req.body?.platformMarkupPercent
    );

    await auditLog(req, {
      ...auditTarget(req.params.id),
      action: AUDIT_ACTIONS.ADMIN_MARKUP_UPDATE,
      before,
      after,
      // The in-flight count goes in the audit entry, not just the response. "The
      // rate changed" is not the question an auditor asks months later — "what did
      // the operator know about the money in flight when they changed it" is, and
      // the answer is only here if it was recorded at the time.
      meta: {
        before,
        after,
        warnings,
        inFlightPaymentCount: warnings?.[0]?.inFlightPaymentCount ?? null,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Platform markup updated successfully",
      data: after,
      warnings: warnings || [],
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
// PUT /admin/schools/:id/platform-fee
// ─────────────────────────────────────────────
export const updateSchoolPlatformFeeController = async (req, res) => {
  try {
    const { before, after } = await updateSchoolPlatformFee(
      req.params.id,
      req.body?.platformFeePercent
    );

    await auditLog(req, {
      ...auditTarget(req.params.id),
      action: AUDIT_ACTIONS.ADMIN_PLATFORM_FEE_UPDATE,
      before,
      after,
      meta: { before, after },
    });

    return res.status(200).json({
      success: true,
      message: "Platform fee updated successfully",
      data: after,
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
// PUT /admin/schools/:id/gateway-mode
// ─────────────────────────────────────────────
export const updateSchoolGatewayModeController = async (req, res) => {
  try {
    const { before, after, changed } = await updateSchoolGatewayMode(
      req.params.id,
      req.body?.gatewayMode
    );

    if (changed !== false) {
      await auditLog(req, {
        ...auditTarget(req.params.id),
        action: AUDIT_ACTIONS.ADMIN_GATEWAY_MODE_UPDATE,
        before,
        after,
        meta: { before, after },
      });
    }

    return res.status(200).json({
      success: true,
      message: changed
        ? "Payment gateway mode updated successfully"
        : "The school is already on that gateway mode",
      data: after,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
      // The blocking batches travel with the 409. An operator told only "settle or
      // cancel them first" has to go and find them; told which ones, they can go
      // straight to the finance screen and approve or cancel.
      ...(error.code === "OPEN_DISBURSEMENTS_BLOCK_GATEWAY_CHANGE"
        ? { batches: error.meta?.batches || [] }
        : {}),
    });
  }
};

// ─────────────────────────────────────────────
// PUT /admin/schools/:id/subscription
// ─────────────────────────────────────────────
export const updateSchoolSubscriptionController = async (req, res) => {
  try {
    const { before, after } = await updateSchoolSubscription(req.params.id, req.body);

    await auditLog(req, {
      ...auditTarget(req.params.id),
      action: AUDIT_ACTIONS.ADMIN_SUBSCRIPTION_UPDATE,
      before,
      after,
      meta: { before, after },
    });

    return res.status(200).json({
      success: true,
      message: "Subscription updated successfully",
      data: after,
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
// PUT /admin/schools/:id/feature-flags
// ─────────────────────────────────────────────
export const updateSchoolFeatureFlagsController = async (req, res) => {
  try {
    const { before, after } = await updateSchoolFeatureFlags(req.params.id, req.body);

    await auditLog(req, {
      ...auditTarget(req.params.id),
      action: AUDIT_ACTIONS.ADMIN_FEATURE_FLAGS_UPDATE,
      before,
      after,
      meta: { before, after },
    });

    return res.status(200).json({
      success: true,
      message: "Feature flags updated successfully",
      data: after,
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
// PUT /admin/schools/:id/tags
// ─────────────────────────────────────────────
export const updateSchoolTagsController = async (req, res) => {
  try {
    const { before, after } = await updateSchoolTags(req.params.id, req.body?.tags);

    await auditLog(req, {
      ...auditTarget(req.params.id),
      action: AUDIT_ACTIONS.ADMIN_TAGS_UPDATE,
      before,
      after,
      meta: { before, after },
    });

    return res.status(200).json({
      success: true,
      message: "Tags updated successfully",
      data: after,
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
// PUT /admin/schools/:id/notes
// ─────────────────────────────────────────────
export const updateSchoolInternalNotesController = async (req, res) => {
  try {
    const { before, after } = await updateSchoolInternalNotes(
      req.params.id,
      req.body?.internalNotes
    );

    await auditLog(req, {
      ...auditTarget(req.params.id),
      action: AUDIT_ACTIONS.ADMIN_NOTES_UPDATE,
      before,
      after,
      meta: { before, after },
    });

    return res.status(200).json({
      success: true,
      message: "Internal notes updated successfully",
      data: after,
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
// PUT /admin/schools/:id/archive — soft delete, school row only
// ─────────────────────────────────────────────
export const archiveSchoolAsPlatformController = async (req, res) => {
  try {
    const { before, after, untouched } = await archiveSchool(req.params.id, req.user);

    await auditLog(req, {
      ...auditTarget(req.params.id),
      action: AUDIT_ACTIONS.ADMIN_SCHOOL_ARCHIVE,
      before,
      after,
      // `untouched` is recorded because "what did archiving break" is the question
      // an operator asks immediately afterwards, and the honest answer is recorded
      // at write time rather than reconstructed from what a later query returns.
      meta: { before, after, untouched },
    });

    return res.status(200).json({
      success: true,
      message:
        "School archived. Its users, payments, disbursements and ledger entries were left untouched.",
      data: after,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};