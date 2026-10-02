import {
  getPlatformRevenueReport,
  getSchoolPerformanceReport,
  getGrowthReport,
  getChurnReport,
  exportReport,
  ADMIN_REPORT_TYPES,
} from "../../services/admin/reports.service.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import { logRequest as auditLog } from "../../utils/auditService.js";

/**
 * Platform report handlers — the owner's four reports and their export.
 *
 * The four GETs are built by one factory rather than written out four times. That is not
 * DRY for its own sake: each of them differs only in which builder runs and what the
 * success message says, and four hand-written handlers is four chances for one of them
 * to forget the audit entry. The factory makes "did you audit it" a question with one
 * answer rather than four.
 *
 * **The export is audited with `ADMIN_EXPORT`, not `REPORT_VIEWED`.** Both are true of
 * a download, and both are written. `report.viewed` records the read;
 * `admin.export` records the file leaving, which `AuditLog.js:78-79` calls out as the
 * one read a school cannot audit itself — the file carries a tenant's whole financial
 * history and is afterwards on somebody's laptop, outside every control the platform
 * has. One entry saying "the owner viewed a report" would leave the more important
 * event unrecorded.
 */

/**
 * Write the two audit entries a download produces.
 *
 * Called **after** `exportReport` has already ended the response — `streamCsv` calls
 * `res.end()` and `sendReportFile` calls `res.send()`. That ordering is deliberate and is
 * the opposite of the conventions' write-path rule: an audit failure must never be the
 * reason an operator's download fails, and `utils/auditService.log` is itself
 * fire-and-forget with its errors swallowed to a `console.error`. Auditing before the
 * write would mean a slow audit entry delays a file somebody is waiting on during a
 * board meeting, for no gain in evidence — the evidence is identical either way.
 */
const auditExport = (req, { type, from, to, format, rowCount, truncated }) =>
  auditLog(req, {
    action: AUDIT_ACTIONS.ADMIN_EXPORT,
    entity: "AdminReport",
    entityId: null,
    meta: {
      report: type,
      format,
      from: from ? new Date(from).toISOString() : null,
      to: to ? new Date(to).toISOString() : null,
      rowCount,
      truncated: Boolean(truncated),
      // Recorded because it is the question an auditor asks first about any export, and
      // because the answer is not otherwise recoverable from the file itself.
      scope: "platform",
      ...(req.impersonation
        ? {
            impersonatedBy: String(req.impersonation.superAdminId),
            impersonationSessionId: String(req.impersonation.sessionId),
          }
        : {}),
    },
  });

/** Row count of a report payload: the largest row array any of its sections carries. */
const sectionRowCount = (payload) =>
  (payload?.sections || []).reduce((max, section) => {
    const count = Array.isArray(section?.rows) ? section.rows.length : 0;
    return count > max ? count : max;
  }, 0);

/**
 * One report GET.
 *
 * `sections` rides along in the JSON response as well as feeding the file renderer. It
 * has to: it is the same rows the download would contain, so a client that renders the
 * file's tables on screen is showing exactly what the operator would download, rather
 * than a parallel set of numbers computed for display.
 */
const makeReportController = (build, reportName) => async (req, res) => {
  try {
    const { from, to } = req.query;
    const result = await build({ from, to });

    await auditLog(req, {
      action: AUDIT_ACTIONS.REPORT_VIEWED,
      entity: "AdminReport",
      entityId: null,
      meta: {
        report: reportName,
        from: result?.filters?.from
          ? new Date(result.filters.from).toISOString()
          : null,
        to: result?.filters?.to ? new Date(result.filters.to).toISOString() : null,
        rowCount: sectionRowCount(result),
        ...(req.impersonation
          ? {
              impersonatedBy: String(req.impersonation.superAdminId),
              impersonationSessionId: String(req.impersonation.sessionId),
            }
          : {}),
      },
    });

    return res.status(200).json({
      success: true,
      message: `${reportName} report retrieved successfully`,
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// GET /admin/reports/platform-revenue
export const getPlatformRevenueReportController = makeReportController(
  getPlatformRevenueReport,
  "platform_revenue"
);

// GET /admin/reports/school-performance
export const getSchoolPerformanceReportController = makeReportController(
  getSchoolPerformanceReport,
  "school_performance"
);

// GET /admin/reports/growth
export const getGrowthReportController = makeReportController(getGrowthReport, "growth");

// GET /admin/reports/churn
export const getChurnReportController = makeReportController(getChurnReport, "churn");

/**
 * GET /admin/reports/export?type=&format=
 *
 * The only handler here that does not return JSON on success, and that is inherent to
 * what it is: the response *is* the file. `exportReport` writes it and returns the row
 * count so the audit entry can say how much left the platform.
 *
* `sendReportFile` throws a plain `Error` carrying `.status` for an unsupported
  * format, so the catch below turns it into a proper JSON envelope with the right
  * status rather than a 500. That matters: "that format is unavailable" and "the
  * report service crashed" are different answers to a client, and only one of them is
  * actionable.
  *
  * There used to be a second branch here that turned a 501 for `pdf` into the same
  * envelope. **There is no longer a 501**: PDF is supported, via
  * `utils/reportPdf.js`. The `catch` is kept and still matters — an unsupported
  * format, or a serialiser that fails on a malformed payload, still needs the right
  * status rather than a 500.
  */
export const exportReportController = async (req, res) => {
  try {
    const { type, from, to, format } = req.query;

    const result = await exportReport(res, { type, from, to, format });

    await auditExport(req, { type, from, to, format, ...result });

    return undefined;
  } catch (error) {
    /*
     * `headersSent` guard, and it matters more here than on any other handler in the
     * console. This is the one endpoint whose success path *is* the response: `streamCsv`
     * calls `res.end()` and `sendReportFile` calls `res.send()`. Anything that throws
     * after the first byte is out — a summary reduce over a malformed payload, a
     * serialiser that fails midway — and answering with `res.status().json()` then is
     * an `ERR_HTTP_HEADERS_SENT` that replaces a working download with a truncated one
     * and a 500 the client cannot read. So once the file has started, the failure is
     * recorded and the connection is left to close on its own terms.
     */
    if (res.headersSent) {
      // eslint-disable-next-line no-console
      console.error(
        `[admin/reports/export] ${type} failed after the response started:`,
        error.message
      );
      return res.end();
    }

    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

export { ADMIN_REPORT_TYPES };

export default {
  getPlatformRevenueReportController,
  getSchoolPerformanceReportController,
  getGrowthReportController,
  getChurnReportController,
  exportReportController,
};
