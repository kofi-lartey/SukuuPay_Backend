import { Payment } from '../../models/paymentModel.js';
import { School } from '../../models/schoolModel.js';
import { PlatformLedger } from '../../models/PlatformLedger.js';
import { DisbursementBatch } from '../../models/DisbursementBatch.js';
import { refundPayment as refundPaymentInPaymentService } from '../payment.service.js';
import { buildCalendarSeries } from '../admin.service.js';
import ApiError from '../../utils/ApiError.js';
import {
  resolvePagination,
  buildMeta,
  optionalId,
  resolveDateRange,
} from '../../utils/platformQuery.js';
import { streamCsv } from '../../utils/csvWriter.js';
import { LIMITS } from '../../config/constants.js';

/**
 * Platform-wide payment administration.
 *
 * The single most important thing to know before reading any of this: **a refund is
 * not a flag on a payment.** It is its own `Payment` row with a negative `amount`,
 * linked back to the original by `refundOfPaymentId`. That single decision drives
 * most of what follows:
 *
 *   - the ledger stays **additive**. A `total` column would have to be re-derived on
 *     every read and would be wrong the moment anything was corrected.
 *   - `status` on the original means something narrow: `refunded` means the *whole*
 *     amount went back, and a partially refunded payment stays `completed` because it
 *     is still partly real money.
 *   - a `completed`-filtered total **excludes refunds**, so it is not "what a school
 *     collected". The honest figure is the sum over every status, which nets them.
 *
 * Both halves of that are surfaced rather than assumed, because the console is where
 * somebody will be trying to answer "why does this school's total not match its
 * bank".
 */

/**
 * `GET /admin/payments`
 *
 * `totals` travels with the page rather than being a second request. Two requests
 * can straddle a payment and disagree, and then the total at the top of the screen
 * does not match the rows beneath it — which is the exact confusion this console
 * exists to resolve.
 *
 * Three sums, not one, because they answer different questions and only one of them
 * is "what did they keep":
 *
 *   - `grossCompleted` — completed positives only. What came in.
 *   - `refunded` — reversals. What went back out.
 *   - `net` — the sum of everything, reversals included. What they actually have.
 *
 * A refund row is `status: 'completed'` with a negative amount, so `grossCompleted`
 * already nets them; `net` is the same figure arrived at by summing all statuses.
 * They are returned separately so a screen can label them honestly rather than
 * guessing which one it is showing.
 */
export const listAllPayments = async (query = {}) => {
  const { schoolId, status, network, gateway, from, to, page, perPage } = query;
  const scopedSchool = optionalId(schoolId, 'school ID');
  const { skip, limit, page: safePage, perPage: safePerPage } = resolvePagination({ page, perPage });

  const filter = {
    deletedAt: null,
    ...(scopedSchool ? { schoolId: scopedSchool } : {}),
    ...(status ? { status } : {}),
    ...(network ? { momoNetwork: network } : {}),
    ...(gateway ? { provider: gateway } : {}),
    ...resolveDateRange(from, to),
  };

  const [rows, total, totalsRows] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select(
        'paymentId schoolId studentId parentId amount currency status paymentMethod provider momoNetwork description receiptNumber invoiceNumber hubtelTransactionId feesBreakdown disbursementBatchId createdAt completedAt'
      )
      .populate('schoolId', 'name schoolCode region status')
      .populate('studentId', 'studentName studentId class')
      .lean(),
    Payment.countDocuments(filter),
    Payment.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          // A reversal is a negative amount on a `completed` row, so this single sum
          // is already net of refunds. `gross` is the positive side of the same
          // thing, kept for the screen that wants "collected before refunds".
          net: { $sum: '$amount' },
          gross: { $sum: { $cond: [{ $gt: ['$amount', 0] }, '$amount', 0] } },
          refunded: {
            $sum: { $cond: [{ $lt: ['$amount', 0] }, { $multiply: ['$amount', -1] }, 0] },
          },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const totals = totalsRows[0] || { net: 0, gross: 0, refunded: 0, count: 0 };

  return {
    data: rows.map((row) => ({
      ...row,
      // Named rather than left implicit. A negative amount in a "Amount" column is
      // either a reversal or a bug depending on whether the reader was told, and the
      // two look identical.
      isReversal: Number(row.amount) < 0,
      school: row.schoolId
        ? {
            _id: row.schoolId._id,
            name: row.schoolId.name,
            schoolCode: row.schoolId.schoolCode,
            region: row.schoolId.region,
            status: row.schoolId.status,
          }
        : null,
      student: row.studentId
        ? {
            _id: row.studentId._id,
            studentName: row.studentId.studentName,
            studentId: row.studentId.studentId,
            class: row.studentId.class,
          }
        : null,
    })),
    totals: {
      net: Number(totals.net) || 0,
      gross: Number(totals.gross) || 0,
      refunded: Number(totals.refunded) || 0,
      count: Number(totals.count) || 0,
    },
    meta: buildMeta({ page: safePage, perPage: safePerPage, total }),
  };
};

/**
 * `GET /admin/payments/:paymentId`
 *
 * Carries **two** markups, on purpose:
 *
 *   - `chargedSplit` — from `feesBreakdown`, what this payment actually paid.
 *   - `currentMarkup` — what the school's rate is *now*.
 *
 * They differ exactly when a school's markup changed after this payment, and they
 * are also the whole explanation for a school's arithmetic not adding up. Showing
 * only the recomputed figure would make a correct historical payment look wrong;
 * showing only the charged figure would hide the change. Both, labelled, is the
 * only version that answers "why is this different to last month".
 *
 * The amounts are integers in pesewas throughout, and `currentMarkup` is left as a
 * **rate** rather than being converted into a cedified split — a percentage and an
 * amount are different quantities and multiplying one by the other's stored value is
 * how a 5% markup becomes 105%.
 */
export const getAdminPaymentDetail = async (paymentId) => {
  const payment = await Payment.findOne({ paymentId, deletedAt: null })
    .populate('schoolId', 'name schoolCode region status payment')
    .populate('studentId', 'studentName studentId class balance totalOwed totalPaid')
    .populate('parentId', 'parentName email phone')
    .lean();

  if (!payment) {
    throw new ApiError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
  }

  const [reversals, batch, ledgerEntries, school] = await Promise.all([
    // The explicit relation, not a scan for `"Refund:"` in a description string.
    Payment.find({ refundOfPaymentId: payment._id, deletedAt: null })
      .sort({ createdAt: -1 })
      .select('paymentId amount reason description createdBy createdAt')
      .populate('createdBy', 'name')
      .lean(),
    payment.disbursementBatchId
      ? DisbursementBatch.findById(payment.disbursementBatchId)
          .select('batchNumber status netAmount processedAt payoutReference')
          .lean()
      : null,
    PlatformLedger.find({ paymentId: payment._id }).sort({ createdAt: -1 }).lean(),
    payment.schoolId?._id
      ? School.findById(payment.schoolId._id)
          .select('name platformFeePercent featureFlags')
          .lean()
      : null,
  ]);

  const refunded = reversals.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

  return {
    payment,
    school: payment.schoolId
      ? {
          _id: payment.schoolId._id,
          name: payment.schoolId.name,
          schoolCode: payment.schoolId.schoolCode,
          region: payment.schoolId.region,
          status: payment.schoolId.status,
          platformFeePercent: Number(school?.platformFeePercent) || 0,
        }
      : null,
    student: payment.studentId,
    parent: payment.parentId,
    chargedSplit: {
      breakdown: payment.feesBreakdown || [],
      markupPercent:
        payment.feesBreakdown?.[0]?.markupPercent ?? null,
      /** What this payment actually kept. Read off the stored breakdown, not recomputed. */
      markupAmount:
        payment.feesBreakdown?.reduce(
          (sum, part) => sum + (Number(part.markupAmount ?? part.amount) || 0),
          0
        ) ?? null,
    },
    currentMarkup: {
      percent: Number(payment.schoolId?.payment?.platformMarkupPercent) || 0,
      platformFeePercent: Number(school?.platformFeePercent) || 0,
      // Explicit, because the comparison above is the reason this endpoint exists.
      differsFromCharged:
        payment.feesBreakdown?.[0]?.markupPercent !== undefined &&
        Number(payment.feesBreakdown[0].markupPercent) !==
          (Number(payment.schoolId?.payment?.platformMarkupPercent) || 0),
    },
    reversals,
    refundSummary: {
      count: reversals.length,
      refunded: Math.abs(refunded),
      // Negative, because `amount` is. A refundable balance that reads positive is
      // the sign error that makes a screen look like it is offering money.
      refundable: Math.abs(Number(payment.amount) || 0) - Math.abs(refunded),
      fullyRefunded:
        reversals.length > 0 &&
        Math.abs(refunded) >= Math.abs(Number(payment.amount) || 0),
    },
    disbursementBatch: batch,
    ledgerEntries,
  };
};

/**
 * `POST /admin/payments/:paymentId/refund` — return money to a parent.
 *
 * **Delegates the write to `payment.service.js`'s own `refundPayment`.** That is not
 * politeness: it is the only function that updates the student's `totalPaid` and
 * `balance`, decrements the school's monthly payment *count* (by one, not by the
 * amount — see the comment there about a counter that once went to -849998), and
 * writes the reversal row. A second implementation of "refund a payment" is four
 * pieces of balance arithmetic that must agree with the first, and a partial one
 * that updates the `Payment` and not the `Student` leaves a parent's balance showing
 * money that is not theirs.
 *
 * `refundPayment` resolves the school scope for a `super_admin` as `null` — which
 * is how it finds a payment belonging to *any* school — so it is already the correct
 * call for a platform operator and no scope is being widened here.
 *
 * The `PlatformLedger` entry is written by this service rather than by
 * `payment.service.js`, because the ledger is a platform-console concept the school
 * path has no reason to know about. It is **negative**, because a refund takes money
 * out of the platform's income rather than adding to it.
 */
export const refundPaymentAsPlatform = async (paymentId, { amount, reason }, actor) => {
  const existing = await Payment.findOne({ paymentId, deletedAt: null })
    .select('_id amount status schoolId')
    .lean();

  if (!existing) {
    throw new ApiError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
  }

  const alreadyRefunded = await Payment.aggregate([
    { $match: { refundOfPaymentId: existing._id, deletedAt: null, status: 'completed' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const refundedSoFar = Math.abs(Number(alreadyRefunded[0]?.total) || 0);
  const refundable = Math.abs(Number(existing.amount) || 0) - refundedSoFar;

  if (refundable <= 0) {
    throw new ApiError('This payment has already been fully refunded', 400, 'ALREADY_REFUNDED');
  }

  // `amount` is optional at the schema level and defaults here rather than inside
  // `refundPayment` — where `data.amount || payment.amount` would silently mean
  // "refund the whole original" even when most of it had already gone back.
  const requested = amount === undefined || amount === null ? refundable : Number(amount);

  if (requested > refundable) {
    throw new ApiError(
      `Only ${refundable} pesewas of this payment remain refundable (${refundedSoFar} already returned)`,
      400,
      'EXCEEDS_REFUNDABLE'
    );
  }

  const result = await refundPaymentInPaymentService(paymentId, { amount: requested, reason }, actor);

  const ledger = await PlatformLedger.create({
    type: 'refund',
    // Negative. A refund reverses income already counted; reporting it as positive
    // would let a platform with many refunds look more profitable than one with none.
    amount: -requested,
    schoolId: existing.schoolId,
    paymentId: result.refundPayment._id,
    // Not settled: the money has left the platform but has not left the gateway's
    // float, and conflating the two is how "collected" and "in hand" come to mean
    // the same number on a screen.
    settled: false,
    description: `Refund: ${reason}`,
    reference: result.refundPayment.paymentId || null,
    metadata: {
      originalPaymentId: String(existing._id),
      originalPaymentRef: paymentId,
      reason,
      actor: String(actor?._id || ''),
    },
    createdBy: actor?._id || null,
  });

  return {
    ...result,
    ledgerEntry: ledger,
    refundableAfter: refundable - requested,
  };
};

/**
 * `GET /admin/payments/stats` — aggregates over a window.
 *
 * `groupBy` is sent explicitly by the caller rather than derived, because 30 daily
 * points and 24 monthly points are different charts.
 *
 * **The series has no gaps, and that is the contract.** A day nobody paid in comes
 * back as an explicit `0`, never as an omitted point — a client that draws a line
 * across a hole presents a day of no collections as steady growth. `day` and `month`
 * reuse `buildCalendarSeries` from `admin.service.js`, which is the function written
 * specifically to prevent this; `week` is walked here for the same reason, because
 * that helper only handles the two it was written for and extending it would have
 * meant touching a well-tested file for a caller that has no other route to it.
 *
 * ISO weeks (`%G-W%V` / `getISOWeek`) on both sides of the walk, so the key the
 * aggregation produces and the key the fill walks to are the same string. A mismatch
 * would produce a gap-free series of all zeros, which is worse than no series.
 */
export const getPaymentStats = async ({ groupBy = 'day', from, to, schoolId } = {}) => {
  const scopedSchool = optionalId(schoolId, 'school ID');

  const toDate = to ? new Date(to) : new Date();
  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - 29 * 24 * 60 * 60 * 1000);

  const filter = {
    deletedAt: null,
    ...(scopedSchool ? { schoolId: scopedSchool } : {}),
    createdAt: { $gte: fromDate, $lte: toDate },
  };

  const [summary, byStatus, byProvider, byNetwork, buckets] = await Promise.all([
    Payment.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          net: { $sum: '$amount' },
          gross: { $sum: { $cond: [{ $gt: ['$amount', 0] }, '$amount', 0] } },
          refunded: {
            $sum: { $cond: [{ $lt: ['$amount', 0] }, { $multiply: ['$amount', -1] }, 0] },
          },
        },
      },
    ]),
    Payment.aggregate([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
    Payment.aggregate([
      { $match: filter },
      { $group: { _id: '$provider', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
    Payment.aggregate([
      { $match: filter },
      { $group: { _id: '$momoNetwork', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
    Payment.aggregate([
      { $match: filter },
      {
        $group: {
          _id: {
            $dateToString:
              groupBy === 'day'
                ? { format: '%Y-%m-%d', date: '$createdAt' }
                : groupBy === 'week'
                  ? { format: '%G-W%V', date: '$createdAt' }
                  : { format: '%Y-%m', date: '$createdAt' },
          },
          amount: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const totals = summary[0] || { count: 0, net: 0, gross: 0, refunded: 0 };
  const byKey = new Map(buckets.map((row) => [row._id, { amount: row.amount, count: row.count }]));

  let series;
  if (groupBy === 'week') {
    series = buildWeekSeries(byKey, fromDate, toDate);
  } else {
    series = buildCalendarSeries(byKey, fromDate, toDate, groupBy);
  }

  const counted = series.reduce(
    (acc, point) => ({ amount: acc.amount + (Number(point.amount) || 0), count: acc.count + (Number(point.count) || 0) }),
    { amount: 0, count: 0 }
  );

  return {
    groupBy,
    window: { from: fromDate, to: toDate },
    schoolId: scopedSchool,
    totals: {
      count: Number(totals.count) || 0,
      // `seriesTotal` is returned beside `totals` and the two are the same sum
      // arrived at by different routes. They are not compared here — but they are
      // both returned so a client *can*, because a gap between them means the
      // calendar walk and the aggregation disagree about the range, which is the
      // one bug in this shape that is invisible on the chart.
      net: Number(totals.net) || 0,
      gross: Number(totals.gross) || 0,
      refunded: Number(totals.refunded) || 0,
      average: Number(totals.count) ? Math.round(Number(totals.net) / Number(totals.count)) : 0,
      seriesTotal: counted.amount,
      seriesCount: counted.count,
    },
    series,
    byStatus: byStatus.map((row) => ({ status: row._id, count: row.count, amount: row.amount })),
    byProvider: byProvider.map((row) => ({ provider: row._id, count: row.count, amount: row.amount })),
    byNetwork: byNetwork.map((row) => ({ network: row._id, count: row.count, amount: row.amount })),
  };
};

/**
 * ISO-8601 week key, matching Mongo's `%G-W%V`.
 *
 * `%G`/`%V` are the ISO year and ISO week, **not** the calendar year and a naive
 * week number. Around new year they disagree: 1 January 2021 is ISO week 53 of 2020,
 * and a `getFullYear()`-based key would place it in week 1 of a year that has not
 * started. Written out rather than pulled from a date library because the codebase
 * has no date dependency and because the one thing that matters is that both sides
 * of the walk agree.
 */
const isoWeekKey = (date) => {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Move to the Thursday of this ISO week: the week is named by the year that owns
  // it, and the Thursday is the day that determines that.
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);

  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);

  const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

/**
 * The week-bucket twin of `buildCalendarSeries`.
 *
 * Walks Monday-to-Monday so each point is a full ISO week, capped at 200 points for
 * the same reason the day walk is capped at 400: an unbounded walk is a hung tab, and
 * a truncated one is a visible flat line rather than a silent omission.
 */
const buildWeekSeries = (byKey, from, to) => {
  const cap = 200;
  const series = [];

  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7));

  const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  last.setUTCDate(last.getUTCDate() - ((last.getUTCDay() + 6) % 7));

  while (cursor <= last && series.length < cap) {
    const key = isoWeekKey(cursor);
    series.push({
      period: key,
      // Each point is the *week* total, not a per-day average. Named `amount`
      // to match the day and month shapes so a chart component does not need to
      // know which bucket it was handed.
      ...(byKey.get(key) || { amount: 0, count: 0 }),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  return series;
};

/**
 * `GET /admin/payments/export` — CSV download.
 *
 * **Capped at `LIMITS.AUDIT_LOG_CSV_CAP`, the same cap the audit log uses**, and
 * for the same reason: both are full-collection scans streamed to one person, and a
 * cap that differs between them would mean one of them is wrong.
 *
 * The cap is fetched as `cap + 1` rows so truncation is detected without a second
 * collection-wide count, and the response carries `X-Export-Truncated` so the caller
 * can say so. **A silently truncated export is worse than a refused one** — a bursar
 * reconciling 2,000 rows against a CSV of 50,000 has no way to know which half
 * arrived.
 *
 * Amounts are written as **integer pesewas**, not cedi. Every consumer of this file
 * is reconciling against a payment record, and a converted amount cannot be
 * re-derived without re-deriving the same rounding — while pesewas is what the
 * database holds and is therefore the only lossless form.
 */
export const exportPaymentsCsv = async (res, { from, to, schoolId } = {}) => {
  const scopedSchool = optionalId(schoolId, 'school ID');
  const filter = {
    deletedAt: null,
    ...(scopedSchool ? { schoolId: scopedSchool } : {}),
    ...resolveDateRange(from, to),
  };

  const cap = LIMITS.AUDIT_LOG_CSV_CAP;
  const rows = await Payment.find(filter)
    .sort({ createdAt: -1 })
    .limit(cap + 1)
    .select(
      'paymentId schoolId studentId amount currency status paymentMethod provider momoNetwork description receiptNumber invoiceNumber hubtelTransactionId createdAt'
    )
    .populate('schoolId', 'name schoolCode')
    .populate('studentId', 'studentName studentId')
    .lean();

  const truncated = rows.length > cap;
  const page = truncated ? rows.slice(0, cap) : rows;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="platform-payments-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('X-Export-Truncated', String(truncated));
  res.setHeader('X-Export-Row-Count', String(page.length));
  res.setHeader('X-Export-Cap', String(cap));

  if (truncated) {
    // Not just a header. A spreadsheet opens with a row of text above the header and
    // a human has to notice it; a comment on the first line is seen.
    res.write(
      `# NOTE: this export hit the ${cap}-row cap and shows the most recent ${cap} payments. Narrow the date range to see the rest.\n`
    );
  }

  streamCsv(
    res,
    [
      { key: 'date', header: 'Date' },
      { key: 'paymentId', header: 'Payment ID' },
      { key: 'schoolName', header: 'School' },
      { key: 'schoolCode', header: 'School code' },
      { key: 'studentName', header: 'Student' },
      { key: 'amountPesewas', header: 'Amount (pesewas)' },
      { key: 'currency', header: 'Currency' },
      { key: 'status', header: 'Status' },
      { key: 'provider', header: 'Provider' },
      { key: 'network', header: 'Network' },
      { key: 'receiptNumber', header: 'Receipt' },
      { key: 'invoiceNumber', header: 'Invoice' },
      { key: 'hubtelReference', header: 'Gateway reference' },
      { key: 'description', header: 'Description' },
    ],
    page.map((row) => ({
      date: row.createdAt,
      paymentId: row.paymentId,
      schoolName: row.schoolId?.name || '',
      schoolCode: row.schoolId?.schoolCode || '',
      studentName: row.studentId?.studentName || '',
      amountPesewas: row.amount,
      currency: row.currency || 'GHS',
      status: row.status,
      provider: row.provider,
      network: row.momoNetwork,
      receiptNumber: row.receiptNumber,
      invoiceNumber: row.invoiceNumber,
      hubtelReference: row.hubtelTransactionId,
      description: row.description,
    }))
  );

  return { rowCount: page.length, truncated, cap };
};

export default {
  listAllPayments,
  getAdminPaymentDetail,
  refundPaymentAsPlatform,
  getPaymentStats,
  exportPaymentsCsv,
};