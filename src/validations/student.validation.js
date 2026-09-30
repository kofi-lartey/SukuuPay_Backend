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

/**
 * The fields a generic `PUT /students/:id` may set.
 *
 * Deliberately does NOT include the lifecycle fields — `promotedFrom/To`,
 * `promotionDate`, `graduationDate`, `graduationYear`, `graduationType`,
 * `certificateNumber`, `honors`, `isAlumni`, `transferOutDate`,
 * `transferOutReason`, `isRepeating`, `repeatCount` — even though every one of
 * them is a plain String/Date/Boolean on the model and so was previously
 * accepted here. Each has a dedicated transition endpoint carrying real
 * preconditions (only active students may be promoted; not in a final year
 * class; maximum repeat limit). A generic update walked past all of them, so a
 * client could graduate a suspended student or clear a repeat flag by putting
 * the field in a request body. `isRepeating` in particular could only ever be
 * *set* this way, since no endpoint existed to clear it.
 */
export const updateStudentSchema = Joi.object({
  studentName: Joi.string().trim().min(2).max(100).optional(),
  studentClass: Joi.string().trim().min(2).max(50).optional(),
  gender: Joi.string().valid("male", "female").optional(),
  dateOfBirth: Joi.date().max("now").optional().allow(null),
  studentImage: Joi.string().uri().optional().allow(null, ""),
  // Integer pesewas. See `createStudent` in the service for the money contract.
  totalOwed: Joi.number().integer().min(0).optional(),
  deadline: notInPastDate.optional(),
  academicYear: Joi.string().trim().pattern(/^\d{4}\/\d{4}$/).optional(),
  parents: Joi.array().items(parentSchema).min(1).optional(),
  emergencyContacts: Joi.array().items(emergencyContactSchema).optional(),
}).min(1);

export const bulkUploadMetaSchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  academicYear: Joi.string().trim().pattern(/^\d{4}\/\d{4}$/).optional(),
  defaultDeadline: notInPastDate.optional().allow(null),
  /** Cedis — a spreadsheet column, converted to pesewas on import. */
  defaultOwed: Joi.number().min(0).optional(),
  /**
   * Parse and validate the file, write nothing. Shares the importer's code path
   * exactly, so the preview cannot disagree with the outcome.
   */
  dryRun: Joi.boolean().default(false),
});

/**
 * A student reference: the Mongo `_id` **or** the human `studentId`.
 *
 * Every screen shows `studentId` (`SCH-DEMO-01-2026-8054`), so requiring 24 hex
 * characters meant the obvious client code — look the student up, send their id
 * back — always 400'd. Accepting both costs one indexed lookup and removes the
 * trap.
 *
 * The school-code part allows internal hyphens, and it has to. The code is free
 * text and most are hyphenated, so a first attempt at
 * `[A-Za-z0-9]{1,20}-[0-9]{4}-[0-9]{4,}` rejected `SCH-DEMO-01-2026-8054`
 * outright — which made *every* human-id lookup on a real school 422 while
 * looking correct, because the `_id` path still worked and so did every test
 * that happened to use one.
 */
const studentReference = Joi.string()
  .trim()
  .pattern(/^([0-9a-fA-F]{24}|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-[0-9]{4}-[0-9]{4,})$/)
  .required()
  .messages({
    "string.pattern.base":
      "Invalid student reference — expected a 24-character id or a student number like SCH-DEMO-01-2026-0001",
  });

export const studentIdParamSchema = Joi.object({
  id: studentReference,
});

export const listStudentsQuerySchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  class: Joi.string().trim().max(50).optional(),
  gender: Joi.string().valid("male", "female").optional(),
  status: Joi.string()
    .valid(...STATUS_ENUM, "all")
    .default("active"),
  search: Joi.string().trim().max(100).allow("").optional(),
  /**
   * Derived server-side, because "fully cleared" is a comparison against a
   * computed `balance` that Mongo cannot express and a client cannot do from a
   * page of 20 rows out of 1,000. Applied as a post-filter: it narrows the page
   * returned and does not change `meta.total`, which is stated in the contract.
   */
  feeStatus: Joi.string().valid("cleared", "owing", "overdue").optional(),
  planStatus: Joi.string()
    .valid("none", "pending", "active", "completed", "defaulted")
    .optional(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string()
    .valid(
      "studentName",
      "firstName",
      "lastName",
      "studentId",
      "createdAt",
      "totalOwed",
      "totalPaid",
      "balance",
      "deadline"
    )
    .default("createdAt"),
  sortOrder: Joi.string().valid("asc", "desc").default("desc"),
  // consumed by the export endpoint
  format: Joi.string().valid("csv", "xlsx").default("csv"),
});

/** `GET /students/stats` — the same scope, no pagination. */
export const statsQuerySchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  class: Joi.string().trim().max(50).optional(),
  status: Joi.string().valid(...STATUS_ENUM, "all").optional(),
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

/**
 * A class *name* — "JHS 2A", "Primary 3".
 *
 * `School.academic.classes` is `[String]`; there are no class ids anywhere in
 * this system. The old schemas demanded 24-hex ObjectIds for `classIds` and
 * `targetClassId`, so a caller following the schema sent a value that could not
 * match any class and every promotion matched nothing.
 */
const classNameValidator = Joi.string().trim().min(2).max(50);

export const promoteStudentSchema = Joi.object({
  targetClass: classNameValidator.optional().allow(null),
  promotionDate: notInFutureDate.optional().allow(null),
  notes: Joi.string().trim().max(500).optional().allow("", null),
}).min(1);

export const bulkPromoteSchema = Joi.object({
  classNames: Joi.array().items(classNameValidator).optional(),
  gradeLevels: Joi.array().items(Joi.number().integer().min(1).max(12)).optional(),
  studentIds: Joi.array().items(Joi.string().pattern(/^[0-9a-fA-F]{24}$/)).optional(),
  promotionDate: notInFutureDate.optional().allow(null),
  dryRun: Joi.boolean().default(false),
  notes: Joi.string().trim().max(500).optional().allow("", null),
})
  .or("classNames", "gradeLevels", "studentIds")
  .oxor("classNames", "gradeLevels", "studentIds");

export const previewPromotionSchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  classNames: Joi.array().items(classNameValidator).optional(),
  gradeLevels: Joi.array().items(Joi.number().integer().min(1).max(12)).optional(),
  studentIds: Joi.array().items(Joi.string().pattern(/^[0-9a-fA-F]{24}$/)).optional(),
  promotionDate: notInFutureDate.optional().allow(null),
  /**
   * Opt-in, because capacity is not a property this system can know: classes
   * are strings on the School model with no capacity and no teacher assignment
   * anywhere. The preview used to assume 40, which warned every school with
   * larger classes and stayed silent for every school with smaller ones.
   */
  classCapacity: Joi.number().integer().min(1).max(500).optional(),
}).or("classNames", "gradeLevels", "studentIds");

export const clearRepeatSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(300).required(),
});

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

/**
 * A cohort: `cohort_2026`, or a bare year.
 *
 * There is no Cohort collection — cohorts are derived by aggregating
 * `graduationYear` on the students — so a cohort's identity *is* its year. The
 * old schema required a 24-hex ObjectId, which the service could not consume
 * under any circumstances, and `GET /cohorts/:cohortId` therefore always
 * returned 422.
 */
const cohortIdValidator = Joi.string()
  .trim()
  .pattern(/^(cohort_)?\d{4}$/)
  .messages({ "string.pattern.base": "Invalid cohort ID — expected cohort_2026" });

export const bulkGraduateSchema = Joi.object({
  cohortId: cohortIdValidator.optional(),
  classNames: Joi.array().items(classNameValidator).optional(),
  graduationDate: notInFutureDate.required(),
  graduationType: Joi.string().valid(...GRADUATION_TYPE_ENUM).default("STANDARD"),
  autoAssignCertificates: Joi.boolean().default(true),
  certificatePrefix: Joi.string().trim().max(20).optional().allow("", null),
  dryRun: Joi.boolean().default(false),
  notes: Joi.string().trim().max(500).optional().allow("", null),
}).or("cohortId", "classNames").oxor("cohortId", "classNames");

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

// `schoolId` is OPTIONAL in the query on both of these.
//
// The routes carry it in the path — `/cohorts/:schoolId`, `/alumni/:schoolId` —
// and these schemas also ran against the query, where `.required()` then failed
// with `"schoolId" is required`. So both endpoints answered **422 to every
// request**, including correct ones. The cohort tab and the alumni tab were
// unreachable over HTTP no matter what the client sent, and the service-level
// tests passed because they called the service directly and never went through
// route validation.
//
// Keeping it optional rather than deleting it: a `super_admin` reading another
// school's cohorts can still pass it, and the service prefers the explicit value.
export const alumniQuerySchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  graduationYear: Joi.number().integer().min(1900).max(2100).optional(),
  honors: Joi.string().valid(...HONORS_ENUM).optional(),
  search: Joi.string().trim().max(100).allow("").optional(),
  sortBy: Joi.string().valid("graduationDate", "lastName", "certificateNumber").default("graduationDate"),
  sortOrder: Joi.string().valid("asc", "desc").default("desc"),
});

export const cohortsQuerySchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  year: Joi.number().integer().min(1900).max(2100).optional(),
  status: Joi.string().valid("ARCHIVED", "ACTIVE").optional(),
  search: Joi.string().trim().max(100).allow("").optional(),
});

export const cohortDetailQuerySchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(50),
  status: Joi.string().valid("GRADUATED", "TRANSFERRED", "DROPPED", "REPEATING").optional(),
  // `lastName` is now a real derived field. `studentNumber` never existed and
  // was a silent no-op, so it is gone rather than mapped behind the caller's
  // back — `studentId` is the real name and is offered under its own key.
  sortBy: Joi.string().valid("lastName", "firstName", "studentId", "graduationDate").default("lastName"),
  sortOrder: Joi.string().valid("asc", "desc").default("asc"),
});

export const schoolIdParamSchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
});

export const cohortIdParamSchema = Joi.object({
  cohortId: cohortIdValidator.required(),
});

export const archiveStudentSchema = Joi.object({
  reason: Joi.string().trim().max(300).optional().allow("", null),
});

// ── Bulk operation schemas ──────────────────────────────────────────────────
//
// Every one takes `dryRun` and returns the same envelope with `committed: false`.
// A destructive bulk action that cannot be previewed is a bulk action nobody
// uses, and the preview has to come from the same code path as the write or it
// can disagree with the outcome.

/** The target: an explicit id list, or a filter over the school. */
const bulkTarget = {
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  ids: Joi.array().items(Joi.string().pattern(/^[0-9a-fA-F]{24}$/)).max(2000).optional(),
  filter: Joi.object({
    class: classNameValidator.optional(),
    status: Joi.string().valid(...STATUS_ENUM).optional(),
    gender: Joi.string().valid("male", "female").optional(),
    search: Joi.string().trim().max(100).allow("").optional(),
  }).optional(),
  dryRun: Joi.boolean().default(false),
};

/** The subset of `updateStudentSchema` a bulk write may set. */
const bulkUpdateFields = Joi.object({
  studentName: Joi.string().trim().min(2).max(100).optional(),
  studentClass: classNameValidator.optional(),
  gender: Joi.string().valid("male", "female").optional(),
  totalOwed: Joi.number().integer().min(0).optional(),
  deadline: notInPastDate.optional(),
  academicYear: Joi.string().trim().pattern(/^\d{4}\/\d{4}$/).optional(),
})
  .min(1)
  .messages({ "object.min": "No fields to update" });

export const bulkUpdateSchema = Joi.object({
  ...bulkTarget,
  update: bulkUpdateFields.required(),
  /**
   * Explicit allow-list. A bulk write must never be able to set something the
   * single-student `PUT` cannot; when absent, only the keys present in `update`
 *  are written.
   */
  fields: Joi.array()
    // Spread, not passed as one array: `valid()` stopped accepting an array
    // argument, and passing one throws at import time rather than at
    // validation time — so this took the whole route file down.
    .items(Joi.string().valid(...Object.keys(bulkUpdateFields.describe().keys)))
    .max(20)
    .optional(),
})
  // `ids` and `filter` are mutually exclusive. The service prefers `ids` and
  // silently ignores `filter`, so a client sending both got a `matched` count
  // for the id list while believing it had targeted the filter — the kind of
  // discrepancy that shows up later as "the bulk update missed 200 students".
  .oxor("ids", "filter");

export const bulkArchiveSchema = Joi.object({
  ...bulkTarget,
  reason: Joi.string().trim().max(300).optional().allow("", null),
  /**
   * Required to archive a student with an outstanding balance. Archiving
   * someone who still owes a term's fees is how a school loses track of who to
   * chase; the endpoint refuses and lists them rather than doing it quietly.
   */
  force: Joi.boolean().default(false),
}).oxor("ids", "filter");

export const bulkStatusSchema = Joi.object({
  ...bulkTarget,
  status: Joi.string().valid("suspended", "active").required(),
  reason: Joi.string().trim().max(300).optional().allow("", null),
}).oxor("ids", "filter");

export const bulkPayLinksSchema = Joi.object({
  ...bulkTarget,
}).oxor("ids", "filter");

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
  // `isPrimary` is intentionally absent: changing the primary contact is its
  // own endpoint, so the exactly-one rule is enforced in one place.
}).min(1);

/** The student *and* the parent sub-document. */
export const studentParentParamsSchema = Joi.object({
  id: studentReference,
  parentId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({ "string.pattern.base": "Invalid parent ID format" }),
});

/** @deprecated superseded by `studentParentParamsSchema` */
export const parentIdParamSchema = Joi.object({
  parentId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({ "string.pattern.base": "Invalid parent ID format" }),
});

export const setPrimaryParentSchema = Joi.object({
  isPrimary: Joi.boolean().valid(true).required(),
});
