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

export {
  schoolIdParamSchema,
  listAllSchoolsQuerySchema,
  revenueQuerySchema,
  suspendSchema,
};
