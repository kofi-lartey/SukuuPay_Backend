import {
  getPlatformOverview,
  getRevenueAnalytics,
  getSchoolsAnalytics,
  getUsageAnalytics,
  getCollectionRateAnalytics,
  getGatewayMixAnalytics,
  getTopSchoolsAnalytics,
  getAtRiskSchools,
} from "../../services/admin/analytics.service.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import { logRequest as auditLog } from "../../utils/auditService.js";

/**
 * Platform-wide analytics handlers.
 *
 * Thin by rule: parse nothing, decide nothing, call one service, shape the response.
 * No `next(error)`, no throw out of a handler — Express 5 does not forward async
 * rejections, so every handler carries its own `try/catch` and every failure becomes a
 * JSON envelope rather than a hung socket.
 *
 * **Every read here is audited.** Not because the analytics endpoints change anything —
 * they do not — but because `AuditLog.js:41-45` records the reason reading a report is
 * an auditable act in its own right: "who looked at a debtors list is as much evidence
 * as who changed it". `GET /admin/analytics/at-risk-schools` and
 * `GET /admin/analytics/collection-rate` are, in substance, a debtors list across every
 * tenant, and an unaudited read of one is a read nobody can afterwards show was made.
 */

/**
 * How many rows a response actually contained.
 *
 * Analytics payloads carry their rows under different names — a `series`, a `rows`, a
 * `schools` list, a `byTerm` breakdown — and the audit entry is worth writing only if
 * `rowCount` says something. Picking the first array that is present, rather than
 * hard-coding one per endpoint, means a payload that gains a new row array is audited
 * correctly without this file being edited, and a payload that genuinely has none is
 * recorded as `0` instead of `undefined`, which would be indistinguishable from a bug.
 */
const countRows = (payload) => {
  if (!payload || typeof payload !== "object") return 0;
  for (const key of ["series", "rows", "schools", "byTerm", "topSchools", "data"]) {
    if (Array.isArray(payload[key])) return payload[key].length;
  }
  return 0;
};

/**
 * Write the `report.viewed` entry for one of these reads.
 *
 * `meta` carries the report name, the window that was asked for and the row count —
 * the three things an auditor reads later. `from`/`to` are stringified because the
 * services return `Date` objects in `period` and an audit row holding a BSON date is
 * harder to read in the log UI than an ISO string.
 *
 * **The impersonation block is the reason this helper exists as a function.** A super
 * admin reading the at-risk list while impersonating a school is the single most
 * sensitive thing this console can do, and an audit entry that recorded only the
 * operator would attribute a platform-wide debtors list to that school. See the
 * impersonation rule in the conventions and `middleware/impersonation.js`.
 *
 * Duplicated in `reports.controller.js` rather than shared, deliberately: the natural
 * home is `utils/auditService.js`, which every module in this console imports, and an
 * edit there is a merge conflict with the other console workers for the sake of six
 * lines. The cost is one function appearing twice, and it is commented in both places.
 */
const auditRead = (req, { report, payload }) =>
  auditLog(req, {
    action: AUDIT_ACTIONS.REPORT_VIEWED,
    entity: "AdminAnalytics",
    entityId: null,
    meta: {
      report,
      from: payload?.period?.from ? new Date(payload.period.from).toISOString() : null,
      to: payload?.period?.to ? new Date(payload.period.to).toISOString() : null,
      rowCount: countRows(payload),
      ...(req.impersonation
        ? {
            impersonatedBy: String(req.impersonation.superAdminId),
            impersonationSessionId: String(req.impersonation.sessionId),
          }
        : {}),
    },
  });

// GET /admin/analytics/overview
export const getPlatformOverviewController = async (req, res) => {
  try {
    const result = await getPlatformOverview();

    await auditRead(req, { report: "platform_overview", payload: result });

    return res.status(200).json({
      success: true,
      message: "Platform overview retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// GET /admin/analytics/revenue
export const getRevenueAnalyticsController = async (req, res) => {
  try {
    const { from, to, groupBy } = req.query;
    const result = await getRevenueAnalytics({ from, to, groupBy });

    await auditRead(req, { report: "revenue_analytics", payload: result });

    return res.status(200).json({
      success: true,
      message: "Platform revenue analytics retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// GET /admin/analytics/schools
export const getSchoolsAnalyticsController = async (req, res) => {
  try {
    const { from, to } = req.query;
    const result = await getSchoolsAnalytics({ from, to });

    await auditRead(req, { report: "schools_analytics", payload: result });

    return res.status(200).json({
      success: true,
      message: "School signup and activation analytics retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// GET /admin/analytics/usage
export const getUsageAnalyticsController = async (req, res) => {
  try {
    const { from, to } = req.query;
    const result = await getUsageAnalytics({ from, to });

    await auditRead(req, { report: "usage_analytics", payload: result });

    return res.status(200).json({
      success: true,
      message: "Platform usage analytics retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// GET /admin/analytics/collection-rate
export const getCollectionRateAnalyticsController = async (req, res) => {
  try {
    const { from, to } = req.query;
    const result = await getCollectionRateAnalytics({ from, to });

    await auditRead(req, { report: "collection_rate_analytics", payload: result });

    return res.status(200).json({
      success: true,
      message: "Platform collection rate retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// GET /admin/analytics/gateway-mix
export const getGatewayMixAnalyticsController = async (req, res) => {
  try {
    const { from, to } = req.query;
    const result = await getGatewayMixAnalytics({ from, to });

    await auditRead(req, { report: "gateway_mix_analytics", payload: result });

    return res.status(200).json({
      success: true,
      message: "Gateway mix retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// GET /admin/analytics/top-schools
export const getTopSchoolsAnalyticsController = async (req, res) => {
  try {
    const { metric, limit, from, to } = req.query;
    const result = await getTopSchoolsAnalytics({ metric, limit, from, to });

    await auditRead(req, { report: `top_schools_${result.metric}`, payload: result });

    return res.status(200).json({
      success: true,
      message: "Top schools retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// GET /admin/analytics/at-risk-schools
//
// The one read in this file whose contents are about individual schools' failures, and
// the one where an audit entry matters most: it names, platform-wide, which schools have
// stopped paying.
export const getAtRiskSchoolsController = async (req, res) => {
  try {
    const { limit } = req.query;
    const result = await getAtRiskSchools({ limit });

    await auditRead(req, { report: "at_risk_schools", payload: result });

    return res.status(200).json({
      success: true,
      message: "At-risk schools retrieved successfully",
      data: result,
      meta: result?.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export default {
  getPlatformOverviewController,
  getRevenueAnalyticsController,
  getSchoolsAnalyticsController,
  getUsageAnalyticsController,
  getCollectionRateAnalyticsController,
  getGatewayMixAnalyticsController,
  getTopSchoolsAnalyticsController,
  getAtRiskSchoolsController,
};
