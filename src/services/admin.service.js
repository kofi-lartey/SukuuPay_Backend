import mongoose from "mongoose";
import { School } from "../models/schoolModel.js";
import { User } from "../models/userModel.js";
import { Payment } from "../models/paymentModel.js";
import { AuditLog } from "../models/AuditLog.js";
import {
  PlatformSettings,
  DEFAULT_PLATFORM_SETTINGS,
  NESTED_PLATFORM_SETTINGS_BRANCHES,
} from "../models/PlatformSettings.js";
import { invalidatePlatformSettingsCache } from "./platformSettings.service.js";
import ApiError from "../utils/ApiError.js";
import { AUDIT_ACTIONS } from "../config/constants.js";
import {
  suspendSchool,
  unsuspendSchool,
} from "./school.service.js";

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// ──────────────────── List all schools (platform view) ────────────────────
export const listAllSchools = async (query) => {
  const {
    page = 1,
    perPage = 20,
    status,
    region,
    plan,
    tag,
    search,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = query;

  const filter = { deletedAt: null };
  if (status) filter.status = status;
  if (region) filter.region = region;
  if (plan) filter["subscription.plan"] = plan;

  /*
   * `tag` filters on `subscription.tags`, which is where the field actually is —
   * see the note on `PLATFORM_FIELD_PATHS` in `services/admin/schools.service.js`.
   * Filtering `tags` at the top level would return nothing and look like "no school
   * carries that label", which is the failure a label system cannot afford.
   *
   * Lowercased to match the normalisation `updateSchoolTags` applies on write: the
   * tag vocabulary is free text, so `"Pilot"` and `"pilot"` are the same operator
   * intent and the filter has to agree with the write side or it silently matches
   * an empty set.
   */
  if (tag) filter["subscription.tags"] = String(tag).trim().toLowerCase();

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { schoolCode: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
      { city: { $regex: search, $options: "i" } },
    ];
  }

  const sort = { [sortBy]: sortOrder === "desc" ? -1 : 1 };
  const skip = (Number(page) - 1) * Number(perPage);

  const [schools, total] = await Promise.all([
    School.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(Number(perPage))
      // Explicit projections rather than "everything but". The console's schools
      // table needs the commercial terms on every row — what this school pays the
      // platform, what is switched on, when it onboarded — so they are named here.
      // `sms.apiKey` is `select: false` on the model and therefore absent
      // already; it is listed so that a reader can verify the console returns no
      // gateway credential from *any* of them, rather than having to know
      // which one happens to be flagged today.
      .select("-sms.apiKey")
      .lean(),
    School.countDocuments(filter),
  ]);

  const schoolIds = schools.map((s) => s._id);
  const schoolIdObjs = schoolIds.map((id) => new mongoose.Types.ObjectId(id));

  const [studentCounts, paymentVolume, userCounts, lastPayments] = await Promise.all([
    User.aggregate([
      { $match: { schoolId: { $in: schoolIdObjs }, role: "student", deletedAt: null } },
      { $group: { _id: "$schoolId", count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      {
        $match: {
          schoolId: { $in: schoolIdObjs },
          status: "completed",
          deletedAt: null,
        },
      },
      { $group: { _id: "$schoolId", totalAmount: { $sum: "$amount" } } },
    ]),
    User.aggregate([
      { $match: { schoolId: { $in: schoolIdObjs }, role: { $in: ["school_admin", "accountant", "teacher"] }, deletedAt: null } },
      { $group: { _id: "$schoolId", count: { $sum: 1 } } },
    ]),
    /*
     * The most recent *completed* payment per school.
     *
     * `$max` rather than `$sort`+`$first` because this runs inside the same
     * aggregation as the volume figure: a school that has never taken a payment
     * produces no group at all rather than a group with a null, and the map lookup
     * below defaults it to `null` — which is the honest answer for "this school has
     * never collected", and distinguishable from "the query failed to answer".
     *
     * Restricted to `completed` deliberately. A `pending` payment is an attempt, not
     * revenue, and a table of last-activity dates built from attempts reports a
     * school that has been abandoned mid-transaction as the busiest tenant on the
     * page.
     */
    Payment.aggregate([
      {
        $match: {
          schoolId: { $in: schoolIdObjs },
          status: "completed",
          deletedAt: null,
        },
      },
      { $group: { _id: "$schoolId", lastPaymentAt: { $max: "$createdAt" } } },
    ]),
  ]);

  const studentCountMap = new Map();
  studentCounts.forEach((entry) => studentCountMap.set(String(entry._id), entry.count));

  const paymentVolumeMap = new Map();
  paymentVolume.forEach((entry) => paymentVolumeMap.set(String(entry._id), entry.totalAmount));

  const userCountMap = new Map();
  userCounts.forEach((entry) => userCountMap.set(String(entry._id), entry.count));

  const lastPaymentMap = new Map();
  lastPayments.forEach((entry) => lastPaymentMap.set(String(entry._id), entry.lastPaymentAt));

  const schoolsWithStats = schools.map((school) => ({
    ...school,
    studentCount: studentCountMap.get(String(school._id)) || 0,
    staffCount: userCountMap.get(String(school._id)) || 0,
    paymentVolume: paymentVolumeMap.get(String(school._id)) || 0,
    lastPaymentAt: lastPaymentMap.get(String(school._id)) || null,
    /*
     * Hoisted out of `subscription` so the table can render a row without reaching
     * into a billing subdocument, and so the three values have one obvious home.
     * The originals stay on the object: this is a *view*, not a move, and anything
     * reading the canonical path (`updateSchoolMarkup`, the finance aggregations)
     * must not have it rewritten underneath it.
     */
    platformFeePercent: school.subscription?.platformFeePercent ?? 0,
    tags: school.subscription?.tags ?? [],
    featureFlags: school.subscription?.featureFlags ?? null,
    onboardingCompletedAt: school.onboardingCompletedAt ?? school.subscription?.onboardingCompletedAt ?? (school.name && school.region ? school.createdAt : null),
  }));

  return {
    data: schoolsWithStats,
    meta: {
      page: Number(page),
      perPage: Number(perPage),
      total,
      pages: Math.ceil(total / Number(perPage)),
    },
  };
};

// ──────────────────── Platform-wide revenue ────────────────────
export const getPlatformRevenue = async (query) => {
  const {
    startDate,
    endDate,
    period = "all",
    plan,
    region,
  } = query;

  const matchFilter = { status: "completed", deletedAt: null };

  if (startDate) {
    matchFilter.createdAt = { ...matchFilter.createdAt, $gte: new Date(startDate) };
  }
  if (endDate) {
    matchFilter.createdAt = { ...matchFilter.createdAt, $lte: new Date(endDate) };
  }

  let dateRanges = null;
  const now = new Date();

  if (period === "mtd") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    dateRanges = { gte: start, lte: now };
  } else if (period === "ytd") {
    const start = new Date(now.getFullYear(), 0, 1);
    dateRanges = { gte: start, lte: now };
  } else if (period === "last30") {
    const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    dateRanges = { gte: start, lte: now };
  }

  if (dateRanges) {
    matchFilter.createdAt = {
      ...(matchFilter.createdAt || {}),
      $gte: dateRanges.gte,
      $lte: dateRanges.lte,
    };
  }

  const basePipeline = [{ $match: matchFilter }];

  const schoolLookup = {
    $lookup: {
      from: "schools",
      localField: "schoolId",
      foreignField: "_id",
      as: "school",
    },
  };

  const unwindSchool = { $unwind: "$school" };

  const schoolMatch = {};
  if (plan) schoolMatch["school.subscription.plan"] = plan;
  if (region) schoolMatch["school.region"] = region;

  if (Object.keys(schoolMatch).length) {
    basePipeline.push(schoolLookup, unwindSchool, { $match: schoolMatch });
  }

  const [revenueResult, platformMarkupResult] = await Promise.all([
    Payment.aggregate([
      ...basePipeline,
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$amount" },
          totalPayments: { $sum: 1 },
          avgPayment: { $avg: "$amount" },
        },
      },
    ]),
    Payment.aggregate([
      ...basePipeline,
      {
        $lookup: {
          from: "schools",
          localField: "schoolId",
          foreignField: "_id",
          as: "school",
        },
      },
      { $unwind: "$school" },
      {
        $addFields: {
          markupAmount: {
            $multiply: [
              { $divide: ["$amount", 100] },
              { $ifNull: ["$school.payment.platformMarkupPercent", 0] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          totalMarkup: { $sum: "$markupAmount" },
        },
      },
    ]),
  ]);

  const totalRevenue = revenueResult[0]?.totalRevenue || 0;
  const totalMarkup = platformMarkupResult[0]?.totalMarkup || 0;

  return {
    summary: {
      totalRevenue,
      totalPayments: revenueResult[0]?.totalPayments || 0,
      avgPayment: revenueResult[0]?.avgPayment || 0,
      platformMarkupRevenue: Math.round(totalMarkup),
    },
    filters: {
      period: period === "all" ? "all" : period,
      startDate: startDate || null,
      endDate: endDate || null,
      plan: plan || null,
      region: region || null,
    },
  };
};

// ──────────────────── Revenue over time (platform view) ────────────────────
//
// The reason this exists at all: `getPlatformRevenue` returns aggregates, and every
// `/api/analytics/*` route is school-scoped (`analytics.routes.js` — each path ends
// `/:schoolId`). So there was no endpoint anywhere in the API that could plot
// platform revenue over time, and the frontend's only options were a line through
// `mtdRevenue` and `ytdRevenue` — which is invented data wearing a chart's clothes.
//
// Bucket choice is a parameter rather than a guess, because the two are not
// interchangeable: 30 daily points for "last 30 days" and 24 monthly points for
// "this year", and a caller picking the wrong one gets a graph whose shape depends
// on how the data happened to be sampled.

const addMonths = (date, count) => {
  const next = new Date(date.getTime());
  next.setMonth(next.getMonth() + count);
  return next;
};

/**
 * Month and day keys are built in **local time on the server**, and Mongo is asked
 * for UTC buckets.
 *
 * Those are different calendars, and the mismatch is the bug: `$dateToString` with
 * no `timezone` truncates in UTC, so for a server in `Africa/Accra` (UTC+0, same
 * offset, fine) it agrees, but for anything west of Greenwich the first bucket
 * silently shifts and a month boundary lands on the wrong side of a payment. Buckets
 * are therefore computed in JS from the server's own calendar rather than trusted to
 * a `$group` the reader cannot verify, and the aggregation only sums.
 */
export const getRevenueSeries = async (query) => {
  const {
    bucket = "month",
    period = "ytd",
    startDate,
    endDate,
    plan,
    region,
  } = query;

  const now = new Date();
  let from;
  let to = endDate ? new Date(endDate) : now;

  if (startDate) {
    from = new Date(startDate);
  } else if (period === "last30") {
    from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else if (period === "mtd") {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (period === "all") {
    from = new Date(now.getFullYear() - 2, 0, 1);
  } else {
    // ytd
    from = new Date(now.getFullYear(), 0, 1);
  }

  const matchFilter = {
    status: "completed",
    deletedAt: null,
    createdAt: { $gte: from, $lte: to },
  };

  const pipeline = [{ $match: matchFilter }];

  if (plan || region) {
    pipeline.push(
      {
        $lookup: {
          from: "schools",
          localField: "schoolId",
          foreignField: "_id",
          as: "school",
        },
      },
      { $unwind: "$school" }
    );
    const schoolMatch = {};
    if (plan) schoolMatch["school.subscription.plan"] = plan;
    if (region) schoolMatch["school.region"] = region;
    if (Object.keys(schoolMatch).length) pipeline.push({ $match: schoolMatch });
  }

  pipeline.push({
    $group: {
      _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
      totalRevenue: { $sum: "$amount" },
      totalPayments: { $sum: 1 },
    },
  });

  const rows = await Payment.aggregate(pipeline);

  const byKey = new Map(
    rows.map((row) => [row._id, { totalRevenue: row.totalRevenue, totalPayments: row.totalPayments }])
  );

  /*
   * Day buckets need a second aggregation: the month-level `$group` above has
   * already collapsed the days away, and a month key is not a substitute for a day
   * one — faking it would put 24 identical points on the chart.
   *
   * `byDay` is local to this invocation, deliberately. An earlier version cached the
   * daily totals in a module-level `Map`, which is the wrong shape for a concurrent
   * request handler: two overlapping calls with different filters interleave their
   * writes into one shared cache and each returns the other's numbers.
   */
  let dayTotals = null;
  if (bucket === "day") {
    const dailyRows = await Payment.aggregate([
      ...pipeline.slice(0, pipeline.length - 1),
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          totalRevenue: { $sum: "$amount" },
          totalPayments: { $sum: 1 },
        },
      },
    ]);
    dayTotals = new Map(
      dailyRows.map((row) => [row._id, { totalRevenue: row.totalRevenue, totalPayments: row.totalPayments }])
    );
  }

  const series = buildCalendarSeries(dayTotals || byKey, from, to, bucket);

  return {
    series,
    filters: {
      bucket,
      period,
      startDate: from,
      endDate: to,
      plan: plan || null,
      region: region || null,
    },
    totals: {
      totalRevenue: series.reduce((sum, point) => sum + point.totalRevenue, 0),
      totalPayments: series.reduce((sum, point) => sum + point.totalPayments, 0),
    },
  };
};

const pad = (value) => String(value).padStart(2, "0");

/** `2026-03-01` → `2026-03`, the key the month-level `$group` produces. */
export const monthKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;

/** `2026-03-01` → `2026-03-01`, the key the day-level `$group` produces. */
export const dayKey = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * Turn `{ "2026-03": 1200 }`-shaped totals into a series with **no gaps**.
 *
 * Pure, and exported, because this is the one part of the endpoint worth testing
 * without a database — and it is the part that decides whether the chart tells the
 * truth.
 *
 * The bug this exists to prevent: mapping the aggregate rows. A month nobody paid
 * produces no row, so the series would simply omit it and the client would draw a
 * straight line across the hole — presenting a month of zero revenue as smooth
 * growth. Walking the calendar instead emits an explicit `0`, which renders as a
 * dip to the baseline. "Nobody paid" and "we have no data" look identical once a
 * chart has drawn over them, and that is the whole reason to prefer a zero.
 *
 * Also caps the length, because an unbounded walk over a ten-year `all` range is a
 * thousand-point array and a hung tab.
 */
export const buildCalendarSeries = (totalsByKey, from, to, bucket = "month") => {
  const cap = bucket === "day" ? 400 : 120;
  const series = [];

  if (bucket === "day") {
    const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const last = new Date(to.getFullYear(), to.getMonth(), to.getDate());
    while (cursor <= last && series.length < cap) {
      series.push({ period: dayKey(cursor), ...(totalsByKey.get(dayKey(cursor)) || { totalRevenue: 0, totalPayments: 0 }) });
      cursor.setDate(cursor.getDate() + 1);
    }
    return series;
  }

  const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
  while (cursor <= to && series.length < cap) {
    series.push({ period: monthKey(cursor), ...(totalsByKey.get(monthKey(cursor)) || { totalRevenue: 0, totalPayments: 0 }) });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return series;
};

// ──────────────────── Platform settings ────────────────────

/**
 * Read the singleton, defaulted in code.
 *
 * Deliberately **not** an upsert: a GET that writes needs write permissions, is not
 * safe to call concurrently before the document exists, and would race the unique
 * index on `singletonKey`. Merging the stored document over the defaults means a
 * settings page added to the product before the collection has a row in it renders
 * real values rather than an error.
 */
export const getPlatformSettings = async () => {
  const stored = await PlatformSettings.findOne({ singletonKey: "platform" }).lean();

  if (!stored) {
    return { ...DEFAULT_PLATFORM_SETTINGS, updatedBy: null, updatedAt: null };
  }

  // Merged per branch rather than spread over the top level: a stored document with
  // `features` but no `maintenance` — which is what an older write looks like —
  // would otherwise replace the whole maintenance default with `undefined`.
  // `NESTED_PLATFORM_SETTINGS_BRANCHES` is the shared list, so a branch added to
  // the defaults is merged here without anyone remembering to add it twice.
  const merged = { ...DEFAULT_PLATFORM_SETTINGS, ...stored };
  NESTED_PLATFORM_SETTINGS_BRANCHES.forEach((branch) => {
    merged[branch] = {
      ...DEFAULT_PLATFORM_SETTINGS[branch],
      ...(stored?.[branch] || {}),
    };
  });

  return merged;
};

/**
 * Write the singleton, recording who did it and what changed.
 *
 * `findOneAndUpdate` with `upsert` rather than `create`, because the second create
 * would hit the unique index — and an E11000 surfaced to an operator as "save
 * failed" is a worse answer than an upsert that cannot fail.
 *
 * Returns the before/after pair the caller writes to the audit log. Both matter:
 * `settings.update` without a `before` records that something changed but not what,
 * which does not answer the question the audit exists for.
 */
export const updatePlatformSettings = async (patch, updatedById) => {
  const before = await getPlatformSettings();

  const updated = await PlatformSettings.findOneAndUpdate(
    { singletonKey: "platform" },
    { $set: { ...patch, singletonKey: "platform" }, updatedBy: updatedById || null },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();

  // Invalidate **after** the write, not before.
  //
  // The readers in `platformSettings.service.js` cache for 30 seconds, and the
  // maintenance middleware reads that cache on every request — so without this, an
  // operator toggling `maintenance.mode` would flip a switch that does nothing for up
  // to half a minute, and would have no way to tell whether it had worked. In-process
  // only: on a multi-instance deploy the other instances still serve the stale value
  // until their TTL lapses, which is why the TTL is short.
  invalidatePlatformSettingsCache();

  return { before, after: updated, changed: diffSettings(before, updated) };
};

/**
 * Fields excluded from the diff.
 *
 * Not a style choice. `before` comes from `getPlatformSettings` (which has
 * `updatedAt: null` on a fresh database) and `after` is the document mongoose just
 * stamped — so without this, **every** write reported `updatedAt`, `updatedBy` and
 * `_id` as three extra "changes" alongside the real one. The audit entry then reads
 * `defaultMarkupPercent: 5→6, updatedAt: null→2026-…`, and the first of those is the
 * one anybody is looking for, buried in bookkeeping.
 *
 * A diff that reports the database's own metadata is a diff nobody reads.
 */
const DIFF_EXCLUDED = new Set(["_id", "__v", "createdAt", "updatedAt", "updatedBy", "singletonKey"]);

/**
 * The leaf paths that actually differ.
 *
 * Reported as flat `a.b` strings rather than a nested object because that is what a
 * reader wants from an audit entry: "features.trialDays" is answerable at a glance, a
 * three-level diff is not. Comparing leaves rather than `JSON.stringify`-ing the
 * whole document is what stops a no-op PUT being logged as a change.
 */
const diffSettings = (before, after) => {
  const changed = [];
  const walk = (a, b, path) => {
    if (path && DIFF_EXCLUDED.has(path.split(".").pop())) return;
    if (a && b && typeof a === "object" && typeof b === "object") {
      Object.keys({ ...a, ...b }).forEach((key) =>
        walk(a[key], b[key], path ? `${path}.${key}` : key)
      );
      return;
    }
    if (String(a ?? "") !== String(b ?? "")) {
      changed.push({ path, from: a ?? null, to: b ?? null });
    }
  };
  walk(before, after, "");
  return changed;
};

// ──────────────────── Settings sub-resources ────────────────────

/**
 * `PUT /admin/settings/commission` — the two percentages SukuuPay takes.
 *
 * A separate entry point rather than a branch of `updatePlatformSettings`, for one
 * reason: **these are the numbers the platform earns, and everything else in the
 * settings document is configuration.** The console puts a confirmation in front of
 * exactly this call, and an endpoint that also accepted `maintenance.mode` or
 * `sms.provider` would make that confirmation cover changes the operator was not
 * thinking about.
 *
 * Thin by design — it validates nothing that `updatePlatformSettings` does not, and
 * delegates the write, so there is exactly one place that writes the singleton and
 * exactly one place that invalidates the cache.
 */
export const updateCommission = async (patch, updatedById) =>
  updatePlatformSettings(
    {
      defaultMarkupPercent: patch.defaultMarkupPercent,
      defaultPlatformFeePercent: patch.defaultPlatformFeePercent,
    },
    updatedById
  );

/**
 * `PUT /admin/settings/disbursement` — payout schedule, and whether it self-approves.
 *
 * **`autoApprove` is the most consequential boolean in this product** and is the
 * reason this is a named endpoint: it is the difference between a payout run needing
 * one human click and money leaving the platform unattended. It defaults to `false`
 * in the schema, so a client that sends only `frequency` cannot turn it on by
 * omission — and because this function passes through exactly the keys it was given,
 * a partial body leaves `autoApprove` as it was rather than as `undefined`.
 *
 * That last part is why it does not spread `patch` blindly: `{ ...undefined }` on an
 * omitted key writes `undefined`, which Mongoose's `$set` turns into an actual field
 * removal on some paths. Naming the three fields is the fix, and it also means a
 * client cannot smuggle a fourth key into the singleton through this route.
 */
export const updateDisbursementSettings = async (patch, updatedById) => {
  const next = {};
  if (patch.frequency !== undefined) next.frequency = patch.frequency;
  if (patch.dayOfWeek !== undefined) next.dayOfWeek = patch.dayOfWeek;
  if (patch.autoApprove !== undefined) next.autoApprove = patch.autoApprove;

  return updatePlatformSettings({ disbursement: next }, updatedById);
};

// ──────────────────── Platform-wide SMS balance ────────────────────
export const getPlatformSmsBalance = async () => {
  const [schoolSms, userCounts] = await Promise.all([
    School.aggregate([
      { $match: { deletedAt: null } },
      {
        $group: {
          _id: null,
          totalBalance: { $sum: "$sms.balance" },
          totalSchools: { $sum: 1 },
          providerBreakdown: {
            $push: {
              provider: "$sms.provider",
              balance: "$sms.balance",
            },
          },
        },
      },
    ]),
    User.aggregate([
      { $match: { deletedAt: null, role: "student" } },
      { $count: "totalStudents" },
    ]),
  ]);

  const result = schoolSms[0];

  return {
    totalBalance: result?.totalBalance || 0,
    totalSchools: result?.totalSchools || 0,
  };
};

// ──────────────────── School usage stats ────────────────────
export const getSchoolUsage = async (schoolId) => {
  if (!isValidObjectId(schoolId)) {
    throw new ApiError("Invalid school ID", 400, "INVALID_ID");
  }

  const school = await School.findOne({ _id: schoolId, deletedAt: null }).select(
    "name schoolCode subscription stats sms"
  ).lean();

  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  const schoolObjId = new mongoose.Types.ObjectId(schoolId);

  const [
    studentCount,
    staffCount,
    parentCount,
    paymentStats,
    pendingPlanCount,
    recentAuditLogs,
  ] = await Promise.all([
    User.countDocuments({ schoolId: schoolObjId, role: "student", deletedAt: null }),
    User.countDocuments({
      schoolId: schoolObjId,
      role: { $in: ["school_admin", "accountant", "teacher"] },
      deletedAt: null,
    }),
    User.countDocuments({ schoolId: schoolObjId, role: "parent", deletedAt: null }),
    Payment.aggregate([
      { $match: { schoolId: schoolObjId, deletedAt: null } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
    ]),
    Payment.countDocuments({
      schoolId: schoolObjId,
      status: { $in: ["pending", "processing"] },
      deletedAt: null,
    }),
    AuditLog.find({ schoolId: schoolObjId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
  ]);

  const statusBreakdown = {};
  let totalRevenueAll = 0;
  let totalPending = 0;

  paymentStats.forEach((entry) => {
    statusBreakdown[entry._id] = {
      count: entry.count,
      amount: entry.totalAmount,
    };
    if (entry._id === "completed") {
      totalRevenueAll += entry.totalAmount;
    }
    if (entry._id === "pending" || entry._id === "processing") {
      totalPending += entry.totalAmount;
    }
  });

  return {
    school: {
      _id: school._id,
      name: school.name,
      schoolCode: school.schoolCode,
      status: school.status,
      subscription: school.subscription,
      sms: {
        provider: school.sms.provider,
        balance: school.sms.balance,
        senderId: school.sms.senderId,
      },
    },
    counts: {
      students: studentCount,
      staff: staffCount,
      parents: parentCount,
    },
    payments: {
      totalRevenue: totalRevenueAll,
      statusBreakdown,
      pendingAmount: totalPending,
      pendingPlans: pendingPlanCount,
    },
    stats: school.stats || {},
    recentActivity: recentAuditLogs,
  };
};

// ──────────────────── Suspend school (platform admin) ────────────────────
export const suspendSchoolPlatform = async (schoolId, reason, requester) => {
  return suspendSchool(schoolId, reason, requester);
};

// ──────────────────── Unsuspend school (platform admin) ────────────────────
export const unsuspendSchoolPlatform = async (schoolId, requester) => {
  return unsuspendSchool(schoolId, requester);
};

// ──────────────────── Dashboard KPIs ────────────────────
export const getDashboardKpis = async () => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  const [
    schoolStats,
    userStats,
    paymentStats,
    mtdRevenue,
    ytdRevenue,
    platformMarkup,
    pendingPayouts,
    smsBalance,
    recentSchools,
  ] = await Promise.all([
    School.aggregate([
      { $match: { deletedAt: null } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
          suspended: { $sum: { $cond: [{ $eq: ["$status", "suspended"] }, 1, 0] } },
          archived: { $sum: { $cond: [{ $eq: ["$status", "archived"] }, 1, 0] } },
          trial: { $sum: { $cond: [{ $eq: ["$subscription.status", "trial"] }, 1, 0] } },
          paid: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ["$subscription.status", "trial"] }, { $ne: ["$subscription.status", "suspended"] }, { $ne: ["$subscription.status", "cancelled"] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    User.aggregate([
      { $match: { deletedAt: null } },
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          totalStudents: { $sum: { $cond: [{ $eq: ["$role", "student"] }, 1, 0] } },
          totalStaff: {
            $sum: {
              $cond: [
                { $in: ["$role", ["school_admin", "accountant", "teacher"]] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    Payment.aggregate([
      { $match: { deletedAt: null, status: "completed" } },
      {
        $group: {
          _id: null,
          totalPayments: { $sum: 1 },
          totalRevenue: { $sum: "$amount" },
        },
      },
    ]),
    Payment.aggregate([
      {
        $match: {
          deletedAt: null,
          status: "completed",
          createdAt: { $gte: startOfMonth, $lte: now },
        },
      },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),
    Payment.aggregate([
      {
        $match: {
          deletedAt: null,
          status: "completed",
          createdAt: { $gte: startOfYear, $lte: now },
        },
      },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),
    Payment.aggregate([
      {
        $match: { deletedAt: null, status: "completed" },
      },
      {
        $lookup: {
          from: "schools",
          localField: "schoolId",
          foreignField: "_id",
          as: "school",
        },
      },
      { $unwind: "$school" },
      {
        $addFields: {
          markup: {
            $multiply: [
              { $divide: ["$amount", 100] },
              { $ifNull: ["$school.payment.platformMarkupPercent", 0] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          totalMarkup: { $sum: "$markup" },
        },
      },
    ]),
    Payment.aggregate([
      { $match: { deletedAt: null, status: "pending" } },
      {
        $group: {
          _id: null,
          amount: { $sum: "$amount" },
        },
      },
    ]),
    School.aggregate([
      { $match: { deletedAt: null } },
      {
        $group: {
          _id: null,
          total: { $sum: "$sms.balance" },
        },
      },
    ]),
    School.find({ deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(5)
      .select("name schoolCode status subscription createdAt")
      .lean(),
  ]);

  return {
    schools: {
      total: schoolStats[0]?.total || 0,
      active: schoolStats[0]?.active || 0,
      suspended: schoolStats[0]?.suspended || 0,
      archived: schoolStats[0]?.archived || 0,
      onTrial: schoolStats[0]?.trial || 0,
      paid: schoolStats[0]?.paid || 0,
    },
    users: {
      total: userStats[0]?.totalUsers || 0,
      students: userStats[0]?.totalStudents || 0,
      staff: userStats[0]?.totalStaff || 0,
    },
    payments: {
      totalCompleted: paymentStats[0]?.totalPayments || 0,
      totalRevenue: paymentStats[0]?.totalRevenue || 0,
      mtdRevenue: mtdRevenue[0]?.revenue || 0,
      mtdCount: mtdRevenue[0]?.count || 0,
      ytdRevenue: ytdRevenue[0]?.revenue || 0,
      ytdCount: ytdRevenue[0]?.count || 0,
      platformMarkup: Math.round(platformMarkup[0]?.totalMarkup || 0),
      pendingPayouts: pendingPayouts[0]?.amount || 0,
    },
    sms: {
      totalBalance: smsBalance[0]?.total || 0,
    },
    recentSchools,
  };
};
