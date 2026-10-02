import Joi from "joi";

const schoolIdParamSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "Invalid school ID format",
    }),
});

const listAllSchoolsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid("active", "suspended", "archived").optional(),
  region: Joi.string().optional(),
  plan: Joi.string().valid("trial", "basic", "standard", "premium", "enterprise").optional(),
  // An operator label from `School.tags`. Free text rather than an enum, so the
  // vocabulary can grow without a deploy — which is why the bound is a length and
  // not a membership test. A tag nobody has used matches nothing, which is a better
  // failure than a schema that cannot express the label at all.
  tag: Joi.string().trim().max(50).allow("").optional(),
  // Free-text is over the name, code, email, city and phone — the fields a school
  // is actually looked up by when someone has a slip of paper. Matching `region` on
  // it as well would make `search=Ashanti` return schools in a region the caller did
  // not filter for, silently widening a query they thought was about names.
  search: Joi.string().trim().max(100).allow("").optional(),
  sortBy: Joi.string()
    .valid("name", "createdAt", "schoolCode", "region", "status")
    .default("createdAt"),
  sortOrder: Joi.string().valid("asc", "desc").default("desc"),
});

const revenueQuerySchema = Joi.object({
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  period: Joi.string().valid("all", "mtd", "ytd", "last30").default("all"),
  plan: Joi.string().valid("trial", "basic", "standard", "premium", "enterprise").optional(),
  region: Joi.string().optional(),
});

const suspendSchema = Joi.object({
  reason: Joi.string().trim().min(10).max(500).required(),
});

/**
 * `GET /admin/revenue/series`
 *
 * `bucket` is a required choice rather than something derived from the range,
 * because the two granularities are not interchangeable — 30 daily points for
 * "last 30 days", 24 monthly points for "this year" — and a chart whose *shape*
 * depends on how the server happened to sample the data is a chart nobody can read.
 *
 * `period` defaults to `ytd` rather than `all`, because `all` here means "two
 * years of history" (see `getRevenueSeries`) and a two-year monthly series on a
 * young platform is a mostly-flat line with one spike, which reads as a failure.
 */
const revenueSeriesQuerySchema = Joi.object({
  bucket: Joi.string().valid("month", "day").default("month"),
  period: Joi.string().valid("mtd", "ytd", "last30", "all").default("ytd"),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  plan: Joi.string().valid("trial", "basic", "standard", "premium", "enterprise").optional(),
  region: Joi.string().optional(),
});

/**
 * `PUT /admin/settings`
 *
 * Every field optional and `.min(1)` on the object, so a PUT is a **patch**: a
 * client that reads, changes one flag and writes the whole document back cannot
 * blank the settings it did not mean to touch.
 *
 * `singletonKey` is absent, not merely ignored — `validate` runs Joi with
 * `stripUnknown: true`, so a body containing it has the key removed rather than
 * rejected, and the model's `immutable` + `unique` constraints are what actually
 * make "one document" true. There is nothing to validate about a field the caller
 * must never set.
 *
 * The nested groups are all-optional *within* an optional group, which is what
 * makes `PUT {"sms": {}}` a no-op rather than a blanking: `updatePlatformSettings`
 * `$set`s the group verbatim, and an empty object written over `ratePesewas` would
 * otherwise leave the field `undefined` and every cost figure computed as `NaN`.
 */
const updatePlatformSettingsSchema = Joi.object({
  defaultMarkupPercent: Joi.number().min(0).max(100),
  // Capped at 5 rather than 100, matching the model's bound. This is a percentage
  // of a school's own collected volume, not a skim off one parent payment — a 100%
  // "platform fee" is a syntactically valid number and a nonsense charge.
  defaultPlatformFeePercent: Joi.number().min(0).max(5),
  // Integer pesewas, like every money field. Coerced so a client sending `150.50`
  // gets 15050 rather than a silent 150.5 that no other code path expects.
  defaultMonthlyFee: Joi.number().integer().min(0),
  features: Joi.object({
    adsEnabled: Joi.boolean(),
    selfSignupEnabled: Joi.boolean(),
    trialDays: Joi.number().integer().min(0).max(365),
  }),
  disbursement: Joi.object({
    frequency: Joi.string().valid("daily", "weekly", "biweekly", "monthly"),
    // 0 = Sunday, matching `Date#getDay` and `cron`. Documented at the schema.
    dayOfWeek: Joi.number().integer().min(0).max(6),
    autoApprove: Joi.boolean(),
  }).min(1),
  sms: Joi.object({
    provider: Joi.string().valid("arke", "hubtel"),
    ratePesewas: Joi.number().integer().min(0),
  }).min(1),
  support: Joi.object({
    phone: Joi.string().trim().allow("").max(40),
    email: Joi.string().trim().email().allow("").max(200),
  }).min(1),
  maintenance: Joi.object({
    mode: Joi.string().valid("off", "readonly", "on"),
    message: Joi.string().trim().allow("").max(500),
  }),
}).min(1);

/**
 * `PUT /admin/settings/commission`
 *
 * The two percentages that decide what SukuuPay takes, separated from the general
 * settings write so the console can put a confirmation in front of exactly these and
 * nothing else. "Save settings" and "change what we earn" are different decisions
 * and deserve different buttons.
 */
const updateCommissionSchema = Joi.object({
  defaultMarkupPercent: Joi.number().min(0).max(100).required(),
  defaultPlatformFeePercent: Joi.number().min(0).max(5).required(),
});

/**
 * `PUT /admin/settings/disbursement`
 *
 * `autoApprove` is the one field in this schema that makes money move without a
 * person pressing anything, which is why the group carries `.min(1)` — a
 * `{}` body is refused rather than treated as a no-op, so a client that means to
 * turn auto-approval on cannot do it by accident with an empty object.
 */
const updateDisbursementSettingsSchema = Joi.object({
  frequency: Joi.string().valid("daily", "weekly", "biweekly", "monthly"),
  dayOfWeek: Joi.number().integer().min(0).max(6),
  autoApprove: Joi.boolean(),
}).min(1);

export {
  schoolIdParamSchema,
  listAllSchoolsQuerySchema,
  revenueQuerySchema,
  suspendSchema,
  revenueSeriesQuerySchema,
  updatePlatformSettingsSchema,
  updateCommissionSchema,
  updateDisbursementSettingsSchema,
};
