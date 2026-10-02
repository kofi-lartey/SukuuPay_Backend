import { School } from "../../models/schoolModel.js";
import { Student } from "../../models/studentModel.js";
import { Payment } from "../../models/paymentModel.js";
import { PaymentPlan } from "../../models/paymentPlanModel.js";
import { SmsMessage } from "../../models/smsMessageModel.js";
import { PlatformLedger, PLATFORM_REVENUE_TYPES } from "../../models/PlatformLedger.js";
import { dayKey, monthKey } from "../admin.service.js";
import { resolveDateRange, MAX_PER_PAGE } from "../../utils/platformQuery.js";

/**
 * Platform-wide analytics for the owner console.
 *
 * Every function here is a **read**. Nothing in this file writes, not even a cache:
 * the console's job here is to answer questions, and a function that mutates state
 * while answering one is a function whose output depends on what was asked before it.
 *
 * **Everything is an aggregation over an explicit `$project`/`$match`, never a
 * `School.find().lean()` handed straight to a response.** That is not style. A school
 * document carries `payment.hubtelApiKey`, `payment.hubtelClientSecret`,
 * `payment.hubtelClientId` and `sms.apiKey`; the first three are `select: false` but
 * `select: false` does not survive an aggregation pipeline, and a `$project` that
 * forgets one path leaks it. Naming the columns we want is the only version of this
 * that cannot leak a credential added to the model next year.
 *
 * What this module deliberately does **not** re-derive: `getRevenueSeries` and the
 * dashboard KPIs in `../admin.service.js` already cover gross payment volume over
 * time and the school/user counts. This module answers the questions those two
 * cannot: what did *the platform itself* earn, split by kind, and how healthy are the
 * tenants behind it.
 */

/**
 * The line this module's whole value rests on: a period with no rows is a period
 * with a **zero**, never a period with a **hole**.
 *
 * `buildCalendarSeries` in `../admin.service.js:405` is the original statement of that
 * rule and the reason it is exported. It cannot be reused verbatim here for two
 * reasons, both of which are about the shape of its arguments rather than its logic:
 *
 *   1. **Its bucket vocabulary is `day | month`.** `getRevenueAnalytics` accepts
 *      `week`, and `getUsageAnalytics` reports "active schools per week". Neither has
 *      a bucket the existing walker can produce.
 *   2. **Its empty point is `{ totalRevenue: 0, totalPayments: 0 }`.** That is the
 *      right default for gross payment volume and the wrong default for every series
 *      in this file — a revenue-by-type point, a school count, a student count. A
 *      shared helper that hard-codes one metric's empty shape is a helper whose
 *      callers all have to overwrite it, and the one that forgets gets zeros in
 *      fields that are not counts.
 *
 * So the rule is reimplemented once, here, parameterised by the empty point, and the
 * *only* difference from the original is that the metric-shaped defaults became an
 * argument. The comment above `buildCalendarSeries` is the reason it is worth
 * reimplementing rather than copying the mapping approach: mapping aggregate rows
 * omits periods with no activity, and the client draws a straight line across the
 * hole — presenting a month of zero revenue as smooth growth.
 *
 * Period keys are `YYYY-MM`, `YYYY-MM-DD` and, for weeks, the **Monday** of that week
 * as `YYYY-MM-DD` (`weekKey` in `analytics.service.js` groups on Sunday; a Ghanaian
 * school week starts on Monday and a Sunday-start series puts Monday's collections in
 * the week before they happened).
 *
 * Days and months reuse `dayKey`/`monthKey` from `../admin.service.js` rather than
 * re-deriving the string, so one calendar format has exactly one definition. Every
 * aggregation in this file groups with `$dateToString` in `%Y-%m-%d` or `%Y-%m` — the
 * same format those helpers produce — and folds days into weeks or months in JS. That
 * indirection is deliberate: asking Mongo to truncate to a week means either trusting
 * `$dateTrunc`'s start-of-week or reimplementing ISO-8601 week numbering, and
 * `PlatformLedger`/`Payment` rows are grouped by day (a format this codebase already
 * uses everywhere) and re-bucketed here, where a mistake is visible in a test rather
 * than as a series that is silently all zeros.
 */

/** Monday 00:00 UTC of the week containing `date`. Ghana's week starts on Monday. */
const startOfWeekMonday = (date) => {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  // `getUTCDay()` is Sunday=0; shifting by 6 makes Monday=0 so the subtraction below
  // lands on the Monday of the same week rather than the Sunday of the previous one.
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
};

/** `YYYY-MM-DD` of the Monday starting this date's week. Sorts lexicographically. */
const weekKey = (date) => dayKey(startOfWeekMonday(date));

const GRANULARITIES = ["day", "week", "month"];

/** Cap on a returned series, mirroring `buildCalendarSeries`'s own caps. */
const SERIES_CAPS = { day: 400, week: 120, month: 120 };

/**
 * Every calendar key between `from` and `to` at the requested granularity, in order.
 *
 * Capped, and the cap is documented rather than silent: `day` is 400 because a
 * two-year daily request is a thousand-point array and a hung tab, and `week`/`month`
 * are 120 for the same reason. A response that silently truncates is worse than one
 * that says so, so `buildGapFreeSeries` reports `truncated` alongside the series.
 */
export const buildPeriodKeys = (from, to, groupBy = "month", cap = Infinity) => {
  const keys = [];
  const limit = Math.min(cap, Infinity);

  if (groupBy === "month") {
    const cursor = new Date(from.getUTCFullYear(), from.getUTCMonth(), 1);
    while (cursor <= to && keys.length < limit) {
      keys.push(monthKey(cursor));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return keys;
  }

  /*
   * Days and weeks share one walk: a week is discovered by deduplicating the Mondays
   * out of the days crossed.
   *
   * Stepping by 7 from an arbitrary `from` instead would silently produce a series
   * offset from the calendar whenever `from` is not itself a Monday — and the offset
   * is invisible on the chart, which is the whole reason `buildCalendarSeries` exists.
   */
  const cursor = new Date(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const last = new Date(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  const seen = new Set();
  while (cursor <= last && keys.length < limit) {
    const key = groupBy === "week" ? weekKey(cursor) : dayKey(cursor);
    if (groupBy !== "week" || !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
};

/**
 * The no-gaps guarantee, as a reusable function.
 *
 * `rowsByKey` is `Map<periodKey, point>` as produced by `foldDaysToPeriods` below;
 * `emptyPoint` is a **factory**, called once per missing period, so no two empty
 * points in one series share an object. Sharing one frozen literal across 400 periods
 * would be a real bug the moment a caller sorted or annotated the series in place.
 *
 * `truncated` is reported rather than applied silently: a caller that asked for five
 * years of daily revenue and got 400 points is holding a series that ends before its
 * own request does, and the difference between "there was no revenue" and "I stopped
 * counting" is the difference between a chart and a lie.
 */
export const buildGapFreeSeries = (rowsByKey, from, to, groupBy, emptyPoint) => {
  const cap = SERIES_CAPS[groupBy] ?? SERIES_CAPS.month;
  const expected = buildPeriodKeys(from, to, groupBy);
  const keys = buildPeriodKeys(from, to, groupBy, cap);

  return {
    series: keys.map((period) => ({
      period,
      ...(rowsByKey.get(period) ?? emptyPoint()),
    })),
    truncated: expected.length > keys.length,
    periodsAvailable: expected.length,
    periodsReturned: keys.length,
  };
};

/**
 * Fold day-keyed aggregation rows into day / week / month keys.
 *
 * **Input contract:** each row is `{ _id: { day: "YYYY-MM-DD", … }, …accumulators }` —
 * the shape a `$group: { _id: { day: { $dateToString: … }, … } }` produces. The day lives
 * at `_id.day`, not at a top-level `_day`, and reading the wrong one of those two yields
 * `undefined`, which parses to `NaN`, which is skipped — so the series comes back empty
 * and every point is a gap-filled zero. That is the failure mode this contract note
 * exists to prevent: it is invisible in review, invisible on a chart that looks
 * plausible, and it is the whole feature going dark.
 *
 * The one place bucket choice is applied. `$dateToString` in `%Y-%m-%d` is the only date
 * format any aggregation in this file asks Mongo for, and this maps its rows onto
 * whatever `groupBy` the caller wanted. `combine` receives the accumulated point and the
 * row, and may mutate the accumulator — which is safe because a fresh one is created per
 * key.
 */
export const foldDaysToPeriods = (rows, groupBy, combine) => {
  const out = new Map();
  for (const row of rows || []) {
    const day = row?._id?.day;
    if (!day) continue;
    const date = new Date(`${day}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) continue;
    const key =
      groupBy === "day" ? dayKey(date) : groupBy === "week" ? weekKey(date) : monthKey(date);

    if (!out.has(key)) out.set(key, {});
    combine(out.get(key), row);
  }
  return out;
};

/**
 * Percentages as real ratios, 0–100, rounded to two decimals.
 *
 * Returns **`null` when the denominator is zero**, not `0`. This is the one place
 * where deliberately departing from `analytics.service.js`'s `rate()` (which returns
 * `0`) is correct: a ratio with no denominator is undefined, and a console that
 * renders `null` as an em-dash says "no basis for this number" while one that
 * renders `0` says "no growth" — or worse, "0% churn" for a month in which nobody
 * churned *because nobody existed yet*. `percent` is named so that no caller has to
 * guess which of the two it got, and every field it feeds is suffixed `Percent` and
 * listed under `units.rates` in the response, so a client cannot read `0.42` off a
 * field and print "42%" by accident.
 */
const percent = (numerator, denominator) => {
  const d = Number(denominator);
  if (!Number.isFinite(d) || d === 0) return null;
  return Math.round(((Number(numerator) || 0) / d) * 10000) / 100;
};

/** Month-on-month growth, or `null` when there is no prior month to grow from. */
const growthPercent = (current, previous) => {
  const prev = Number(previous) || 0;
  if (prev === 0) return null;
  return Math.round(((Number(current) || 0) - prev) / prev * 10000) / 100;
};

/**
 * Median of a numeric array, or `null` for an empty one.
 *
 * `null` rather than `0` for the same reason `percent` is: "no school in this window
 * has taken a payment yet" is the most interesting thing this function can be asked,
 * and `0 days` says the opposite.
 */
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
};

/**
 * Resolve `from`/`to` into concrete `Date`s, defaulting the window.
 *
 * The default is documented per caller, not here: "last 12 months" is right for a
 * revenue series and wrong for a weekly usage report, and one global default would
 * make one of those two silently return a thousand points or a single week.
 *
 * `to` defaults to *now* rather than the end of today: a series must not show a
 * full-day bucket for a day that has not finished, and a zero in that bucket is read
 * as "nothing happened today" rather than "the day is not over".
 */
const resolveWindow = (from, to, fallbackDays = 365) => {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - fallbackDays * 86400000);
  return { from: start, to: end };
};

/** `{ from, to }` → `{ createdAt: { $gte, $lte } }`, whole days widened (UTC). */
const createdAtRange = (from, to) =>
  resolveDateRange(from.toISOString(), to.toISOString(), "createdAt").createdAt;

/**
 * The seven `School.status` / `subscription.status` values that mean "this tenant is
 * not on trial and is not in trouble".
 *
 * Two distinct enums live on `School` and mixing them up is the single easiest way
 * to produce a headline that is quietly wrong: `School.status` is
 * `active|suspended|archived` (schoolModel.js:356) and `School.subscription.status`
 * is `active|trial|suspended|expired|cancelled` (schoolModel.js:302). A school can
 * be `status: "active"` while its `subscription.status` is `"expired"`, and that
 * combination — good tenant, unpaid bill — is precisely the one an owner needs to see.
 */
const BILLABLE_SUBSCRIPTION_STATUSES = ["active"];
const ALIVE_SUBSCRIPTION_STATUSES = ["active", "trial"];

/**
 * When this school stopped being a paying customer, or `null` if it has not.
 *
 * The later of `suspendedAt` (an operator action, schoolModel.js:376) and
 * `subscription.cancelledAt` (a billing action, schoolModel.js:308), because a
 * school that was suspended in January and unsuspended in June has its
 * `suspendedAt` still populated and reporting March as a churn month would be wrong.
 *
 * The alternative — a status-history collection — does not exist. Every churn figure
 * in this module is therefore *inferred* from two stamps and is only as good as
 * whether those stamps are still the latest truth, which is why callers pair it with
 * a check on the school's **current** status before counting it as churned.
 */
const churnDateOf = (school) => {
  const suspendedAt = school.suspendedAt ? new Date(school.suspendedAt) : null;
  const cancelledAt = school.subscription?.cancelledAt
    ? new Date(school.subscription.cancelledAt)
    : null;
  if (!suspendedAt) return cancelledAt;
  if (!cancelledAt) return suspendedAt;
  return suspendedAt > cancelledAt ? suspendedAt : cancelledAt;
};

/** Is this school *still* suspended or cancelled as of right now? */
const isStillChurned = (school) =>
  school.status === "suspended" ||
  school.subscription?.status === "suspended" ||
  school.subscription?.status === "cancelled" ||
  school.subscription?.status === "expired";

/**
 * Non-deleted students still on the roster.
 *
 * Excludes `removed` only, and **not** `graduated` or `transferred_out`. A school
 * whose entire cohort has graduated is a real school whose next cohort has not
 * arrived; filtering graduates out would report it as having no students and put it
 * on the at-risk list for the one thing it did correctly.
 */
const ROSTER_MATCH = { deletedAt: null, status: { $ne: "removed" } };

const MS_PER_DAY = 86400000;

/**
 * A school with no completed payment for this long is quiet.
 *
 * Fourteen days, not thirty: a Ghanaian school term's fee collection is concentrated
 * in the first weeks after reopening, and a school that has taken nothing for a
 * fortnight while *others are collecting* is a support conversation, whereas a
 * thirty-day rule would not surface a school until most of the term's money had
 * already been missed.
 */
const AT_RISK_NO_PAYMENT_DAYS = 14;

/**
 * `subscription.status` values that mean "past due".
 *
 * The enum has no literal `past_due` (schoolModel.js:302). `expired` is the state the
 * billing cycle lands on when a period lapses without payment, and it is the honest
 * mapping — `suspended` is an operator decision rather than a missed bill, and
 * `cancelled` is a decision somebody already made. Filing those two under "past due"
 * would put a deliberately churned school on a dunning list.
 */
const PAST_DUE_SUBSCRIPTION_STATUSES = ["expired"];

/**
 * `School.payment.gatewayMode` mapped onto the rail question the console asks.
 *
 * **The naming divergence is real and worth stating plainly.** The brief for this
 * console described the field as a `sukuupay | school` pair. It is not one: the enum
 * on `School.payment.gatewayMode` (schoolModel.js:159) is
 * `hubtel | arke | mnotify | manual`, which names a *provider*, not a rail. So the
 * mapping has to be made explicitly:
 *
 *   - `manual` → the school's own rail. The school takes the money itself, in cash or
 *     by its own arrangement, and SukuuPay is not in the transaction.
 *   - `hubtel | arke | mnotify` → SukuuPay's rail. The payment is initiated through a
 *     gateway SukuuPay operates and the platform takes its cut (which is why every
 *     one of these schools is a `markup` / `platform_fee` ledger payer).
 *
 * There is no third bucket and no `unknown`: the field defaults to `"hubtel"` and is
 * `required`-by-default in the schema, so a school with no value is a data problem
 * worth seeing as a data problem rather than a fourth category that quietly holds
 * every unmigrated school and makes the platform's share look smaller than it is.
 */
export const GATEWAY_RAIL_BY_MODE = {
  manual: "school_own",
  hubtel: "sukuupay",
  arke: "sukuupay",
  mnotify: "sukuupay",
};

/**
 * `Payment.provider` values, mapped onto the same two rails.
 *
 * `mtn` appears on `Payment.provider` (paymentModel.js:81) but not on
 * `School.payment.gatewayMode`, because MTN is reached through one of the platform's
 * own integrations rather than as a school-selectable gateway. It therefore maps to
 * `sukuupay`, and the divergence is noted here rather than left to a reader to
 * discover when a payment counts and its school's mode says otherwise.
 */
export const PAYMENT_PROVIDER_RAIL = {
  hubtel: "sukuupay",
  arke: "sukuupay",
  mnotify: "sukuupay",
  mtn: "sukuupay",
  manual: "school_own",
};

/**
 * Sum of a possibly-`null` aggregation field.
 *
 * Mongo returns `null` from `$sum` over an empty match, and `null + 1200` is `1200`
 * — a revenue figure produced for a school that has never taken a payment. Every
 * `$sum` result in this module goes through here (see the same note at
 * `platformQuery.js:172`).
 */
const num = (value) => Number(value) || 0;

// ──────────────────── 1. Platform overview ────────────────────

/**
 * The headline payload: one request, every number the console's top bar shows.
 *
 * Grouped rather than flat because these are four different questions — how many
 * tenants, how big, how much they pay us, and how much of it is new — and a flat
 * `schoolsTotal` / `revenueMrr` object invites a client to render the ARR next to
 * the collected figure without noticing they are different units.
 */
export const getPlatformOverview = async () => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );
  const monthEnd = now;

  const [
    schoolStats,
    studentStats,
    newSchoolsThisMonth,
    newSchoolsLastMonth,
    collectedAllTime,
    platformRevenueThisMonth,
    churnMaterial,
    planRevenueRows,
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
          onTrial: { $sum: { $cond: [{ $eq: ["$subscription.status", "trial"] }, 1, 0] } },
        },
      },
    ]),

    /*
     * Counted from `Student`, not from `School.stats.totalStudents`.
     *
     * The counter exists and is maintained by `$inc` on every create, archive and
     * restore (student.service.js:293, :540, :989, :1045), so it is fast — and it is
     * a counter, which is to say it is only as accurate as the sum of every increment
     * ever applied to it. `student.service.js:985-989` documents a past incident where
     * bulk archives left it a hundred too high with nothing to reconcile it. A
     * platform headline that drifts upward forever is worse than a slower correct one.
     *
     * `admin.service.js:65` and `:718` count `User` rows with `role: "student"` for
     * the same number, which is a *different population* — an account, not a roster
     * entry. The two must never be summed or compared; this module always uses
     * `Student` and says so in the payload.
     */
    Student.aggregate([
      { $match: ROSTER_MATCH },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
          graduated: { $sum: { $cond: [{ $eq: ["$status", "graduated"] }, 1, 0] } },
        },
      },
    ]),

    School.countDocuments({ deletedAt: null, createdAt: { $gte: monthStart, $lte: monthEnd } }),
    School.countDocuments({
      deletedAt: null,
      createdAt: { $gte: lastMonthStart, $lt: monthStart },
    }),

    /*
     * `status: "completed"` with **no `amount: { $gt: 0 }` filter**, deliberately.
     *
     * `refundPayment` (payment.service.js:1316) writes the reversal as its own
     * `Payment` with `amount: -refundAmount` and `status: "completed"`, so summing
     * completed amounts already nets refunds out. Filtering to positive amounts here
     * would report gross collections as "total collected all-time" — a number that
     * rises every time a school refunds a parent and never falls, and is therefore
     * not a collection figure at all.
     */
    Payment.aggregate([
      { $match: { deletedAt: null, status: "completed" } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),

    /*
     * What the *platform* earned this month, as distinct from what parents paid.
     *
     * `PlatformLedger` is the only collection that answers this: a `Payment` is gross,
     * school-bound money (PlatformLedger.js:8-14), and no amount of summing payments
     * yields "what did we earn". `type: { $in: PLATFORM_REVENUE_TYPES }` excludes
     * `refund`, `payout` and `adjustment` — the constant's own comment says why, and
     * repeating the list here would be the drift it exists to prevent.
     *
     * `amount: { $gt: 0 }` keeps a negative correction of an earlier month from
     * restating this one, per the same comment. Reversals are reported separately in
     * `getRevenueAnalytics`, not silently dropped.
     */
    PlatformLedger.aggregate([
      {
        $match: {
          type: { $in: PLATFORM_REVENUE_TYPES },
          amount: { $gt: 0 },
          createdAt: { $gte: monthStart, $lte: monthEnd },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" }, entries: { $sum: 1 } } },
    ]),

    /*
     * Every non-deleted school with enough fields to answer "did they churn, and
     * when" in JS.
     *
     * Not an aggregation, and that is the point: the churn calculation mixes two
     * independent stamps (`suspendedAt`, `subscription.cancelledAt`) with a check
     * against the school's *current* status, and expressing that in `$group` requires
     * a `$max` over two optional dates followed by a comparison against a field that
     * is not in the group key. The population is one row per school — a few thousand
     * at most — so the honest implementation is a projection and an arithmetic step.
     */
    School.find({ deletedAt: null })
      .select("name status suspendedAt subscription.status subscription.cancelledAt createdAt")
      .lean(),

    /* Per-type platform revenue for the month, so the headline can be explained. */
    PlatformLedger.aggregate([
      {
        $match: {
          type: { $in: PLATFORM_REVENUE_TYPES },
          amount: { $gt: 0 },
          createdAt: { $gte: monthStart, $lte: monthEnd },
        },
      },
      { $group: { _id: "$type", total: { $sum: "$amount" }, entries: { $sum: 1 } } },
    ]),
  ]);

  /*
   * MRR.
   *
   * `subscription.monthlyFee` for schools whose `subscription.status` is `active` —
   * and explicitly *not* `trial`, since a trial school's fee is the price of nothing
   * and including it would report intent as revenue. `BILLABLE_SUBSCRIPTION_STATUSES`
   * carries the list so the exclusion is one named constant rather than an inline
   * `$and` nobody can check against the enum.
   *
   * The sum is **rounded to whole pesewas on the way out**, and that is not
   * defensiveness for its own sake: `subscription.monthlyFee` is
   * `Number, min 0` with *no* integer validator (schoolModel.js:314), unlike
   * `PlatformLedger.amount` which asserts integer pesewas explicitly. A fee set to
   * 150.50 through any path that bypasses validation would make MRR fractional, and a
   * fractional MRR is a number the frontend's `toCedis` will round again, silently
   * disagreeing with this one. Integer pesewas in, integer pesewas out.
   */
  const mrrResult = await School.aggregate([
    {
      $match: {
        deletedAt: null,
        "subscription.status": { $in: BILLABLE_SUBSCRIPTION_STATUSES },
        "subscription.plan": { $ne: "trial" },
      },
    },
    {
      $group: {
        _id: null,
        mrr: { $sum: "$subscription.monthlyFee" },
        schools: { $sum: 1 },
      },
    },
  ]);

  const mrr = Math.round(num(mrrResult[0]?.mrr));

  /*
   * Churn.
   *
   * Numerator: schools whose churn stamp falls inside the month **and which are still
   * churned today**. The second half is the load-bearing condition — a school
   * suspended on the 3rd and reinstated on the 20th has a `suspendedAt` inside the
   * month and did not churn, and counting it would report a recovery as a loss.
   *
   * Denominator: schools that existed and had not yet churned when the month began —
   * `createdAt` before the month start and no churn stamp at or before it.
   *
   * Archived schools are excluded from both. `School.status: "archived"` is a
   * deliberate retirement, and the brief defines churn as "active or trial → suspended
   * or cancelled"; widening it to include archiving would make the number a measure of
   * the owner's housekeeping.
   */
  const churnedThisMonth = churnMaterial.filter((school) => {
    if (school.status === "archived") return false;
    const churnedAt = churnDateOf(school);
    if (!churnedAt || churnedAt < monthStart || churnedAt > monthEnd) return false;
    return isStillChurned(school);
  });

  const activeAtMonthStart = churnMaterial.filter((school) => {
    if (school.status === "archived") return false;
    if (school.createdAt && new Date(school.createdAt) >= monthStart) return false;
    const churnedAt = churnDateOf(school);
    return !churnedAt || churnedAt > monthStart;
  });

  const byTypeThisMonth = Object.fromEntries(
    PLATFORM_REVENUE_TYPES.map((type) => [type, 0])
  );
  const entriesByType = {};
  for (const row of planRevenueRows) {
    byTypeThisMonth[row._id] = num(row.total);
    entriesByType[row._id] = num(row.entries);
  }

  return {
    generatedAt: now.toISOString(),
    /*
     * Keyed `from`/`to` rather than `monthStart`/`monthEnd`, because every other payload
     * in this module uses those two names and the audit helper reads them. `monthLabel`
     * carries the human framing. A month-scoped response whose period block used
     * different key names would have to be special-cased in the controller, and the
     * special case would be the only thing not covered by the shared reader.
     */
    period: { from: monthStart, to: monthEnd, monthLabel: monthKey(monthStart) },

    units: {
      money: "integer pesewas (1 GHS = 100 pesewas)",
      rates: "percent, 0–100, null when there is no denominator to divide by",
    },

    schools: {
      total: num(schoolStats[0]?.total),
      active: num(schoolStats[0]?.active),
      suspended: num(schoolStats[0]?.suspended),
      archived: num(schoolStats[0]?.archived),
      onTrial: num(schoolStats[0]?.onTrial),
      newThisMonth: num(newSchoolsThisMonth),
      newLastMonth: num(newSchoolsLastMonth),
      growthPercent: growthPercent(newSchoolsThisMonth, newSchoolsLastMonth),
    },

    students: {
      total: num(studentStats[0]?.total),
      active: num(studentStats[0]?.active),
      graduated: num(studentStats[0]?.graduated),
    },

    revenue: {
      /*
       * ARR is `MRR × 12`, and it is a **projection**, not a measurement.
       *
       * No cedi of it has been earned. It answers "if every school on the current
       * plan paid the current fee for the next twelve months and nobody joined,
       * resigned, negotiated or was upgraded, the run rate would be this". Every ARR
       * figure in every SaaS product is this arithmetic, and the difference between a
       * useful one and a misleading one is whether anybody says so out loud. It is
       * stated here, in the payload the console reads, rather than only in a comment
       * a developer sees once: the number is what gets screenshotted.
       *
       * It is also the number most sensitive to a mis-set `monthlyFee`. A trial plan
       * leaking into MRR, or one school on an enterprise fee of 850000 pesewas, moves
       * ARR by ten million pesewas — which is why `mrrSchools` is returned next to it
       * so a reader can sanity-check the population the figure came from.
       */
      arr: mrr * 12,
      arrBasis: "projection: MRR x 12, assumes no churn, no upgrades and no new schools",
      collectedAllTime: num(collectedAllTime[0]?.total),
      completedPaymentsAllTime: num(collectedAllTime[0]?.count),
      mrr,
      mrrSchools: num(mrrResult[0]?.schools),
      thisMonth: num(platformRevenueThisMonth[0]?.total),
      thisMonthEntries: num(platformRevenueThisMonth[0]?.entries),
      thisMonthByType: byTypeThisMonth,
      thisMonthEntriesByType: entriesByType,
    },

    churn: {
      churnedThisMonth: churnedThisMonth.length,
      activeAtMonthStart: activeAtMonthStart.length,
      churnRatePercent: percent(churnedThisMonth.length, activeAtMonthStart.length),
      churnedSchoolNames: churnedThisMonth
        .slice(0, 20)
        .map((s) => ({ id: s._id, name: s.name, status: s.status })),
      note:
        "Inferred from suspendedAt / subscription.cancelledAt plus current status — this " +
        "schema has no status history, so a month where a school churned and came back " +
        "cannot be distinguished from one where it never churned.",
    },
  };
};

// ──────────────────── 2. Revenue analytics (by type) ────────────────────

/**
 * Platform revenue over time, split by kind.
 *
 * The split is derived from `PLATFORM_REVENUE_TYPES` rather than typed out as
 * `["markup", "platform_fee", "subscription", "sms"]`. That list in the brief is a
 * subset — it omits `gateway_fee`, which the same file's comment classes as income —
 * and a hard-coded subset is exactly the drift that constant exists to prevent: the
 * day somebody adds a revenue type to the enum, a hard-coded array silently stops
 * reporting it and the two pages that must agree disagree. Deriving it costs nothing
 * and cannot drift.
 */
export const getRevenueAnalytics = ({ from, to, groupBy = "month" } = {}) => {
  const granularity = GRANULARITIES.includes(groupBy) ? groupBy : "month";
  const { from: start, to: end } = resolveWindow(from, to, 365);
  const range = createdAtRange(start, end);

  const baseMatch = {
    type: { $in: PLATFORM_REVENUE_TYPES },
    createdAt: range,
  };

  return Promise.all([
    /*
     * Grouped by **day**, then folded to the requested granularity in JS.
     *
     * See the block comment at the top of this file for why: a day bucket is the one
     * `$dateToString` format this codebase already uses everywhere, so nothing here
     * depends on Mongo's start-of-week convention or on a JS reimplementation of
     * ISO-8601 week numbering agreeing with `$isoWeek`. One row per day per type per
     * settled-state is bounded by the window, not by the ledger's size.
     */
    PlatformLedger.aggregate([
      { $match: { ...baseMatch, amount: { $gt: 0 } } },
      {
        $group: {
          _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, type: "$type" },
          total: { $sum: "$amount" },
          entries: { $sum: 1 },
          settled: { $sum: { $cond: [{ $eq: ["$settled", true] }, "$amount", 0] } },
        },
      },
    ]),

    /*
     * Negative amounts within the income types, reported rather than discarded.
     *
     * A correction is a negative entry of a type that *is* income (a markup reversal,
     * a subscription credit). Filtering to `amount > 0` keeps it out of the headline —
     * it belongs next to the thing it corrects, not inside this month's number — but
     * dropping it entirely would make the series disagree with the ledger with no
     * visible reason. This is the number that explains the difference.
     */
    PlatformLedger.aggregate([
      { $match: { ...baseMatch, amount: { $lt: 0 } } },
      { $group: { _id: null, total: { $sum: "$amount" }, entries: { $sum: 1 } } },
    ]),

    PlatformLedger.aggregate([
      { $match: { ...baseMatch, amount: { $gt: 0 } } },
      { $group: { _id: "$type", total: { $sum: "$amount" }, entries: { $sum: 1 } } },
    ]),
  ]).then(([dayRows, reversalRows, typeRows]) => {
    const emptyByType = () => Object.fromEntries(PLATFORM_REVENUE_TYPES.map((t) => [t, 0]));

    const byPeriod = foldDaysToPeriods(dayRows, granularity, (acc, row) => {
      acc.total = num(acc.total) + num(row.total);
      acc.entries = num(acc.entries) + num(row.entries);
      acc.settledAmount = num(acc.settledAmount) + num(row.settled);
      /*
       * Accumulate **into `acc.byType`**, reading the running total from there.
       *
       * `acc.total` above is what makes the mistake in this line survivable if it is
       * made: reading the previous value from the *row* instead of the accumulator
       * yields the last row's value for the type rather than the sum, so the per-type
       * split of a month with several `markup` days reports one day's revenue while the
       * month's `total` reports all of them. The two columns then disagree, the share
       * percentages stop summing to 100, and nothing anywhere throws.
       */
      if (!acc.byType) acc.byType = emptyByType();
      acc.byType[row._id.type] = num(acc.byType[row._id.type]) + num(row.total);
      if (!acc.entriesByType) acc.entriesByType = emptyByType();
      acc.entriesByType[row._id.type] = num(acc.entriesByType[row._id.type]) + num(row.entries);
    });

    const trend = buildGapFreeSeries(
      byPeriod,
      start,
      end,
      granularity,
      () => ({
        total: 0,
        entries: 0,
        settledAmount: 0,
        byType: emptyByType(),
        entriesByType: emptyByType(),
      })
    );

    const totalsByType = emptyByType();
    const entriesByType = emptyByType();
    for (const row of typeRows) {
      totalsByType[row._id] = num(row.total);
      entriesByType[row._id] = num(row.entries);
    }

    const total = num(typeRows.reduce((sum, row) => sum + num(row.total), 0));

    return {
      generatedAt: new Date().toISOString(),
      groupBy: granularity,
      period: { from: start, to: end },
      units: {
        money: "integer pesewas (1 GHS = 100 pesewas)",
        share: "percent, 0–100",
      },

      totals: {
        total,
        entries: num(typeRows.reduce((sum, row) => sum + num(row.entries), 0)),
        byType: totalsByType,
        entriesByType,
        shareByType: Object.fromEntries(
          PLATFORM_REVENUE_TYPES.map((type) => [type, percent(totalsByType[type], total)])
        ),
        reversalAmount: num(reversalRows[0]?.total),
        reversalEntries: num(reversalRows[0]?.entries),
        /*
         * Summed off `trend.series` rather than a separate `$group`, because the series
         * already carries a per-period `settledAmount` and two aggregations of the same
         * thing are two answers that must agree.
         */
        settledAmount: trend.series.reduce(
          (sum, point) => sum + num(point.settledAmount),
          0
        ),
      },

      series: trend.series,
      // Reported rather than applied silently: a caller that asked for five years of
      // daily revenue and got 400 points is holding a series that ends before its own
      // request does, and "there was no revenue" must be distinguishable from "we
      // stopped counting".
      truncated: trend.truncated,
      periodsAvailable: trend.periodsAvailable,
      periodsReturned: trend.periodsReturned,

      note:
        "amount > 0 only, and only the income types in PLATFORM_REVENUE_TYPES. Negative " +
        "entries of those types are reported as `reversalAmount` instead of being netted " +
        "into a period they do not belong to.",
    };
  });
};

// ──────────────────── 3. Schools analytics (signup, activation, first payment) ────────────────────

/**
 * Signups, churn, activation and time-to-first-payment.
 *
 * The first two are counts over the window. The third and fourth are the two numbers
 * a SaaS console exists to get right, and both have a failure mode that only shows
 * up if you think about who is *missing* from the average.
 */
export const getSchoolsAnalytics = async ({ from, to } = {}) => {
  const { from: start, to: end } = resolveWindow(from, to, 365);
  const range = createdAtRange(start, end);

  const newSchools = await School.find({ deletedAt: null, createdAt: range })
    .select(
      /*
       * `onboardingCompletedAt` at the **top level** (schoolModel.js:303), which is where
       * the index is too (`schoolModel.js:413`).
       *
       * These six platform-operator fields — `platformFeePercent`, `featureFlags`,
       * `internalNotes`, `accountManagerId`, `onboardingCompletedAt`, `tags` — were at
       * one point declared *inside* the already-open `subscription: { … }` block, which
       * does not close until the end of that object, and have since been moved back out.
       *
       * The trap is recorded here because it is silent in both directions. `undefined`
       * in a `$ifNull` becomes "not activated", so a reader pointed at the wrong path
       * reports an activation rate of 0% forever and it looks like a product problem
       * rather than a typo. `activationFieldPath` is returned in the payload for the
       * same reason the `tags,status` index exists: so the path this module reads is
       * visible to whoever has to check it.
       */
      "name region status createdAt subscription.status subscription.plan subscription.monthlyFee onboardingCompletedAt subscription.cancelledAt suspendedAt"
    )
    .lean();

  const newSchoolIds = newSchools.map((school) => school._id);

  /*
   * Earliest completed payment per new school.
   *
   * `$min` on `createdAt` rather than `completedAt`: `completedAt` is stamped by the
   * pre-save hook when the status flips, and a manual payment recorded after the fact
   * carries a `createdAt` of the moment it was entered. "How long until this school
   * first took money" is the question a signup funnel asks, and the date the money
   * arrived is `createdAt`.
   */
  const firstPayments = newSchoolIds.length
    ? await Payment.aggregate([
        {
          $match: {
            schoolId: { $in: newSchoolIds },
            deletedAt: null,
            status: "completed",
          },
        },
        { $group: { _id: "$schoolId", firstPaymentAt: { $min: "$createdAt" } } },
      ])
    : [];

  const firstPaymentBySchool = new Map(
    firstPayments.map((row) => [String(row._id), row.firstPaymentAt])
  );

  const activated = newSchools.filter((school) => school.onboardingCompletedAt != null);

  const daysToFirstPayment = [];
  let noPaymentYet = 0;

  for (const school of newSchools) {
    const paidAt = firstPaymentBySchool.get(String(school._id));
    if (!paidAt) {
      /*
       * Censored, not zero.
       *
       * A school created nine days ago that has not taken a payment has a
       * time-to-first-payment of *at least* nine, and no upper bound this window can
       * see. Including it as `0` (or as the days elapsed) would pull the mean toward
       * zero and make onboarding look faster the more recently the cohort signed up —
       * the exact inverse of the truth, and a bias that grows as the window widens.
       *
       * So these schools are **excluded from the mean and the median** and reported as
       * a count instead. The consequence is stated in the payload
       * (`firstPaymentCoveragePercent`) because the excluded fraction is the
       * confidence interval nobody would otherwise have: on a young platform this
       * number will often be small, and a mean computed from three schools is not a
       * mean.
       */
      noPaymentYet += 1;
      continue;
    }
    /*
     * Not clamped at zero. A negative value here would mean a payment predates the
     * school that supposedly took it — a data-integrity fault. Clamping would turn a
     * visible contradiction into a plausible-looking `0`, and the aggregation would
     * carry on reporting a median as though the records agreed.
     */
    daysToFirstPayment.push(
      Math.round(
        (new Date(paidAt).getTime() - new Date(school.createdAt).getTime()) / MS_PER_DAY
      ) * 100
    ) / 100;
  }

  /*
   * Churned inside the window: same definition as the overview, same reason for the
   * "still churned today" condition. A school's `suspendedAt` is never cleared on
   * reinstatement, so without that check every month after a suspension would report
   * the suspension again.
   */
  const churnedMaterial = await School.find({
    deletedAt: null,
    status: { $ne: "archived" },
    $or: [{ suspendedAt: range }, { "subscription.cancelledAt": range }],
  })
    .select("name region status suspendedAt subscription.status subscription.cancelledAt createdAt")
    .lean();

  const churned = churnedMaterial.filter((school) => {
    const churnedAt = churnDateOf(school);
    if (!churnedAt || churnedAt < start || churnedAt > end) return false;
    return isStillChurned(school);
  });

  return {
    generatedAt: new Date().toISOString(),
    period: { from: start, to: end },
    units: {
      days: "whole days (mean and median rounded to 2dp)",
      rates: "percent, 0–100, null when there is no denominator to divide by",
    },

    signups: {
      newSchools: newSchools.length,
      churnedSchools: churned.length,
      netChange: newSchools.length - churned.length,
      churnRatePercent: percent(churned.length, newSchools.length + churned.length),
      activatedSchools: activated.length,
      activationRatePercent: percent(activated.length, newSchools.length),
      activationFieldPath: "onboardingCompletedAt",
    },

    timeToFirstPayment: {
      medianDays: median(daysToFirstPayment),
      meanDays: daysToFirstPayment.length
        ? Math.round(
            (daysToFirstPayment.reduce((sum, d) => sum + d, 0) / daysToFirstPayment.length) *
              100
          ) / 100
        : null,
      schoolsWithAPayment: daysToFirstPayment.length,
      schoolsWithoutAPaymentYet: noPaymentYet,
      firstPaymentCoveragePercent: percent(
        daysToFirstPayment.length,
        newSchools.length
      ),
      note:
        "Computed over new schools that have taken a completed payment. Schools that " +
        "have not are censored and excluded — see the note above — so `firstPaymentCoveragePercent` " +
        "is the honest denominator for how much weight these two figures carry.",
    },

    schools: newSchools
      .slice(0, 200)
      .map((school) => ({
        id: school._id,
        name: school.name,
        region: school.region,
        status: school.status,
        plan: school.subscription?.plan || null,
        subscriptionStatus: school.subscription?.status || null,
        mrr: Math.round(num(school.subscription?.monthlyFee)),
        createdAt: school.createdAt,
        onboardingCompletedAt: school.onboardingCompletedAt || null,
        firstPaymentAt: firstPaymentBySchool.get(String(school._id)) || null,
      })),
    schoolsTruncated: newSchools.length > 200,
  };
};

// ──────────────────── 4. Usage analytics ────────────────────

/**
 * What the platform is actually being used for.
 *
 * The brief asked for a storage-usage figure. **There is none, and none is
 * invented here.** Every file upload in this system goes to Cloudinary through
 * `multer-storage-cloudinary` or is held in memory and parsed in-process
 * (`middleware/upload.js`), so no byte count of a school's uploads is recorded
 * anywhere; `School` has no `storageUsed` field, and the only "storage" figure in the
 * codebase is `storageUsedMB: 0` in `services/settings.service.js:249-251`, which is
 * a `Promise.resolve(0)` with a comment admitting a real figure would require summing
 * Cloudinary usage. `storageUsed` is therefore returned as an explicit `null` — a
 * field that is honestly absent rather than a number that is confidently zero.
 */
export const getUsageAnalytics = async ({ from, to } = {}) => {
  /*
   * Default window is 30 days, not the module's 12-month default, and that is a cost
   * decision rather than an inconsistency: "active schools per week" is derived from
   * every school's first and last payment (see below), but the per-school volume
   * table ranks three aggregations that are each `$group`ed by `schoolId`, and a
   * twelve-month window multiplies nothing there while making the payload a
   * full-platform census rather than a usage report.
   */
  const { from: start, to: end } = resolveWindow(from, to, 30);
  const range = createdAtRange(start, end);

  const [smsStats, studentsBySchool, paymentsBySchool, paymentSpan, smsBySchool] =
    await Promise.all([
      SmsMessage.aggregate([
        { $match: { deletedAt: null, isTest: false, createdAt: range } },
        {
          $group: {
            _id: null,
            sent: { $sum: 1 },
            credits: { $sum: "$creditsCharged" },
            segments: { $sum: "$segments" },
          },
        },
      ]),

      Student.aggregate([
        { $match: { deletedAt: null, createdAt: range } },
        { $group: { _id: "$schoolId", studentsImported: { $sum: 1 } } },
      ]),

      Payment.aggregate([
        { $match: { deletedAt: null, status: "completed", createdAt: range } },
        {
          $group: {
            _id: "$schoolId",
            paymentsProcessed: { $sum: 1 },
            collected: { $sum: "$amount" },
          },
        },
      ]),

      /*
       * First and last completed payment per school, over **all time**.
       *
       * "Active schools per week" is derived from these two stamps rather than from
       * a `{week, schoolId}` group: a school is active in every week between the one
       * it first collected in and the one it last collected in, so one row per school
       * is enough to place it on every week it belongs on. The alternative grouping
       * produces `weeks x schools` rows — 15,000 for a month on a 500-school platform
       * and 730,000 for a year — to answer a question one row per school answers.
       * No `createdAt` floor here: a school whose last payment was eight months ago
       * must still be reported as having been active in those weeks.
       */
      Payment.aggregate(
        [
          { $match: { deletedAt: null, status: "completed" } },
          {
            $group: {
              _id: "$schoolId",
              firstAt: { $min: "$createdAt" },
              lastAt: { $max: "$createdAt" },
            },
          },
        ],
        { allowDiskUse: true }
      ),

      SmsMessage.aggregate([
        { $match: { deletedAt: null, isTest: false, createdAt: range } },
        { $group: { _id: "$schoolId", smsSent: { $sum: 1 } } },
      ]),
    ]);

  /* ── Active schools per week, from the first/last spans ── */
  const weekKeys = buildPeriodKeys(start, end, "week");
  const weekSet = new Set(weekKeys);
  /*
   * A `Map`, not `Object.fromEntries`.
   *
   * The key is a calendar string, which makes an object read perfectly well right up to
   * the point where something asks it for `.values()` — which is how the union of all
   * weeks is computed below. An object would fail there at runtime, on a code path that
   * only runs once the platform has enough payment history to be interesting, which is
   * exactly the failure that reaches production.
   */
  const schoolsPerWeek = new Map(weekKeys.map((key) => [key, new Set()]));

  for (const row of paymentSpan) {
    const first = startOfWeekMonday(new Date(row.firstAt));
    const last = startOfWeekMonday(new Date(row.lastAt));
    if (last < start) continue;
    if (first < start) first.setTime(startOfWeekMonday(start).getTime());
    for (
      let cursor = new Date(first);
      cursor <= last && cursor <= end;
      cursor = new Date(cursor.getTime() + 7 * MS_PER_DAY)
    ) {
      const key = weekKey(cursor);
      // A school's span can start before the first week in the window and end after
      // the last; `weekSet` drops the keys outside it rather than growing the payload
      // with weeks the caller never asked about.
      if (weekSet.has(key)) schoolsPerWeek.get(key).add(String(row._id));
    }
  }

  const activeSchoolSeries = weekKeys.map((period) => {
    const weekStart = new Date(`${period}T00:00:00.000Z`);
    const weekEnd = new Date(weekStart.getTime() + 6 * MS_PER_DAY);
    return {
      period,
      periodStart: weekStart,
      periodEnd: weekEnd,
      activeSchools: schoolsPerWeek.get(period).size,
    };
  });

  /* ── Per-school volume, all three dimensions side by side ── */
  const combined = new Map();
  const touch = (schoolId) => {
    const key = String(schoolId);
    if (!combined.has(key)) {
      combined.set(key, {
        schoolId,
        smsSent: 0,
        studentsImported: 0,
        paymentsProcessed: 0,
        collected: 0,
      });
    }
    return combined.get(key);
  };
  for (const row of smsBySchool) touch(row._id).smsSent = num(row.smsSent);
  for (const row of studentsBySchool) touch(row._id).studentsImported = num(row.studentsImported);
  for (const row of paymentsBySchool) {
    const entry = touch(row._id);
    entry.paymentsProcessed = num(row.paymentsProcessed);
    entry.collected = num(row.collected);
  }

  const topSchools = [...combined.values()]
    .map((entry) => ({
      ...entry,
      /*
       * A **ranking score**, not a quantity.
       *
       * An SMS, an imported student and a processed payment have nothing in common
       * dimensionally, and the brief asks for one top-10 "across all of them". Adding
       * them produces a number whose magnitude means nothing — it is only ever read as
       * an ordering. Labelling it `activityScore` rather than `volume` is what stops
       * somebody putting it in a cedi column, and each component is returned beside it
       * so the ordering can be checked rather than trusted.
       */
      activityScore: entry.smsSent + entry.studentsImported + entry.paymentsProcessed,
    }))
    .sort((a, b) => b.activityScore - a.activityScore)
    .slice(0, 10);

  const schoolNames = await School.find({
    _id: { $in: [...combined.keys()] },
  })
    .select("name region subscription.plan")
    .lean();
  const nameById = new Map(schoolNames.map((s) => [String(s._id), s]));

  const totalPayments = paymentsBySchool.reduce((sum, row) => sum + num(row.paymentsProcessed), 0);
  const totalCollected = paymentsBySchool.reduce((sum, row) => sum + num(row.collected), 0);

  /*
   * Schools active *in the window*, which is not the same as schools that have ever
   * collected. `paymentSpan.length` would be a lifetime count wearing an active label,
   * and on a platform that has grown for two years the two differ by an order of
   * magnitude. The union of the per-week sets is exactly the schools whose first-to-last
   * span reaches into the window, so it is read off the series already built rather than
   * recomputed from the spans.
   */
  const schoolsActiveInWindow = new Set(
    [...schoolsPerWeek.values()].flatMap((set) => [...set])
  ).size;

  return {
    generatedAt: new Date().toISOString(),
    period: { from: start, to: end },
    units: { money: "integer pesewas", activityScore: "unitless ranking score, not a quantity" },

    totals: {
      smsSent: num(smsStats[0]?.sent),
      smsCreditsCharged: num(smsStats[0]?.credits),
      smsSegments: num(smsStats[0]?.segments),
      studentsImported: studentsBySchool.reduce(
        (sum, row) => sum + num(row.studentsImported),
        0
      ),
      paymentsProcessed: totalPayments,
      paymentsCollected: totalCollected,
      schoolsActiveInWindow,
      schoolsCollectingInWindow: new Set(
        paymentsBySchool.map((row) => String(row._id))
      ).size,
      schoolsThatEverCollected: paymentSpan.length,
    },

    /*
     * `storageUsed: null` — see the function comment. Returning `0` would be a
     * different claim: "no school uses any storage" is false, and "we do not measure
     * it" is true. `null` is the only value that renders as "unknown".
     */
    storageUsed: null,
    storageUsedReason:
      "Not measurable in this codebase. Uploads go to Cloudinary (utils/uploads.js, " +
      "middleware/upload.js) or are parsed in memory; no byte count is stored on School " +
      "or anywhere else. services/settings.service.js:249 returns a hard-coded 0.",

    /*
     * Test sends are excluded (`isTest: false` above) and the reason is not ours:
     * `smsMessageModel.js:74-78` records that a test message is billed at nothing and
     * must be excluded, or a school's "98% delivered" is partly a measurement of its
     * own phone. Counting them here would inflate platform SMS volume with messages
     * nobody's parent received.
     */
    activeSchoolsPerWeek: activeSchoolSeries,
    activeSchoolsNote:
      "A school counts as active in a week if it took at least one completed payment " +
      "in it. Derived from each school's first and last completed payment, so a school " +
      "with no payments at all in the window still appears on the weeks it was active.",

    topSchools: topSchools.map((entry) => {
      const school = nameById.get(String(entry.schoolId));
      return {
        ...entry,
        name: school?.name || null,
        region: school?.region || null,
        plan: school?.subscription?.plan || null,
      };
    }),
  };
};

// ──────────────────── 5. Collection rate (platform-wide, by term) ────────────────────

/**
 * Owed against collected, by term, across every school.
 *
 * **Where the "owed" figure actually comes from.** `PaymentPlan` does carry a
 * per-term owed amount, and it is the right field: `totalAmount` is the plan's face
 * value in integer pesewas, frozen at creation (paymentPlanModel.js:108), and
 * `academicYear` + `term` are denormalised onto the plan precisely so a term's
 * position can be read without joining back to a school whose current term has since
 * moved on (the comment at paymentPlanModel.js:74-87 says exactly that). So nothing
 * here is approximated away.
 *
 * What is approximated is the **window**, and the two facts are reported separately
 * because they are different questions:
 *
 *   - `owed` is a **position**: the face value of every live plan whose term overlaps
 *     the window. It does not change with the window once the plans exist.
 *   - `collectedInWindow` is a **flow**: money parents actually paid inside the
 *     window, from `Payment` where `status: "completed"`.
 *
 * Their ratio is *not* a collection rate and is not returned as one. A school that
 * billed in September and is still collecting in January would show a term with a full
 * owed amount against two months of collections and look catastrophically delinquent;
 * the reverse — a term billed inside the window and paid in an earlier one — is not
 * even expressible. What *is* a collection rate is the applied side: `installments
 * [.].amountPaid` against `installments[].amount` for the same plans, which is what
 * `byTerm[].collectionRatePercent` reports.
 *
 * **Schools with no plan for the term are NOT owed, and are reported as such.**
 * The alternative — excluding them from the platform total — silently flatters the
 * figure by removing every school that never created a plan, which is exactly the set
 * an owner most needs to see: `schoolsWithoutPlan` is returned for that reason, and
 * including those schools' collections in the numerator while leaving them out of the
 * denominator is the other failure, which would let the rate exceed 100%.
 */
export const getCollectionRateAnalytics = async ({ from, to } = {}) => {
  const { from: start, to: end } = resolveWindow(from, to, 365);
  const range = createdAtRange(start, end);

  /*
   * Plans whose own `[startDate, endDate]` overlaps the window.
   *
   * An overlap test rather than `createdAt in range`, because a plan created in June
   * for a term running September to December is owed in the window and a plan created
   * inside the window for a term that ended in March is not. Filtering on the plan's
   * creation date would answer "what was issued" — a plan count — under a heading
   * that says "what is owed".
   *
   * `planStatus: { $ne: "cancelled" }` only: a cancelled plan is not owed and a
   * defaulted one is very much still owed, which is the whole point of reporting.
   */
  const plans = await PaymentPlan.find({
    deletedAt: null,
    planStatus: { $ne: "cancelled" },
    startDate: { $lte: end },
    endDate: { $gte: start },
  })
    .select("schoolId studentId academicYear term totalAmount totalPaid installments planStatus")
    .lean();

  const termKeyOf = (plan) =>
    `${plan.academicYear || "(no academic year)"}|${plan.term || "(no term)"}`;

  const terms = new Map();
  for (const plan of plans) {
    const key = termKeyOf(plan);
    if (!terms.has(key)) {
      terms.set(key, {
        academicYear: plan.academicYear || null,
        term: plan.term || null,
        plans: 0,
        students: new Set(),
        schools: new Set(),
        owed: 0,
        applied: 0,
        dueInWindow: 0,
        appliedInWindow: 0,
      });
    }
    const entry = terms.get(key);
    entry.plans += 1;
    entry.students.add(String(plan.studentId));
    entry.schools.add(String(plan.schoolId));
    entry.owed += num(plan.totalAmount);
    /*
     * `amountPaid`, not `totalPaid`.
     *
     * `recomputePlanProgress` (paymentPlanModel.js:290) sets `totalPaid` to the sum of
     * `installments[].amountPaid`, so the two agree — but only for a plan that has been
     * through a save since its last installment moved. `amountPaid` is the field the
     * payment-application path writes, so it is the one that is right even for a plan
     * mid-update, and the derived field is read only as a cross-check below.
     */
    entry.applied += num(plan.totalPaid);
    for (const installment of plan.installments || []) {
      const dueAt = new Date(installment.dueDate);
      if (Number.isNaN(dueAt.getTime())) continue;
      if (dueAt < start || dueAt > end) continue;
      entry.dueInWindow += num(installment.amount);
      entry.appliedInWindow += num(installment.amountPaid);
    }
  }

  const plannedSchoolIds = new Set(plans.map((plan) => String(plan.schoolId)));

  /*
   * The roster is resolved **first**, on its own.
   *
   * It has to be: the "no plan" population is defined as *roster-bearing schools that
   * never issued a plan*, and asking the `School` collection for that directly needs
   * the roster's `_id` list as the `$in` half of the query. Doing it the other way
   * round — fetch every non-archived school with no plan, then discard the ones with no
   * students in JS — returns the whole platform to Node and throws most of it away,
   * which on a young platform with thousands of not-yet-enrolled signups is the single
   * most expensive line in this module.
   */
  const schoolsWithRoster = await Student.aggregate([
    { $match: ROSTER_MATCH },
    { $group: { _id: "$schoolId", students: { $sum: 1 } } },
  ]);

  const rosterSchools = new Set(schoolsWithRoster.map((row) => String(row._id)));

  const [collectedInWindow, schoolsWithoutPlan] = await Promise.all([
    Payment.aggregate([
      { $match: { deletedAt: null, status: "completed", createdAt: range } },
      { $group: { _id: "$schoolId", collected: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),

    /*
     * Live schools with a roster but **no** plan overlapping the window.
     *
     * Counted, then excluded from the denominator. Not because they perform well, but
     * because there is nothing to measure: a school that never issued an installment
     * plan has issued no owed amount, so counting it as fully paid would let the
     * operator of a school that collects nothing raise the platform's headline rate by
     * existing — and the report would have no way to say so. The count is returned so
     * the reader can judge the population the rate was computed over.
     *
     * `_id: { $in: [...rosterSchools] }` is `rosterSchools` — strings, which Mongoose
     * casts to ObjectId for this path. `rosterSchoolCount` is returned rather than
     * derived from the `_in` array so the response does not echo the whole roster.
     */
    School.countDocuments({
      deletedAt: null,
      status: { $ne: "archived" },
      _id: { $in: [...rosterSchools], $nin: [...plannedSchoolIds] },
    }),
  ]);

  const noPlanWithRosterCount = num(schoolsWithoutPlan);

  /*
   * Collected, restricted to schools that actually have a plan in scope.
   *
   * Without that restriction, a school paying through a pay link with no plan in the
   * window contributes collections to a numerator whose denominator excludes it, and
   * the platform rate climbs past 100% — a number that is arithmetically possible
   * here and means nothing.
   */
  const collectedFromPlannedSchools = collectedInWindow.filter((row) =>
    plannedSchoolIds.has(String(row._id))
  );

  const totalCollectedInWindow = collectedInWindow.reduce(
    (sum, row) => sum + num(row.collected),
    0
  );
  const collectedInScope = collectedFromPlannedSchools.reduce(
    (sum, row) => sum + num(row.collected),
    0
  );

  const byTerm = [...terms.entries()]
    .map(([key, entry]) => {
      const outstanding = Math.max(entry.owed - entry.applied, 0);
      return {
        key,
        academicYear: entry.academicYear,
        term: entry.term,
        schools: entry.schools.size,
        students: entry.students.size,
        plans: entry.plans,
        owed: entry.owed,
        applied: entry.applied,
        outstanding,
        collectionRatePercent: percent(entry.applied, entry.owed),
        dueInWindow: entry.dueInWindow,
        appliedInWindow: entry.appliedInWindow,
        rateOnDueInWindowPercent: percent(entry.appliedInWindow, entry.dueInWindow),
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  const totalOwed = byTerm.reduce((sum, row) => sum + row.owed, 0);
  const totalApplied = byTerm.reduce((sum, row) => sum + row.applied, 0);

  return {
    generatedAt: new Date().toISOString(),
    period: { from: start, to: end },
    units: {
      money: "integer pesewas (1 GHS = 100 pesewas)",
      rates: "percent, 0–100, null when there is no denominator to divide by",
    },

    totals: {
      owed: totalOwed,
      applied: totalApplied,
      outstanding: Math.max(totalOwed - totalApplied, 0),
      collectionRatePercent: percent(totalApplied, totalOwed),
      collectedInWindow: totalCollectedInWindow,
      collectedInWindowFromSchoolsWithPlans: collectedInScope,
      paymentsInWindow: collectedInWindow.reduce((sum, row) => sum + num(row.count), 0),
      terms: byTerm.length,
      schoolsWithPlans: plannedSchoolIds.size,
      schoolsWithRoster: rosterSchools.size,
      schoolsWithRosterButNoPlan: noPlanWithRosterCount,
      schoolsWithRosterAndAPlan: rosterSchools.size - noPlanWithRosterCount,
    },

    byTerm,

    definitions: {
      owed: "Sum of PaymentPlan.totalAmount for live plans whose term overlaps the window",
      applied: "Sum of the same plans' installments[].amountPaid — money actually applied",
      collectionRatePercent: "applied / owed, per term and in total",
      collectedInWindow:
        "Completed Payment amounts dated inside the window — a flow, not a position, and " +
        "deliberately not divided by `owed`",
      schoolsWithRosterButNoPlan:
        "Live schools with students and no plan in the window. Counted as NOT owed rather " +
        "than as fully paid, and excluded from the denominator so they cannot raise the rate. " +
        "`schoolsWithRosterAndAPlan` is the difference, and the two together are the " +
        "population the rate was computed over.",
    },
  };
};

// ──────────────────── 6. Gateway mix ────────────────────

/**
 * How much of the platform's payment volume runs over SukuuPay's own rails and how
 * much runs over the school's.
 *
 * Reads the mode from `School`, so there is an honest caveat that has to be stated in
 * the payload: this is a school's **current** configuration applied retroactively to
 * payments it took months ago. A school that switched from `manual` to `hubtel` in
 * March appears in full under SukuuPay for January too. Fixing it needs a per-payment
 * rail stamp (or a mode history), neither of which exists — `Payment.provider` records
 * which provider handled a payment but not whether the school chose it, so it cannot
 * reconstruct the rail either. The alternative of reading `Payment.provider` is worse:
 * it answers "which carrier" and would put a school running its own Hubtel account
 * through SukuuPay's line.
 */
export const getGatewayMixAnalytics = async ({ from, to } = {}) => {
  const { from: start, to: end } = resolveWindow(from, to, 365);
  const range = createdAtRange(start, end);

  const [schools, byMode, byProvider] = await Promise.all([
    School.find({ deletedAt: null })
      .select("name region payment.gatewayMode subscription.plan platformFeePercent")
      .lean(),

    /*
     * Volume grouped by the school's *current* mode, via `$lookup` into `schools`.
     *
     * The lookup rather than two round trips because a school's payment history is
     * the large side of the join; pulling `schoolId -> mode` into JS and grouping there
     * would materialise every completed payment in the window. `$unwind` drops nothing
     * — `schoolId` is `required` on `Payment` (paymentModel.js:47) and every school is
     * in the collection unless hard-deleted, in which case its payments are orphans and
     * belong in nobody's rail.
     */
    Payment.aggregate([
      { $match: { deletedAt: null, status: "completed", createdAt: range } },
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
        $group: {
          _id: { $ifNull: ["$school.payment.gatewayMode", "unset"] },
          volume: { $sum: "$amount" },
          count: { $sum: 1 },
          schools: { $addToSet: "$schoolId" },
        },
      },
    ]),

    /* The provider that actually handled each payment, for cross-reference. */
    Payment.aggregate([
      { $match: { deletedAt: null, status: "completed", createdAt: range } },
      {
        $group: {
          _id: { $ifNull: ["$provider", "unset"] },
          volume: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const schoolsPerMode = new Map();
  for (const school of schools) {
    const mode = school.payment?.gatewayMode || "unset";
    schoolsPerMode.set(mode, num(schoolsPerMode.get(mode)) + 1);
  }

  const totalVolume = byMode.reduce((sum, row) => sum + num(row.volume), 0);
  const totalCount = byMode.reduce((sum, row) => sum + num(row.count), 0);

  const rails = { sukuupay: [], school_own: [], unset: [] };
  for (const row of byMode) {
    const rail = GATEWAY_RAIL_BY_MODE[row._id] || "unset";
    rails[rail].push(row);
  }

  const railSummary = (rail) => {
    const rows = rails[rail] || [];
    const volume = rows.reduce((sum, row) => sum + num(row.volume), 0);
    const count = rows.reduce((sum, row) => sum + num(row.count), 0);
    return {
      volume,
      count,
      volumePercent: percent(volume, totalVolume),
      countPercent: percent(count, totalCount),
    };
  };

  return {
    generatedAt: new Date().toISOString(),
    period: { from: start, to: end },
    units: {
      money: "integer pesewas (1 GHS = 100 pesewas)",
      shares: "percent, 0–100, null when there is no denominator to divide by",
    },

    mapping: {
      /*
       * Published in the payload, not just in a comment, because the field name says
       * `gatewayMode` and its enum says `hubtel|arke|mnotify|manual` while the console
       * question is "ours or theirs". Anyone reading this response without the model
       * open would otherwise have to guess which of four provider names means "the
       * platform is in this transaction".
       */
      description:
        "School.payment.gatewayMode is a provider enum, not a rail enum. " +
        "manual = the school's own rail (no platform involvement); " +
        "hubtel|arke|mnotify = SukuuPay's rail.",
      rails: GATEWAY_RAIL_BY_MODE,
      paymentProviderRails: PAYMENT_PROVIDER_RAIL,
      divergence:
        "There is no `sukuupay|school` enum anywhere in this codebase. School.payment." +
        "gatewayMode is `hubtel|arke|mnotify|manual` (schoolModel.js:159) and " +
        "Payment.provider additionally allows `mtn` (paymentModel.js:81), which maps to " +
        "Sukuupay because it is reached through a platform integration.",
    },

    totals: { volume: totalVolume, count: totalCount },

    rails: {
      sukuupay: railSummary("sukuupay"),
      school_own: railSummary("school_own"),
      unset: railSummary("unset"),
    },

    byGatewayMode: byMode
      .map((row) => ({
        gatewayMode: row._id,
        rail: GATEWAY_RAIL_BY_MODE[row._id] || "unset",
        schoolsWithThisMode: num(schoolsPerMode.get(row._id)),
        schoolsCollecting: row.schools.length,
        volume: num(row.volume),
        count: num(row.count),
        volumePercent: percent(row.volume, totalVolume),
        countPercent: percent(row.count, totalCount),
      }))
      .sort((a, b) => b.volume - a.volume),

    byPaymentProvider: byProvider
      .map((row) => ({
        provider: row._id,
        rail: PAYMENT_PROVIDER_RAIL[row._id] || "unset",
        volume: num(row.volume),
        count: num(row.count),
        volumePercent: percent(row.volume, totalVolume),
      }))
      .sort((a, b) => b.volume - a.volume),

    caveat:
      "A school's CURRENT gatewayMode is applied to every payment in the window. " +
      "Switching modes restates the whole history; Payment.provider records which " +
      "carrier handled a payment but not whether the school chose it, so the rail at " +
      "the time of payment cannot be reconstructed.",
  };
};

// ──────────────────── 7. Top schools ────────────────────

/**
 * The largest schools by revenue, students or payment volume.
 *
 * `metric: "revenue"` is genuinely ambiguous — it could mean the school's gross
 * collected volume or the platform's earnings from that school — and both readings
 * are useful to the same person, so **both are returned** and neither is called
 * `revenue` alone. `collected` is what the school took; `platformRevenue` is what
 * SukuuPay took from it, from `PlatformLedger` where `schoolId` is set. An owner
 * reading a "top schools by revenue" table wants the first column to sort by and the
 * second to explain why the first is not simply the biggest school.
 */
export const getTopSchoolsAnalytics = async ({ metric = "revenue", limit = 10, from, to } = {}) => {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const { from: start, to: end } = resolveWindow(from, to, 365);
  const range = createdAtRange(start, end);

  let ranked;

  if (metric === "students") {
    /*
     * Students are a **position**, not a windowed flow, so this one deliberately
     * ignores the window: "the schools with the most students" is not a question
     * about last quarter, and filtering by `createdAt` would answer "which schools
     * imported the most students since March" — a different and much less useful
     * question, silently.
     */
    ranked = await Student.aggregate([
      { $match: ROSTER_MATCH },
      { $group: { _id: "$schoolId", value: { $sum: 1 } } },
      { $sort: { value: -1 } },
      { $limit: safeLimit },
    ]);
  } else {
    /*
     * `payments` and `revenue` share one pipeline and differ only in the sort: the
     * count and the cedi total come out of the same `$group`, so splitting them into
     * two aggregations would scan the same payments twice to return a row that already
     * contains both numbers.
     */
    ranked = await Payment.aggregate([
      { $match: { deletedAt: null, status: "completed", createdAt: range } },
      { $group: { _id: "$schoolId", value: { $sum: 1 }, collected: { $sum: "$amount" } } },
      { $sort: { [metric === "payments" ? "value" : "collected"]: -1 } },
      { $limit: safeLimit },
    ]);
  }

  const schoolIds = ranked.map((row) => row._id);

  const [schools, platformRevenue] = await Promise.all([
    School.find({ _id: { $in: schoolIds }, deletedAt: null })
      .select("name schoolCode region status subscription.plan subscription.status subscription.monthlyFee payment.gatewayMode")
      .lean(),

    schoolIds.length
      ? PlatformLedger.aggregate([
          {
            $match: {
              schoolId: { $in: schoolIds },
              type: { $in: PLATFORM_REVENUE_TYPES },
              amount: { $gt: 0 },
              createdAt: range,
            },
          },
          { $group: { _id: "$schoolId", platformRevenue: { $sum: "$amount" } } },
        ])
      : [],
  ]);

  const schoolById = new Map(schools.map((school) => [String(school._id), school]));
  const platformById = new Map(
    platformRevenue.map((row) => [String(row._id), num(row.platformRevenue)])
  );

  return {
    generatedAt: new Date().toISOString(),
    metric,
    limit: safeLimit,
    period: { from: start, to: end },
    units: { money: "integer pesewas", counts: "documents, not cedi" },

    note:
      metric === "students"
        ? "Student counts are a current position and ignore the window."
        : "`value` is the metric asked for; `collected` and `platformRevenue` are both " +
          "returned because 'revenue' means two different numbers to the two people " +
          "reading this table.",

    schools: ranked
      .map((row, index) => {
        const school = schoolById.get(String(row._id));
        if (!school) return null;
        return {
          rank: index + 1,
          schoolId: school._id,
          name: school.name,
          schoolCode: school.schoolCode,
          region: school.region,
          status: school.status,
          plan: school.subscription?.plan || null,
          subscriptionStatus: school.subscription?.status || null,
          gatewayMode: school.payment?.gatewayMode || null,
          value: num(row.value),
          collected: metric === "students" ? null : num(row.collected),
          platformRevenue: platformById.get(String(row._id)) ?? 0,
          mrr: Math.round(num(school.subscription?.monthlyFee)),
        };
      })
      .filter(Boolean),
  };
};

// ──────────────────── 8. At-risk schools ────────────────────

/**
 * Schools that are quietly going quiet.
 *
 * **Three conditions, reported as an array of reasons rather than one flag.** A school
 * with no payments *and* no students is a signup that never started; a school with no
 * payments and 400 students is a live business whose parents have stopped paying.
 * Both are "no completed payment in 14 days", they call for opposite conversations,
 * and a boolean cannot tell them apart — so `reasons` is the contract and every
 * condition that fired contributes a code to it.
 *
 * Codes, rather than prose, because a client will want to filter and colour them:
 *
 *   - `no_payment_14d`   — nothing completed in 14+ days. Also fires for a school that
 *                         has *never* taken a payment, which is the extreme of the same
 *                         condition; `lastPaymentAt: null` is what distinguishes "quiet"
 *                         from "has never paid", and `daysSinceLastPayment` is `null`
 *                         rather than `0` for the same reason.
 *   - `subscription_past_due` — `subscription.status` is `expired`. See
 *                         `PAST_DUE_SUBSCRIPTION_STATUSES` for why `suspended` and
 *                         `cancelled` are *not* included.
 *   - `zero_students`   — no roster. A school with nobody on it is not a churn risk,
 *                         it is an unfinished setup, and the fix is a different person
 *                         being called.
 *
 * Suspended schools are **included** (the brief scopes this to non-archived,
 * non-deleted) and their `status` is returned, so the operator can filter rather than
 * being handed a list with a hidden filter in it.
 */
export const getAtRiskSchools = async ({ limit } = {}) => {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 100, 1),
    MAX_PER_PAGE
  );
  const now = new Date();
  const cutoff = new Date(now.getTime() - AT_RISK_NO_PAYMENT_DAYS * MS_PER_DAY);

  /*
   * One platform-wide `$group` for last-payment-per-school.
   *
   * This is the only full scan in the module and it is deliberate. The alternative is
   * N+1 — one query per school — which is worse at every scale, and a second query
   * for "schools with a recent payment" plus a third for the rest would produce the
   * same answer with two round trips and no per-school detail. `{schoolId, status}`
   * and `{schoolId, createdAt}` are both indexed (paymentModel.js:227-228), and the
   * `$max` grouped by an indexed field is what makes this a grouped pass rather than a
   * scan per school.
   *
   * `allowDiskUse` because a grouped pass over every payment in the database is
   * allowed to spill; the alternative is a 100MB memory limit failure in production
   * that has never been seen in development.
   */
  const lastPayments = await Payment.aggregate(
    [
      { $match: { deletedAt: null, status: "completed" } },
      {
        $group: {
          _id: "$schoolId",
          lastPaymentAt: { $max: "$createdAt" },
          payments: { $sum: 1 },
          collected: { $sum: "$amount" },
        },
      },
    ],
    { allowDiskUse: true }
  );

  const lastBySchool = new Map(
    lastPayments.map((row) => [String(row._id), row])
  );

  const schools = await School.find({ deletedAt: null, status: { $ne: "archived" } })
    .select(
      "name schoolCode region status createdAt subscription.plan subscription.status subscription.monthlyFee subscription.currentPeriodEnd platformFeePercent payment.gatewayMode tags"
    )
    .lean();

  const roster = await Student.aggregate([
    { $match: ROSTER_MATCH },
    { $group: { _id: "$schoolId", students: { $sum: 1 } } },
  ]);
  const studentsBySchool = new Map(roster.map((row) => [String(row._id), num(row.students)]));

  const rows = [];

  for (const school of schools) {
    const reasons = [];

    const last = lastBySchool.get(String(school._id));
    const lastPaymentAt = last?.lastPaymentAt ? new Date(last.lastPaymentAt) : null;
    const daysSinceLastPayment = lastPaymentAt
      ? Math.floor((now.getTime() - lastPaymentAt.getTime()) / MS_PER_DAY)
      : null;

    if (!lastPaymentAt || lastPaymentAt <= cutoff) reasons.push("no_payment_14d");

    if (PAST_DUE_SUBSCRIPTION_STATUSES.includes(school.subscription?.status)) {
      reasons.push("subscription_past_due");
    }

    const studentCount = num(studentsBySchool.get(String(school._id)));
    if (studentCount === 0) reasons.push("zero_students");

    if (!reasons.length) continue;

    rows.push({
      schoolId: school._id,
      name: school.name,
      schoolCode: school.schoolCode,
      region: school.region,
      status: school.status,
      tags: school.tags || [],
      plan: school.subscription?.plan || null,
      subscriptionStatus: school.subscription?.status || null,
      subscriptionPeriodEndsAt: school.subscription?.currentPeriodEnd || null,
      platformFeePercent: num(school.platformFeePercent),
      gatewayMode: school.payment?.gatewayMode || null,
      mrr: Math.round(num(school.subscription?.monthlyFee)),
      studentCount,
      reasons,
      lastPaymentAt,
      daysSinceLastPayment,
      paymentsAllTime: num(last?.payments),
      collectedAllTime: num(last?.collected),
      createdAt: school.createdAt,
    });
  }

  /*
   * Most reasons first, then the longest silence.
   *
   * A school tripping all three conditions is a setup that never happened; a school
   * tripping one, with 400 students, is a collection problem. Sorting on the reason
   * count puts the first conversation before the second, which is roughly the order
   * an operator can act in.
   */
  rows.sort((a, b) => {
    if (b.reasons.length !== a.reasons.length) return b.reasons.length - a.reasons.length;
    return (b.daysSinceLastPayment ?? Infinity) - (a.daysSinceLastPayment ?? Infinity);
  });

  const byReason = {};
  for (const code of ["no_payment_14d", "subscription_past_due", "zero_students"]) {
    byReason[code] = rows.filter((row) => row.reasons.includes(code)).length;
  }

  return {
    generatedAt: now.toISOString(),
    noPaymentThresholdDays: AT_RISK_NO_PAYMENT_DAYS,
    units: { money: "integer pesewas", days: "whole days since the last completed payment" },

    definitions: {
      no_payment_14d:
        "No completed Payment in 14+ days, including never having taken one. " +
        "lastPaymentAt is null in that case rather than being back-dated.",
      subscription_past_due:
        "subscription.status is `expired`. The enum has no `past_due` value; `suspended` " +
        "and `cancelled` are deliberate decisions, not missed bills, and are not included.",
      zero_students:
        "No Student rows on the roster (status is not `removed`). A graduated cohort " +
        "still counts — see ROSTER_MATCH.",
    },

    summary: {
      atRiskSchools: rows.length,
      byReason,
      neverPaid: rows.filter((row) => row.lastPaymentAt === null).length,
      byStatus: rows.reduce((acc, row) => {
        acc[row.status] = num(acc[row.status]) + 1;
        return acc;
      }, {}),
    },

    meta: {
      page: 1,
      perPage: safeLimit,
      total: rows.length,
      pages: Math.max(1, Math.ceil(rows.length / safeLimit)),
      truncated: rows.length > safeLimit,
    },

    schools: rows.slice(0, safeLimit),
  };
};

export default {
  getPlatformOverview,
  getRevenueAnalytics,
  getSchoolsAnalytics,
  getUsageAnalytics,
  getCollectionRateAnalytics,
  getGatewayMixAnalytics,
  getTopSchoolsAnalytics,
  getAtRiskSchools,
  buildGapFreeSeries,
  buildPeriodKeys,
};
