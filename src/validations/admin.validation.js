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
 */
const updatePlatformSettingsSchema = Joi.object({
  defaultMarkupPercent: Joi.number().min(0).max(100),
  features: Joi.object({
    adsEnabled: Joi.boolean(),
    selfSignupEnabled: Joi.boolean(),
    trialDays: Joi.number().integer().min(0).max(365),
  }),
  maintenance: Joi.object({
    mode: Joi.string().valid("off", "readonly", "on"),
    message: Joi.string().trim().allow("").max(500),
  }),
}).min(1);

export {
  schoolIdParamSchema,
  listAllSchoolsQuerySchema,
  revenueQuerySchema,
  suspendSchema,
  revenueSeriesQuerySchema,
  updatePlatformSettingsSchema,
};
