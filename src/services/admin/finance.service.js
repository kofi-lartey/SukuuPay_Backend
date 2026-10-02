/**
 * The finance read side: the platform ledger, the CSV that leaves the building,
 * the daily reconciliation report, and the derived invoice list.
 *
 * Everything here is a **read except the export's audit entry**, and that is
 * deliberate. A reconciliation is a report: it compares what the gateway says
 * against what the ledger says, and the moment it starts fixing the difference
 * it is no longer able to tell anybody whether the difference existed. The one
 * thing it must never do is write a correcting entry to make the two agree,
 * because a self-healing reconciliation reports zero discrepancies forever and
 * the day it silently stops checking is the day it was needed.
 *
 * Corrections go in as `PlatformLedger` `adjustment` rows pointing at what they
 * adjust (PlatformLedger.js:14-19). Nothing in this file writes one.
 */

import { School } from "../../models/schoolModel.js";
import { Payment } from "../../models/paymentModel.js";
import {
  PlatformLedger,
  PLATFORM_REVENUE_TYPES,
} from "../../models/PlatformLedger.js";
import { LIMITS } from "../../config/constants.js";
import ApiError from "../../utils/ApiError.js";
import { streamCsv } from "../../utils/csvWriter.js";
import {
  optionalId,
  resolvePagination,
  buildMeta,
  resolveDateRange,
} from "../../utils/platformQuery.js";
import { startOfDayAccra, endOfDayAccra } from "../../utils/dateHelpers.js";

/**
 * The CSV row ceiling, reused from `LIMITS.AUDIT_LOG_CSV_CAP`.
 *
 * The precedent is the Audit Log export, which is the other endpoint that
 * streams a whole platform-wide collection to a file. The number is not
 * arbitrary and it is not a "we were asked for a big one" number: 50,000 rows of
 * a few hundred bytes is a file in the tens of megabytes, which is fine, and
 * anything past it is an operator who wanted a database dump and got a CSV
 * instead — at which point the honest answer is a narrower date range, not a
 * process holding a six-figure result set in memory.
 *
 * The cap is *communicated*, not silent. A truncated export that looks complete
 * is the worst possible outcome here: it is a financial file that reconciles
 * against a statement and is quietly missing rows. The service returns
 * `truncated` and `rowCount` and the controller puts them in response headers,
 * so the file itself and the API response cannot disagree about whether it is
 * the whole ledger.
 */
const LEDGER_CSV_ROW_CAP = LIMITS.AUDIT_LOG_CSV_CAP;

/** How many schools a day's reconciliation will name before it stops listing. */
const RECONCILIATION_SCHOOL_LIMIT = 50;

// ────────────────────────── Ledger list ──────────────────────────

/**
 * Build the ledger filter once, so the list, the totals and the export cannot
 * disagree about what "the filter" means.
 *
 * A pager that reports `total: 412` under a `unsettled = true` heading, and a
 * totals row summed over a *different* filter, is how a finance screen ends up
 * with a headline and a list that mean different things. One function, three
 * callers.
 */
const buildLedgerFilter = ({ schoolId, type, settled, from, to } = {}) => {
  const filter = {};

  if (schoolId) filter.schoolId = optionalId(schoolId, "school ID");
  if (type) filter.type = type;
  if (settled !== undefined && settled !== null && settled !== "") {
    filter.settled = settled === true || settled === "true";
  }
  Object.assign(filter, resolveDateRange(from, to, "createdAt"));

  return filter;
};

/**
 * The ledger, paginated, with the totals for **the matched set** — not the totals
 * for the page.
 *
 * The distinction is the reason `totals` is here at all. A page of 20 rows summed
 * on its own tells a finance user nothing about the period they are looking at,
 * and the two numbers that *are* useful are the whole-set total and the row
 * count, both of which are the same answer for every page. Returning the page
 * subtotal instead would be the more common mistake and it is the one that makes
 * a screen disagree with itself between page 1 and page 2.
 */
export const listLedgerEntries = async (query = {}) => {
  const { page, perPage } = query;
  const filter = buildLedgerFilter(query);

  const { skip, limit, page: safePage, perPage: safePerPage } = resolvePagination({
    page,
    perPage,
  });

  const [entries, total, totals] = await Promise.all([
    PlatformLedger.find(filter)
      .populate("schoolId", "name schoolCode")
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PlatformLedger.countDocuments(filter),

    /*
     * Signed, because the ledger is signed (PlatformLedger.js:63-74): a refund
     * or a payout is a negative entry, and a totals object that dropped them
     * would report a month as having earned money it gave back. The gross and net
     * halves are both returned so a reader can see which way the period moved.
     */
    PlatformLedger.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          netAmount: { $sum: "$amount" },
          creditAmount: { $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] } },
          debitAmount: { $sum: { $cond: [{ $lt: ["$amount", 0] }, "$amount", 0] } },
          entryCount: { $sum: 1 },
        },
      },
    ]),
  ]);

  const totalsRow = totals[0] || {};

  const totalsObject = {
    netAmount: totalsRow.netAmount || 0,
    creditAmount: totalsRow.creditAmount || 0,
    debitAmount: totalsRow.debitAmount || 0,
    entryCount: totalsRow.entryCount || 0,
  };

  return {
    data: entries.map((entry) => ({
      ...entry,
      schoolName: entry.schoolId?.name || null,
      schoolCode: entry.schoolId?.schoolCode || null,
    })),
    totals: totalsObject,
    /*
     * `totals` rides in `meta` as well as at the top level, and that is not
     * duplication for its own sake. `SUKUU_ADMIN_CONVENTIONS.md` §3 gives every
     * console list a `{ data, meta }` envelope, and the frontend's pager reads
     * `meta` — so a totals block returned only beside `data` is a block the
     * console has no agreed place to render, and the natural next step is for
     * somebody to recompute it client-side from the twenty rows on screen. The
     * top-level copy is there for the service's other callers; the `meta` copy is
     * the one the console will actually use.
     */
    meta: buildMeta({
      page: safePage,
      perPage: safePerPage,
      total,
      extra: { totals: totalsObject },
    }),
  };
};

// ────────────────────────── Ledger export ──────────────────────────

/**
 * Stream the ledger to CSV, capped at {@link LEDGER_CSV_ROW_CAP} rows.
 *
 * `cap + 1` is fetched, not `cap`. That one extra row is the only way to know
 * whether the cap was *hit* without a second `countDocuments` over the whole
 * collection, and knowing it is the difference between a file that says "there
 * is more" and one that quietly stops. The extra row is discarded before it
 * reaches the writer, so the file is never `cap + 1` rows.
 *
 * The GHS column is derived, never stored, and it is named "Amount (GHS)" in the
 * header for the reason `payment.service.js:898` gives: a spreadsheet that sees
 * a column called `amount` holding `85000` and no unit will read it as 85,000
 * cedis. Both columns are emitted so the pesewa figure stays available for a
 * machine that reconciles in integers, which is the only unit this system sums
 * in.
 *
 * ### Why this function sets the response headers itself
 *
 * A normal controller sets `Content-Type` and `Content-Disposition` before
 * handing off to a streaming service. That is impossible here for one specific
 * reason: the truncation notice lives in `X-Export-Truncated` and
 * `X-Export-Row-Count`, those numbers are only known once the rows have been
 * fetched, and the first `res.write` — after which no header can be changed —
 * happens inside this function. So the headers are set here, immediately before
 * `streamCsv`, and the controller is left with the audit entry and the error
 * shape. Writing `res.setHeader` after the stream has started throws, and a
 * silent `try/catch` around it would be a cap that reports success.
 */
export const exportLedgerCsv = async (res, { from, to, schoolId } = {}) => {
  const filter = buildLedgerFilter({ from, to, schoolId });

  const entries = await PlatformLedger.find(filter)
    .populate("schoolId", "name schoolCode")
    .sort({ createdAt: 1, _id: 1 })
    .limit(LEDGER_CSV_ROW_CAP + 1)
    .lean();

  const truncated = entries.length > LEDGER_CSV_ROW_CAP;
  const capped = truncated ? entries.slice(0, LEDGER_CSV_ROW_CAP) : entries;

  const rows = capped.map((entry) => ({
    date: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : entry.createdAt || "",
    school: entry.schoolId?.name || "Platform",
    type: entry.type,
    amountPesewas: entry.amount,
    // Cedis, named in the header. A negative amount arrives as text prefixed
    // with an apostrophe by `csvWriter`'s formula-injection guard, which is
    // that writer doing its job on a ledger that legitimately contains
    // negative rows.
    amountGhs: ((entry.amount || 0) / 100).toFixed(2),
    settled: entry.settled ? "settled" : "unsettled",
    reference: entry.reference || (entry.disbursementBatchId ? `batch:${entry.disbursementBatchId}` : ""),
    description: entry.description || "",
  }));

  const columns = [
    { key: "date", header: "Date" },
    { key: "school", header: "School" },
    { key: "type", header: "Type" },
    { key: "amountPesewas", header: "Amount (pesewas)" },
    { key: "amountGhs", header: "Amount (GHS)" },
    { key: "settled", header: "Settled" },
    { key: "reference", header: "Reference" },
    { key: "description", header: "Description" },
  ];

  const fromPart = from ? `-${String(from).slice(0, 10)}` : "";

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="platform-ledger${fromPart}-${new Date().toISOString().slice(0, 10)}.csv"`
  );

  // The cap, announced. `X-Export-Truncated: true` is the header a reader — or
  // a CI job — checks, and it is what stops a partial financial file from being
  // filed as a complete one.
  res.setHeader("X-Export-Row-Count", String(rows.length));
  res.setHeader("X-Export-Cap", String(LEDGER_CSV_ROW_CAP));
  res.setHeader("X-Export-Truncated", truncated ? "true" : "false");
  if (truncated) {
    res.setHeader(
      "X-Export-Truncated-Notice",
      `Row limit of ${LEDGER_CSV_ROW_CAP} reached. This file is INCOMPLETE — narrow the date range or filter by school to get the rest.`
    );
  }

  streamCsv(res, columns, rows);

  return {
    rowCount: rows.length,
    truncated,
    cap: LEDGER_CSV_ROW_CAP,
  };
};

// ────────────────────────── Daily reconciliation ──────────────────────────

/**
 * Reconcile one day of collection against one day of the ledger.
 *
 * **A report, not a mutation.** Nothing here writes, and the reason is in the
 * file header: a reconciliation that repairs its own discrepancies can never
 * report one, so it would go green the moment it was introduced. The output
 * exists to be looked at by a person, and the person's job is to decide whether a
 * delta is a bug, a timing artefact, or a correction somebody has to make by
 * hand.
 *
 * ### Reading the delta, which is the part that is easy to get wrong
 *
 * The obvious number — gross collected minus the ledger total — is **supposed to
 * be non-zero**, because the ledger does not hold gross: it holds the platform's
 * share of it, and the rest belongs to the school. Publishing that subtraction as
 * a "discrepancy" would report every single school, every single day, as broken,
 * and the number would be ignored within a week.
 *
 * The actionable figure is `deltaCount`: **the number of completed payments
 * minus the number of `markup` ledger lines written for the same school on the
 * same day.** `buildDisbursementBatch` writes exactly one line per payment
 * (`PlatformLedger` has no other writer of `type: 'markup'` in this codebase), so
 * those two counts must be equal. A school with 41 payments and 39 markup lines
 * has two payments the platform took nothing from — the real finding, and the
 * one worth waking somebody up for.
 *
 * A `deltaAmount` is still reported, because a school whose counts match but
 * whose markup is 12% light is a *rate* problem rather than a *missed line*
 * problem, and only the amount shows that. Both are returned; the comment above
 * is which one to act on.
 */
export const reconcileDay = async (dateInput) => {
  const day = dateInput ? new Date(dateInput) : new Date();

  if (Number.isNaN(day.getTime())) {
    throw new ApiError("Invalid reconciliation date", 400, "INVALID_DATE");
  }

  // `startOfDayAccra`/`endOfDayAccra` are exact here rather than approximate:
  // Ghana is permanently UTC+0 with no DST, so a day boundary is a UTC boundary
  // and no payment can fall in the gap an offset would create.
  const dayStart = startOfDayAccra(day);
  const dayEnd = endOfDayAccra(day);

  const paymentMatch = {
    status: "completed",
    deletedAt: null,
    createdAt: { $gte: dayStart, $lte: dayEnd },
  };

  const [
    paymentTotals,
    paymentByProvider,
    paymentBySchool,
    ledgerTotals,
    ledgerBySchool,
  ] = await Promise.all([
    Payment.aggregate([
      { $match: paymentMatch },
      { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),

    Payment.aggregate([
      { $match: paymentMatch },
      {
        $group: {
          _id: { provider: "$provider", method: "$paymentMethod" },
          amount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { amount: -1 } },
    ]),

    Payment.aggregate([
      { $match: paymentMatch },
      {
        $group: {
          _id: "$schoolId",
          amount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),

    // All types: the day's total written, *and* the markup slice. They are
    // different numbers and a reconciliation that showed only one of them would
    // be unable to distinguish "no markup was written" from "no other revenue
    // was written", which are very different days.
    PlatformLedger.aggregate([
      { $match: { createdAt: { $gte: dayStart, $lte: dayEnd } } },
      {
        $group: {
          _id: null,
          amount: { $sum: "$amount" },
          count: { $sum: 1 },
          markupAmount: {
            $sum: { $cond: [{ $eq: ["$type", "markup"] }, "$amount", 0] },
          },
          markupCount: {
            $sum: { $cond: [{ $eq: ["$type", "markup"] }, 1, 0] },
          },
        },
      },
    ]),

    PlatformLedger.aggregate([
      { $match: { type: "markup", createdAt: { $gte: dayStart, $lte: dayEnd } } },
      { $group: { _id: "$schoolId", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
  ]);

  const paymentsBySchool = new Map(
    paymentBySchool.map((row) => [String(row._id), { amount: row.amount, count: row.count }])
  );
  const ledgerBySchoolId = new Map(
    ledgerBySchool.map((row) => [String(row._id), { amount: row.amount, count: row.count }])
  );

  // Union, not just the payment side: a school with a markup line and no payment
  // that day means a line referencing a payment that is not there, which is
  // exactly the kind of thing a reconciliation exists to surface, and iterating
  // the payments alone would never see it.
  const schoolIds = new Set([...paymentsBySchool.keys(), ...ledgerBySchoolId.keys()]);

  const rows = [...schoolIds].map((schoolId) => {
    const payments = paymentsBySchool.get(schoolId) || { amount: 0, count: 0 };
    const ledger = ledgerBySchoolId.get(schoolId) || { amount: 0, count: 0 };

    return {
      schoolId,
      paymentsCount: payments.count,
      paymentsAmount: payments.amount,
      markupAmount: ledger.amount,
      markupCount: ledger.count,
      // The actionable one: one markup line per completed payment.
      deltaCount: payments.count - ledger.count,
      // Informational. Expected to be non-zero — it is mostly the school's money.
      deltaAmount: payments.amount - ledger.amount,
    };
  });

  const withDelta = rows.filter((row) => row.deltaCount !== 0 || row.deltaAmount !== 0);

  const sorted = withDelta.sort(
    (a, b) => Math.abs(b.deltaAmount) - Math.abs(a.deltaAmount) || b.deltaCount - a.deltaCount
  );

  const namedSchoolIds = sorted.slice(0, RECONCILIATION_SCHOOL_LIMIT).map((row) => row.schoolId);
  const schools = namedSchoolIds.length
    ? await School.find({ _id: { $in: namedSchoolIds } })
        .select("name schoolCode")
        .lean()
    : [];
  const schoolNameById = new Map(schools.map((school) => [String(school._id), school]));

  const paymentsTotal = paymentTotals[0] || { amount: 0, count: 0 };
  const ledgerTotal = ledgerTotals[0] || { amount: 0, count: 0 };

  return {
    date: day.toISOString().slice(0, 10),
    dayStart,
    dayEnd,

    payments: {
      totalAmount: paymentsTotal.amount || 0,
      totalCount: paymentsTotal.count || 0,
      byGateway: paymentByProvider.map((row) => ({
        provider: row._id?.provider || "unknown",
        method: row._id?.method || "unknown",
        amount: row.amount || 0,
        count: row.count || 0,
      })),
    },

    ledger: {
      totalAmount: ledgerTotal.amount || 0,
      totalCount: ledgerTotal.count || 0,
      markupAmount: ledgerTotal.markupAmount || 0,
      markupCount: ledgerTotal.markupCount || 0,
    },

    /*
     * Reported for completeness and explicitly *not* a discrepancy. `payments`
     * is gross; `ledger.markupAmount` is the platform's share of it. The
     * subtraction is the school's money plus whatever the rate did not take,
     * and a reader who treats it as an error will be right every single day.
     * The per-school `deltaCount` is the number that means something.
     */
    delta: {
      amount: (paymentsTotal.amount || 0) - (ledgerTotal.markupAmount || 0),
      count: (paymentsTotal.count || 0) - (ledgerTotal.markupCount || 0),
    },

    schoolsWithDelta: sorted.map((row) => ({
      ...row,
      schoolName: schoolNameById.get(String(row.schoolId))?.name || null,
      schoolCode: schoolNameById.get(String(row.schoolId))?.schoolCode || null,
    })),

    schoolsWithDeltaCount: withDelta.length,
    schoolsWithDeltaTruncated: withDelta.length > RECONCILIATION_SCHOOL_LIMIT,
    schoolCount: rows.length,
  };
};

// ────────────────────────── Derived invoices ──────────────────────────

/** `subscription` and `platform_fee` are the two entries a Mode B invoice is made of. */
const INVOICE_LEDGER_TYPES = ["subscription", "platform_fee"];

/**
 * The month a `YYYY-MM` string names, as half-open UTC bounds.
 *
 * Half-open `[start, endExclusive)` rather than `$lte` on the last instant,
 * because `$lte` at `23:59:59.999` and a half-open bound are the same set only
 * until a document is written with a sub-millisecond timestamp — which Mongo
 * stores at millisecond resolution today but which is not a guarantee the next
 * storage engine will keep making.
 *
 * Bounds are `Date.UTC` and the caller passes `YYYY-MM`, so the month is the
 * Accra month: Ghana is permanently UTC+0 with no DST.
 */
const monthBounds = (month) => {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || ""));

  if (!match) {
    throw new ApiError(
      "Month must be formatted YYYY-MM, e.g. 2026-03",
      400,
      "INVALID_MONTH"
    );
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;

  return {
    start: new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0)),
    endExclusive: new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0)),
    key: `${match[1]}-${match[2]}`,
  };
};

/**
 * One row per school per month, **computed from `PlatformLedger`**.
 *
 * ### Why these are not stored
 *
 * There is no `Invoice` model in this codebase, and that is not an oversight
 * being worked around — it is a deliberate trade with a real cost, stated here
 * because the cost is not visible anywhere else.
 *
 * **What is gained:** an invoice cannot drift from what the platform actually
 * charged. There is no second place to update, no sync job, and no "the invoice
 * says 15,000 but the ledger says 15,000 for a different month" class of bug,
 * because the invoice *is* the ledger. A school that disputes a figure gets a
 * figure that was summed from the entries it can also be shown.
 *
 * **What is lost, and it is not small:**
 *
 *   - **No invoice number, so no durable record.** A real invoice has an
 *     identity: "INV-2026-03-0042" is what a school quotes, what a bank transfer
 *     is referenced by, and what a tax filing is built from. Here the row's
 *     identity is `{ schoolId, month }`, which exists only for as long as the
 *     ledger entries do. **Delete or correct a ledger entry — which the
 *     append-only rule permits, via a compensating `adjustment` — and the
 *     invoice that month existed is silently restated.** A school holding a PDF
 *     of last March's invoice has a document the API no longer agrees with and
 *     nothing to reconcile the two against.
 *   - **No snapshot of what was agreed.** A subscription fee is 15,000 this month
 *     because that is the rate now. If the rate changes mid-month, or a school is
 *     grandfathered, the "invoice" reflects the entries, not the agreement, and
 *     the agreement is not recorded anywhere in this derivation.
 *   - **A month with no entries produces no row at all.** A Mode B school that
 *     was never charged for October does not appear in October's invoice list. The
 *     absence is a real signal — the billing job did not run — but it arrives as
 *     a missing row rather than as a `due` invoice, which is the one thing a
 *     collections screen most needs to be able to show.
 *
 * The last point is the live one: **nothing in this codebase writes
 * `subscription` or `platform_fee` ledger entries today.** There is no invoice
 * model, no subscription billing service and no billing job, so this list is
 * correct and empty. It becomes useful the moment a billing writer exists, and
 * it is written now so that writer has a reader to be checked against.
 *
 * ### `paid` versus `due`
 *
 * `paid` when the school has at least one `subscription` or `platform_fee`
 * entry in the month that is `settled: true`; `due` otherwise. `settled` is the
 * closest thing the ledger has to "this invoice was paid", and it is used here
 * because it means the same thing everywhere else in the system: the money moved
 * out of the float. It is a weaker guarantee than an invoice payment record
 * would be — it says a matching entry settled, not that this school paid *this*
 * invoice — and that weakness is the concrete argument for storing invoices
 * later.
 */
const deriveInvoiceRows = async ({ start, endExclusive, schoolId, status }) => {
  const match = {
    type: { $in: INVOICE_LEDGER_TYPES },
    schoolId: { $ne: null },
    createdAt: { $gte: start, $lt: endExclusive },
  };

  if (schoolId) match.schoolId = schoolId;

  const rows = await PlatformLedger.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$schoolId",
        subscriptionFee: {
          $sum: { $cond: [{ $eq: ["$type", "subscription"] }, "$amount", 0] },
        },
        platformFee: {
          $sum: { $cond: [{ $eq: ["$type", "platform_fee"] }, "$amount", 0] },
        },
        anySettled: { $max: { $cond: [{ $eq: ["$settled", true] }, 1, 0] } },
        entryCount: { $sum: 1 },
      },
    },
  ]);

  let shaped = rows.map((row) => {
    const total = row.subscriptionFee + row.platformFee;
    return {
      schoolId: row._id,
      schoolName: null,
      subscriptionFee: row.subscriptionFee,
      platformFee: row.platformFee,
      total,
      status: row.anySettled === 1 ? "paid" : "due",
      entryCount: row.entryCount,
    };
  });

  if (status) {
    shaped = shaped.filter((row) => row.status === status);
  }

  shaped.sort((a, b) => b.total - a.total);

  const schoolIds = shaped.map((row) => row.schoolId);
  const schools = schoolIds.length
    ? await School.find({ _id: { $in: schoolIds } })
        .select("name schoolCode subscription.plan payment.gatewayMode")
        .lean()
    : [];
  const schoolById = new Map(schools.map((school) => [String(school._id), school]));

  return shaped.map((row) => {
    const school = schoolById.get(String(row.schoolId));
    return {
      ...row,
      schoolName: school?.name || null,
      schoolCode: school?.schoolCode || null,
      plan: school?.subscription?.plan || null,
      // `manual` is the Mode B marker: the school is not running parent payments
      // through SukuuPay's gateway, so there is no markup to take and the only
      // revenue is the subscription and the platform fee.
      gatewayMode: school?.payment?.gatewayMode || null,
    };
  });
};

export const listInvoices = async (query = {}) => {
  const { schoolId, status, page, perPage } = query;

  /*
   * A month is required here, and this is the one endpoint in the file where a
   * default would be actively misleading. `listInvoices` with no `month` would
   * have to guess between "the current month" (which silently hides that March is
   * unpaid) and "all time" (which is a sum of months and not an invoice list at
   * all). The schema requires it, and this re-states the requirement for callers
   * that reach the service directly.
   */
  if (!query.month) {
    throw new ApiError(
      "A month is required, formatted YYYY-MM. An invoice list with no month cannot be a list of invoices.",
      400,
      "MONTH_REQUIRED"
    );
  }

  const { start, endExclusive, key } = monthBounds(query.month);
  const schoolObjectId = schoolId ? optionalId(schoolId, "school ID") : null;

  const allRows = await deriveInvoiceRows({
    start,
    endExclusive,
    schoolId: schoolObjectId,
    status,
  });

  const { skip, limit, page: safePage, perPage: safePerPage } = resolvePagination({
    page,
    perPage,
  });

  return {
    month: key,
    data: allRows.slice(skip, skip + limit),
    totals: {
      subscriptionFee: allRows.reduce((sum, row) => sum + row.subscriptionFee, 0),
      platformFee: allRows.reduce((sum, row) => sum + row.platformFee, 0),
      total: allRows.reduce((sum, row) => sum + row.total, 0),
      paid: allRows.filter((row) => row.status === "paid").length,
      due: allRows.filter((row) => row.status === "due").length,
    },
    meta: buildMeta({
      page: safePage,
      perPage: safePerPage,
      total: allRows.length,
    }),
  };
};

/** The same rows for one month, unpaginated — the invoice detail view. */
export const getInvoicesForMonth = async (month) => {
  if (!month) {
    throw new ApiError(
      "A month is required, formatted YYYY-MM.",
      400,
      "MONTH_REQUIRED"
    );
  }

  const { start, endExclusive, key } = monthBounds(month);
  const rows = await deriveInvoiceRows({ start, endExclusive });

  return {
    month: key,
    data: rows,
    totals: {
      subscriptionFee: rows.reduce((sum, row) => sum + row.subscriptionFee, 0),
      platformFee: rows.reduce((sum, row) => sum + row.platformFee, 0),
      total: rows.reduce((sum, row) => sum + row.total, 0),
      paid: rows.filter((row) => row.status === "paid").length,
      due: rows.filter((row) => row.status === "due").length,
    },
  };
};
