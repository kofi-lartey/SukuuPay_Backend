import Joi from "joi";
import { getGhanaRegions, validateGhanaPhone } from "../utils/generateCode.js";

const currentYear = new Date().getFullYear();

const ghanaRegions = getGhanaRegions();

const phoneValidator = Joi.string()
  .custom((value, helpers) => {
    const validated = validateGhanaPhone(value);
    if (!validated) {
      return helpers.error("string.pattern.base", {
        message: "Invalid Ghana phone number format. Use format: 024xxxxxxx or 23324xxxxxxx",
      });
    }
    return validated;
  })
  .messages({
    "string.pattern.base": "Invalid Ghana phone number format. Use format: 024xxxxxxx or 23324xxxxxxx",
  });

const emailValidator = Joi.string().email().lowercase().trim().required();

export const createSchoolSchema = Joi.object({
  name: Joi.string().trim().min(2).max(150).required(),
  type: Joi.string()
    .valid("public", "private", "international", "mission", "charter")
    .required(),
  phone: phoneValidator,
  email: emailValidator,
  address: Joi.string().trim().min(5).max(300).required(),
  city: Joi.string().trim().min(2).max(100).required(),
  region: Joi.string()
    .valid(...ghanaRegions)
    .required(),
  motto: Joi.string().trim().max(200).allow("").optional(),
  yearFounded: Joi.number().integer().min(1800).max(currentYear).optional(),
  classes: Joi.array().items(Joi.string().trim().max(50)).optional(),
});

export const updateSchoolSchema = Joi.object({
  name: Joi.string().trim().min(2).max(150).optional(),
  type: Joi.string()
    .valid("public", "private", "international", "mission", "charter")
    .optional(),
  motto: Joi.string().trim().max(200).allow("").optional(),
  yearFounded: Joi.number().integer().min(1800).max(currentYear).optional(),
  phone: phoneValidator.optional(),
  email: Joi.string().email().lowercase().trim().optional(),
  website: Joi.string().uri().trim().allow("").optional(),
  address: Joi.string().trim().min(5).max(300).optional(),
  city: Joi.string().trim().min(2).max(100).optional(),
  region: Joi.string()
    .valid(...ghanaRegions)
    .optional(),
  gpsAddress: Joi.string().trim().max(200).allow("").optional(),
  brandColor: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).optional(),
  "academic.classes": Joi.array().items(Joi.string().trim().max(50)).optional(),
}).min(1);

export const suspendSchoolSchema = Joi.object({
  reason: Joi.string().trim().min(10).max(500).required(),
});

export const schoolIdParamSchema = Joi.object({
  schoolId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "Invalid school ID format",
    }),
});

export const listSchoolsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid("active", "suspended", "archived").optional(),
  region: Joi.string().valid(...ghanaRegions).optional(),
  search: Joi.string().trim().max(100).allow("").optional(),
  sortBy: Joi.string()
    .valid("name", "createdAt", "schoolCode", "region", "status")
    .default("createdAt"),
  sortOrder: Joi.string().valid("asc", "desc").default("desc"),
});