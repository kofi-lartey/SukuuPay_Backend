/**
 * Joi schemas for the platform console's finance area: disbursements, the
 * ledger, the reconciliation report and the derived invoice list.
 *
 * Two rules from `SUKUU_ADMIN_CONVENTIONS.md` shape everything here.
 *
 *   - **Patch by default** (§6). Every field optional, `.min(1)` on the object,
 *     so a client that reads a document and writes the whole thing back cannot
 *     blank what it did not mean to change. That rule is written for updates;
 *     this file has one `PUT`-shaped body and a great many reads.
 *   - **`stripUnknown: true`** (in `middleware/validate.js`). Unknown keys are
 *     removed silently rather than rejected, so a schema is a whitelist that
 *     cannot be used to smuggle a field past. `createdBy`, `approvedBy` and
 *     `payoutReference` are consequently *absent* from every schema here: the
 *     callers of these endpoints must never be able to name who approved a
 *     payout or what reference it carries.
 */

import Joi from "joi";

/**
 * A money field: integer pesewas, never cedi, never a float.
 *
 * Exported so the finance area has exactly one definition of "a money field".
 * No endpoint in this file currently *accepts* an amount — a batch's gross,
 * platform and net figures are all derived from `Payment.amount` and the
 * school's markup rate, and the ledger and invoices are sums of what was already
 * written — so this schema is the vocabulary rather than a binding constraint
 * today. It is here because the first endpoint that does take money (a manual
 * payout adjustment, a write-off) must reach for this instead of writing
 * `Joi.number()` and quietly accepting `150.50` as a figure that then gets
 * summed with integers everywhere else. `.min(0)` because a negative *input* is
 * never valid; a negative in the ledger is produced by a reversal, not accepted
 * from a request.
 */
export const pesewas = Joi.number().integer().min(0);

/** A 24-character hex ObjectId, as it appears in a path segment. */
const objectId = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({ "string.pattern.base": "Invalid ID format" });

/** `YYYY-MM`, the only month format the invoice endpoints accept. */
const MONTH = Joi.string()
  .pattern(/^\d{4}-(0[1-9]|1[0-2])$/)
  .messages({ "string.pattern.base": "Month must be formatted YYYY-MM, e.g. 2026-03" });

/** Shared by every list endpoint: bounded so one request cannot ask for a dump. */
const pagination = {
  page: Joi.number().integer().min(1).default(1),
  // Capped at `MAX_PER_PAGE` (200) in `platformQuery.js` as well. The schema
  // bound is the first refusal, the helper is the guarantee — two clamps,
  // because a clamp that only exists in one place is a clamp that stops being
  // enforced the first time somebody calls the service directly.
  perPage: Joi.number().integer().min(1).max(200).default(20),
};

// ────────────────────────── Disbursements ──────────────────────────

/**
 * `POST /admin/finance/disbursements`
 *
 * The one body in this file that is **not** a patch, and every field is
 * `.required()` because the operation is genuinely impossible without each one.
 * There is no sensible default for a window: defaulting `periodStart` to "now"
 * would build a batch covering this instant, and defaulting `periodEnd` to
 * "now + 7 days" would quietly pay out a week of money the operator never
 * looked at. §6 permits required fields where the operation cannot proceed
 * without them, and a payout window is the clearest case in the console.
 *
 * `periodEnd` is `.greater(Joi.ref('periodStart'))` — a cross-field rule Joi
 * evaluates against the validated body, so the ordering is checked once, here,
 * at the edge. The service checks it again (`INVERTED_PERIOD`) because the
 * service is reachable from a job and from tests that do not go through
 * `validate`, and an inverted window is invisible — it matches no payments and
 * looks exactly like a school that collected nothing. Two checks for the same
 * rule is not redundancy for its own sake; it is the difference between a 422
 * that explains the problem and a 409 that says "nothing to disburge" and sends
 * somebody hunting for a bug that does not exist.
 *
 * Note the deliberate asymmetry: the schema requires *strictly* after, the
 * service accepts *at or after* (`end >= start`, matching
 * DisbursementBatch.js:62). A window whose start and end are the same instant is
 * never something an operator meant to ask for, so it is refused at the edge
 * with a message about ordering, while the service's looser floor keeps a job
 * that passes identical timestamps from being told its window is invalid. The
 * stricter rule is the one a human can be shown; the looser one is the one that
 * cannot surprise a human.
 */
export const createDisbursementBatchSchema = Joi.object({
  schoolId: objectId.required().messages({ "any.required": "A schoolId is required" }),
  periodStart: Joi.date().iso().required(),
  periodEnd: Joi.date()
    .iso()
    .required()
    .greater(Joi.ref("periodStart"))
    .messages({ "date.greater": "periodEnd must be after periodStart" }),
});

/** `:batchId` on approve, retry and detail. */
export const batchIdParamSchema = Joi.object({
  batchId: objectId
    .required()
    .messages({ "any.required": "A batchId is required" }),
});

/**
 * `GET /admin/finance/disbursements`
 *
 * `status` is an enum rather than a free string, and it is the **same
 * vocabulary** as `DisbursementBatch.status` (DisbursementBatch.js:85). A typo
 * that slipped through as `status=paid_` would return an empty list, and an empty
 * list on a payouts queue reads as "nothing is waiting" — which is the one thing
 * this screen must never be wrong about. Rejecting the value turns a silent
 * "no results" into a 422 that names the valid set.
 */
export const listDisbursementsQuerySchema = Joi.object({
  status: Joi.string()
    .valid("draft", "pending_approval", "approved", "processing", "paid", "failed", "cancelled")
    .optional(),
  schoolId: objectId.optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  ...pagination,
});

// ────────────────────────── Ledger ──────────────────────────

/**
 * `GET /admin/finance/ledger`
 *
 * `type` mirrors `PlatformLedger.type` (PlatformLedger.js:48) and must stay in
 * step with it, for the same reason `status` does above: an unmatched filter is
 * an empty list, not an error.
 *
 * `settled` accepts a boolean or the strings `"true"`/`"false"` because a query
 * string is a string. `Joi.boolean()` alone would reject `?settled=true` with a
 * 422 — a filter that works by hand in a browser bar and then fails in the
 * console, which is the worst of both. The service normalises to a real boolean
 * before it reaches Mongo, so the filter never arrives as the string `"false"`
 * and silently matches nothing.
 */
export const listLedgerQuerySchema = Joi.object({
  schoolId: objectId.optional(),
  type: Joi.string()
    .valid(
      "markup",
      "platform_fee",
      "subscription",
      "sms",
      "gateway_fee",
      "refund",
      "payout",
      "adjustment"
    )
    .optional(),
  settled: Joi.boolean().optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  ...pagination,
});

/**
 * `GET /admin/finance/ledger/export`
 *
 * `page`/`perPage` are deliberately **absent** even though
 * `listLedgerQuerySchema` has them. An export ignores pagination, and accepting
 * the parameters without honouring them is how somebody exports "everything" and
 * receives 20 rows, files it, and reconciles a fortnight against it. Rejecting
 * them is better: the console's "export this view" link that carries them can be
 * pointed here with the parameters stripped, and a client that sends them is
 * told plainly that the export is not paginated.
 *
 * `stripUnknown: true` removes them rather than refusing the request, so the
 * link works either way — but the audit entry records only `from`, `to` and
 * `schoolId`, which is the filter the file actually contains.
 */
export const exportLedgerQuerySchema = Joi.object({
  schoolId: objectId.optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
});

// ────────────────────────── Reconciliation ──────────────────────────

/**
 * `GET /admin/finance/reconciliation`
 *
 * `date` is optional and defaults to today in Accra, because the daily report
 * nobody runs is not a report. It is `.iso()` rather than a `YYYY-MM` pattern
 * because the service already takes a `Date` and a full ISO timestamp from a
 * job's caller is a legitimate thing to hand it; the day bounds are computed
 * server-side from `startOfDayAccra`/`endOfDayAccra`, which are exact here
 * (Ghana is permanently UTC+0 with no DST).
 */
export const reconciliationQuerySchema = Joi.object({
  date: Joi.date().iso().optional(),
});

// ────────────────────────── Invoices ──────────────────────────

/**
 * `GET /admin/finance/invoices`
 *
 * `month` is **required**, and it is the only required field in this file that
 * is not an id. Without a month this endpoint would have to guess between "the
 * current month" — which silently hides that March is still unpaid, the exact
 * thing a collections screen exists to show — and "all time", which is a sum of
 * months and not an invoice list. The service re-checks it so a direct caller
 * gets the same 400.
 *
 * `status` is `paid | due`, the two values `deriveInvoiceRows` can produce
 * (finance.service.js). It is not the `PlatformLedger.type` enum and does not
 * borrow from it: an invoice is not a ledger row, and typing it as one is how
 * somebody later adds `refunded` to the invoice filter and gets a validation
 * error in production.
 */
export const listInvoicesQuerySchema = Joi.object({
  month: MONTH.required().messages({ "any.required": "A month is required, e.g. 2026-03" }),
  schoolId: objectId.optional(),
  status: Joi.string().valid("paid", "due").optional(),
  ...pagination,
});

/** `GET /admin/finance/invoices/:month` — pattern-matched in the route. */
export const invoiceMonthParamSchema = Joi.object({
  month: MONTH.required().messages({ "any.required": "A month is required, e.g. 2026-03" }),
});

export default {
  pesewas,
  createDisbursementBatchSchema,
  batchIdParamSchema,
  listDisbursementsQuerySchema,
  listLedgerQuerySchema,
  exportLedgerQuerySchema,
  reconciliationQuerySchema,
  listInvoicesQuerySchema,
  invoiceMonthParamSchema,
};
