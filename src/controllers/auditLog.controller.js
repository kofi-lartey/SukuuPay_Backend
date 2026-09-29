import { listAuditLogs, exportAuditLogs, getUserAuditLogs } from "../services/auditLog.service.js";
import { streamCsv } from "../utils/csvWriter.js";

// ── LIST / FILTER AUDIT LOGS (paginated) ──
// GET /audit-logs/:schoolId
export const getAuditLogsController = async (req, res) => {
  try {
    const result = await listAuditLogs(req.params.schoolId, req.query, req.user);

    return res.status(200).json({
      success: true,
      message: "Audit logs retrieved successfully",
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

// ── EXPORT FULL AUDIT LOG AS CSV ──
// GET /audit-logs/:schoolId/export
// Streams a CSV file directly to the response.  No pagination — every matching
// row is written, capped at 50,000 by the service layer.
export const exportAuditLogsController = async (req, res) => {
  try {
    const result = await exportAuditLogs(req.params.schoolId, req.query, req.user);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-log-${result.schoolSlug}-${new Date()
        .toISOString()
        .slice(0, 10)}.csv"`
    );

    const columns = [
      { key: "createdAt", header: "Timestamp" },
      { key: "userName", header: "User Name" },
      { key: "userEmail", header: "User Email" },
      { key: "action", header: "Action" },
      { key: "entity", header: "Entity" },
      { key: "entityId", header: "Entity ID" },
      { key: "ip", header: "IP Address" },
      { key: "description", header: "Description" },
    ];

    // Flatten populated user fields into display columns.
    const rows = result.logs.map((log) => ({
      createdAt: log.createdAt?.toISOString?.() || log.createdAt,
      userName: log.userId?.name || "System",
      userEmail: log.userId?.email || "",
      action: log.action,
      entity: log.entity,
      entityId: log.entityId || "",
      ip: log.ip || "",
      description: log.meta?.description || JSON.stringify(log.meta || {}),
    }));

    streamCsv(res, columns, rows);
  } catch (error) {
    // If headers were already sent, we cannot switch to a JSON error response.
    if (!res.headersSent) {
      return res.status(error.status || 500).json({
        success: false,
        message: error.message,
      });
    }
    res.end();
  }
};

// ── GET ACTIVITY FOR A SPECIFIC USER ──
// GET /audit-logs/user/:userId
// The school is derived from req.user (school admins are scoped to their
// school; super admins can query any user's activity).
export const getUserAuditLogsController = async (req, res) => {
  try {
    const result = await getUserAuditLogs(
      req.params.userId,
      req.query,
      req.user
    );

    return res.status(200).json({
      success: true,
      message: "User audit logs retrieved successfully",
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
