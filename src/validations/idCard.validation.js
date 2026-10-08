import Joi from "joi";

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

export const batchIdParamSchema = Joi.object({
  batchId: objectId.required().messages({
    "string.pattern.base": "Invalid batch ID format",
  }),
});

export const studentIdParamSchema = Joi.object({
  studentId: objectId.required().messages({
    "string.pattern.base": "Invalid student ID format",
  }),
});

export const schoolIdParamSchema = Joi.object({
  schoolId: objectId.required().messages({
    "string.pattern.base": "Invalid school ID format",
  }),
});

export const createBatchSchema = Joi.object({
  studentIds: Joi.array().items(objectId.required()).min(1).required(),
  includeQr: Joi.boolean().default(true),
  includePhoto: Joi.boolean().default(true),
  useSchoolSettings: Joi.boolean().default(true),
  templateId: objectId.allow(null),
});

export const mergeBatchSchema = Joi.object({
  batchIds: Joi.array().items(objectId.required()).min(1).required(),
});

export const qrLinksQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

export const batchesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(50).default(20),
});
