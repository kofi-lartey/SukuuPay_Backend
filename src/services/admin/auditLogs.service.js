import { AuditLog } from "../../models/AuditLog.js";
import { User } from "../../models/userModel.js";
import { ImpersonationSession } from "../../models/ImpersonationSession.js";
import { streamCsv } from "../../utils/csvWriter.js";
import { log as writeAudit } from "../../utils/auditService.js";
import ApiError from "../../utils/ApiError.js";
import {
  resolvePagination,
  buildMeta,
  resolveDateRange,
  optionalId,
} from "../../utils/platformQuery.js";
import { AUDIT_ACTIONS, LIMITS } from "../../config/constants.js";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PLATFORM-WIDE AUDIT LOG
 *
 * This is the only read path in the entire product where one person can see
 * entries belonging to more than one school.
 *
 * That is why it sits behind `authorize('super_admin')` on the console router and
 * why every function here takes no tenant argument at all. The scoping is not a
 * filter that a future caller could forget to pass — there is nothing to pass.
 * `services/auditLog.service.js` is the school-scoped module and takes a
 * `schoolId` because its callers include a `school_admin`; this one does not take
 * one because the person who may call it belongs to no school
 * (`User.schoolId` is null for a super admin by design, per
 * `middleware/impersonation.js:139-146` — that nullness is exactly what makes
 * these reads platform-wide).
 *
 * The cost of that design is that an accidental filter omission here is a
 * cross-tenant data leak rather than a missing row, so every filter below is
 * built by one shared helper and no query is hand-assembled at a call site.
 */

// ──────────────────── Shared filter construction ────────────────────

/**
 * Turn a validated query into one Mongo filter over `AuditLog`.
 *
 * One helper for the list, the export and the user trail, because three
 * hand-assembled copies of "schoolId, userId, action, entity, from, to" is three
 * places for the next filter to be added to two of them — and the copy that
 * misses it is the export, which is the one nobody diffs.
 *
 * `resolveDateRange` widens `to` to the end of its day, so `?from=2026-03-01
 * &to=2026-03-01` is the whole of the first of March. That is not a nicety:
 * `auditLog.service.js:49` does the same widening by hand for the school-scoped
 * module, and a `$lte` on the bare date drops everything after midnight and makes
 * a day look emptier than it is.
 */
const buildFilter = (query = {}) => {
  const filter = {};

  // `optionalId` throws a 400 ApiError on a malformed id, which is why these are
  // not `isValid` checks at the call sites: a hand-rolled check either throws a
  // bare `Error` (a 500 with a mangled message) or silently drops the filter.
  const schoolId = optionalId(query.schoolId, "school ID");
  if (schoolId) filter.schoolId = schoolId;

  const userId = optionalId(query.userId, "user ID");
  if (userId) filter.userId = userId;

  const entityId = optionalId(query.entityId, "entity ID");
  if (entityId) filter.entityId = entityId;

  if (query.action) filter.action = query.action;

  /*
   * `entity` is free text and matched exactly, not by prefix.
   *
   * Exact, because the values are model names (`"User"`, `"Payment"`,
   * `"PlatformSettings"`, `"DisbursementBatch"`) written by hand at each call
   * site. A prefix match would silently widen `entity=User` into
   * `UserImpersonation` and `UserSettings` if anybody ever added one, and the
   * result — a longer list than the operator filtered for — reads as correct.
   */
  if (query.entity) filter.entity = query.entity;

  Object.assign(filter, resolveDateRange(query.from, query.to, "createdAt"));

  return filter;
};

/**
 * Who did it, and whose school.
 *
 * Both references are populated with named projections rather than
 * `.populate("userId")`, because the default is the entire document: that pulls
 * `password`, `passwordResetToken`, `emailVerificationToken` and `refreshToken`
 * (all `select: false` on `userModel.js`, which `.populate` does **not** honour —
 * it is not a projection, it is a separate query with its own select) into a
 * response that is then serialised to the browser. Naming the three fields the
 * console actually renders makes that impossible to do by accident, which is why
 * it is spelled out on every populate in this file rather than factored away.
 *
 * `schoolId` on an audit row is nullable by design (`AuditLog.js:114-124`): a
 * platform-wide action belongs to no school, and populating `null` yields `null`.
 * That is the correct render — "platform" — and not something to filter away.
 */
const withActors = (query) =>
  query
    .populate("userId", "name email role")
    .populate("schoolId", "name schoolCode");

/**
 * A stable sort key for every read here.
 *
 * `{ createdAt: -1 }` alone is not deterministic: two entries written inside the
 * same millisecond can come back in either order, so paging through a busy
 * minute can show the same row twice and skip another. `AuditLog._id` is
 * monotonic within a process and breaks the tie deterministically. The cost is
 * that `{ action, createdAt }` (the index in `AuditLog.js:167`) is no longer
 * perfectly matched, because the sort now has a second key — accepted, and it is
 * still a covered prefix, so the index still serves the filter and the createdAt
 * ordering.
 */
const NEWEST_FIRST = { createdAt: -1, _id: -1 };

// ──────────────────── List ────────────────────

/**
 * `GET /admin/audit-logs` — every school's audit rows in one query.
 *
 * Not paginated by school: this is a single chronological stream across all of
 * them, because the question it answers is temporal ("what happened to the
 * platform between 14:00 and 15:00") and slicing it per school would answer a
 * different question that nobody asked. `schoolId` narrows it when the operator
 * does know the tenant.
 */
export const listPlatformAuditLogs = async (query = {}) => {
  const filter = buildFilter(query);
  const { page, perPage, skip, limit } = resolvePagination(query);

  const [logs, total] = await Promise.all([
    withActors(AuditLog.find(filter))
      .sort(NEWEST_FIRST)
      .skip(skip)
      .limit(limit)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  return {
    data: logs,
    meta: buildMeta({ page, perPage, total, extra: { filters: describeFilters(query) } }),
  };
};

/**
 * `GET /admin/audit-logs/:id` — one entry in full.
 *
 * **A real read, not a client-side scan.** The detail screen was initially built to
 * fetch the newest 200 rows and pick the matching one out, which works for a
 * click-through from the list and fails silently for everything else: an entry older
 * than the 200 most recent is not found, and "not found" for a row the operator can
 * see in the list is an answer that looks like deletion. A 404 from this endpoint is
 * true; a scan that misses is a lie.
 *
 * `withActors` populates the same `name email role` / `name schoolCode` fields as
 * every other read here, because a detail view showing a bare ObjectId where the
 * list showed a name would be a downgrade on exactly the screen where the reader is
 * looking hardest.
 *
 * Returns `404` rather than `null` for a missing id: an audit entry that does not
 * exist is a different fact from one that exists but has no actor, and the console's
 * convention throughout is that absence is stated rather than rendered blank.
 */
export const getAuditLogById = async (auditLogId) => {
  const id = optionalId(auditLogId, "audit log ID");

  const log = await withActors(AuditLog.findById(id)).lean();

  if (!log) {
    throw new ApiError("Audit entry not found", 404, "AUDIT_LOG_NOT_FOUND");
  }

  /*
   * The sibling entries, so the detail screen can answer "what else happened around
   * the same time" without a second round trip. Deliberately a window rather than a
   * pagination cursor: an operator reading one entry wants the seconds either side
   * of it, and `±5` at this table's volume is a handful of rows rather than a page.
   */
  const windowStart = new Date(log.createdAt.getTime() - 5_000);
  const windowEnd = new Date(log.createdAt.getTime() + 5_000);

  const surrounding = await withActors(
    AuditLog.find({
      createdAt: { $gte: windowStart, $lte: windowEnd },
      _id: { $ne: log._id },
    })
  )
    .sort(NEWEST_FIRST)
    .limit(20)
    .lean();

  return { log, surrounding, window: { from: windowStart, to: windowEnd } };
};

/** The filter echo, so a paginated response says which page of what it is. */
const describeFilters = (query = {}) => ({
  schoolId: query.schoolId || null,
  userId: query.userId || null,
  action: query.action || null,
  entity: query.entity || null,
  from: query.from || null,
  to: query.to || null,
});

// ──────────────────── CSV export ────────────────────

/**
 * The CSV columns.
 *
 * School name and code are here, and not only the id, because the whole reason
 * the platform export exists is that a reader cannot otherwise tell which of two
 * schools a row belongs to — `entityId` is an ObjectId and means nothing to
 * anybody outside the database. `description` renders `meta` rather than a
 * hand-picked subset, so a before/after diff or an impersonation attribution that
 * nobody thought to add a column for is still in the file.
 */
const EXPORT_COLUMNS = [
  { key: "createdAt", header: "Timestamp" },
  { key: "action", header: "Action" },
  { key: "entity", header: "Entity" },
  { key: "entityId", header: "Entity ID" },
  { key: "schoolName", header: "School" },
  { key: "schoolCode", header: "School Code" },
  { key: "userName", header: "User Name" },
  { key: "userEmail", header: "User Email" },
  { key: "ip", header: "IP Address" },
  { key: "userAgent", header: "User Agent" },
  { key: "description", header: "Description" },
];

/**
 * `GET /admin/audit-logs/export` — stream the platform audit log as CSV.
 *
 * Streams rather than buffering the whole result into a string. That is the point
 * of `streamCsv`: the cap below is 50,000 rows, which as one accumulated string
 * is tens of megabytes of transient heap per concurrent export, and this is the
 * one endpoint where an operator will sensibly ask for "everything, unfiltered"
 * more than once.
 *
 * The cap is `LIMITS.AUDIT_LOG_CSV_CAP` and it is `LIMITS`-owned rather than
 * written here, because the school-scoped export has the same ceiling
 * (`auditLog.service.js:118`) and two hand-copied numbers is two numbers that
 * drift. It is a **`.limit()`**, not a truncation of a larger read — the query
 * stops there — so the file is a prefix of the stream in newest-first order and
 * the response says so rather than letting an operator believe 50,000 rows is
 * the whole history.
 *
 * `@param res` is passed in and written to here, not returned as a string. The
 * alternative — building a string and handing it to the controller — is the
 * buffering this function exists to avoid. The cost is that once the first byte
 * is written the response can no longer become a JSON error, so the controller
 * guards on `res.headersSent`. That guard belongs to the controller because it is
 * a statement about HTTP, not about audit logs.
 *
 * @param {import('express').Response} res
 * @param {object} query validated query
 * @param {object} [actor] the acting user, for the audit entry
 * @param {object} [req] the request, for `logRequest` attribution
 * @returns {{ filename: string, rowCount: number, cap: number, capped: boolean }}
 */
export const exportAuditLogsCsv = async (res, query = {}, actor = null, req = null) => {
  const filter = buildFilter(query);

  /*
   * Read the count first, so `capped` is a fact rather than an inference.
   *
   * Two options were rejected. Inferring it from `rows.length === cap` reports a
   * full export of exactly 50,000 rows as truncated, which tells an operator to
   * go looking for a pagination bug that does not exist. Dropping the field
   * entirely means the console cannot warn at all. One extra `countDocuments` on
   * an export that is already a full table scan is the cheapest honest option.
   */
  const total = await AuditLog.countDocuments(filter);
  const cap = LIMITS.AUDIT_LOG_CSV_CAP;

  const logs = await withActors(AuditLog.find(filter))
    .sort(NEWEST_FIRST)
    .limit(cap)
    .lean();

  const rows = logs.map((log) => ({
    createdAt: log.createdAt?.toISOString?.() || log.createdAt || "",
    action: log.action || "",
    entity: log.entity || "",
    entityId: log.entityId ? String(log.entityId) : "",
    // A platform action has `schoolId: null` and renders as "Platform" rather
    // than blank: a blank school column on a platform-wide export reads as a
    // data-quality bug in the row, and it is not.
    schoolName: log.schoolId?.name || "Platform",
    schoolCode: log.schoolId?.schoolCode || "",
    userName: log.userId?.name || "System",
    userEmail: log.userId?.email || "",
    ip: log.ip || "",
    userAgent: log.userAgent || "",
    description: log.meta?.description || JSON.stringify(log.meta || {}),
  }));

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `platform-audit-log-${stamp}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // The cap, as a header. A client that checks the row count can find out whether
  // it got the whole series without counting rows.
  res.setHeader("X-Export-Cap", String(cap));
  if (total > cap) res.setHeader("X-Export-Truncated", "true");

  streamCsv(res, EXPORT_COLUMNS, rows);

  /*
   * Audited, after the bytes are written.
   *
   * `admin.export` rather than nothing: an export is the one read a tenant cannot
   * audit itself. `auditLog.service.js`'s school-scoped export writes no entry at
   * all, which for a *school's own* data is defensible — the school's own log
   * will show the rows it read — but this file is every school's data leaving the
   * platform in one file, downloaded by one person. If it is ever copied to a
   * support ticket or a spreadsheet on a laptop, the audit entry is the only
   * record that it happened at all.
   *
   * `before`/`after` are deliberately absent. There is no state change to dispute
   * here — what changed is the contents of a file the operator now holds, which is
   * what `filters` and `rowCount` record.
   */
  await writeAudit({
    action: AUDIT_ACTIONS.ADMIN_EXPORT,
    entity: "AuditLog",
    entityId: null,
    userId: actor?._id || null,
    // Null, deliberately. The export spans schools, so attaching it to one would
    // put a platform-wide act in a single tenant's log — and leave it invisible in
    // the platform-wide view this module serves, which is the view that matters.
    schoolId: null,
    meta: {
      ...(req?.impersonation
        ? {
            // Attributed to the impersonation, because a super admin is forbidden
            // from writing while impersonating (`impersonation.js:227`) — so in
            // practice this is defence in depth, and the right kind: it holds if
            // somebody later allowlists this route without thinking.
            impersonatedBy: String(req.impersonation.superAdminId),
            impersonationSessionId: String(req.impersonation.sessionId),
          }
        : {}),
      export: "audit_logs_csv",
      filters: describeFilters(query),
      rowCount: rows.length,
      matched: total,
      cap,
      capped: total > cap,
      filename,
    },
    req,
  });

  return { filename, rowCount: rows.length, matched: total, cap, capped: total > cap };
};

// ──────────────────── One user's trail ────────────────────

/**
 * `GET /admin/audit-logs/user/:userId` — everything one person did.
 *
 * This is the screen a bursar is handed when a colleague's permissions are
 * questioned: "prove who changed Kwame's role". It has to span the user's whole
 * history and not stop at one school, because the answer to a role question is
 * sometimes "the platform owner did it", and a school-scoped query would return
 * an empty list — which reads as "nobody did anything", the exact wrong answer.
 *
 * `User.role_change` and `user.remove` are the two actions it exists for (see
 * `AuditLog.js:57-60` — both were added precisely because a bursar asked and
 * there was nothing to show). So the trail is filtered by *user*, never by school:
 * `schoolId` is left off, and the school is populated onto each row instead.
 */
export const getUserAuditTrail = async (userId, query = {}) => {
  const targetUserId = optionalId(userId, "user ID");
  if (!targetUserId) {
    throw new ApiError("Invalid user ID", 400, "INVALID_ID");
  }

  const target = await User.findById(targetUserId)
    .select("name email role schoolId")
    .lean();
  if (!target) {
    throw new ApiError("User not found", 404, "NOT_FOUND");
  }

  const filter = buildFilter({ ...query, userId: targetUserId });

  const { page, perPage, skip, limit } = resolvePagination(query);

  const [logs, total] = await Promise.all([
    withActors(AuditLog.find(filter))
      .sort(NEWEST_FIRST)
      .skip(skip)
      .limit(limit)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  return {
    /*
     * The subject, not just the rows.
     *
     * A list of audit rows for "user 662f…" cannot be shown to a bursar, and
     * resolving the name here means the console does not have to make a second
     * round trip to render a heading. `schoolId` on the subject is the user's own
     * school; a `null` means a super admin, which is itself the answer to a
     * surprising trail.
     */
    user: {
      id: String(target._id),
      name: target.name,
      email: target.email,
      role: target.role,
      schoolId: target.schoolId ? String(target.schoolId) : null,
    },
    data: logs,
    meta: buildMeta({ page, perPage, total, extra: { filters: describeFilters(query) } }),
  };
};

// ──────────────────── One impersonation session ────────────────────

/**
 * `GET /admin/audit-logs/impersonation/:sessionId` — what was done under one
 * impersonation.
 *
 * Filters on `meta.impersonationSessionId`, and that choice carries two
 * limitations which have to be stated rather than discovered:
 *
 * 1. **It depends on `meta` never being stripped.** `AuditLog.meta` is
 *    `Schema.Types.Mixed` (`AuditLog.js:158`) — an untyped bag with no schema
 *    and no validation — so any code path that writes an entry without carrying
 *    the impersonation keys writes an entry this query cannot see. There is no
 *    index and no constraint keeping them, and a future writer that
 *    overwrites `meta` wholesale would silently blind this screen rather than
 *    break anything. The `ImpersonationSession` document is the durable record of
 *    the session itself; this is the activity *inside* it.
 *
 * 2. **A platform action taken while impersonating with a null `meta` is
 *    invisible here.** Not absent from the database — absent from *this query*.
 *    An operator who read a school without triggering any audited write leaves
 *    `actionsCount` incremented on the session (`ImpersonationSession.js:200`,
 *    fire-and-forget) but no matching audit row, because a read that writes
 *    nothing has nothing to log. So "no rows" does **not** mean "the operator did
 *    nothing": it means "nothing they did was audited under this session". The
 *    session's own `actionsCount` is the check on that, which is why the session
 *    is loaded and returned alongside the rows rather than the console having to
 *    remember to.
 *
 * Newest first, matching every other read in this module. There is no pagination
 * — a session is minutes long — but `limit` is applied anyway, because `meta` is
 * an untyped bag and an unbounded `$elemMatch`-free scan of the whole audit log
 * for a session id is a table scan dressed as a lookup.
 */
export const getImpersonationSessionAudit = async (sessionId, query = {}) => {
  const targetSessionId = optionalId(sessionId, "impersonation session ID");
  if (!targetSessionId) {
    throw new ApiError("Invalid impersonation session ID", 400, "INVALID_ID");
  }

  const session = await ImpersonationSession.findById(targetSessionId)
    .select("superAdminId schoolId reason startedAt endedAt actionsCount ipAddress userAgent")
    .populate("superAdminId", "name email")
    .populate("schoolId", "name schoolCode")
    .lean();

  if (!session) {
    throw new ApiError("Impersonation session not found", 404, "NOT_FOUND");
  }

  const requested = Number(query.limit);
  const limit = Math.min(
    1000,
    Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 200)
  );

  const logs = await withActors(
    AuditLog.find({ "meta.impersonationSessionId": String(targetSessionId) })
  )
    .sort(NEWEST_FIRST)
    .limit(limit)
    .lean();

  return {
    session: {
      id: String(session._id),
      superAdmin: session.superAdminId
        ? { id: String(session.superAdminId._id), name: session.superAdminId.name, email: session.superAdminId.email }
        : null,
      school: session.schoolId
        ? { id: String(session.schoolId._id), name: session.schoolId.name, schoolCode: session.schoolId.schoolCode }
        : null,
      reason: session.reason,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      /*
       * Returned because it is the cross-check on `data.length`, and that is the
       * whole caveat: `actionsCount` counts *requests*, `data.length` counts
       * *audited writes*. The two are not expected to match and must not be
       * compared as though they were. A high count against no rows is normal (a
       * read-only investigation) and is precisely the case this screen would
       * otherwise read as "nothing happened".
       */
      actionsCount: session.actionsCount,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    },
    data: logs,
    meta: {
      returned: logs.length,
      limit,
      // Said out loud in the payload. A console that renders "0 activities" for a
      // session where the operator looked at a school's payments for twenty
      // minutes is worse than showing nothing, because it is actively wrong.
      note:
        "Rows are audit entries whose meta.impersonationSessionId matches. Reads that wrote nothing are counted on session.actionsCount, not here, so an empty list does not mean the operator was idle.",
    },
  };
};