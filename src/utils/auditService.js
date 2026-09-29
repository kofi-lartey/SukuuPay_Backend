import { AuditLog } from "../models/AuditLog.js";

/**
 * Audit logging service.
 *
 * In the existing codebase every service file declared a local stub that
 * merely `console.log`ged.  Now that the `AuditLog` model exists this service
 * writes every entry to the database so the Audit Log module (module 13) has
 * a single source of truth.
 *
 * It is intentionally fire-and-forget: a failed audit write must never block
 * the business operation that triggered it.
 */
export const log = async ({
  action,
  entity,
  entityId,
  userId,
  schoolId,
  meta,
  ip,
  userAgent,
  req,
}) => {
  try {
    // Accept either an explicit `req` or individual context fields.  This keeps
    // the call-site simple for webhook-driven flows (e.g. Hubtel callbacks)
    // that have no request object.
    if (req && !ip) {
      ip = req.ip || req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || null;
    }
    if (req && !userAgent) {
      userAgent = req.headers?.["user-agent"] || null;
    }

    await AuditLog.create({
      action,
      entity,
      entityId: entityId || null,
      userId: userId || null,
      schoolId: schoolId || null,
      meta,
      ip,
      userAgent,
    });
  } catch (error) {
    // Audit writes must never break the primary operation.
    console.error("[AUDIT] Failed to write audit log:", error.message);
  }
};

// Convenience: attach `req` automatically when called from a controller.
export const logRequest = (req, payload) =>
  log({
    ...payload,
    userId: payload.userId || req.user?._id,
    schoolId: payload.schoolId || req.user?.schoolId,
    req,
  });

export default { log, logRequest };
