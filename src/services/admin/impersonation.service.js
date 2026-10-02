import { School } from "../../models/schoolModel.js";
import { User } from "../../models/userModel.js";
import { AuditLog } from "../../models/AuditLog.js";
import { ImpersonationSession } from "../../models/ImpersonationSession.js";
import { clearImpersonation } from "../../middleware/impersonation.js";
import ApiError from "../../utils/ApiError.js";
import {
  signImpersonationToken,
  IMPERSONATION_TOKEN_EXPIRE_MINUTES,
} from "../../utils/tokens.js";
import {
  resolvePagination,
  buildMeta,
  optionalId,
} from "../../utils/platformQuery.js";

/**
 * Impersonation: the platform owner opening one school's console.
 *
 * The two functions that change anything (`startImpersonation` /
 * `endImpersonation`) and the two that only read (`listImpersonationSessions` /
 * `getImpersonationSession`) live together because they share one invariant that
 * is easy to break if they are split: **a session row and the pointer on `User`
 * are two records of the same fact, and the row is the authority.** The request
 * path (`middleware/impersonation.js`) re-reads the open row on every request
 * and ignores both the token's claims and anything a handler put on `req`. So
 * every write here lands on the row first and the pointer second, and any code
 * that tries to "repair" one without the other is producing the exact state the
 * middleware's stale-pointer branch exists to clean up.
 *
 * What is deliberately *not* reimplemented here: the read-only boundary, the
 * per-request session re-verification, the `actionsCount` increment. Those live
 * in `middleware/impersonation.js` and are enforced on the request path rather
 * than in these four functions, because a rule enforced by four service
 * functions is enforced by whichever four somebody remembers to call.
 */

/**
 * How many audit rows `getImpersonationSession` will return.
 *
 * A session cannot produce an unbounded number of entries in practice: reads
 * bump `actionsCount` but only *writes* audit, and writes are refused while
 * impersonating (see `IMPERSONATION_WRITE_ALLOWLIST`). So this cap is about the
 * response size a long read-only investigation can reach, not about a flood. It
 * is a cap rather than a page because the caller is not browsing: they are
 * reading one session's history at once. `actionsTotal` is counted separately so
 * a truncated list admits that it is truncated instead of looking complete.
 */
const MAX_SESSION_ACTIONS = 500;

/**
 * Strip `__v` from a `.lean()` result.
 *
 * `ImpersonationSession.js:150` installs a `toJSON` transform that removes it,
 * but `.lean()` bypasses transforms entirely and hands the raw BSON back. The
 * field is version bookkeeping, it means nothing to a client, and leaving it in a
 * payload is the first step towards a client trying to write one back.
 */
const withoutVersion = (doc) => {
  if (!doc) return doc;
  const { __v, ...rest } = doc;
  return rest;
};

// ──────────────────── Start ────────────────────

/**
 * Open a session and mint the token that acts inside it.
 *
 * The order below is a sequence of refusals before a single write, and each one
 * is a state the owner can be in right now rather than a hypothetical: wrong
 * role, a school that no longer exists as far as the console is concerned, a
 * school that is suspended, an operator already inside somebody else's console.
 * All four are refused before anything is created, so a failed start leaves no
 * debris to clean up.
 */
export const startImpersonation = async (schoolId, reason, actor, req) => {
  /*
   * Not "the router already checked this".
   *
   * `authorize("super_admin")` sits on the admin router, so every route in this
   * file is behind the same check today. It is repeated because the cost of the
   * check being wrong is not a rejected request: it is `School.findById` and
   * then `User.findByIdAndUpdate` writing `impersonatingSchoolId` onto an
   * account that belongs to a tenant, which is precisely the state
   * `impersonation.js:147` refuses on the *next* request, having already handed
   * out a token in the interim. Cheap assertion, expensive alternative.
   */
  if (actor?.role !== "super_admin") {
    throw new ApiError(
      "Only a platform owner can impersonate a school.",
      403,
      "IMPERSONATION_NOT_PERMITTED"
    );
  }

  /*
   * The target has to be a real, live tenant.
   *
   * `optionalId` throws a 400 on a malformed id rather than letting it reach
   * Mongoose, where `findById` with garbage produces a `CastError` and a 500
   * (the same guard `platformQuery.js:80` applies to the console's other
   * filters). `deletedAt: null` excludes archived schools: the console can still
   * *read* an archived school's history, but impersonating it would produce a
   * console that behaves like a live one for a tenant that no longer has one,
   * and every read inside it would be a fact about the past presented as the
   * present.
   */
  const targetId = optionalId(schoolId, "school ID");

  if (!targetId) {
    throw new ApiError("School not found", 404, "SCHOOL_NOT_FOUND");
  }

  const school = await School.findById(targetId)
    .select("name region status deletedAt")
    .lean();

  if (!school || school.deletedAt) {
    throw new ApiError("School not found", 404, "SCHOOL_NOT_FOUND");
  }

  /*
   * A suspended school cannot be impersonated.
   *
   * Suspension is the console's answer to "this tenant must not transact", and
   * impersonation would hand back a console that can: the impersonation token
   * carries `role: "super_admin"`, and the read-only boundary in
   * `impersonation.js` refuses writes made *as* the school but says nothing
   * about a platform-level read that bypasses the tenant's own gating. So the
   * case that looks useful here, "let me see what the suspended school sees", is
   * not reproducible by this route, and pretending otherwise produces a session
   * whose reads no ordinary login can corroborate.
   *
   * The real case, "fix the suspended school", is not an impersonation at all:
   * the owner has `PUT /admin/schools/:id/unsuspend`, and that is the button
   * that belongs on this screen.
   */
  if (school.status === "suspended") {
    throw new ApiError(
      "This school is suspended and cannot be impersonated. Unsuspend it first if you need to investigate it as a live tenant.",
      409,
      "SCHOOL_SUSPENDED"
    );
  }

  /*
   * One open session per operator, and the refusal is a 409 rather than "end the
   * previous one and start a new one".
   *
   * Silently closing the previous session is the version that looks kinder: the
   * operator clicks a second school and it just works. It is wrong for two
   * reasons that only surface later. The token the *previous* client is holding
   * stops being an impersonation the instant `endedAt` is set, so another tab
   * drops out of its school's scope with nothing to indicate that anything
   * happened; and the operator is now inside school B having never been told
   * they left school A, which is the state in which somebody believes they are
   * reading one school's records while the banner says another.
   *
   * A 409 is the better failure. It is loud, it names the state, and it leaves
   * the existing session exactly as trustworthy as it already was.
   */
  if (actor.impersonatingSchoolId) {
    throw new ApiError(
      "You are already impersonating a school. End the current impersonation before starting another.",
      409,
      "ALREADY_IMPERSONATING"
    );
  }

  /*
   * The session row is created before the pointer is written, never after.
   *
   * The reverse order leaves a window in which `User.impersonatingSchoolId`
   * points at a session that does not exist yet. `impersonation.js:165` looks
   * the open session up on every request and, not finding one, treats the token
   * as a stale credential: it clears the pointer and answers 401 "sign in
   * again". So a request landing in that window kills the impersonation the
   * operator is about to be told they have just started, and the message they
   * get is about re-authenticating rather than about what went wrong.
   */
  const session = await ImpersonationSession.create({
    superAdminId: actor._id,
    schoolId: targetId,
    reason,
    ipAddress: req?.ip || req?.headers?.["x-forwarded-for"] || null,
    userAgent: req?.headers?.["user-agent"] || null,
  });

  /*
   * The pointer is written with `findByIdAndUpdate`, not with `actor.save()`.
   *
   * `req.user` is a Mongoose document that `authenticate` loaded at the top of
   * this request (`middleware/authenticate.js:19`). Between that load and this
   * write, anything else that updated the user row has already changed the
   * database without changing this in-memory copy, and the likeliest candidate
   * is mundane: a concurrent sign-in calls `issueSession`, which writes
   * `refreshToken` and `refreshTokenExpires` and then `user.save()`s
   * (`utils/tokens.js:134`). An `actor.save()` here would write this document's
   * entire state, so that refresh token, written a moment ago, is reverted and
   * the next refresh fails for a reason that has nothing to do with
   * impersonation.
   *
   * `findByIdAndUpdate` writes only the two fields this function owns, so the
   * two writes compose instead of overwriting one another.
   */
  let updated;

  try {
    /*
     * `impersonatingSchoolId: null` in the *filter* is a lock, not a condition.
     *
     * The `actor.impersonatingSchoolId` check above is the readable 409; this is
     * the one that is actually true. Two starts issued in the same second both
     * read that field as null and both create a session, and a plain
     * `findByIdAndUpdate` would then let the second silently overwrite the
     * first pointer, leaving two open rows behind one pointer: one of the two
     * impersonations is then invisible to `impersonation.js` and cannot be
     * stopped by ending anything. Making the pointer the thing being
     * conditionally updated turns this into a compare-and-set, so the loser
     * matches no document, gets `null` back, and is refused.
     *
     * `null` rather than `$exists: false` is the right predicate because
     * Mongoose declares the field `default: null` (`userModel.js:87`): it is
     * present on every document this model writes, so the two are equivalent
     * today, and `null` stays correct if an older row without the field is ever
     * read.
     */
    updated = await User.findByIdAndUpdate(
      { _id: actor._id, impersonatingSchoolId: null },
      {
        $set: {
          impersonatingSchoolId: targetId,
          impersonationSessionId: session._id,
        },
      },
      { new: true, runValidators: true }
    );
  } catch (error) {
    /*
     * The pointer write failed, so the row created above is an open session that
     * nothing points at and no middleware will ever find: the only place the
     * middleware looks is `User.impersonationSessionId`, which was never set.
     * Left alone it shows up in `GET /admin/impersonate/sessions` as an
     * `endedAt: null` session that has been open since the incident and was
     * never used: a phantom in the operator's own history, in the one list an
     * auditor reads. Close it before rethrowing, and swallow a failure to close
     * rather than masking the original error with a second one.
     */
    await ImpersonationSession.updateOne(
      { _id: session._id, endedAt: null },
      { $set: { endedAt: new Date() } }
    ).catch((closeError) => {
      console.error(
        "[impersonation] could not close an orphaned session:",
        closeError.message
      );
    });

    throw error;
  }

  if (!updated) {
    /*
     * The lock matched nothing, so another start took the pointer between the
     * read above and this write. The row this call created goes with it, for the
     * same reason the catch block above does it.
     */
    await ImpersonationSession.updateOne(
      { _id: session._id, endedAt: null },
      { $set: { endedAt: new Date() } }
    );

    throw new ApiError(
      "You are already impersonating a school. End the current impersonation before starting another.",
      409,
      "ALREADY_IMPERSONATING"
    );
  }

  /*
   * The token is minted last, from the *live* user document.
   *
   * `signImpersonationToken` reads `tokenVersion` (`utils/tokens.js:92`), and the
   * check that consumes it runs in `authenticate` on every request. Signing from
   * the pre-write `actor` would not be wrong on its own, since the update above
   * does not touch `tokenVersion`, but `updated` is the document as it exists
   * after this write and a token that describes the current state cannot be
   * stale. If a concurrent sign-in bumps `tokenVersion` between the two, the
   * freshly minted token is the one that gets rejected and the operator has to
   * start again; the alternative is a credential that is born invalid and
   * nothing that can say why.
   */
  const token = signImpersonationToken(updated, targetId, session._id);

  return {
    token,

    /*
     * The client needs to know when the credential it is about to hold stops
     * working, because the banner it renders has to be able to say so. The value
     * is imported from `utils/tokens.js` rather than written as `60` here, and
     * that is not tidiness: this constant *is* the security property described
     * at `tokens.js:24`, a hard ceiling deliberately not equal to `JWT_EXPIRE`.
     * A second copy of the number in a response builder is how a client ends up
     * telling an operator "signed in for 24 hours" during an impersonation that
     * dies in sixty.
     */
    expiresInMinutes: IMPERSONATION_TOKEN_EXPIRE_MINUTES,
    session: withoutVersion(session.toObject()),
    school: {
      _id: school._id,
      name: school.name,
      region: school.region,
    },
  };
};

// ──────────────────── End ────────────────────

/**
 * Close the operator's open session and clear the pointer.
 *
 * The writes themselves are `clearImpersonation`'s
 * (`middleware/impersonation.js:99`), reused rather than reimplemented so this
 * endpoint and the middleware's stale-session recovery cannot drift apart: both
 * have to close the session *and* null the pointer, in that order, and a second
 * copy of those three lines is a second thing to forget.
 */
export const endImpersonation = async (actor) => {
  /*
   * Not impersonating is a success, not a 404.
   *
   * The button this backs is the "exit impersonation" banner, and the banner is
   * rendered from state the client can be out of date about: the session may
   * have been closed by the middleware's stale-pointer branch, by another tab,
   * or by an operator who already pressed it. A 404 in any of those cases puts
   * an error on a screen for a state the user cannot see and cannot cause, and
   * it teaches the frontend to suppress errors on the one button that has to
   * work.
   *
   * `ended: false` states what actually happened, so the caller can render
   * "you are not impersonating" without having to tell the two apart.
   */
  if (!actor?.impersonatingSchoolId) {
    return {
      ended: false,
      endedAt: null,
      sessionId: null,
      startedAt: null,
      sessionsClosed: 0,
    };
  }

  /*
   * Read the open session(s) before closing them.
   *
   * Two reasons, and the second is the one that matters. First,
   * `clearImpersonation` closes with its own `new Date()` internally, so
   * reporting `new Date()` from here would report a timestamp that was never
   * stored; and that timestamp is what a session's duration is computed from,
   * so a gap between the duration in the console and the duration on the row is
   * exactly the kind of detail that gets an otherwise legitimate investigation
   * questioned. Second, `startedAt` is what makes the end entry worth anything:
   * "ended after four minutes" and "ended after six hours" are different facts,
   * and only the first is available if it was not read before the row closed.
   */
  const open = await ImpersonationSession.find({
    superAdminId: actor._id,
    endedAt: null,
  })
    .sort({ startedAt: -1 })
    .select("_id startedAt")
    .lean();

  const current = open[0] || null;

  await clearImpersonation(actor._id);

  /*
   * `clearImpersonation` is an `updateMany` on purpose (`impersonation.js:97`),
   * so `open.length` is normally 1 and occasionally more: the two-starts race
   * that the pointer lock above makes very unlikely, or a row left behind on a
   * deployment that ran before that lock existed. Reporting the count is how
   * either gets noticed.
   */
  const closed = current
    ? await ImpersonationSession.findById(current._id).select("endedAt").lean()
    : null;

  return {
    ended: true,
    endedAt: closed?.endedAt || new Date(),
    sessionId: current?._id || null,
    startedAt: current?.startedAt || null,
    sessionsClosed: open.length,
  };
};

// ──────────────────── Read ────────────────────

/**
 * The impersonation history, newest first.
 *
 * **Platform-only, and only by virtue of the router.** `admin.routes.js:42`
 * carries `authorize("super_admin")` for the whole mount, and that is the only
 * thing keeping this off a school admin's screen. There is deliberately no
 * `requester` parameter and no narrowing on `req.user.schoolId`, because the
 * school-scoped version of this query, "has anyone been inside my records", is a
 * real question a school will eventually ask and is *not* answered by this
 * function: narrowing it here would be right for that case and wrong for this
 * one, and they are different functions. If a route outside the super admin
 * mount ever needs it, it needs its own.
 */
export const listImpersonationSessions = async ({
  schoolId,
  superAdminId,
  page,
  perPage,
} = {}) => {
  const filter = {};

  /*
   * `optionalId` returns `null` for absent and throws for malformed, and the
   * distinction is what keeps an unfiltered call meaning platform-wide. A filter
   * key explicitly set to `null` is *kept* in the query document and means "is
   * null", so assigning unconditionally would turn "no school filter" into
   * "schools whose id is null", which is no rows at all and reads as a platform
   * with no impersonation history.
   */
  const school = optionalId(schoolId, "school ID");
  if (school) filter.schoolId = school;

  const admin = optionalId(superAdminId, "super admin ID");
  if (admin) filter.superAdminId = admin;

  const { page: safePage, perPage: safePerPage, skip, limit } = resolvePagination({
    page,
    perPage,
  });

  const [sessions, total] = await Promise.all([
    ImpersonationSession.find(filter)
      /*
       * `superAdminId` is populated as `name email` only. The owner's `password`
       * is `select: false` (`userModel.js:40`) so it cannot arrive through any
       * populate, and neither can `refreshToken` or `passwordResetToken`: the
       * same model-level exclusion the console relies on everywhere else. The
       * field list is explicit rather than a whole-document populate so that a
       * field added to `User` later is not published onto every session row by
       * default.
       *
       * A deleted operator or school populates as `null` rather than dropping
       * the row. That is the correct outcome: the session outlives the account
       * on purpose (`ImpersonationSession.js:34`), and a history that silently
       * omitted the entries nobody can attribute would be worse than one with a
       * blank name.
       */
      .populate("superAdminId", "name email")
      .populate("schoolId", "name schoolCode region")
      /*
       * `startedAt`, not `createdAt`. They are the same value today and they stop
       * being the same value the moment a session is ever imported or backfilled
       * - and for this list they are not interchangeable anyway, because the
       * question being asked is when the door opened. It is also the order the
       * two compound indexes at `ImpersonationSession.js:135` and `:136` exist to
       * serve.
       */
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ImpersonationSession.countDocuments(filter),
  ]);

  return {
    data: sessions.map(withoutVersion),
    meta: buildMeta({ page: safePage, perPage: safePerPage, total }),
  };
};

/**
 * One session, plus everything that was done while it was open.
 *
 * The actions are `AuditLog` rows matched on `meta.impersonationSessionId` -
 * and **that is why `meta` on the audit entry is load-bearing and must not be
 * stripped.** `ImpersonationSession` records that a door opened, who opened it,
 * from where, and roughly how much they looked around (`actionsCount`). It does
 * not record *what* they looked at, and `actionsCount` is a number that cannot
 * be interrogated: "47" says an operator paid attention, and says nothing about
 * whether they were reading the arrears ledger or a student's home address. The
 * `meta` field is the only place the per-request attribution is written, and
 * this query is the only place it can be assembled back into a story.
 *
 * So the chain is: `impersonation.js:207` puts the session on the request, the
 * console's audit convention (build conventions section 5) copies it onto the
 * entry as `meta.impersonationSessionId`, and this function reads it back. A
 * change that "tidies up" `meta` - dropping unknown keys, renaming the field, or
 * storing an ObjectId instead of the string the convention specifies - does not
 * fail loudly. It returns an empty `actions` array, which is indistinguishable
 * from a session in which nothing happened.
 */
export const getImpersonationSession = async (sessionId) => {
  const id = optionalId(sessionId, "impersonation session ID");

  if (!id) {
    throw new ApiError("Impersonation session not found", 404, "SESSION_NOT_FOUND");
  }

  const session = await ImpersonationSession.findById(id)
    .populate("superAdminId", "name email")
    .populate("schoolId", "name schoolCode region status")
    .lean();

  if (!session) {
    throw new ApiError("Impersonation session not found", 404, "SESSION_NOT_FOUND");
  }

  /*
   * The id is matched as a **string**, and it has to be.
   *
   * `meta` is `Schema.Types.Mixed`, so nothing coerces what is written into it:
   * the console convention writes `String(req.impersonation.sessionId)` and that
   * string is what is in the database. Querying
   * `"meta.impersonationSessionId": session._id` with an ObjectId neither throws
   * nor matches, because BSON compares a binary ObjectId against a stored UTF-8
   * string, both sides are well-formed, and the result is an empty list. An
   * audit view that silently shows no actions is a worse failure than one that
   * errors, so the `.toString()` below is load-bearing rather than cosmetic.
   *
   * `userId` is not populated: every one of these rows was written by the same
   * operator, whose name and email are already on the session above, and a
   * populate per row would buy nothing.
   */
  const actionFilter = { "meta.impersonationSessionId": id.toString() };

  const [actions, actionsTotal] = await Promise.all([
    AuditLog.find(actionFilter)
      .sort({ createdAt: -1 })
      .limit(MAX_SESSION_ACTIONS)
      .lean(),
    AuditLog.countDocuments(actionFilter),
  ]);

  return {
    session: withoutVersion(session),
    actions,
    /*
     * The count, because a capped list that does not admit it was capped reads as
     * complete. `actionsTruncated` is what tells a reader "there are more of
     * these than you are looking at" instead of letting 500 rows of a longer
     * history be mistaken for the whole session.
     */
    actionsTotal,
    actionsTruncated: actionsTotal > actions.length,
  };
};

export default {
  startImpersonation,
  endImpersonation,
  listImpersonationSessions,
  getImpersonationSession,
};
