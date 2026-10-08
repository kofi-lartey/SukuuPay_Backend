import Joi from "joi";
import { gpsAddressValidator } from "./gpsAddress.validation.js";

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

export { gpsAddressValidator };

export const schoolIdParamSchema = Joi.object({
  schoolId: objectId.required().messages({
    "string.pattern.base": "Invalid school ID format",
  }),
});

export const updateSettingsSchema = Joi.object({
  brandColor: Joi.string()
    .pattern(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  motto: Joi.string().trim().max(200).allow("").optional(),
  yearFounded: Joi.number().integer().min(1800).max(2099).optional(),
  website: Joi.string().uri().trim().allow("").optional(),
  gpsAddress: gpsAddressValidator.optional(),
  classes: Joi.array()
    .items(Joi.string().trim().max(50))
    .min(1)
    .max(50)
    .unique()
    .optional(),
  termsPerYear: Joi.number().integer().min(1).max(4).optional(),
  gradingSystem: Joi.string()
    .valid("WAEC", "IB", "Cambridge", "Custom")
    .optional(),
}).min(1);


// YYYY/YYYY where the second year is the first year + 1 (e.g. 2025/2026)
const academicYearPattern = /^\d{4}\/\d{4}$/;
const consecutiveYears = (value, helpers) => {
  if (!value) return value;
  const [startStr, endStr] = value.split("/");
  const startYear = Number(startStr);
  const endYear = Number(endStr);
  if (endYear !== startYear + 1) {
    return helpers.error("any.custom");
  }
  return value;
};

export const updateAcademicYearSchema = Joi.object({
  currentYear: Joi.string()
    .pattern(academicYearPattern)
    .custom(consecutiveYears)
    .required()
    .messages({
      "string.pattern.base": "currentYear must match format YYYY/YYYY (e.g. 2025/2026)",
      "any.custom": "The two years in currentYear must be consecutive (e.g. 2025/2026)",
    }),
  currentTerm: Joi.string()
    .valid("Term 1", "Term 2", "Term 3")
    .required(),
  termsPerYear: Joi.number().integer().min(1).max(4).default(3),
});

export const updateNotificationPrefsSchema = Joi.object({
  email: Joi.boolean().required(),
  sms: Joi.boolean().required(),
  inApp: Joi.boolean().required(),
});

export const billingQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

export const idCardSettingsUpdateSchema = Joi.object({
  sheetLayout: Joi.string()
    .valid("6up_a4_landscape", "9up_a4_landscape")
    .optional(),
  sides: Joi.string()
    .valid("front_back", "front")
    .optional(),
  showQr: Joi.boolean().optional(),
  showPhoto: Joi.boolean().optional(),
  showStamp: Joi.boolean().optional(),
  includeCutGuides: Joi.boolean().optional(),
}).min(1);

export const idCardSettingsSchema = Joi.object({
  schoolId: objectId.required().messages({
    "string.pattern.base": "Invalid school ID format",
  }),
  sheetLayout: Joi.string().valid("6up_a4_landscape", "9up_a4_landscape"),
  sides: Joi.string().valid("front_back", "front"),
  showQr: Joi.boolean(),
  showPhoto: Joi.boolean(),
  showStamp: Joi.boolean(),
  includeCutGuides: Joi.boolean(),
});
