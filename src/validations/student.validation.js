import Joi from "joi";
import { validateGhanaPhone } from "../utils/generateCode.js";

// Ghana phone validator reused from the school module's rule set.
// Accepts 024xxxxxxx or 23324xxxxxxx and normalizes to the 0xx form.
export const phoneValidator = Joi.string().custom((value, helpers) => {
  const validated = validateGhanaPhone(value);
  if (!validated) {
    return helpers.error("any.custom", {
      message:
        "Invalid Ghana phone number format. Use format: 024xxxxxxx or 23324xxxxxxx",
    });
  }
  // normalize to the 0xx form used across student records
  return validated.startsWith("233") ? "0" + validated.slice(3) : validated;
});

export const emailValidator = Joi.string().email().lowercase().trim().optional();

const STATUS_ENUM = ["active", "suspended", "removed", "graduated", "transferred_out"];
const RELATIONSHIP_ENUM = ["father", "mother", "guardian", "other"];

const parentSchema = Joi.object({
  parentName: Joi.string().trim().min(2).max(100).required(),
  relationship: Joi.string()
    .valid(...RELATIONSHIP_ENUM)
    .required(),
  phone: phoneValidator.required(),
  email: emailValidator,
  isPrimary: Joi.boolean().default(false),
  isAlive: Joi.boolean().default(true),
});

const emergencyContactSchema = Joi.object({
  contactName: Joi.string().trim().min(2).max(100).required(),
  relationship: Joi.string().trim().min(2).max(50).required(),
  phone: phoneValidator.required(),
  alternatePhone: phoneValidator.optional().allow(null, ""),
});

// Reject deadlines that fall before today (business rule #9).
const notInPastDate = Joi.date().custom((value, helpers) => {
  if (!value) return value;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (new Date(value) < today) {
    return helpers.error("any.custom");
  }
  return value;
}).messages({ "any.custom": "Date cannot be in the past" });

export const createStudentSchema = Joi.object({
  studentName: Joi.string().trim().min(2).max(100).required(),
  studentClass: Joi.string().trim().min(2).max(50).required(),
  gender: Joi.string().valid("male", "female").required(),
  dateOfBirth: Joi.date().max("now").optional().allow(null),
  studentImage: Joi.string().uri().optional().allow(null, ""),
  totalOwed: Joi.number().integer().min(0).required(),
  deadline: notInPastDate.required(),
  academicYear: Joi.string().trim().pattern(/^\d{4}\/\d{4}$/).optional().allow(null),
  parents: Joi.array().items(parentSchema).min(1).required(),
  emergencyContacts: Joi.array().items(emergencyContactSchema).optional(),
  // schoolId is derived server-side; only honoured for super_admin (see route/service).
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
});

export const updateStudentSchema = Joi.object({
  studentName: Joi.string().trim().min(2).max(100).optional(),
  studentClass: Joi.string().trim().min(2).max(50).optional(),
  gender: Joi.string().valid("male", "female").optional(),
  dateOfBirth: Joi.date().max("now").optional().allow(null),
  studentImage: Joi.string().uri().optional().allow(null, ""),
  totalOwed: Joi.number().integer().min(0).optional(),
  deadline: notInPastDate.optional(),
  academicYear: Joi.string().trim().pattern(/^\d{4}\/\d{4}$/).optional(),
  parents: Joi.array().items(parentSchema).min(1).optional(),
  emergencyContacts: Joi.array().items(emergencyContactSchema).optional(),
  promotedFrom: Joi.string().trim().max(50).optional().allow(null),
  promotedTo: Joi.string().trim().max(50).optional().allow(null),
  promotionDate: Joi.date().optional().allow(null),
  graduationDate: Joi.date().optional().allow(null),
  graduationYear: Joi.string().trim().max(9).optional().allow(null),
  isAlumni: Joi.boolean().optional(),
  transferOutDate: Joi.date().optional().allow(null),
  transferOutReason: Joi.string().trim().max(300).optional().allow(null),
  isRepeating: Joi.boolean().optional(),
}).min(1);

export const bulkUploadMetaSchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  academicYear: Joi.string().trim().pattern(/^\d{4}\/\d{4}$/).optional(),
  defaultDeadline: notInPastDate.optional().allow(null),
  defaultOwed: Joi.number().integer().min(0).optional(),
});

export const studentIdParamSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "Invalid student ID format",
    }),
});

export const listStudentsQuerySchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  class: Joi.string().trim().max(50).optional(),
  status: Joi.string()
    .valid(...STATUS_ENUM, "all")
    .default("active"),
  search: Joi.string().trim().max(100).allow("").optional(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string()
    .valid("studentName", "studentId", "createdAt", "totalOwed", "balance")
    .default("createdAt"),
  sortOrder: Joi.string().valid("asc", "desc").default("desc"),
  // consumed by the export endpoint
  format: Joi.string().valid("csv", "xlsx").default("csv"),
});

export const suspendStudentSchema = Joi.object({
  reason: Joi.string().trim().min(5).max(300).required(),
});

export const transferClassSchema = Joi.object({
  newClass: Joi.string().trim().min(2).max(50).required(),
  reason: Joi.string().trim().max(300).optional().allow("", null),
});

const REPEAT_REASON_ENUM = ["ACADEMIC", "ATTENDANCE", "MEDICAL", "PARENTAL_REQUEST", "OTHER"];
const GRADUATION_TYPE_ENUM = ["STANDARD", "EARLY", "HONORARY", "DEFERRED"];
const HONORS_ENUM = ["NONE", "HONORS", "HIGH_HONORS", "HIGHEST_HONORS"];
const TRANSFER_REASON_ENUM = ["RELOCATION", "ACADEMIC", "FINANCIAL", "PERSONAL", "EXPULSION", "OTHER"];
const INSTITUTION_TYPE_ENUM = ["PUBLIC_SCHOOL", "PRIVATE_SCHOOL", "INTERNATIONAL_SCHOOL", "HOMESCHOOL", "VOCATIONAL", "COLLEGE_UNIVERSITY", "OTHER"];

const notInFutureDate = Joi.date().custom((value, helpers) => {
  if (!value) return value;
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 30);
  if (new Date(value) > maxDate) {
    return helpers.error("any.custom");
  }
  return value;
}).messages({ "any.custom": "Date cannot be more than 30 days in the future" });

export const promoteStudentSchema = Joi.object({
  targetClassId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional().allow(null),
  promotionDate: notInFutureDate.optional().allow(null),
  notes: Joi.string().trim().max(500).optional().allow("", null),
}).min(1);

export const bulkPromoteSchema = Joi.object({
  classIds: Joi.array().items(Joi.string().pattern(/^[0-9a-fA-F]{24}$/)).optional(),
  gradeLevels: Joi.array().items(Joi.number().integer().min(1).max(12)).optional(),
  studentIds: Joi.array().items(Joi.string().pattern(/^[0-9a-fA-F]{24}$/)).optional(),
  promotionDate: notInFutureDate.optional().allow(null),
  dryRun: Joi.boolean().default(false),
  notes: Joi.string().trim().max(500).optional().allow("", null),
}).or("classIds", "gradeLevels", "studentIds").oxor("classIds", "gradeLevels", "studentIds");

export const previewPromotionSchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  classIds: Joi.array().items(Joi.string().pattern(/^[0-9a-fA-F]{24}$/)).optional(),
  gradeLevels: Joi.array().items(Joi.number().integer().min(1).max(12)).optional(),
  studentIds: Joi.array().items(Joi.string().pattern(/^[0-9a-fA-F]{24}$/)).optional(),
  promotionDate: notInFutureDate.optional().allow(null),
}).or("classIds", "gradeLevels", "studentIds");

export const repeatStudentSchema = Joi.object({
  repeatReason: Joi.string().valid(...REPEAT_REASON_ENUM).required(),
  customReason: Joi.when("repeatReason", {
    is: "OTHER",
    then: Joi.string().trim().min(5).max(500).required(),
    otherwise: Joi.string().trim().max(500).optional().allow("", null),
  }),
  repeatDate: notInFutureDate.optional().allow(null),
  notes: Joi.string().trim().max(500).optional().allow("", null),
});

export const graduateStudentSchema = Joi.object({
  graduationDate: notInFutureDate.required(),
  graduationType: Joi.string().valid(...GRADUATION_TYPE_ENUM).required(),
  certificateNumber: Joi.string().trim().max(50).optional().allow("", null),
  honors: Joi.string().valid(...HONORS_ENUM).default("NONE"),
  notes: Joi.string().trim().max(500).optional().allow("", null),
});

export const bulkGraduateSchema = Joi.object({
  cohortId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  classIds: Joi.array().items(Joi.string().pattern(/^[0-9a-fA-F]{24}$/)).optional(),
  graduationDate: notInFutureDate.required(),
  graduationType: Joi.string().valid(...GRADUATION_TYPE_ENUM).default("STANDARD"),
  autoAssignCertificates: Joi.boolean().default(true),
  certificatePrefix: Joi.string().trim().max(20).optional().allow("", null),
  dryRun: Joi.boolean().default(false),
  notes: Joi.string().trim().max(500).optional().allow("", null),
}).or("cohortId", "classIds").oxor("cohortId", "classIds");

export const transferOutSchema = Joi.object({
  destinationInstitution: Joi.string().trim().min(2).max(200).required(),
  destinationInstitutionType: Joi.string().valid(...INSTITUTION_TYPE_ENUM).required(),
  transferDate: notInFutureDate.required(),
  transferReason: Joi.string().valid(...TRANSFER_REASON_ENUM).required(),
  customReason: Joi.when("transferReason", {
    is: "OTHER",
    then: Joi.string().trim().min(5).max(500).required(),
    otherwise: Joi.string().trim().max(500).optional().allow("", null),
  }),
  contactPerson: Joi.string().trim().max(100).optional().allow("", null),
  contactEmail: Joi.string().email().lowercase().optional().allow("", null),
  contactPhone: Joi.string().trim().max(20).optional().allow("", null),
  recordsTransferred: Joi.boolean().default(false),
  notes: Joi.string().trim().max(500).optional().allow("", null),
});

export const alumniQuerySchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  graduationYear: Joi.number().integer().min(1900).max(2100).optional(),
  honors: Joi.string().valid(...HONORS_ENUM).optional(),
  search: Joi.string().trim().max(100).allow("").optional(),
  sortBy: Joi.string().valid("graduationDate", "lastName", "certificateNumber").default("graduationDate"),
  sortOrder: Joi.string().valid("asc", "desc").default("desc"),
});

export const cohortsQuerySchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  year: Joi.number().integer().min(1900).max(2100).optional(),
  status: Joi.string().valid("ARCHIVED", "ACTIVE").optional(),
  search: Joi.string().trim().max(100).allow("").optional(),
});

export const cohortDetailQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(50),
  status: Joi.string().valid("GRADUATED", "TRANSFERRED", "DROPPED", "REPEATING").optional(),
  sortBy: Joi.string().valid("lastName", "studentNumber", "graduationDate").default("lastName"),
  sortOrder: Joi.string().valid("asc", "desc").default("asc"),
});

export const schoolIdParamSchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
});

export const cohortIdParamSchema = Joi.object({
  cohortId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
});

// Parent management schemas

export const addParentSchema = Joi.object({
  parentName: Joi.string().trim().min(2).max(100).required(),
  relationship: Joi.string().valid(...RELATIONSHIP_ENUM).required(),
  phone: phoneValidator.required(),
  email: emailValidator,
  isPrimary: Joi.boolean().default(false),
  isAlive: Joi.boolean().default(true),
});

export const updateParentSchema = Joi.object({
  parentName: Joi.string().trim().min(2).max(100).optional(),
  relationship: Joi.string().valid(...RELATIONSHIP_ENUM).optional(),
  phone: phoneValidator.optional(),
  email: emailValidator,
  isAlive: Joi.boolean().optional(),
}).min(1);

export const parentIdParamSchema = Joi.object({
  parentId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "Invalid parent ID format",
    }),
});

export const setPrimaryParentSchema = Joi.object({
  isPrimary: Joi.boolean().valid(true).required(),
});
