import Joi from "joi";

export const schoolDirectorySearchQuerySchema = Joi.object({
  q: Joi.string().trim().min(2).max(100).required(),
  region: Joi.string().trim().max(50).optional(),
  district: Joi.string().trim().max(100).optional(),
  limit: Joi.number().integer().min(1).max(50).default(20),
});

export const uploadVerificationDocumentSchema = Joi.object({
  documentType: Joi.string()
    .valid("NASIA_LICENSE", "RGD_CERTIFICATE", "AUTHORIZATION_LETTER", "HEADTEACHER_ID")
    .required(),
});

export const adminVerifySchoolSchema = Joi.object({
  decision: Joi.string().valid("approved", "rejected").required(),
  rejectionReason: Joi.string().trim().min(10).max(500).when("decision", {
    is: "rejected",
    then: Joi.required(),
    otherwise: Joi.optional().allow(""),
  }),
});

export const linkDirectoryMatchSchema = Joi.object({
  externalId: Joi.string().trim().min(1).max(100).required(),
  source: Joi.string().valid("sukuudata", "ghana_api", "manual").required(),
  name: Joi.string().trim().max(150).optional(),
  region: Joi.string().trim().max(50).optional(),
  district: Joi.string().trim().max(100).optional(),
  level: Joi.string().valid("Basic/Primary", "JHS", "SHS/SHTS", "TVET", "International").optional(),
  category: Joi.string().valid("Public", "Private").optional(),
});

export const schoolIdParamSchema = Joi.object({
  schoolId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "Invalid school ID format",
    }),
});