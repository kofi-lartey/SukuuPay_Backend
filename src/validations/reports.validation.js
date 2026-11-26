import Joi from "joi";

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

export const schoolIdParamSchema = Joi.object({
  schoolId: objectId
    .required()
    .messages({ "string.pattern.base": "Invalid school ID format" }),
});

const GROUP_BY_ENUM = ["method", "month", "term", "class"];
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
const PAYMENT_STATUS_ENUM = [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
  "refunded",
];
const RELATIONSHIP_ENUM = ["father", "mother", "guardian", "other"];
const PAYMENT_METHOD_ENUM = ["momo", "card", "bank_transfer", "cash"];
const SORT_ORDER_ENUM = ["asc", "desc"];

const formatSchema = Joi.string()
  .trim()
  .lowercase()
  .valid("csv", "excel", "pdf")
  .optional()
  .allow("", null);

const reportFormatSchema = Joi.string()
  .trim()
  .lowercase()
  .valid("csv", "pdf", "xlsx")
  .optional()
  .allow("", null);

const createTemplateBodySchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).required(),
  type: Joi.string()
    .valid("moe_compliance", "custom_audit", "financial_summary")
    .required(),
  format: reportFormatSchema.default("csv"),
  moeCompliant: Joi.boolean().default(false),
  parameters: Joi.object().default({}),
});

const createJobBodySchema = Joi.object({
  templateId: objectId.required(),
  parameters: Joi.object().default({}),
});

const jobIdParamSchema = Joi.object({
  id: objectId.required(),
});

const dateSchema = Joi.date().iso().optional();

const academicYearSchema = Joi.string().trim().pattern(/^\d{4}\/\d{4}$/).optional().allow("", null);
const termSchema = Joi.string().trim().max(20).optional().allow("", null);
const classSchema = Joi.string().trim().max(50).optional().allow("", null);
const pageSchema = Joi.number().integer().min(1).default(1);
const perPageSchema = Joi.number().integer().min(1).max(200).default(50);

const reportListQuerySchema = Joi.object({
  page: pageSchema,
  perPage: perPageSchema,
  status: Joi.string()
    .valid("queued", "processing", "completed", "failed")
    .optional(),
});

export const dailyQuerySchema = Joi.object({
  date: dateSchema,
  class: classSchema,
  paymentMethod: Joi.string().valid(...PAYMENT_METHOD_ENUM).optional(),
  status: Joi.string().valid(...PAYMENT_STATUS_ENUM).optional(),
  page: pageSchema,
  perPage: perPageSchema,
  format: formatSchema,
}).custom((value, helpers) => {
  if (value.date) {
    const d = new Date(value.date);
    if (Number.isNaN(d.getTime())) {
      return helpers.message({ custom: "Invalid date format" });
    }
  }
  return value;
});

export const termQuerySchema = Joi.object({
  academicYear: academicYearSchema,
  term: termSchema,
  class: classSchema,
  format: formatSchema,
});

export const outstandingQuerySchema = Joi.object({
  academicYear: academicYearSchema,
  class: classSchema,
  minAmount: Joi.number().integer().min(0).optional(),
  minAgeDays: Joi.number().integer().min(0).optional(),
  status: Joi.string().valid("not_paid", "partial", "all").default("all"),
  sortBy: Joi.string()
    .valid("balance", "studentName", "studentClass", "oldestDueDate")
    .default("balance"),
  sortOrder: Joi.string().valid(...SORT_ORDER_ENUM).default("desc"),
  page: pageSchema,
  perPage: perPageSchema,
  format: formatSchema,
}).custom((value, helpers) => {
  if (value.sortBy === "oldestDueDate" && value.sortOrder === "asc") {
    return value;
  }
  return value;
});

export const complianceQuerySchema = Joi.object({
  academicYear: academicYearSchema,
  term: termSchema,
  class: classSchema,
  planStatus: Joi.string().valid(...PLAN_STATUS_ENUM).optional(),
  page: pageSchema,
  perPage: perPageSchema,
  format: formatSchema,
});

export const paymentMethodsQuerySchema = Joi.object({
  startDate: dateSchema,
  endDate: dateSchema,
  groupBy: Joi.string().valid(...GROUP_BY_ENUM).default("method"),
  academicYear: academicYearSchema,
  class: classSchema,
  format: formatSchema,
}).custom((value, helpers) => {
  if (value.startDate && value.endDate && new Date(value.startDate) > new Date(value.endDate)) {
    return helpers.message({ custom: "startDate must be before or equal to endDate" });
  }
  return value;
});

export const classCollectionsQuerySchema = Joi.object({
  academicYear: academicYearSchema,
  term: termSchema,
  startDate: dateSchema,
  endDate: dateSchema,
  sortBy: Joi.string()
    .valid("className", "expected", "collected", "balance", "collectionRate")
    .default("collectionRate"),
  sortOrder: Joi.string().valid(...SORT_ORDER_ENUM).default("asc"),
  format: formatSchema,
}).custom((value, helpers) => {
  if (value.startDate && value.endDate && new Date(value.startDate) > new Date(value.endDate)) {
    return helpers.message({ custom: "startDate must be before or equal to endDate" });
  }
  return value;
});

export const parentContactsQuerySchema = Joi.object({
  class: classSchema,
  relationship: Joi.string().valid(...RELATIONSHIP_ENUM).optional(),
  onlyPrimary: Joi.boolean().default(false),
  onlyWithBalance: Joi.boolean().default(false),
  search: Joi.string().trim().max(100).optional().allow("", null),
  sortBy: Joi.string()
    .valid("studentName", "studentClass", "parentName")
    .default("studentName"),
  sortOrder: Joi.string().valid(...SORT_ORDER_ENUM).default("asc"),
  page: pageSchema,
  perPage: perPageSchema,
  format: formatSchema,
});

export const overdueQuerySchema = Joi.object({
  academicYear: academicYearSchema,
  term: termSchema,
  class: classSchema,
  severity: Joi.string().valid(...SEVERITY_ENUM).default("all"),
  minDaysOverdue: Joi.number().integer().min(0).default(0),
  planStatus: Joi.string().valid(...PLAN_STATUS_ENUM).optional(),
  sortBy: Joi.string()
    .valid("daysOverdue", "totalOverdueAmount", "studentName", "studentClass")
    .default("daysOverdue"),
  sortOrder: Joi.string().valid(...SORT_ORDER_ENUM).default("desc"),
  page: pageSchema,
  perPage: perPageSchema,
  format: formatSchema,
});

export const headmasterMonthlyQuerySchema = Joi.object({
  month: Joi.string().pattern(/^\d{4}-\d{2}$/).optional().allow("", null),
  academicYear: academicYearSchema,
  term: termSchema,
  includeHeadcount: Joi.boolean().default(true),
  format: formatSchema,
}).custom((value, helpers) => {
  if (value.month) {
    const [year, month] = value.month.split("-").map(Number);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return helpers.message({ custom: "month must be in YYYY-MM format" });
    }
  }
  return value;
});

export {
  GROUP_BY_ENUM,
  HORIZON_ENUM,
  SEVERITY_ENUM,
  PLAN_STATUS_ENUM,
  PAYMENT_STATUS_ENUM,
  RELATIONSHIP_ENUM,
  PAYMENT_METHOD_ENUM,
  SORT_ORDER_ENUM,
  objectId,
  formatSchema,
  createTemplateBodySchema,
  createJobBodySchema,
  jobIdParamSchema,
  reportListQuerySchema,
};