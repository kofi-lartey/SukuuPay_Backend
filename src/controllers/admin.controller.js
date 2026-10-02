import {
  listAllSchools,
  getPlatformRevenue,
  getPlatformSmsBalance,
  getSchoolUsage,
  suspendSchoolPlatform,
  unsuspendSchoolPlatform,
  getDashboardKpis,
  getRevenueSeries,
getPlatformSettings,
  updatePlatformSettings,
  updateCommission,
  updateDisbursementSettings,
} from "../services/admin.service.js";
import { AUDIT_ACTIONS } from "../config/constants.js";
import { logRequest as auditLog } from "../utils/auditService.js";

// ─────────────────────────────────────────────
// GET /admin/schools — list all schools on platform
// ─────────────────────────────────────────────
export const listAllSchoolsController = async (req, res) => {
  try {
    const result = await listAllSchools(req.query);

    return res.status(200).json({
      success: true,
      message: "Schools retrieved successfully",
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
// GET /admin/revenue — platform-wide revenue
// ─────────────────────────────────────────────
export const getPlatformRevenueController = async (req, res) => {
  try {
    const result = await getPlatformRevenue(req.query);

    return res.status(200).json({
      success: true,
      message: "Platform revenue retrieved successfully",
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
// GET /admin/sms-balance — master SMS balance
// ─────────────────────────────────────────────
export const getPlatformSmsBalanceController = async (req, res) => {
  try {
    const result = await getPlatformSmsBalance();

    return res.status(200).json({
      success: true,
      message: "SMS balance retrieved successfully",
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
// GET /admin/schools/:id/usage — school usage stats
// ─────────────────────────────────────────────
export const getSchoolUsageController = async (req, res) => {
  try {
    const result = await getSchoolUsage(req.params.id);

    return res.status(200).json({
      success: true,
      message: "School usage stats retrieved successfully",
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
// PUT /admin/schools/:id/suspend — suspend school
// ─────────────────────────────────────────────
export const suspendSchoolPlatformController = async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "Suspension reason is required",
      });
    }

    const school = await suspendSchoolPlatform(req.params.id, reason, req.user);

    return res.status(200).json({
      success: true,
      message: "School suspended successfully",
      data: school,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// PUT /admin/schools/:id/unsuspend — unsuspend school
// ─────────────────────────────────────────────
export const unsuspendSchoolPlatformController = async (req, res) => {
  try {
    const school = await unsuspendSchoolPlatform(req.params.id, req.user);

    return res.status(200).json({
      success: true,
      message: "School unsuspended successfully",
      data: school,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /admin/dashboard — super admin KPIs
// ─────────────────────────────────────────────
export const getDashboardKpisController = async (req, res) => {
  try {
    const result = await getDashboardKpis();

    return res.status(200).json({
      success: true,
      message: "Dashboard KPIs retrieved successfully",
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
// GET /admin/revenue/series — platform revenue over time
// ─────────────────────────────────────────────
export const getRevenueSeriesController = async (req, res) => {
  try {
    const result = await getRevenueSeries(req.query);

    return res.status(200).json({
      success: true,
      message: "Platform revenue series retrieved successfully",
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
// GET /admin/settings — platform configuration
// ─────────────────────────────────────────────
export const getPlatformSettingsController = async (req, res) => {
  try {
    const result = await getPlatformSettings();

    return res.status(200).json({
      success: true,
      message: "Platform settings retrieved successfully",
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
// PUT /admin/settings — change platform configuration
// ─────────────────────────────────────────────
export const updatePlatformSettingsController = async (req, res) => {
  try {
    const { before, after, changed } = await updatePlatformSettings(
      req.body,
      req.user?._id
    );

    /*
     * Audited, with the leaf paths that actually changed.
     *
     * A platform setting is the kind of change that gets disputed weeks later —
     * "who set the markup to 12?" — and `settings.update` already existed in the
     * action enum with nothing calling it, so this is the endpoint it was reserved
     * for. `changed` is a flat list of `features.trialDays`-style paths with both
     * sides of each, because an entry that records *that* something changed but not
     * what is not an answer to the question.
     *
     * Only written when something did. A client that PUTs an unchanged document on
     * every page load would otherwise fill the log with noise and make the one entry
     * that matters harder to find.
     */
    if (changed.length) {
      await auditLog(req, {
        action: AUDIT_ACTIONS.SETTINGS_UPDATE,
        entity: "PlatformSettings",
        entityId: after?._id || null,
        meta: { changed },
      });
    }

    return res.status(200).json({
      success: true,
      message: changed.length
        ? "Platform settings updated successfully"
        : "No changes to save",
      data: { ...after, changed },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * `PUT /admin/settings/commission` � the two percentages SukuuPay takes.
 *
 * Its own endpoint, and its own confirmation on the console side, because "save
 * settings" and "change what we earn" are different decisions. Both required by the
 * schema, so unlike the general settings write this can never be a partial patch �
 * which is what makes it safe to audit unconditionally rather than only when
 * `changed.length` is non-zero.
 *
 * Audited as `settings.update` with the leaf paths, the same action the general
 * endpoint uses: the *thing* that changed is a platform setting, and having two
 * actions for it would split the history of every dispute about a school's markup
 * across two filters for no benefit. The `meta.resource` field is what distinguishes
 * the two entries after the fact.
 */
export const updateCommissionController = async (req, res) => {
  try {
    const { before, after, changed } = await updateCommission(req.body, req.user?._id);

    if (changed.length) {
      await auditLog(req, {
        action: AUDIT_ACTIONS.SETTINGS_UPDATE,
        entity: "PlatformSettings",
        entityId: after?._id || null,
        meta: { resource: "commission", changed },
      });
    }

    return res.status(200).json({
      success: true,
      message: changed.length
        ? "Commission updated successfully"
        : "No changes to save",
      data: { ...after, changed },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * `PUT /admin/settings/disbursement` � payout schedule, and whether it self-approves.
 *
 * Partial, so a client changing only the frequency does not reset `autoApprove` to
 * whatever a stale form held. The `changed` list therefore names the field that
 * actually moved � which for this endpoint is very often `disbursement.autoApprove`,
 * and that entry is the record that the platform stopped waiting for a human.
 *
 * The `autoApprove` flag is also called out in `meta` as a boolean rather than left
 * to be inferred from the diff, because "did the platform start approving its own
 * payouts" is a question worth being able to ask of the log directly.
 */
export const updateDisbursementSettingsController = async (req, res) => {
  try {
    const { before, after, changed } = await updateDisbursementSettings(
      req.body,
      req.user?._id
    );

    if (changed.length) {
      await auditLog(req, {
        action: AUDIT_ACTIONS.SETTINGS_UPDATE,
        entity: "PlatformSettings",
        entityId: after?._id || null,
        meta: {
          resource: "disbursement",
          changed,
          autoApprove: after?.disbursement?.autoApprove ?? null,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: changed.length
        ? "Disbursement settings updated successfully"
        : "No changes to save",
      data: { ...after, changed },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};
