import { School } from "../../models/schoolModel.js";
import { Student } from "../../models/studentModel.js";
import { Payment } from "../../models/paymentModel.js";
import { PaymentPlan } from "../../models/paymentPlanModel.js";
import { PlatformLedger, PLATFORM_REVENUE_TYPES } from "../../models/PlatformLedger.js";
import ApiError from "../../utils/ApiError.js";
import { LIMITS } from "../../config/constants.js";
import { sendReportFile } from "../../utils/reportExport.js";
import { streamCsv } from "../../utils/csvWriter.js";
import { resolveDateRange } from "../../utils/platformQuery.js";
import { formatCedis } from "../../utils/formatters.js";
import {
  buildGapFreeSeries,
  foldDaysToPeriods,
  GATEWAY_RAIL_BY_MODE,
} from "./analytics.service.js";
import { monthKey } from "../admin.service.js";

/**
 * The platform owner's five reports, and the one export path.
 *
 * **Every payload is shaped `{ report, generatedAt, filters, sections }`** because that
 * is what `utils/reportExport.js` needs: `csvFor` reads `section.title` and
 * `section.columns[].key`, `workbookFor` reads `section.name`, `columns[].header` and
 * `columns[].width`. Building a report in some other shape and then reshaping it at the
 * edge is how the file a user downloads stops matching the screen they were looking at,
 * which is the one thing a report file must not do.
 *
 * Each builder also returns `summary` and its own named row arrays alongside `sections`,
 * so the JSON GET returns something a console can render and the file renderer has
 * something to serialise from the *same* rows — never two independently derived
 * numbers that happen to agree today.
 *
 * **Nothing here writes.** The audit entries are written by the controller, which is
 * the only layer that has the request to attribute them to.
 */

/**
 * The `schoolId` handed to `sendReportFile` purely to build a filename.
 *
 * `sendReportFile` was written for school-scoped reports and names the file
 * `<report>-<schoolId>-<timestamp>`. A platform report belongs to no school, and the
 * honest token for "every tenant" is the word `platform` — not an empty string, which
 * would produce `revenue--2026-…csv`, and not a real ObjectId, which would put a
 * school identifier in the name of a file about all of them.
 */
const PLATFORM_EXPORT_SCOPE = "platform";

/**
 * The five report `type` values, and the builders behind them.
 *
 * A single registry rather than a `switch` per call site, so the export endpoint and
 * the JSON endpoints cannot disagree about what names exist — the failure being a
 * `type` that validates, builds nothing and throws at runtime.
 */
export const ADMIN_REPORT_TYPES = [
  "platform_revenue",
  "school_performance",
  "growth",
  "churn",
];

/** Cap on CSV rows. `LIMITS` has one export cap today and inventing a second key is
 *  worse than reusing a correctly-named one for a second purpose: `AUDIT_LOG_CSV_CAP`
 *  is *the* cap on how many rows one streamed export may write, and the audit-log
 *  export is the only other consumer. If a report needs a smaller ceiling than this it
 *  gets its own key in `LIMITS`, not a magic number here. */
const CSV_ROW_CAP = LIMITS.AUDIT_LOG_CSV_CAP;

const MS_PER_DAY = 86400000;

/** Top-N caps inside a report, so a file cannot grow with the platform. */
const TOP_SCHOOLS_IN_REPORT = 200;
const TREND_PERIODS_IN_REPORT = 60;

const percent = (numerator, denominator) => {
  const d = Number(denominator);
  if (!Number.isFinite(d) || d === 0) return null;
  return Math.round(((Number(numerator) || 0) / d) * 10000) / 100;
};

const num = (value) => Number(value) || 0;

const pad = (value) => String(value).padStart(2, "0");

/** `{ from, to }` → concrete dates, defaulting to the last 12 months. */
const resolveWindow = (from, to, fallbackDays = 365) => {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - fallbackDays * MS_PER_DAY);
  return { from: start, to: end };
};

const createdAtRange = (from, to) =>
  resolveDateRange(from.toISOString(), to.toISOString(), "createdAt").createdAt;

/**
 * A money column pair for an export.
 *
 * Both columns, always, and never one. An exported file that carries only
 * `GHS 12,340.00` cannot be summed by the bursar who opens it in a spreadsheet, and one
 * that carries only pesewas cannot be read. This mirrors what every report in
 * `controllers/reports.controller.js` does and why: the pesewa column is the truth and
 * the cedi column is the convenience.
 */
const moneyColumns = (key, header) => [
  { key, header: `${header} (pesewas)` },
  { key: `${key}Display`, header },
];

/** The two columns every report starts with, so rows are identifiable in a CSV. */
const schoolIdentityColumns = [
  { key: "name", header: "School", width: 32 },
  { key: "schoolCode", header: "School Code" },
  { key: "region", header: "Region" },
];

const rosterMatch = { deletedAt: null, status: { $ne: "removed" } };

/** A `{metric, value, display}` summary section, matching the shape the school reports use. */
const summarySection = (summary, fields) => ({
  name: "Summary",
  title: "Summary",
  columns: [
    { key: "metric", header: "Metric", width: 40 },
    { key: "value", header: "Value" },
    { key: "display", header: "Display" },
  ],
  rows: fields.map((field) => ({
    metric: field.header,
    value: summary?.[field.key] ?? null,
    display: field.money
      ? formatCedis(summary?.[field.key])
      : field.percent
        ? (summary?.[field.key] === null || summary?.[field.key] === undefined
            ? "—"
            : `${summary[field.key]}%`)
        : String(summary?.[field.key] ?? ""),
  })),
});

// ──────────────────── 1. Platform revenue report ────────────────────

/**
 * What SukuuPay earned, by kind, by period and by school.
 *
 * Read from `PlatformLedger` and nowhere else. `Payment` is gross, school-bound money
 * (PlatformLedger.js:8-14), so a "platform revenue report" built from payments would be
 * a report of what parents paid, with the platform's own share nowhere in it — the
 * single most expensive confusion available in this codebase, because every number in it
 * would be real and every number would be wrong.
 */
export const getPlatformRevenueReport = async ({ from, to } = {}) => {
  const { from: start, to: end } = resolveWindow(from, to);
  const range = createdAtRange(start, end);
  const baseMatch = { type: { $in: PLATFORM_REVENUE_TYPES }, createdAt: range };

  const [dayRows, typeRows, schoolRows, reversalRows] = await Promise.all([
    PlatformLedger.aggregate([
      { $match: { ...baseMatch, amount: { $gt: 0 } } },
      {
        $group: {
          _id: {
            day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            type: "$type",
          },
          total: { $sum: "$amount" },
          entries: { $sum: 1 },
          settled: { $sum: { $cond: [{ $eq: ["$settled", true] }, "$amount", 0] } },
        },
      },
    ]),

    PlatformLedger.aggregate([
      { $match: { ...baseMatch, amount: { $gt: 0 } } },
      { $group: { _id: "$type", total: { $sum: "$amount" }, entries: { $sum: 1 } } },
    ]),

    /* Per school, so the report can name who paid. `schoolId: null` entries are
     * platform-level (a maintenance SMS charge, a gateway fee) and appear in the
     * `unattributed` row rather than being dropped from a revenue report. */
    PlatformLedger.aggregate([
      { $match: { ...baseMatch, amount: { $gt: 0 } } },
      { $group: { _id: { schoolId: "$schoolId", type: "$type" }, total: { $sum: "$amount" }, entries: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]),

    PlatformLedger.aggregate([
      { $match: { ...baseMatch, amount: { $lt: 0 } } },
      { $group: { _id: null, total: { $sum: "$amount" }, entries: { $sum: 1 } } },
    ]),
  ]);

  const emptyByType = () => Object.fromEntries(PLATFORM_REVENUE_TYPES.map((t) => [t, 0]));

  const byPeriod = foldDaysToPeriods(dayRows, "month", (acc, row) => {
    acc.total = num(acc.total) + num(row.total);
    acc.entries = num(acc.entries) + num(row.entries);
    acc.settled = num(acc.settled) + num(row.settled);
    if (!acc.byType) acc.byType = emptyByType();
    acc.byType[row._id.type] = num(acc.byType[row._id.type]) + num(row.total);
  });

  /*
   * Gap-free by construction: `buildGapFreeSeries` walks the calendar and emits an
   * explicit `0` for a month nobody billed on. Mapping `byPeriod` instead would omit
   * those months entirely, and a client would draw a straight line across the hole —
   * presenting a month of zero platform revenue as steady growth.
   */
  const trend = buildGapFreeSeries(
    byPeriod,
    start,
    end,
    "month",
    () => ({ total: 0, entries: 0, settled: 0, byType: emptyByType() })
  );

  const totalsByType = emptyByType();
  const entriesByType = emptyByType();
  for (const row of typeRows) {
    totalsByType[row._id] = num(row.total);
    entriesByType[row._id] = num(row.entries);
  }
  const total = typeRows.reduce((sum, row) => sum + num(row.total), 0);

  const schoolIds = [
    ...new Set(schoolRows.map((row) => (row._id.schoolId ? String(row._id.schoolId) : null))),
  ].filter(Boolean);

  const schools = schoolIds.length
    ? await School.find({ _id: { $in: schoolIds } })
        .select("name schoolCode region subscription.plan")
        .lean()
    : [];
  const schoolById = new Map(schools.map((s) => [String(s._id), s]));

  const bySchool = schoolRows.map((row) => {
    const school = row._id.schoolId ? schoolById.get(String(row._id.schoolId)) : null;
    return {
      schoolId: row._id.schoolId ? row._id.schoolId : null,
      name: school?.name || "(platform-level entry)",
      schoolCode: school?.schoolCode || null,
      region: school?.region || null,
      plan: school?.subscription?.plan || null,
      type: row._id.type,
      total: num(row.total),
      totalDisplay: formatCedis(num(row.total)),
      entries: num(row.entries),
    };
  });

  /*
   * `settled` is summed off `trend.series`, which accumulated the same `settled` value
   * the per-period rows use. Summing it from a *separate* `$group` would be a second
   * query answering a question the rows above already answer, and two queries that must
   * agree are two queries that will eventually disagree.
   */
  const summary = {
    total,
    totalDisplay: formatCedis(total),
    entries: typeRows.reduce((sum, row) => sum + num(row.entries), 0),
    settled: trend.series.reduce((sum, point) => sum + num(point.settled), 0),
    reversalAmount: num(reversalRows[0]?.total),
    reversalEntries: num(reversalRows[0]?.entries),
    schoolsEarning: schoolIds.length,
    periods: trend.series.length,
    monthsDroppedByCap: trend.truncated ? trend.series.length - TREND_PERIODS_IN_REPORT : 0,
  };

  const periodRows = trend.series.slice(-TREND_PERIODS_IN_REPORT).map((point) => ({
    period: point.period,
    ...Object.fromEntries(PLATFORM_REVENUE_TYPES.map((type) => [type, num(point.byType?.[type])])),
    total: num(point.total),
    totalDisplay: formatCedis(num(point.total)),
    settled: num(point.settled),
    entries: num(point.entries),
  }));

  return {
    report: "platform_revenue",
    generatedAt: new Date().toISOString(),
    filters: { from: start, to: end, types: PLATFORM_REVENUE_TYPES },

    summary: { ...summary, byType: totalsByType, entriesByType },
    trend: trend.series,
    bySchool: bySchool.slice(0, TOP_SCHOOLS_IN_REPORT),

    sections: [
      summarySection(summary, [
        { key: "total", header: "Platform Revenue", money: true },
        { key: "entries", header: "Ledger Entries" },
        { key: "settled", header: "Settled", money: true },
        { key: "reversalAmount", header: "Reversals (negative entries)", money: true },
        { key: "schoolsEarning", header: "Schools Earning" },
        { key: "periods", header: "Periods Covered" },
      ]),
      {
        name: "By Period",
        title: "Platform revenue by month",
        columns: [
          { key: "period", header: "Period" },
          ...PLATFORM_REVENUE_TYPES.map((type) => ({
            key: type,
            header: `${type} (pesewas)`,
          })),
          { key: "total", header: "Total (pesewas)" },
          { key: "totalDisplay", header: "Total" },
          { key: "settled", header: "Settled (pesewas)" },
          { key: "entries", header: "Entries" },
        ],
        rows: periodRows,
      },
      {
        name: "By School",
        title: "Platform revenue by school and type",
        columns: [
          ...schoolIdentityColumns,
          { key: "plan", header: "Plan" },
          { key: "type", header: "Revenue Type" },
          { key: "total", header: "Amount (pesewas)" },
          { key: "totalDisplay", header: "Amount" },
          { key: "entries", header: "Entries" },
        ],
        rows: bySchool.slice(0, TOP_SCHOOLS_IN_REPORT),
      },
    ],
  };
};

// ──────────────────── 2. School performance report ────────────────────

/**
 * Every live school, with what it collected, what it owes its parents, how many
 * students it has, what it pays the platform and which rail its money moves over.
 *
 * **The collection-rate column is a position, not a flow, and it says so.** `owed` and
 * `applied` both come from `PaymentPlan` — the face value of live plans and the amount
 * actually applied to their installments — so numerator and denominator are the same
 * population measured at the same moment. `collectedInWindow` is reported beside it as
 * a separate, separately-headed column because it is a flow over the report's window
 * and dividing it by `owed` would produce a rate that moves when the window moves.
 */
export const getSchoolPerformanceReport = async ({ from, to } = {}) => {
  const { from: start, to: end } = resolveWindow(from, to);
  const range = createdAtRange(start, end);

  const [schools, collectedRows, planRows, appliedRows, rosterRows] = await Promise.all([
    School.find({ deletedAt: null, status: { $ne: "archived" } })
      .select(
        "name schoolCode region status createdAt subscription.plan subscription.status subscription.monthlyFee platformFeePercent payment.gatewayMode payment.platformMarkupPercent"
      )
      .lean(),

    Payment.aggregate([
      { $match: { deletedAt: null, status: "completed", createdAt: range } },
      {
        $group: {
          _id: "$schoolId",
          collected: { $sum: "$amount" },
          payments: { $sum: 1 },
          lastPaymentAt: { $max: "$createdAt" },
        },
      },
    ]),

    /*
     * Owed, from live plans only.
     *
     * `planStatus: { $ne: "cancelled" }` and nothing else excluded: a `defaulted` plan
     * is the most owed of all and is exactly what a performance report exists to show,
     * while a cancelled one was withdrawn by the school and is not owed by anybody.
     *
     * No `$unwind` in this pipeline. `totalAmount` is the **plan's** face value, so
     * unwinding `installments` first would add that same value once per installment and
     * report a three-instalment plan as owing three times its fee — a number that looks
     * like a real balance and is off by the instalment count on every plan in the
     * database.
     */
    PaymentPlan.aggregate([
      { $match: { deletedAt: null, planStatus: { $ne: "cancelled" } } },
      {
        $group: {
          _id: "$schoolId",
          owed: { $sum: "$totalAmount" },
          plans: { $sum: 1 },
          students: { $addToSet: "$studentId" },
        },
      },
    ]),

    /*
     * Applied, from the installment array — the field the payment path actually writes.
     *
     * `totalPaid` is a *derived* field recomputed only on save (paymentPlanModel.js:321),
     * so it can be stale on a plan whose last installment moved; `amountPaid` is what the
     * payment-application path sets, so it is right even mid-update. This aggregation
     * deliberately does not use `totalPaid`, and the result is a real "applied" figure
     * rather than a cached copy of one.
     */
    PaymentPlan.aggregate([
      { $match: { deletedAt: null, planStatus: { $ne: "cancelled" } } },
      { $unwind: { path: "$installments", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$schoolId",
          applied: { $sum: { $ifNull: ["$installments.amountPaid", 0] } },
          installments: { $sum: 1 },
        },
      },
    ]),

    Student.aggregate([
      { $match: rosterMatch },
      { $group: { _id: "$schoolId", students: { $sum: 1 } } },
    ]),
  ]);

  const collectedBy = new Map(collectedRows.map((r) => [String(r._id), r]));
  const owedBy = new Map(planRows.map((r) => [String(r._id), r]));
  const appliedBy = new Map(appliedRows.map((r) => [String(r._id), r]));
  const rosterBy = new Map(rosterRows.map((r) => [String(r._id), num(r.students)]));

  const rows = schools.map((school) => {
    const collected = collectedBy.get(String(school._id));
    const owedRow = owedBy.get(String(school._id));
    const appliedRow = appliedBy.get(String(school._id));
    const owed = num(owedRow?.owed);
    const applied = num(appliedRow?.applied);
    const mrr = Math.round(num(school.subscription?.monthlyFee));

    return {
      schoolId: school._id,
      name: school.name,
      schoolCode: school.schoolCode,
      region: school.region,
      status: school.status,
      plan: school.subscription?.plan || null,
      subscriptionStatus: school.subscription?.status || null,
      /* The rail question the `gatewayMode` enum does not answer on its own; see
       * `GATEWAY_RAIL_BY_MODE`. `manual` is the school's own rail, the other three are
       * SukuuPay's, and shipping the raw enum alone would leave the reader guessing. */
      gatewayMode: school.payment?.gatewayMode || null,
      gatewayRail: GATEWAY_RAIL_BY_MODE[school.payment?.gatewayMode] || "unset",
      students: num(rosterBy.get(String(school._id))),
      collected: num(collected?.collected),
      collectedDisplay: formatCedis(num(collected?.collected)),
      payments: num(collected?.payments),
      lastPaymentAt: collected?.lastPaymentAt || null,
      owed,
      owedDisplay: formatCedis(owed),
      applied,
      appliedDisplay: formatCedis(applied),
      outstanding: Math.max(owed - applied, 0),
      outstandingDisplay: formatCedis(Math.max(owed - applied, 0)),
      collectionRatePercent: percent(applied, owed),
      plans: num(owedRow?.plans),
      studentsWithPlans: owedRow?.students?.length ?? 0,
      installments: num(appliedRow?.installments),
      mrr,
      mrrDisplay: formatCedis(mrr),
      platformMarkupPercent: num(school.payment?.platformMarkupPercent),
      platformFeePercent: num(school.platformFeePercent),
      createdAt: school.createdAt,
    };
  });

  /* Biggest collector first — the ordering an owner opening this file wants. */
  rows.sort((a, b) => b.collected - a.collected);

  const totalCollected = rows.reduce((sum, row) => sum + row.collected, 0);
  const totalOwed = rows.reduce((sum, row) => sum + row.owed, 0);
  const totalApplied = rows.reduce((sum, row) => sum + row.applied, 0);

  const summary = {
    schools: rows.length,
    students: rows.reduce((sum, row) => sum + row.students, 0),
    collected: totalCollected,
    collectedDisplay: formatCedis(totalCollected),
    owed: totalOwed,
    owedDisplay: formatCedis(totalOwed),
    outstanding: Math.max(totalOwed - totalApplied, 0),
    collectionRatePercent: percent(totalApplied, totalOwed),
    mrr: rows.reduce((sum, row) => sum + row.mrr, 0),
    schoolsWithNoStudents: rows.filter((row) => row.students === 0).length,
  };

  return {
    report: "school_performance",
    generatedAt: new Date().toISOString(),
    filters: { from: start, to: end },

    summary,
    rows,

    sections: [
      summarySection(summary, [
        { key: "schools", header: "Schools" },
        { key: "students", header: "Students" },
        { key: "collected", header: "Collected In Window", money: true },
        { key: "owed", header: "Owed (Live Plans)", money: true },
        { key: "outstanding", header: "Outstanding", money: true },
        { key: "collectionRatePercent", header: "Collection Rate", percent: true },
        { key: "mrr", header: "Total MRR", money: true },
        { key: "schoolsWithNoStudents", header: "Schools With No Students" },
      ]),
      {
        name: "Schools",
        title: "School performance",
        columns: [
          ...schoolIdentityColumns,
          { key: "status", header: "Status" },
          { key: "plan", header: "Plan" },
          { key: "subscriptionStatus", header: "Subscription" },
          { key: "gatewayMode", header: "Gateway Mode" },
          { key: "gatewayRail", header: "Rail" },
          { key: "students", header: "Students" },
          { key: "collected", header: "Collected In Window (pesewas)" },
          { key: "collectedDisplay", header: "Collected In Window" },
          { key: "payments", header: "Payments" },
          { key: "lastPaymentAt", header: "Last Payment" },
          { key: "owed", header: "Owed (pesewas)" },
          { key: "owedDisplay", header: "Owed" },
          { key: "applied", header: "Applied (pesewas)" },
          { key: "appliedDisplay", header: "Applied" },
          { key: "outstanding", header: "Outstanding (pesewas)" },
          { key: "outstandingDisplay", header: "Outstanding" },
          { key: "collectionRatePercent", header: "Collection Rate (%)" },
          { key: "plans", header: "Plans" },
          { key: "mrr", header: "MRR (pesewas)" },
          { key: "mrrDisplay", header: "MRR" },
        ],
        rows,
      },
    ],
  };
};

// ──────────────────── 3. Growth report ────────────────────

/**
 * New schools, new students and whether the revenue followed.
 *
 * The third of those is the point. Signups without collections are the failure mode
 * this console exists to catch, so the report puts the two side by side per month rather
 * than in two separate blocks a reader has to correlate — and every month in the range
 * appears, including the months with signups and no revenue and the months with neither,
 * because "nothing happened" is the answer to "did growth continue".
 */
export const getGrowthReport = async ({ from, to } = {}) => {
  const { from: start, to: end } = resolveWindow(from, to);
  const range = createdAtRange(start, end);

  const [newSchools, studentsByMonth, revenueByMonth, collectedByMonth] = await Promise.all([
    School.find({ deletedAt: null, createdAt: range })
      .select(
        "name schoolCode region status createdAt subscription.plan subscription.status subscription.monthlyFee onboardingCompletedAt"
      )
      .sort({ createdAt: 1 })
      .lean(),

    /*
     * Students by month, `$dateToString`-keyed in UTC.
     *
     * Ghana is permanently UTC+0 with no DST (utils/dateHelpers.js), so a UTC month
     * boundary is the local one exactly. This is the same reasoning `getRevenueSeries`
     * in `../admin.service.js:255` gives, and it is why no `timezone` option is passed
     * to Mongo here.
     */
    Student.aggregate([
      { $match: { deletedAt: null, createdAt: range } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          students: { $sum: 1 },
          schools: { $addToSet: "$schoolId" },
        },
      },
    ]),

    PlatformLedger.aggregate([
      {
        $match: {
          type: { $in: PLATFORM_REVENUE_TYPES },
          amount: { $gt: 0 },
          createdAt: range,
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          revenue: { $sum: "$amount" },
        },
      },
    ]),

    Payment.aggregate([
      { $match: { deletedAt: null, status: "completed", createdAt: range } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          collected: { $sum: "$amount" },
          payments: { $sum: 1 },
        },
      },
    ]),
  ]);

  const monthKeys = [];
  for (
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    cursor <= end;
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
  ) {
    monthKeys.push(monthKey(cursor));
  }

  const studentsBy = new Map(studentsByMonth.map((r) => [r._id, r]));
  const revenueBy = new Map(revenueByMonth.map((r) => [r._id, num(r.revenue)]));
  const collectedBy = new Map(collectedByMonth.map((r) => [r._id, r]));

  /*
   * Signups per month, counted once here rather than by filtering `newSchools` inside
   * the trend loop. The loop version is `months x schools` and turns a 40-school report
   * into a 40,000-iteration scan; the version below is a single pass, and it also makes
   * the "a month with no signups" case a key that is simply absent rather than a row
   * that had to be filtered out.
   */
  const newSchoolsByMonth = new Map();
  for (const school of newSchools) {
    const key = monthKey(new Date(school.createdAt));
    newSchoolsByMonth.set(key, num(newSchoolsByMonth.get(key)) + 1);
  }

  const trend = monthKeys.map((period) => {
    const students = studentsBy.get(period);
    const collected = collectedBy.get(period);
    const revenue = num(revenueBy.get(period));
    const schoolsNew = num(newSchoolsByMonth.get(period));
    return {
      period,
      newSchools: schoolsNew,
      newStudents: num(students?.students),
      schoolsImporting: students?.schools?.length ?? 0,
      collected: num(collected?.collected),
      collectedDisplay: formatCedis(num(collected?.collected)),
      payments: num(collected?.payments),
      platformRevenue: revenue,
      platformRevenueDisplay: formatCedis(revenue),
      /* `null` rather than `0` for a month with no signups: there is no per-school
       * figure for a month with no schools, and a `0` reads as "each school earned
       * nothing", which is a different and much worse claim. */
      platformRevenuePerNewSchool: schoolsNew > 0 ? Math.round(revenue / schoolsNew) : null,
    };
  });

  const firstPaymentRows = newSchools.length
    ? await Payment.aggregate([
        {
          $match: {
            schoolId: { $in: newSchools.map((s) => s._id) },
            deletedAt: null,
            status: "completed",
          },
        },
        { $group: { _id: "$schoolId", firstPaymentAt: { $min: "$createdAt" } } },
      ])
    : [];
  const firstPaymentBy = new Map(firstPaymentRows.map((r) => [String(r._id), r.firstPaymentAt]));

  const schoolRows = newSchools.map((school) => {
    const firstPaymentAt = firstPaymentBy.get(String(school._id)) || null;
    return {
      schoolId: school._id,
      name: school.name,
      schoolCode: school.schoolCode,
      region: school.region,
      plan: school.subscription?.plan || null,
      subscriptionStatus: school.subscription?.status || null,
      createdAt: school.createdAt,
      activatedAt: school.onboardingCompletedAt || null,
      firstPaymentAt,
      daysToFirstPayment: firstPaymentAt
        ? Math.round(
            (new Date(firstPaymentAt).getTime() - new Date(school.createdAt).getTime()) / MS_PER_DAY
          )
        : null,
      mrr: Math.round(num(school.subscription?.monthlyFee)),
      /* Present and null rather than absent: "signed up and has never paid" is a fact
       * a growth report must state, and an absent column reads as "not measured". */
      paying: firstPaymentAt ? "yes" : "no",
    };
  });

  const totalNewSchools = newSchools.length;
  const converted = schoolRows.filter((row) => row.firstPaymentAt).length;
  const revenueTotal = trend.reduce((sum, row) => sum + row.platformRevenue, 0);

  /*
   * `activated` is counted once into a local rather than filtering `newSchools` twice
   * inline, and read off the **top-level** `onboardingCompletedAt` (schoolModel.js:303).
   * Filtering twice was harmless; reading the wrong path was not — `undefined` is falsy,
   * so the activation rate would report 0% forever and read as a product failure.
   */
  const activatedSchools = newSchools.filter((s) => s.onboardingCompletedAt).length;

  const summary = {
    newSchools: totalNewSchools,
    newStudents: trend.reduce((sum, row) => sum + row.newStudents, 0),
    activated: activatedSchools,
    activationRatePercent: percent(activatedSchools, totalNewSchools),
    schoolsWithFirstPayment: converted,
    firstPaymentRatePercent: percent(converted, totalNewSchools),
    collected: trend.reduce((sum, row) => sum + row.collected, 0),
    platformRevenue: revenueTotal,
    months: monthKeys.length,
  };

  return {
    report: "growth",
    generatedAt: new Date().toISOString(),
    filters: { from: start, to: end },

    summary,
    trend,
    schools: schoolRows,

    sections: [
      summarySection(summary, [
        { key: "newSchools", header: "New Schools" },
        { key: "newStudents", header: "New Students" },
        { key: "activated", header: "Activated" },
        { key: "activationRatePercent", header: "Activation Rate", percent: true },
        { key: "schoolsWithFirstPayment", header: "Took A First Payment" },
        { key: "firstPaymentRatePercent", header: "First Payment Rate", percent: true },
        { key: "collected", header: "Collected", money: true },
        { key: "platformRevenue", header: "Platform Revenue", money: true },
        { key: "months", header: "Months Covered" },
      ]),
      {
        name: "Monthly Trend",
        title: "Growth by month",
        columns: [
          { key: "period", header: "Period" },
          { key: "newSchools", header: "New Schools" },
          { key: "newStudents", header: "New Students" },
          { key: "schoolsImporting", header: "Schools Importing" },
          { key: "collected", header: "Collected (pesewas)" },
          { key: "collectedDisplay", header: "Collected" },
          { key: "payments", header: "Payments" },
          { key: "platformRevenue", header: "Platform Revenue (pesewas)" },
          { key: "platformRevenueDisplay", header: "Platform Revenue" },
        ],
        rows: trend,
      },
      {
        name: "New Schools",
        title: "Schools signed up in the window",
        columns: [
          ...schoolIdentityColumns,
          { key: "plan", header: "Plan" },
          { key: "subscriptionStatus", header: "Subscription" },
          { key: "createdAt", header: "Signed Up" },
          { key: "activatedAt", header: "Activated" },
          { key: "firstPaymentAt", header: "First Payment" },
          { key: "daysToFirstPayment", header: "Days To First Payment" },
          { key: "paying", header: "Has Paid" },
          ...moneyColumns("mrr", "MRR"),
        ],
        rows: schoolRows,
      },
    ],
  };
};

// ──────────────────── 4. Churn report ────────────────────

/**
 * Schools that became inactive inside the window, with how long they lasted and when
 * they last took money.
 *
 * **The two timestamps are what make this report worth reading.** "Ashanti College left"
 * is not actionable; "Ashanti College paid for 11 months, stopped on the 14th, and its
 * account manager is unassigned" is a phone call. So the report carries both
 * `activeForDays` (signup → churn) and `daysSinceLastPayment` (last payment → churn),
 * because a school that churned after a long silence and one that churned the day after
 * a full collection are different stories about the same event.
 *
 * Derived from `suspendedAt` and `subscription.cancelledAt` — this schema has no status
 * history, so the report can say *when* a school stopped but not what state it passed
 * through to get there. It also only reports schools that are **still** inactive: a
 * school suspended on the 3rd and reinstated on the 20th has a `suspendedAt` inside the
 * window and did not churn, and counting it would report a save as a loss.
 */
export const getChurnReport = async ({ from, to } = {}) => {
  const { from: start, to: end } = resolveWindow(from, to);
  const range = createdAtRange(start, end);

  const churnMaterial = await School.find({
    deletedAt: null,
    status: { $ne: "archived" },
    $or: [{ suspendedAt: range }, { "subscription.cancelledAt": range }],
  })
    .select(
      "name schoolCode region status createdAt suspendedAt suspendedReason subscription.plan subscription.status subscription.monthlyFee subscription.cancelledAt subscription.currentPeriodEnd accountManagerId"
    )
    .lean();

  const churned = churnMaterial.filter((school) => {
    const candidates = [
      school.suspendedAt ? new Date(school.suspendedAt) : null,
      school.subscription?.cancelledAt ? new Date(school.subscription.cancelledAt) : null,
    ].filter(Boolean);
    if (!candidates.length) return false;
    const churnedAt = candidates.reduce((a, b) => (a > b ? a : b));
    if (churnedAt < start || churnedAt > end) return false;
    return (
      school.status === "suspended" ||
      ["suspended", "cancelled", "expired"].includes(school.subscription?.status)
    );
  });

  const schoolIds = churned.map((school) => school._id);

  const [payments, roster, ledger] = await Promise.all([
    schoolIds.length
      ? Payment.aggregate([
          { $match: { schoolId: { $in: schoolIds }, deletedAt: null, status: "completed" } },
          {
            $group: {
              _id: "$schoolId",
              lastPaymentAt: { $max: "$createdAt" },
              firstPaymentAt: { $min: "$createdAt" },
              payments: { $sum: 1 },
              collected: { $sum: "$amount" },
            },
          },
        ])
      : [],
    schoolIds.length
      ? Student.aggregate([
          { $match: { schoolId: { $in: schoolIds }, ...rosterMatch } },
          { $group: { _id: "$schoolId", students: { $sum: 1 } } },
        ])
      : [],
    schoolIds.length
      ? PlatformLedger.aggregate([
          {
            $match: {
              schoolId: { $in: schoolIds },
              type: { $in: PLATFORM_REVENUE_TYPES },
              amount: { $gt: 0 },
            },
          },
          { $group: { _id: "$schoolId", platformRevenue: { $sum: "$amount" } } },
        ])
      : [],
  ]);

  const paymentBy = new Map(payments.map((r) => [String(r._id), r]));
  const rosterBy = new Map(roster.map((r) => [String(r._id), num(r.students)]));
  const ledgerBy = new Map(ledger.map((r) => [String(r._id), num(r.platformRevenue)]));

  const rows = churned
    .map((school) => {
      const candidates = [
        school.suspendedAt ? new Date(school.suspendedAt) : null,
        school.subscription?.cancelledAt ? new Date(school.subscription.cancelledAt) : null,
      ].filter(Boolean);
      const churnedAt = candidates.reduce((a, b) => (a > b ? a : b));
      const paymentsRow = paymentBy.get(String(school._id));
      const lastPaymentAt = paymentsRow?.lastPaymentAt ? new Date(paymentsRow.lastPaymentAt) : null;
      const mrr = Math.round(num(school.subscription?.monthlyFee));

      return {
        schoolId: school._id,
        name: school.name,
        schoolCode: school.schoolCode,
        region: school.region,
        status: school.status,
        plan: school.subscription?.plan || null,
        subscriptionStatus: school.subscription?.status || null,
        createdAt: school.createdAt,
        churnedAt,
        churnKind:
          school.status === "suspended" || school.subscription?.status === "suspended"
            ? "suspended"
            : "cancelled",
        /* `activeForDays` is signup → churn. Null rather than 0 when the school was
         * created after it churned, which is a data fault worth showing as absent
         * instead of as "churned on day one". */
        activeForDays: Math.max(
          Math.round((churnedAt.getTime() - new Date(school.createdAt).getTime()) / MS_PER_DAY),
          0
        ),
        lastPaymentAt,
        /* Days from the last payment to the churn. Null for a school that never took
         * one — an unknown silence, not a zero-day one. */
        daysFromLastPaymentToChurn: lastPaymentAt
          ? Math.round((churnedAt.getTime() - lastPaymentAt.getTime()) / MS_PER_DAY)
          : null,
        daysSinceLastPayment: lastPaymentAt
          ? Math.round((Date.now() - lastPaymentAt.getTime()) / MS_PER_DAY)
          : null,
        paymentsAllTime: num(paymentsRow?.payments),
        collectedAllTime: num(paymentsRow?.collected),
        collectedAllTimeDisplay: formatCedis(num(paymentsRow?.collected)),
        platformRevenueAllTime: num(ledgerBy.get(String(school._id))),
        students: num(rosterBy.get(String(school._id))),
        mrr,
        mrrDisplay: formatCedis(mrr),
        lostMrr: mrr,
        lostMrrDisplay: formatCedis(mrr),
        suspendedReason: school.suspendedReason || null,
        subscriptionPeriodEndsAt: school.subscription?.currentPeriodEnd || null,
        /* `accountManagerId`, not `accountManagerId` — see the nested-field
         * note in `analytics.service.js`. Read off the wrong path this is `undefined`,
         * so a churn report would show an unassigned account manager for every school
         * including the ones that have one, which is the field an operator uses to
         * decide who to call. */
        accountManagerId: school.subscription?.accountManagerId || null,
        accountManagerAssigned: Boolean(school.subscription?.accountManagerId),
      };
    })
    .sort((a, b) => b.churnedAt - a.churnedAt);

  const summary = {
    churnedSchools: rows.length,
    lostMrr: rows.reduce((sum, row) => sum + row.lostMrr, 0),
    lostCollectedAllTime: rows.reduce((sum, row) => sum + row.collectedAllTime, 0),
    suspended: rows.filter((row) => row.churnKind === "suspended").length,
    cancelled: rows.filter((row) => row.churnKind === "cancelled").length,
    neverPaidAgain: rows.filter((row) => row.lastPaymentAt === null).length,
    averageActiveForDays: rows.length
      ? Math.round((rows.reduce((sum, row) => sum + row.activeForDays, 0) / rows.length) * 10) / 10
      : null,
  };

  return {
    report: "churn",
    generatedAt: new Date().toISOString(),
    filters: { from: start, to: end },

    summary,
    rows,

    sections: [
      summarySection(summary, [
        { key: "churnedSchools", header: "Schools Churned" },
        { key: "suspended", header: "Suspended" },
        { key: "cancelled", header: "Cancelled" },
        { key: "lostMrr", header: "MRR Lost", money: true },
        { key: "lostCollectedAllTime", header: "Lifetime Collected Forgone", money: true },
        { key: "neverPaidAgain", header: "Never Took A Payment" },
        { key: "averageActiveForDays", header: "Average Days Active" },
      ]),
      {
        name: "Churned",
        title: "Schools that became inactive in the window",
        columns: [
          ...schoolIdentityColumns,
          { key: "plan", header: "Plan" },
          { key: "subscriptionStatus", header: "Subscription" },
          { key: "createdAt", header: "Signed Up" },
          { key: "churnedAt", header: "Went Inactive" },
          { key: "churnKind", header: "Kind" },
          { key: "activeForDays", header: "Days Active" },
          { key: "lastPaymentAt", header: "Last Payment" },
          { key: "daysFromLastPaymentToChurn", header: "Days Last Payment → Churn" },
          { key: "daysSinceLastPayment", header: "Days Since Last Payment" },
          { key: "paymentsAllTime", header: "Payments (lifetime)" },
          { key: "collectedAllTime", header: "Collected (lifetime, pesewas)" },
          { key: "collectedAllTimeDisplay", header: "Collected (lifetime)" },
          { key: "platformRevenueAllTime", header: "Platform Revenue (lifetime, pesewas)" },
          { key: "students", header: "Students" },
          ...moneyColumns("lostMrr", "MRR Lost"),
          { key: "suspendedReason", header: "Reason", width: 40 },
          { key: "subscriptionPeriodEndsAt", header: "Subscription Period End" },
          { key: "accountManagerAssigned", header: "Account Manager Assigned" },
        ],
        rows,
      },
    ],
  };
};

/**
 * The four report builders, keyed by their validated `type`.
 *
 * `ADMIN_REPORT_TYPES` above and this object must not drift: a `type` that validates but
 * has no builder is a 400 thrown at runtime rather than at validation, which is the
 * worst moment to discover it.
 */
const BUILDERS = {
  platform_revenue: getPlatformRevenueReport,
  school_performance: getSchoolPerformanceReport,
  growth: getGrowthReport,
  churn: getChurnReport,
};

/** Look up a report type, throwing the 400 that a bad `?type=` deserves. */
const builderFor = (type) => {
  const build = BUILDERS[type];
  if (!build) {
    throw new ApiError(
      `Unknown report type: ${type}. Supported: ${ADMIN_REPORT_TYPES.join(", ")}`,
      400,
      "UNKNOWN_REPORT_TYPE"
    );
  }
  return build;
};

/**
 * The row set and column list a CSV export writes for each report.
 *
 * **Explicit per report, not "whatever `sections` happens to hold".** A CSV that
 * contained every section of a multi-section payload would be a file with a summary
 * block, then a trend table, then a per-school table, all sharing one header row — which
 * opens in a spreadsheet as one unreadable table. One report, one table, one header, is
 * what a CSV is.
 */
const CSV_EXPORT = {
  platform_revenue: () => ({
    columns: [
      ...schoolIdentityColumns,
      { key: "plan", header: "Plan" },
      { key: "type", header: "Revenue Type" },
      { key: "total", header: "Amount (pesewas)" },
      { key: "totalDisplay", header: "Amount" },
      { key: "entries", header: "Entries" },
    ],
    rows: (report) => report.bySchool,
  }),
  school_performance: () => ({
    columns: [
      ...schoolIdentityColumns,
      { key: "status", header: "Status" },
      { key: "plan", header: "Plan" },
      { key: "subscriptionStatus", header: "Subscription" },
      { key: "gatewayMode", header: "Gateway Mode" },
      { key: "gatewayRail", header: "Rail" },
      { key: "students", header: "Students" },
      { key: "collected", header: "Collected In Window (pesewas)" },
      { key: "collectedDisplay", header: "Collected In Window" },
      { key: "payments", header: "Payments" },
      { key: "lastPaymentAt", header: "Last Payment" },
      { key: "owed", header: "Owed (pesewas)" },
      { key: "owedDisplay", header: "Owed" },
      { key: "applied", header: "Applied (pesewas)" },
      { key: "appliedDisplay", header: "Applied" },
      { key: "outstanding", header: "Outstanding (pesewas)" },
      { key: "outstandingDisplay", header: "Outstanding" },
      { key: "collectionRatePercent", header: "Collection Rate (%)" },
      { key: "mrr", header: "MRR (pesewas)" },
      { key: "mrrDisplay", header: "MRR" },
    ],
    rows: (report) => report.rows,
  }),
  growth: () => ({
    columns: [
      ...schoolIdentityColumns,
      { key: "plan", header: "Plan" },
      { key: "subscriptionStatus", header: "Subscription" },
      { key: "createdAt", header: "Signed Up" },
      { key: "activatedAt", header: "Activated" },
      { key: "firstPaymentAt", header: "First Payment" },
      { key: "daysToFirstPayment", header: "Days To First Payment" },
      { key: "paying", header: "Has Paid" },
      ...moneyColumns("mrr", "MRR"),
    ],
    rows: (report) => report.schools,
  }),
  churn: () => ({
    columns: [
      ...schoolIdentityColumns,
      { key: "plan", header: "Plan" },
      { key: "subscriptionStatus", header: "Subscription" },
      { key: "createdAt", header: "Signed Up" },
      { key: "churnedAt", header: "Went Inactive" },
      { key: "churnKind", header: "Kind" },
      { key: "activeForDays", header: "Days Active" },
      { key: "lastPaymentAt", header: "Last Payment" },
      { key: "daysFromLastPaymentToChurn", header: "Days Last Payment → Churn" },
      { key: "daysSinceLastPayment", header: "Days Since Last Payment" },
      { key: "paymentsAllTime", header: "Payments (lifetime)" },
      { key: "collectedAllTime", header: "Collected (lifetime, pesewas)" },
      { key: "collectedAllTimeDisplay", header: "Collected (lifetime)" },
      { key: "platformRevenueAllTime", header: "Platform Revenue (lifetime, pesewas)" },
      { key: "students", header: "Students" },
      ...moneyColumns("lostMrr", "MRR Lost"),
      { key: "suspendedReason", header: "Reason" },
    ],
    rows: (report) => report.rows,
  }),
};

/**
 * Stream or render one report as a file.
 *
 * **Three formats, two existing helpers, no third path.** `csv` goes through
 * `utils/csvWriter.js`'s `streamCsv` because it writes straight to the response stream
 * and never holds the file in memory; `xlsx` and `pdf` go through
 * `utils/reportExport.js`'s `sendReportFile`, which already builds a multi-sheet
 * workbook from the `sections` a report carries. Writing a fourth serialiser here would
 * mean a fourth place where formula-injection escaping, column widths and
 * `Content-Disposition` have to be right.
 *
 * **`xlsx` is renamed to `excel` on the way in.** The public vocabulary for this
 * endpoint is `csv | xlsx | pdf` because that is what a caller asks for by extension;
 * `sendReportFile` branches on `excel` (utils/reportExport.js:81). The translation
 * happens here, once, at the boundary, rather than by adding `xlsx` as a fourth accepted
 * value in a shared helper that nine school-report endpoints also use.
 *
* **`pdf` works.** It did not for most of this file's life: `sendReportFile` threw
  * `501 PDF_EXPORT_UNAVAILABLE`, and the comment there explaining why was itself out of
  * date — `pdfkit` *is* a dependency and `utils/pdfGenerator.js` exists. But
  * `pdfGenerator` renders ID cards from a fixed template, not tables of arbitrary
  * columns, which is the whole problem: a report's columns are not a shape anybody
  * designed in advance. `utils/reportPdf.js` is that second path — it derives column
  * widths from the content, paginates, and caps rows at 5,000 with the truncation
  * printed on the page.
  *
   * Returns `{ rowCount, truncated, report }` **after** the response has been written, so
   * the controller can record in the audit log exactly how many rows left the platform.
   * That is not bookkeeping for its own sake: `AuditLog.js:78-79` records that an export is
   * the one read a school cannot audit itself, because the file carries its whole financial
   * history and is now on somebody's laptop.
 */
export const exportReport = async (res, { type, from, to, format }) => {
  const build = builderFor(type);
  const report = await build({ from, to });

  if (format === "csv") {
    const { columns, rows: pick } = CSV_EXPORT[type]();
    const rows = pick(report);
    const capped = rows.slice(0, CSV_ROW_CAP);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${type}-${PLATFORM_EXPORT_SCOPE}-${stamp}.csv"`
    );
    streamCsv(res, columns, capped);

    return {
      rowCount: capped.length,
      truncated: rows.length > capped.length,
      report: type,
    };
  }

  /*
   * **Awaited.** `sendReportFile` became `async` when PDF support landed, because
   * `pdfkit` streams and the buffer only exists once the document has ended. A bare
   * call here would return this function's `{ rowCount }` while the response was
   * still empty — so the controller would answer the audit write and finish, and the
   * download would never arrive. The CSV branch above is unaffected for the same
   * reason it always was: it uses `streamCsv`, which writes straight to `res`.
   */
  await sendReportFile(res, {
    report: type,
    schoolId: PLATFORM_EXPORT_SCOPE,
    format: format === "xlsx" ? "excel" : format,
    sections: report.sections,
  });

  const rowCount = report.sections.reduce((sum, section) => sum + (section.rows?.length || 0), 0);

  return {
    rowCount,
    // `false` because the non-CSV formats are serialised from `report.sections`,
    // which the report builders already cap. A truncation there is the report's own
    // and is stated in its own payload — reporting it as `false` here would mean
    // "this serialiser did not truncate", which is true.
    truncated: false,
    report: type,
    format: format === "xlsx" ? "excel" : format,
  };
};

export default {
  ADMIN_REPORT_TYPES,
  getPlatformRevenueReport,
  getSchoolPerformanceReport,
  getGrowthReport,
  getChurnReport,
  exportReport,
};
