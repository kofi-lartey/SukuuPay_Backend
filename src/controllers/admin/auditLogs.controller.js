import {
  listPlatformAuditLogs,
  exportAuditLogsCsv,
  getUserAuditTrail,
  getImpersonationSessionAudit,
  getAuditLogById,
} from "../../services/admin/auditLogs.service.js";

/*
 * Thin by construction: parse nothing, decide nothing, call one service, shape the
 * response. Every filter, every rule and every write lives in
 * `services/admin/auditLogs.service.js`.
 *
 * All five sit behind `authenticate` + `authorize('super_admin')` on
 * `routes/admin.routes.js`, and that is not boilerplate here — it is the only
 * thing stopping one operator from reading another school's audit log. The
 * service itself takes no `schoolId` argument at all, so there is no narrower
 * variant of any of these to accidentally call instead.
 */

// ─────────────────────────────────────────────
// GET /admin/audit-logs/:id — one entry, with its neighbours
// ─────────────────────────────────────────────

/**
 * No audit entry. A read, and reading an audit row is the whole point of the
 * collection — auditing the auditor's own reads would fill the trail with noise
 * proportional to how diligently anybody checked anything, which is the opposite of
 * what makes a trail readable.
 */
export const getAuditLogByIdController = async (req, res) => {
  try {
    const result = await getAuditLogById(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Audit entry retrieved successfully",
      data: result.log,
      meta: {
        surrounding: result.surrounding,
        window: result.window,
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

// ─────────────────────────────────────────────
// GET /admin/audit-logs — every school's audit rows, newest first
// ─────────────────────────────────────────────
export const listPlatformAuditLogsController = async (req, res) => {
  try {
    const result = await listPlatformAuditLogs(req.query);

    return res.status(200).json({
      success: true,
      message: "Platform audit logs retrieved successfully",
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
// GET /admin/audit-logs/export — stream as CSV
// ─────────────────────────────────────────────
/*
 * The one handler here that does not answer with JSON.
 *
 * `exportAuditLogsCsv` writes the CSV directly to `res` — it takes the response
 * because building the file as a string is the buffering the stream exists to
 * avoid, and 50,000 rows held as one JS string is tens of megabytes of heap per
 * concurrent export.
 *
 * So the failure branch cannot be uniform. Once the first byte is written the
 * status line is already on the wire: the headers are final, the status is 200,
 * and the only correct response to a mid-stream failure is to end the response.
 * A `res.status(500).json(...)` there would throw `ERR_HTTP_HEADERS_SENT` — a
 * second error on top of the first, and one that hides the first.
 *
 * `res.headersSent` is the only honest test for "have we started", and checking
 * it is what keeps a database error *before* the first write a clean JSON 500.
 * This mirrors `controllers/auditLog.controller.js:66`.
 */
export const exportPlatformAuditLogsCsvController = async (req, res) => {
  try {
    await exportAuditLogsCsv(res, req.query, req.user, req);

    // No response body: the service has already ended the stream with the CSV.
    return undefined;
  } catch (error) {
    if (res.headersSent) {
      console.error("[ADMIN] Audit CSV export failed after the stream opened:", error.message);
      return res.end();
    }

    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /admin/audit-logs/user/:userId — one person's trail
// ─────────────────────────────────────────────
export const getUserAuditTrailController = async (req, res) => {
  try {
    const result = await getUserAuditTrail(req.params.userId, req.query);

    return res.status(200).json({
      success: true,
      message: "User audit trail retrieved successfully",
      // `result.user` is the resolved subject and `result.data` the rows; they are
      // separate keys rather than one merged array because a console needs the
      // subject's name to render a heading, and making it re-fetch the user is a
      // second round trip for something the endpoint already had.
      data: { user: result.user, entries: result.data },
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
// GET /admin/audit-logs/impersonation/:sessionId — one impersonation's activity
// ─────────────────────────────────────────────
export const getImpersonationSessionAuditController = async (req, res) => {
  try {
    const result = await getImpersonationSessionAudit(req.params.sessionId, req.query);

    return res.status(200).json({
      success: true,
      message: "Impersonation session audit retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};