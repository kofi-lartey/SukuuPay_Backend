import Joi from "joi";

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

export const templateIdParamSchema = Joi.object({
  templateId: objectId.required().messages({
    "string.pattern.base": "Invalid template ID format",
  }),
});

export const schoolIdParamSchema = Joi.object({
  schoolId: objectId.required().messages({
    "string.pattern.base": "Invalid school ID format",
  }),
});

export const createTemplateSchema = Joi.object({
  name: Joi.string().trim().max(80).required(),
  audience: Joi.string().valid("student", "staff", "prefect", "visitor", "custom").default("student"),
  isDefault: Joi.boolean().default(false),
  fields: Joi.object({
    showPhoto: Joi.boolean().default(true),
    showQr: Joi.boolean().default(true),
    showStamp: Joi.boolean().default(true),
    showEmergency: Joi.boolean().default(true),
    showGuardian: Joi.boolean().default(true),
    showClass: Joi.boolean().default(true),
    showStudentId: Joi.boolean().default(true),
  }).default({}),
  layout: Joi.object({
    sheetLayout: Joi.string().valid("6up_a4_landscape", "9up_a4_landscape").default("6up_a4_landscape"),
    sides: Joi.string().valid("front_back", "front").default("front_back"),
    includeCutGuides: Joi.boolean().default(false),
  }).default({}),
  theme: Joi.object({
    brandColor: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).allow(null),
    accentColor: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).allow(null),
  }).default({}),
  text: Joi.object({
    termsOverride: Joi.string().max(500).allow(null),
    footerLeft: Joi.string().default("SUKUUPAY"),
    footerRight: Joi.string().allow(null),
  }).default({}),
});

export const updateTemplateSchema = Joi.object({
  name: Joi.string().trim().max(80),
  audience: Joi.string().valid("student", "staff", "prefect", "visitor", "custom"),
  isDefault: Joi.boolean(),
  fields: Joi.object({
    showPhoto: Joi.boolean(),
    showQr: Joi.boolean(),
    showStamp: Joi.boolean(),
    showEmergency: Joi.boolean(),
    showGuardian: Joi.boolean(),
    showClass: Joi.boolean(),
    showStudentId: Joi.boolean(),
  }),
  layout: Joi.object({
    sheetLayout: Joi.string().valid("6up_a4_landscape", "9up_a4_landscape"),
    sides: Joi.string().valid("front_back", "front"),
    includeCutGuides: Joi.boolean(),
  }),
  theme: Joi.object({
    brandColor: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).allow(null),
    accentColor: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).allow(null),
  }),
  text: Joi.object({
    termsOverride: Joi.string().max(500).allow(null),
    footerLeft: Joi.string(),
    footerRight: Joi.string().allow(null),
  }),
});

export const duplicateTemplateSchema = Joi.object({
  name: Joi.string().trim().max(80),
});
