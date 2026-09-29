import Joi from "joi";

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

export const schoolIdParamSchema = Joi.object({
  schoolId: objectId
    .required()
    .messages({ "string.pattern.base": "Invalid school ID format" }),
});

const GROUP_BY_ENUM = ["month", "term", "class"];
const HORIZON_ENUM = [30, 60, 90];
const SEVERITY_ENUM = ["warning", "critical", "all"];
const PLAN_STATUS_ENUM = [
  "pending_acceptance",
  "active",
  "completed",
  "defaulted",
  "cancelled",
  "expired",
];

export const overviewQuerySchema = Joi.object({
  academicYear: Joi.string().trim().max(20).optional().allow("", null),
  term: Joi.string().trim().max(20).optional().allow("", null),
});

export const revenueQuerySchema = Joi.object({
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  groupBy: Joi.string()
    .valid(...GROUP_BY_ENUM)
    .default("month"),
  class: Joi.string().trim().max(50).optional().allow("", null),
  academicYear: Joi.string().trim().max(20).optional().allow("", null),
  term: Joi.string().trim().max(20).optional().allow("", null),
}).custom((value, helpers) => {
  if (value.startDate && value.endDate && new Date(value.startDate) > new Date(value.endDate)) {
    return helpers.message({ custom: "startDate must be before or equal to endDate" });
  }
  return value;
});

export const paidOwedQuerySchema = Joi.object({
  academicYear: Joi.string().trim().max(20).optional().allow("", null),
  term: Joi.string().trim().max(20).optional().allow("", null),
  class: Joi.string().trim().max(50).optional().allow("", null),
});

export const personsQuerySchema = Joi.object({
  class: Joi.string().trim().max(50).optional().allow("", null),
  status: Joi.string().trim().max(20).optional().allow("", null),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(200).default(50),
});

export const revenueChartQuerySchema = Joi.object({
  groupBy: Joi.string()
    .valid(...GROUP_BY_ENUM)
    .required(),
  academicYear: Joi.string().trim().max(20).optional().allow("", null),
  term: Joi.string().trim().max(20).optional().allow("", null),
  class: Joi.string().trim().max(50).optional().allow("", null),
});

export const overdueQuerySchema = Joi.object({
  class: Joi.string().trim().max(50).optional().allow("", null),
  severity: Joi.string()
    .valid(...SEVERITY_ENUM)
    .default("all"),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(200).default(50),
  sortBy: Joi.string()
    .valid("daysOverdue", "totalOverdueAmount", "studentName", "studentClass")
    .default("daysOverdue"),
  sortOrder: Joi.string().valid("asc", "desc").default("desc"),
});

export const cashflowQuerySchema = Joi.object({
  horizon: Joi.number()
    .integer()
    .valid(...HORIZON_ENUM)
    .default(90),
  asOf: Joi.date().iso().optional(),
  class: Joi.string().trim().max(50).optional().allow("", null),
});

export const complianceQuerySchema = Joi.object({
  academicYear: Joi.string().trim().max(20).optional().allow("", null),
  term: Joi.string().trim().max(20).optional().allow("", null),
  class: Joi.string().trim().max(50).optional().allow("", null),
});

export const defaultRateQuerySchema = Joi.object({
  academicYear: Joi.string().trim().max(20).optional().allow("", null),
  term: Joi.string().trim().max(20).optional().allow("", null),
});

export const classPerformanceQuerySchema = Joi.object({
  academicYear: Joi.string().trim().max(20).optional().allow("", null),
  term: Joi.string().trim().max(20).optional().allow("", null),
});

export {
  GROUP_BY_ENUM,
  HORIZON_ENUM,
  SEVERITY_ENUM,
  PLAN_STATUS_ENUM,
  objectId,
};
