import Joi from "joi";
import { AUDIT_ACTION_VALUES } from "../config/constants.js";
import { MAX_PER_PAGE, DEFAULT_PER_PAGE } from "../utils/platformQuery.js";

/**
 * Schemas for the **platform** audit log — the cross-school console views.
 *
 * These are a separate file from `auditLog.validation.js` because that module is
 * the school-scoped one and its filters take a `schoolId` in the path. Folding
 * these in would mean one file serving two different scopes, and the school one
 * is mounted for `school_admin` too.
 */

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

/**
 * Every optional filter also accepts `""`.
 *
 * Copied as a rule from `auditLog.validation.js:33-47`, and the reason is worth
 * repeating because it is the single most likely 422 on a screen with six filter
 * controls: `.optional()` says "absent is fine" and says nothing about
 * present-but-empty, while Joi rejects `""` against `.valid(...)`, a hex regex
 * and `.iso()`. A console that sends `?action=&from=&entity=` on its first load —
 * which is what an untouched filter bar does — would fail validation on the
 * first request and the log would never load at all. `stripUnknown` then removes
 * the empty keys and the service sees `undefined`, which is what "no filter" means.
 */
const optionalId = () => objectId.optional().allow(null, "");
const optionalText = (max = 200) => Joi.string().trim().max(max).optional().allow(null, "");
const optionalIsoDate = () => Joi.date().iso().optional().allow(null, "");

/**
 * `action` is validated against `AUDIT_ACTION_VALUES` — never a list written here.
 *
 * This is the exact bug the array exists to prevent, documented at both its
 * definition (`config/constants.js:89-99`) and its cause (`models/AuditLog.js:5-11`):
 * `auditLog.validation.js` once held a hand-copied subset of 14 of the 27 actions
 * in the model enum. Every action added after that copy was written was
 * unwritable through the only endpoint that could filter on it — the model
 * accepted the write, and the filter refused to find it. A value present in the
 * enum and absent from this schema is a 422 on a legitimate, system-written
 * action, so the list is imported, never transcribed.
 *
 * Importing it also means `admin.*` and `health.check` are filterable the moment
 * they were added to the enum, which is the entire reason the platform console
 * can answer "what did the owner do" with one dropdown.
 */
const actionFilter = () =>
  Joi.string().valid(...AUDIT_ACTION_VALUES).optional().allow(null, "");

/**
 * `entity` is bounded free text, not an enum.
 *
 * The values are model names (`"User"`, `"Payment"`, `"PlatformSettings"`,
 * `"DisbursementBatch"`) written by hand at each call site, and `AuditLog.entity`
 * has no enum on the model either (`AuditLog.js:136`). An enum here would reject
 * a legitimate entity the moment somebody logs one, with no way to fix it except a
 * deploy — the same drift problem as the action list, in the one place where it
 * has not already bitten. A length bound is the right constraint: it stops a
 * megabyte in a query string, and a value nobody uses simply matches nothing.
 */
const entityFilter = () => optionalText(120);

/**
 * `GET /admin/audit-logs` — the cross-school list.
 *
 * `perPage` is capped at `MAX_PER_PAGE` (200) rather than at the 100 the
 * school-scoped module uses, because this list can legitimately be wider than one
 * tenant's and `resolvePagination` clamps to the same ceiling. Both numbers come
 * from `platformQuery.js` so the frontend's pager, which expects
 * `{page, perPage, total, pages}`, is served one shape.
 */
export const listPlatformAuditLogsQuerySchema = Joi.object({
  // A platform action has `schoolId: null` and is invisible from the school's own
  // log by design (`AuditLog.js:114-124`). So the platform list must NOT default
  // this to the requester's school — a super admin's is null anyway, and pinning
  // it would hide every platform-wide entry from the one screen that exists to
  // show them.
  schoolId: optionalId(),
  userId: optionalId(),
  action: actionFilter(),
  entity: entityFilter(),
  entityId: optionalId(),
  from: optionalIsoDate(),
  to: optionalIsoDate(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(MAX_PER_PAGE).default(DEFAULT_PER_PAGE),
});

/**
 * `GET /admin/audit-logs/export`
 *
 * The same filters, minus pagination — an export is "everything that matches",
 * and accepting `page`/`perPage` here would invite a client to think it could page
 * through a stream, which it cannot. The row ceiling is `LIMITS.AUDIT_LOG_CSV_CAP`
 * and is applied in the service.
 */
export const exportPlatformAuditLogsQuerySchema = Joi.object({
  schoolId: optionalId(),
  userId: optionalId(),
  action: actionFilter(),
  entity: entityFilter(),
  entityId: optionalId(),
  from: optionalIsoDate(),
  to: optionalIsoDate(),
});

/**
 * `GET /admin/audit-logs/user/:userId`
 *
 * The date range and paging only. `userId` comes from the path and is therefore
 * not a query filter — a client that sent `?userId=` alongside a path id would
 * have two ids disagreeing, and `buildFilter` merges the path value over the
 * query so the path wins. Accepting it silently would make the loser invisible.
 */
export const userAuditTrailQuerySchema = Joi.object({
  action: actionFilter(),
  entity: entityFilter(),
  entityId: optionalId(),
  from: optionalIsoDate(),
  to: optionalIsoDate(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(MAX_PER_PAGE).default(DEFAULT_PER_PAGE),
});

/**
 * `GET /admin/audit-logs/impersonation/:sessionId`
 *
 * `limit` rather than `page`, because the result is bounded by the session's own
 * length — an impersonation is minutes long — and a paged screen for it would be
 * inventing a depth that does not exist. Capped at 1000 in the service.
 */
export const impersonationAuditQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(1000).default(200),
});

export const auditUserIdParamSchema = Joi.object({
  userId: objectId.required().messages({
    "string.pattern.base": "Invalid user ID format",
  }),
});

export const auditSessionIdParamSchema = Joi.object({
  sessionId: objectId.required().messages({
    "string.pattern.base": "Invalid impersonation session ID format",
  }),
});

/**
 * `GET /admin/audit-logs/:id` — one entry.
 *
 * Keyed `id`, not `auditLogId`, because the route is `/audit-logs/:id`. Matching the
 * path segment name matters more than it looks: a schema declaring a key the route
 * does not provide strips the parameter to nothing and the handler then queries for
 * `undefined`, which is a 404 for *every* id — a validation schema that silently
 * disables the route it was written to protect.
 *
 * `.unknown(false)` so a client cannot smuggle a second identifier in alongside and
 * have one of them win by ordering.
 */
export const auditLogIdParamSchema = Joi.object({
  id: objectId.required().messages({
    "string.pattern.base": "Invalid audit log ID format",
  }),
}).unknown(false);