import Joi from "joi";
import { AD_PLACEMENTS, AD_STATUSES } from "../models/SchoolAd.js";

const objectId = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .required()
  .messages({ "string.pattern.base": "Invalid school ID format" });

// Ads render client-side from this value, so only https is accepted. A
// javascript: or data: URL here would turn every auth page into an XSS sink.
const safeUrl = Joi.string()
  .uri({ scheme: ["https"] })
  .trim()
  .max(500)
  .required()
  .messages({
    "string.uri": "linkUrl must be a valid https URL",
  });

const adBody = {
  schoolId: Joi.alternatives().try(Joi.string().allow("", null), Joi.valid(null)),
  schoolName: Joi.string().trim().min(2).max(150).required(),
  headline: Joi.string().trim().min(4).max(60).required(),
  imageUrl: Joi.string().trim().max(500).allow("").optional(),
  imageAlt: Joi.string().trim().min(5).max(160).required(),
  linkUrl: safeUrl,
  placement: Joi.string().valid(...AD_PLACEMENTS).default("auth_aside"),
  endsAt: Joi.date().iso().required(),
  sortWeight: Joi.number().integer().min(-100).max(100).default(0),
};

export const createSchoolAdSchema = Joi.object(adBody)
  .custom((value, helpers) => {
    // A null startsAt means "live immediately".
    if (value.endsAt && new Date(value.endsAt) <= new Date()) {
      return helpers.message({
        custom: "endsAt must be in the future",
      });
    }
    return value;
  })
  .messages({ custom: "endsAt must be in the future" });

export const updateSchoolAdSchema = Joi.object({
  schoolName: Joi.string().trim().min(2).max(150).optional(),
  headline: Joi.string().trim().min(4).max(60).optional(),
  imageUrl: Joi.string().trim().max(500).allow("").optional(),
  imageAlt: Joi.string().trim().min(5).max(160).optional(),
  linkUrl: safeUrl.optional(),
  placement: Joi.string().valid(...AD_PLACEMENTS).optional(),
  endsAt: Joi.date().iso().optional(),
  sortWeight: Joi.number().integer().min(-100).max(100).optional(),
  // `status` and `rejectedReason` are deliberately absent: they are settable
  // only through the approve/reject endpoint, so an edit can never self-approve.
}).min(1);

export const schoolAdIdParamSchema = Joi.object({
  adId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({ "string.pattern.base": "Invalid ad ID format" }),
});

export const listSchoolAdsQuerySchema = Joi.object({
  // No default here: this schema is shared by the public slider and the admin
  // moderation queue, and a default would hide every other placement from the
  // queue. listPublicSchoolAds falls back to "auth_aside" itself.
  placement: Joi.string().valid(...AD_PLACEMENTS).optional(),
  status: Joi.string().valid(...AD_STATUSES).optional(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

export const approveSchoolAdSchema = Joi.object({
  status: Joi.string()
    .valid("approved", "rejected")
    .required()
    .messages({ "any.only": "status must be approved or rejected" }),
  rejectedReason: Joi.string().trim().max(300).allow("").optional(),
}).custom((value, helpers) => {
  if (value.status === "rejected" && !value.rejectedReason) {
    return helpers.message({
      custom: "A reason is required when rejecting an ad",
    });
  }
  return value;
}).messages({ custom: "A reason is required when rejecting an ad" });

export { objectId };
