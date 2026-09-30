import Joi from "joi";
import { getGhanaRegions, validateGhanaPhone } from "../utils/generateCode.js";
import { SIGNUP_CLASSIFICATIONS, toSchoolType } from "../utils/schoolTypeMapping.js";
import { gpsAddressValidator } from "./gpsAddress.validation.js";

const currentYear = new Date().getFullYear();

const ghanaRegions = getGhanaRegions();

/** Where a coordinate came from. Recorded so a pin is never presented as certain. */
const LOCATION_SOURCES = ["gps_address", "map_pin", "device", "manual"];


/**
 * Coordinates, addressed as dotted keys because `updateSchool` writes
 * `school[subKey]` for nested paths (the same treatment `academic.*` already
 * gets). Coordinates are optional and validated only when present.
 */
const locationKeys = {
  "location.latitude": Joi.number().min(-90).max(90).optional(),
  "location.longitude": Joi.number().min(-180).max(180).optional(),
  "location.source": Joi.string().valid(...LOCATION_SOURCES).allow(null).optional(),
  "location.updatedAt": Joi.date().optional(),
};


/**
 * Ghana phone, normalised to the 233 form.
 *
 * `.required()` matters: the School model declares `phone` as required, so a
 * schema that treated it as optional let the request through validation and
 * failed later at the Mongoose layer — a 500 with a driver message instead of a
 * 422 naming the field. This was already the case for `createSchoolSchema`
 * before self-service provisioning existed; provisioning simply made it
 * reachable by more callers. `updateSchoolSchema` chains `.optional()` onto it,
 * which still wins over the base `required`.
 */
const phoneValidator = Joi.string()
  .required()
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
    "any.required": "Phone number is required",
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
  gpsAddress: gpsAddressValidator.optional(),
  brandColor: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).optional(),
  "academic.classes": Joi.array().items(Joi.string().trim().max(50)).optional(),
  ...locationKeys,
}).min(1);

/**
 * `POST /schools/me` — self-service school provisioning.
 *
 * Deliberately *not* a reuse of `createSchoolSchema`. That one is the
 * super_admin's admin-tool contract and its `type` enum rejects the signup
 * classifications (`senior_high`, `university`). Accepting both vocabularies
 * here and normalising through `toSchoolType` is what lets the bursar keep the
 * answer they gave at signup instead of being bounced off an enum they never
 * saw — see utils/schoolTypeMapping.js.
 */
export const provisionMySchoolSchema = Joi.object({
  name: Joi.string().trim().min(2).max(150).required(),
  type: Joi.string()
    .trim()
    .lowercase()
    .required()
    .custom((value, helpers) => {
      const mapped = toSchoolType(value);
      if (!mapped) {
        return helpers.error("any.invalid", {
          message: `"type" must be one of [public, private, international, mission, charter] or one of [${SIGNUP_CLASSIFICATIONS.join(", ")}]`,
        });
      }
      return mapped;
    }),
  phone: phoneValidator,
  email: emailValidator,
  address: Joi.string().trim().min(5).max(300).required(),
  city: Joi.string().trim().min(2).max(100).required(),
  region: Joi.string().valid(...ghanaRegions).required(),
  motto: Joi.string().trim().max(200).allow("").optional(),
  yearFounded: Joi.number().integer().min(1800).max(currentYear).optional(),
  website: Joi.string().uri().trim().allow("").optional(),
  gpsAddress: gpsAddressValidator.optional(),
  ...locationKeys,
}).min(1);

/**
 * `POST /schools/join` — ask to join a school that already exists.
 *
 * A code alone cannot grant access, so there is nothing to validate beyond its
 * shape; the decision happens against the stored record.
 */
export const joinSchoolSchema = Joi.object({
  schoolCode: Joi.string().trim().min(4).max(12).required(),
  applicantName: Joi.string().trim().max(100).allow("").optional(),
  applicantPosition: Joi.string().trim().max(80).allow("").optional(),
});

/** `PUT /schools/join-requests/:requestId` — an existing admin approves or rejects. */
export const decideJoinRequestSchema = Joi.object({
  decision: Joi.string().valid("approved", "rejected").required(),
  note: Joi.string().trim().max(300).allow("").optional(),
});


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

export const joinRequestIdParamSchema = Joi.object({
  requestId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "Invalid request ID format",
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