import {
  startImpersonation,
  endImpersonation,
  listImpersonationSessions,
  getImpersonationSession,
} from "../../services/admin/impersonation.service.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import { logRequest as auditLog } from "../../utils/auditService.js";

/**
 * Impersonation endpoints.
 *
 * Four handlers, and none of them contains a business rule. The refusals (wrong
 * role, suspended school, already impersonating), the pointer writes and the
 * queries all live in `services/admin/impersonation.service.js`; what is left
 * here is the part that genuinely belongs to the transport layer, and it is the
 * same part for all four: **write the audit entry, then answer**.
 *
 * The order matters and is not stylistic. `logRequest` is awaited before the
 * response is sent so that a caller who gets a 201 can rely on the entry being
 * there. `auditService` swallows its own failures (`utils/auditService.js:46`),
 * so a duplicate-key problem or a dropped connection does not surface as a
 * failed impersonation - which is the right trade, because refusing to open a
 * door because the log was down would be a worse product than a session that
 * opened and a gap in the trail. What that trade does require is that a
 * swallowed failure be visible, which is why the enum-parity obligation in
 * `config/constants.js:46` is called out: an action present in one file and
 * absent from the other is a `ValidationError` that becomes a `console.error`
 * and no entry at all.
 */

// ─────────────────────────────────────────────
// POST /admin/impersonate/:schoolId — open a session
// ─────────────────────────────────────────────
export const startImpersonationController = async (req, res) => {
  try {
    const result = await startImpersonation(
      req.params.schoolId,
      req.body.reason,
      req.user,
      req
    );

    /*
     * Audited with the **impersonated** school, not the operator's own.
     *
     * `logRequest` defaults `schoolId` to `req.user.schoolId` (`auditService.js:57`),
     * which for a platform owner is null by design and would leave the entry
     * belonging to nobody: invisible in the operator's own log, because those
     * filter on a school, and invisible in the school's log, which is the one
     * that matters. Passing the target explicitly is the whole point of the
     * feature: a tenant can see, in the activity log their head teacher already
     * looks at, that the platform owner was inside their records at 14:02 on the
     * 9th and why. Without this line the capability is silent, and a capability
     * that is silent to the party it acts upon is not a support tool.
     *
     * `entityId` is the session, so `GET /admin/audit-logs?entityId=` and the
     * session detail screen resolve to the same row, and `meta.sessionId` is
     * repeated because it is the key `getImpersonationSession` matches the
     * actions on. `after` records the pointer transition, since "which school was
     * this operator scoped to" is a value somebody will dispute.
     */
    await auditLog(req, {
      action: AUDIT_ACTIONS.ADMIN_IMPERSONATE_START,
      entity: "ImpersonationSession",
      entityId: result.session._id,
      schoolId: result.school._id,
      meta: {
        reason: result.session.reason,
        sessionId: String(result.session._id),
        expiresInMinutes: result.expiresInMinutes,
      },
      after: {
        impersonatingSchoolId: result.school._id,
        impersonationSessionId: result.session._id,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Impersonation started. Actions are blocked until you exit.",
      data: result,
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
// POST /admin/impersonate/end — close the session
// ─────────────────────────────────────────────
export const endImpersonationController = async (req, res) => {
  try {
    /*
     * The two pointers are read off the user document *before* the service runs.
     *
     * `endImpersonation` delegates to `clearImpersonation`
     * (`middleware/impersonation.js:99`), which `$set`s
     * `impersonatingSchoolId` and `impersonationSessionId` to null in the
     * database. The in-memory `req.user` is a separate Mongoose document and is
     * not mutated by that update, so reading afterwards would usually work - and
     * "usually" is the problem. The audit entry for an end is filed against the
     * school that was impersonated, precisely so the tenant's own log records
     * that the owner left; filing it against null puts the entry in the
     * platform-wide bucket where nobody reads it, and it would be an entry that
     * exists and is useless at the exact moment it is needed. Capturing first
     * makes the correct behaviour independent of Mongoose's document semantics.
     */
    const schoolId = req.user?.impersonatingSchoolId || null;
    const sessionId = req.user?.impersonationSessionId || null;

    const result = await endImpersonation(req.user);

    /*
     * Audited only when something actually ended.
     *
     * `endImpersonation` returns `ended: false` for the not-impersonating case,
     * and that is a *successful no-op* by design (see the service). Writing an
     * `admin.impersonate_end` for it would be wrong twice: there is no end, and
     * the entry has no `entityId` to attach to. It would also be the more
     * likely of the two to be written, because "exit impersonation" is a banner
     * button that gets double-clicked.
     */
    if (result.ended) {
      await auditLog(req, {
        action: AUDIT_ACTIONS.ADMIN_IMPERSONATE_END,
        entity: "ImpersonationSession",
        entityId: sessionId,
        schoolId,
        meta: {
          sessionId: sessionId ? String(sessionId) : null,
          startedAt: result.startedAt,
          endedAt: result.endedAt,
          /*
           * `sessionsClosed` is 1 in every normal case. Anything above that
           * means more than one open row existed for this operator, which is the
           * fingerprint of a start that raced another start - so the count is
           * carried into the entry that a reviewer would actually read.
           */
          sessionsClosed: result.sessionsClosed,
        },
        before: {
          impersonatingSchoolId: schoolId,
          impersonationSessionId: sessionId,
        },
        after: {
          impersonatingSchoolId: null,
          impersonationSessionId: null,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: result.ended
        ? "Impersonation ended. Platform access restored."
        : "No impersonation was active.",
      data: result,
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
// GET /admin/impersonate/sessions — the history
// ─────────────────────────────────────────────
export const listImpersonationSessionsController = async (req, res) => {
  try {
    const result = await listImpersonationSessions(req.query);

    return res.status(200).json({
      success: true,
      message: "Impersonation sessions retrieved successfully",
      data: result.data,
      meta: result.meta,
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
// GET /admin/impersonate/sessions/:id — one session and its actions
// ─────────────────────────────────────────────
export const getImpersonationSessionController = async (req, res) => {
  try {
    const result = await getImpersonationSession(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Impersonation session retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export default {
  startImpersonationController,
  endImpersonationController,
  listImpersonationSessionsController,
  getImpersonationSessionController,
};
