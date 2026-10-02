import Joi from "joi";
import { ADMIN_REPORT_TYPES } from "../services/admin/reports.service.js";

/**
 * Query validation for the platform console's analytics and reports.
 *
 * **No `.min(1)` on these objects, and that is the opposite of the body-schema rule in
 * the conventions.** Schemas are patches by default — every field optional, `.min(1)` so
 * a client writing back a whole document cannot blank what it did not mean to change —
 * and that rule exists because `PUT /admin/settings` writes with `$set`. A `GET` has no
 * body and nothing to blank: `GET /admin/analytics/overview` arrives with `req.query` as
 * an empty object, and a `.min(1)` would turn the console's most-used endpoint into a
 * 422 for the want of a query string. The patch convention protects writes; applying it
 * to reads only breaks them.
 *
 * **Every field is optional and defaulted in the service instead.** A default that 422s
 * is worse than a default that works: "the last 12 months" and "the last 30 days" are
 * different windows chosen for different endpoints, and they are documented at the
 * function that applies them rather than hidden in a `.default()` here where the reason
 * would have nowhere to go.
 */

/** `YYYY-MM-DD` or a full ISO timestamp. `resolveDateRange` widens both ends to whole
 *  days in UTC, and Ghana is permanently UTC+0 (utils/dateHelpers.js), so a day
 *  boundary here is the local one exactly. */
const isoDate = Joi.date().iso();

/**
 * `from`/`to` pair.
 *
 * The ordering check lives in `.custom` rather than in a per-endpoint rule because an
 * inverted range is *silently* wrong everywhere it can appear: an empty aggregation
 * result and a plausible-looking "0 revenue over the whole period" are the same
 * response, and a reversed range produces the first one every time. Refusing it is the
 * only way the operator learns they typed it backwards.
 */
const dateRange = {
  from: isoDate.optional(),
  to: isoDate.optional(),
};

const assertOrderedRange = (value, helpers) => {
  if (value.from && value.to && new Date(value.from) > new Date(value.to)) {
    return helpers.message({ custom: "'from' must be on or before 'to'" });
  }
  return value;
};

/**
 * `GET /admin/analytics/revenue`
 *
 * `groupBy` accepts `week` in addition to the two `revenueSeriesQuerySchema` in
 * `admin.validation.js` allows, because this endpoint splits by ledger type and a week
 * is the granularity a finance reviewer actually asks for. It is defaulted to `month`
 * rather than `day` for the same reason `admin.validation.js` defaults to `month`: a
 * daily view of a young platform is 365 identical-looking points.
 */
const revenueAnalyticsQuerySchema = Joi.object({
  ...dateRange,
  groupBy: Joi.string().valid("day", "week", "month").default("month"),
}).custom(assertOrderedRange);

/** `GET /admin/analytics/schools` */
const schoolsAnalyticsQuerySchema = Joi.object({
  ...dateRange,
}).custom(assertOrderedRange);

/** `GET /admin/analytics/usage` */
const usageAnalyticsQuerySchema = Joi.object({
  ...dateRange,
}).custom(assertOrderedRange);

/** `GET /admin/analytics/collection-rate` */
const collectionRateQuerySchema = Joi.object({
  ...dateRange,
}).custom(assertOrderedRange);

/** `GET /admin/analytics/gateway-mix` */
const gatewayMixQuerySchema = Joi.object({
  ...dateRange,
}).custom(assertOrderedRange);

/**
 * `GET /admin/analytics/top-schools`
 *
 * `limit` is capped at 50 rather than at the console's `MAX_PER_PAGE` of 200 because a
 * "top schools" list of 200 is not a top list: the row limit here exists to keep the
 * response a chart, and 50 is already past the point where anybody reads it. The two
 * ceilings answer different questions and reusing the pagination one would be a
 * convenience that quietly permits a 200-row ranking.
 *
 * `metric: "students"` is documented as window-ignoring in the service; validating the
 * enum here means a client cannot pass `?metric=students&from=…` and be silently
 * misled, because the response carries `note` saying the window was ignored.
 */
const topSchoolsQuerySchema = Joi.object({
  ...dateRange,
  metric: Joi.string().valid("revenue", "students", "payments").default("revenue"),
  limit: Joi.number().integer().min(1).max(50).default(10),
}).custom(assertOrderedRange);

/**
 * `GET /admin/analytics/at-risk-schools`
 *
 * `limit` defaults to 100 and is capped at `MAX_PER_PAGE`'s 200 — the same ceiling every
 * console list uses (`platformQuery.js` `MAX_PER_PAGE`), because the response carries the
 * standard `meta` block and a pager whose perPage exceeds the platform ceiling is a
 * pager for something else.
 */
const atRiskSchoolsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(200).default(100),
});

/**
 * The four report GETs.
 *
 * Shared rather than per-report because all four take exactly the same filter, and four
 * copies of the same date rule is four places for one of them to drift.
 */
const reportQuerySchema = Joi.object({
  ...dateRange,
}).custom(assertOrderedRange);

/**
 * `GET /admin/reports/export`
 *
 * **`type` is validated against `ADMIN_REPORT_TYPES`, imported from the reports service
 * rather than retyped here.** That is a deliberate layering compromise and the reason is
 * worth stating: a hand-written list of five names in a validation file is a second
 * source of truth, and the failure it produces is a 400 thrown from deep inside the
 * service at request time rather than a 422 at the edge — which is the worst moment to
 * discover that a report was renamed. The service owns the list; the schema enforces it.
 *
 * **`format` is `csv | xlsx | pdf`, and `xlsx` is not what the serialiser is called.**
 * The public vocabulary is by file extension because that is what a caller means. The
 * translation to `sendReportFile`'s `excel` branch happens at the export boundary, once,
 * rather than by adding `xlsx` as a fourth accepted value to `utils/reportExport.js` —
 * which nine school-report endpoints share.
 */
const reportExportQuerySchema = Joi.object({
  type: Joi.string()
    .valid(...ADMIN_REPORT_TYPES)
    .required(),
  ...dateRange,
  format: Joi.string()
    .trim()
    .lowercase()
    .valid("csv", "xlsx", "pdf")
    .required(),
}).custom(assertOrderedRange);

export {
  revenueAnalyticsQuerySchema,
  schoolsAnalyticsQuerySchema,
  usageAnalyticsQuerySchema,
  collectionRateQuerySchema,
  gatewayMixQuerySchema,
  topSchoolsQuerySchema,
  atRiskSchoolsQuerySchema,
  reportQuerySchema,
  reportExportQuerySchema,
  ADMIN_REPORT_TYPES,
};
