import { User } from '../models/userModel.js';
import { ImpersonationSession } from '../models/ImpersonationSession.js';

/**
 * HTTP methods that mutate state.
 *
 * A `Set`, because the middleware asks this question once per impersonated request
 * and the answer is a membership test. `PATCH` is in here even though the console
 * does not currently use it — an allowlist of *methods* that omits a verb defers
 * the decision to whoever next adds a `PATCH` route, and they will not be looking
 * at this file.
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Writes an impersonated session is still allowed to make.
 *
 * Paths relative to the admin router, compared after the mount prefix and query
 * string are stripped.
 *
 * An allowlist rather than a denylist, and that direction is the safety property.
 * A denylist has to enumerate every dangerous endpoint, so the first endpoint added
 * after it was written is writable by default — which is how "suspend this school"
 * ends up available to somebody impersonating that school. An allowlist means a new
 * write route is refused until somebody decides it should not be.
 *
* What is on it, and why each entry is safe:
 *
 *   - **ending the impersonation.** The one write the operator must always be able
 *     to make, or a session could outlast its usefulness with no way out from
 *     inside it.
 *
 * **That is the whole list, and the smallness is deliberate.**
 *
 * The obvious next entries were `/finance/ledger/export`, `/finance/reconciliation`,
 * `/reports/export`, `/payments/export` and `/payments/stats` — all read-only. None
 * of them is needed: every one is a `GET`, and this middleware only ever blocks
 * write methods. Adding them would have been cargo cult.
 *
 * It would also have been actively dangerous, and that is the reason it is called out
 * rather than just avoided. These are matched as **prefixes** so a route with a
 * dynamic segment (`/impersonate/end/:anything`) still resolves, and a prefix entry
 * for `/health` — added on the same reasoning — also matched `/health/...`, which
 * silently swept in `POST /health/maintenance-mode`. That is the one call that takes
 * the entire platform quiet while an operator is supposedly read-only inside one
 * school. `tests/platformConsole.test.js` is what caught it; the allowlist is now
 * short enough that the mistake cannot be repeated, and if a read-only endpoint ever
 * does become a `POST`, it goes in here as an exact path with a comment naming what
 * it does.
 *
 * Everything else is refused: suspending a school, changing its markup, deleting a
 * student, approving a disbursement, refunding a payment. None of those are things a
 * platform owner may do *as* a school.
 */
export const IMPERSONATION_WRITE_ALLOWLIST = [
  // Ending the session. The only write an impersonated operator may always make.
  '/impersonate/end',
];

/**
 * Whether this request is one of the writes an impersonated operator may make.
 *
 * Normalised on three axes, all of which exist because of a way the naive comparison
 * is wrong:
 *
 *   - the query string, so `?schoolId=…` cannot change the match;
 *   - the mount prefix, so the allowlist reads as `/impersonate/end` rather than
 *     hard-coding `/api/admin/…`, which breaks the moment the router is mounted
 *     somewhere else — the routes are mounted twice in this codebase already;
 *   - a trailing-slash-insensitive prefix match, so `/impersonate/end/` is the same
 *     route and not an unlisted one.
 */
export const isWriteAllowed = (req) => {
  const fullPath = (req.originalUrl || req.url || '').split('?')[0];
  const baseUrl = req.baseUrl || '';
  const path = baseUrl && fullPath.startsWith(baseUrl)
    ? fullPath.slice(baseUrl.length)
    : fullPath;

  const normalised = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

  return IMPERSONATION_WRITE_ALLOWLIST.some(
    (allowed) => normalised === allowed || normalised.startsWith(`${allowed}/`)
  );
};

/**
 * End every open impersonation for an operator and clear the pointer.
 *
 * Shared by `POST /admin/impersonate/end` and by the stale-session recovery in the
 * middleware below, because the two must do the same thing: close the session
 * **and** clear `impersonatingSchoolId` / `impersonationSessionId`.
 *
 * The order matters and is not reversible by the caller. The session is closed
 * first, so that a crash between the two steps leaves a *closed* session with a
 * stale pointer — which the middleware detects and refuses, which is safe — rather
 * than an open session with no pointer, which no code path would ever find and which
 * would therefore silently leave the impersonation running with no record of it.
 *
 * `updateMany`, not `updateOne`: a user must never be able to hold two open
 * sessions by racing two starts, and closing every one of them is the only version
 * of this that is correct regardless of which ones exist.
 */
export const clearImpersonation = async (superAdminId) => {
  await ImpersonationSession.updateMany(
    { superAdminId, endedAt: null },
    { $set: { endedAt: new Date() } }
  );

  await User.updateOne(
    { _id: superAdminId },
    { $set: { impersonatingSchoolId: null, impersonationSessionId: null } }
  );
};

/**
 * The impersonation boundary.
 *
 * Mounted on the platform console router. It is the whole reason a platform owner
 * can look at a school's data without becoming a risk to it, and it enforces two
 * rules that would otherwise have to be repeated in every handler:
 *
 *   1. **Every write is refused** while impersonating, except the allowlist above. A
 *      super admin belongs to no school and is accountable to none of them, so
 *      anything they do under a school's banner must not look like it came from
 *      that school. Deleting a student while wearing a school's identity is not
 *      support.
 *   2. **The session is re-verified on every request**, so ending an impersonation
 *      ends it for every token already in circulation.
 *
 * Both live on the request path rather than in the controllers, because a rule
 * enforced by thirty handlers is enforced by whichever thirty handlers somebody
 * remembers to update.
 */
export const handleImpersonation = async (req, res, next) => {
  try {
    const user = req.user;

    /*
     * Not impersonating — the overwhelmingly common path, so it exits before any
     * query. A super admin's own `schoolId` is null by design, and must stay null:
     * this is a platform console, and null is what makes its reads platform-wide.
     */
    if (!user?.impersonatingSchoolId) {
      return next();
    }

    // Must be a super admin. The field can only be written by the impersonation
    // route, which sits behind `authorize("super_admin")` — but a corrupted row, or
    // a future code path that sets it on a school account, must not silently grant
    // that account a view of another tenant's data.
    if (user.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message:
          'Impersonation is a platform-owner capability and cannot be attached to this account.',
      });
    }

    /*
     * Re-read the session rather than trusting the token.
     *
     * This is the difference between an impersonation that ends and one that is
     * merely no longer being used. `POST /admin/impersonate/end` sets `endedAt`;
     * without this lookup every token already issued keeps working until it expires,
     * so "exit impersonation" would only ever affect the client that asked to exit.
     * The session is the authority on whether a door is open. The token is a claim
     * that one might be.
     */
    const session = await ImpersonationSession.findOne({
      _id: user.impersonationSessionId,
      superAdminId: user._id,
      endedAt: null,
    }).lean();

    if (!session) {
      /*
       * The session is gone but the pointer is not. Rather than fall through —
       * which would treat a stale token as a clean super admin and hand out full
       * platform access from an impersonation credential — the stale pointer is
       * cleared and the request refused. The operator signs in again and gets a real
       * token. One extra round trip, in exchange for an impersonation token never
       * being an escalation.
       */
      await clearImpersonation(user._id);

      return res.status(401).json({
        success: false,
        message:
          'This impersonation has ended. Sign in again to continue as the platform owner.',
        impersonationEnded: true,
      });
    }

    /*
     * Reads count. `actionsCount` measures attention, and a support call that only
     * looked around still opened a door and still read records. A counter that moved
     * only on writes would report `0` for a twenty-minute investigation of a
     * school's payment page — the session an auditor most wants to see.
     *
     * Fire-and-forget, and deliberately not awaited: the counter is evidence, not a
     * precondition. Losing a count is recoverable; failing the operator's request
     * because an audit increment timed out is not.
     */
    ImpersonationSession.updateOne(
      { _id: session._id },
      { $inc: { actionsCount: 1 } }
    ).catch((error) => {
      console.error('[impersonation] could not increment actionsCount:', error.message);
    });

    req.impersonation = {
      sessionId: session._id,
      schoolId: session.schoolId,
      superAdminId: session.superAdminId,
      reason: session.reason,
      startedAt: session.startedAt,
    };

    /*
     * The scope pin, for the requests that are still going through.
     *
     * `req.auth.schoolId` is what a handler reads to decide which tenant a request
     * belongs to, and it is null for every super admin — so left alone, a handler
     * that forgot to scope itself would read across the entire platform while
     * wearing one school's banner. This is defence in depth behind the per-route
     * filters, never a replacement for them: it narrows what an unscoped handler
     * *can* reach, it does not decide what it *should* reach.
     */
    req.auth.impersonatedSchoolId = String(session.schoolId);

    if (WRITE_METHODS.has(req.method) && !isWriteAllowed(req)) {
      return res.status(403).json({
        success: false,
        message:
          'Actions are blocked during impersonation. Exit impersonation to make changes.',
        code: 'IMPERSONATION_READ_ONLY',
        impersonation: {
          schoolId: session.schoolId,
          reason: session.reason,
          startedAt: session.startedAt,
        },
      });
    }

    return next();
  } catch (error) {
    // An impersonation whose state cannot be established is refused, not allowed.
    // Failing open here would mean a database blip silently removes the read-only
    // boundary for the duration — which is the exact opposite of what this
    // middleware is for.
    console.error('[impersonation] middleware failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Impersonation state could not be verified.',
    });
  }
};

export default handleImpersonation;