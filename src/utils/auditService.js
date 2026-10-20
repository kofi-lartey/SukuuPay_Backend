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
  before,
  after,
  meta,
  ip,
  userAgent,
  req,
}) => {
  try {
    // Accept either an explicit `req` or individual context fields.  This keeps
    // the call-site simple for webhook-driven flows (e.g. Moolre callbacks)
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
      // `before` and `after` are the point of the trail, and they used to be
      // missing from this destructure — so a caller passing them had them
      // dropped on the floor and the entry recorded only that *something*
      // happened. "Who changed this, and from what to what" is the entire
      // question an audit exists to answer; an entry that records only the fact
      // of the change cannot answer it, and there is no second place the values
      // were kept.
      before: before ?? undefined,
      after: after ?? undefined,
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
    /*
     * `schoolId` falls back to the *actor's* school, which is null for a
     * super_admin — so a platform action on a tenant carried no school at all and
     * was therefore absent from that school's own activity log. For the platform
     * console that is the whole point: the owner changing a school's markup must
     * appear in the school's log, and the schools that receive these payloads all
     * pass `schoolId` explicitly for exactly that reason. The fallback remains so
     * every existing school-scoped call site keeps working unchanged.
     */
    schoolId: payload.schoolId || req.user?.schoolId,
    req,
  });

export default { log, logRequest };
