import Joi from "joi";
import { validateGhanaPhone } from "../utils/generateCode.js";

/**
 * Student validation schemas.
 *
 * Every schema exported here is consumed by exactly one route file
 * (`routes/student.routes.js`) and one controller
 * (`controllers/student.controller.js`). Changing a rule here changes the
 * API contract, so keep the schemas and their consumers in lockstep.
 *
 * Conventions:
 *   - Dates: Joi.date() parses ISO 8601 (YYYY-MM-DD or full ISO).
 *   - Money: integer pesewas on every schema except bulk upload, which takes
 *     cedis because the source is a spreadsheet a bursar typed in.
 *   - References: `studentReference` accepts either a Mongo _id or the human
 *     studentId, because every screen shows the human one.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Reusable field definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Ghana phone number in `024xxxxxxx` or `23324xxxxxxx` form. Normalized to
 * the local `0xx` form so the same parent is not stored two ways.
 */
export const phoneValidator = Joi.string().custom((value, helpers) => {
    const validated = validateGhanaPhone(value);
    if (!validated) {
        return helpers.error("any.custom", {
            message:
                "Invalid Ghana phone number format. Use format: 024xxxxxxx or 23324xxxxxxx",
        });
    }
    return validated.startsWith("233") ? "0" + validated.slice(3) : validated;
});

export const emailValidator = Joi.string()
    .email()
    .lowercase()
    .trim()
    .optional()
    .allow(null, "");

/** A class *name*, not an id — there are no class ids in this system. */
const classNameValidator = Joi.string().trim().min(2).max(50);

/** The academic year format used across the platform: `2025/2026`. */
const academicYearValidator = Joi.string()
    .trim()
    .pattern(/^\d{4}\/\d{4}$/)
    .messages({
        "string.pattern.base": "Academic year must look like 2025/2026",
    });

/**
 * A student reference — the Mongo `_id` or the human `studentId`.
 *
 * The human form is `SCH-DEMO-01-2026-8054`: an arbitrary hyphenated school
 * code, a year, and a zero-padded counter. Accepting both costs one indexed
 * lookup on the service side and removes the trap where a client sent the
 * studentId shown on screen and got a 400.
 */
const studentReference = Joi.string()
    .trim()
    .pattern(/^([0-9a-fA-F]{24}|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-[0-9]{4}-[0-9]{4,})$/)
    .required()
    .messages({
        "string.pattern.base":
            "Invalid student reference — expected a 24-character id or a student number like SCH-DEMO-01-2026-0001",
    });

const objectIdValidator = Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .messages({ "string.pattern.base": "Invalid id format" });

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_ENUM = [
    "active",
    "suspended",
    "removed",
    "graduated",
    "transferred_out",
];

const RELATIONSHIP_ENUM = ["father", "mother", "guardian", "other"];

const REPEAT_REASON_ENUM = [
    "ACADEMIC",
    "ATTENDANCE",
    "MEDICAL",
    "PARENTAL_REQUEST",
    "OTHER",
];

const GRADUATION_TYPE_ENUM = ["STANDARD", "EARLY", "HONORARY", "DEFERRED"];

const HONORS_ENUM = ["NONE", "HONORS", "HIGH_HONORS", "HIGHEST_HONORS"];

const TRANSFER_REASON_ENUM = [
    "RELOCATION",
    "ACADEMIC",
    "FINANCIAL",
    "PERSONAL",
    "EXPULSION",
    "OTHER",
];

const INSTITUTION_TYPE_ENUM = [
    "PUBLIC_SCHOOL",
    "PRIVATE_SCHOOL",
    "INTERNATIONAL_SCHOOL",
    "HOMESCHOOL",
    "VOCATIONAL",
    "COLLEGE_UNIVERSITY",
    "OTHER",
];

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rejects any date before today. Used for deadlines — a fee deadline in the
 * past is not something a school can enforce.
 */
const notInPastDate = Joi.date()
    .custom((value, helpers) => {
        if (!value) return value;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (new Date(value) < today) return helpers.error("any.custom");
        return value;
    })
    .messages({ "any.custom": "Date cannot be in the past" });

/**
 * Rejects any date more than 30 days in the future. Used for lifecycle
 * transitions (promotion, graduation, transfer) where a future date is fine but
 * a wildly future one is a typo.
 */
const notInFutureDate = Joi.date()
    .custom((value, helpers) => {
        if (!value) return value;
        const maxDate = new Date();
        maxDate.setDate(maxDate.getDate() + 30);
        if (new Date(value) > maxDate) return helpers.error("any.custom");
        return value;
    })
    .messages({ "any.custom": "Date cannot be more than 30 days in the future" });

// ─────────────────────────────────────────────────────────────────────────────
// Sub-documents
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Create & update
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `POST /students/single`
 *
 * `schoolId` is only honoured for super admins; school admins have their own
 * schoolId derived server-side.
 */
export const createStudentSchema = Joi.object({
    studentName: Joi.string().trim().min(2).max(100).required(),
    studentClass: classNameValidator.required(),
    gender: Joi.string().valid("male", "female").required(),
    dateOfBirth: Joi.date().max("now").optional().allow(null),
    studentImage: Joi.string().uri().optional().allow(null, ""),
    totalOwed: Joi.number().integer().min(0).required(),
    deadline: notInPastDate.required(),
    academicYear: academicYearValidator.optional().allow(null),
    parents: Joi.array().items(parentSchema).min(1).required(),
    emergencyContacts: Joi.array().items(emergencyContactSchema).optional(),
    schoolId: objectIdValidator.optional(),
});

/**
 * `PUT /students/:id`
 *
 * Deliberately excludes every lifecycle field — `promotedFrom/To`,
 * `promotionDate`, `graduationDate`, `graduationYear`, `graduationType`,
 * `certificateNumber`, `honors`, `isAlumni`, `transferOutDate`,
 * `transferOutReason`, `isRepeating`, `repeatCount`. Each has a dedicated
 * transition endpoint carrying its own preconditions; a generic update must not
 * be able to walk past them.
 */
export const updateStudentSchema = Joi.object({
    studentName: Joi.string().trim().min(2).max(100).optional(),
    studentClass: classNameValidator.optional(),
    gender: Joi.string().valid("male", "female").optional(),
    dateOfBirth: Joi.date().max("now").optional().allow(null),
    studentImage: Joi.string().uri().optional().allow(null, ""),
    totalOwed: Joi.number().integer().min(0).optional(),
    deadline: notInPastDate.optional(),
    academicYear: academicYearValidator.optional(),
    parents: Joi.array().items(parentSchema).min(1).optional(),
    emergencyContacts: Joi.array().items(emergencyContactSchema).optional(),
}).min(1);

// ─────────────────────────────────────────────────────────────────────────────
// Bulk upload metadata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metadata accompanying a CSV/Excel upload. The file itself is parsed
 * separately; this schema covers the form fields sent alongside it.
 *
 * `defaultOwed` is in cedis because the source is a spreadsheet column, not a
 * programmatic payload. It is converted to pesewas during import.
 */
export const bulkUploadMetaSchema = Joi.object({
    schoolId: objectIdValidator.optional(),
    academicYear: academicYearValidator.optional(),
    defaultDeadline: notInPastDate.optional().allow(null),
    defaultOwed: Joi.number().min(0).optional(),
    dryRun: Joi.boolean().default(false),
});

// ─────────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────────

export const studentIdParamSchema = Joi.object({
    id: studentReference,
});

export const schoolIdParamSchema = Joi.object({
    schoolId: objectIdValidator.required(),
});

/** A cohort id: `cohort_2026` or a bare `2026`. */
const cohortIdValidator = Joi.string()
    .trim()
    .pattern(/^(cohort_)?\d{4}$/)
    .messages({
        "string.pattern.base": "Invalid cohort ID — expected cohort_2026 or 2026",
    });

export const cohortIdParamSchema = Joi.object({
    cohortId: cohortIdValidator.required(),
});

export const studentParentParamsSchema = Joi.object({
    id: studentReference,
    parentId: objectIdValidator.required().messages({
        "string.pattern.base": "Invalid parent ID format",
    }),
});

/** @deprecated superseded by `studentParentParamsSchema` */
export const parentIdParamSchema = Joi.object({
    parentId: objectIdValidator.required().messages({
        "string.pattern.base": "Invalid parent ID format",
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// List & stats
// ─────────────────────────────────────────────────────────────────────────────

export const listStudentsQuerySchema = Joi.object({
    schoolId: objectIdValidator.optional(),
    class: classNameValidator.allow("").optional(),
    gender: Joi.string().valid("male", "female").allow("").optional(),
    // Photograph presence. Server-side because the print studio needs this over
    // the whole roster — the roster is 24 students to a page, so a client-side
    // photo filter would only ever see the page you are already looking at.
    photo: Joi.string().valid("has", "missing").allow("").optional(),
    status: Joi.string()
        .valid(...STATUS_ENUM, "all")
        .default("active"),
    search: Joi.string().trim().max(100).allow("").optional(),
    feeStatus: Joi.string().valid("cleared", "owing", "overdue").allow("").optional(),
    planStatus: Joi.string()
        .valid("none", "pending", "active", "completed", "defaulted")
        .allow("")
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
    format: Joi.string().valid("csv", "xlsx").default("csv"),
});

export const statsQuerySchema = Joi.object({
    schoolId: objectIdValidator.optional(),
    class: classNameValidator.allow("").optional(),
    status: Joi.string().valid(...STATUS_ENUM, "all").optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Simple mutations
// ─────────────────────────────────────────────────────────────────────────────

export const suspendStudentSchema = Joi.object({
    reason: Joi.string().trim().min(5).max(300).required(),
});

export const transferClassSchema = Joi.object({
    newClass: classNameValidator.required(),
    reason: Joi.string().trim().max(300).optional().allow("", null),
});

export const archiveStudentSchema = Joi.object({
    reason: Joi.string().trim().max(300).optional().allow("", null),
});

export const setPrimaryParentSchema = Joi.object({
    isPrimary: Joi.boolean().valid(true).required(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle: promote, repeat, graduate, transfer out
// ─────────────────────────────────────────────────────────────────────────────

export const promoteStudentSchema = Joi.object({
    targetClass: classNameValidator.optional().allow(null),
    promotionDate: notInFutureDate.optional().allow(null),
    notes: Joi.string().trim().max(500).optional().allow("", null),
}).min(1);

export const bulkPromoteSchema = Joi.object({
    classNames: Joi.array().items(classNameValidator).optional(),
    gradeLevels: Joi.array()
        .items(Joi.number().integer().min(1).max(12))
        .optional(),
    studentIds: Joi.array().items(objectIdValidator).optional(),
    promotionDate: notInFutureDate.optional().allow(null),
    dryRun: Joi.boolean().default(false),
    notes: Joi.string().trim().max(500).optional().allow("", null),
})
    .or("classNames", "gradeLevels", "studentIds")
    .oxor("classNames", "gradeLevels", "studentIds");

export const previewPromotionSchema = Joi.object({
    schoolId: objectIdValidator.required(),
    classNames: Joi.array().items(classNameValidator).optional(),
    gradeLevels: Joi.array()
        .items(Joi.number().integer().min(1).max(12))
        .optional(),
    studentIds: Joi.array().items(objectIdValidator).optional(),
    promotionDate: notInFutureDate.optional().allow(null),
    /**
     * Opt-in. Classes are strings on the School model with no capacity field, so
     * the preview cannot infer a default. Sending this caps the "over capacity"
     * warning to schools that asked for it.
     */
    classCapacity: Joi.number().integer().min(1).max(500).optional(),
}).or("classNames", "gradeLevels", "studentIds");

export const clearRepeatSchema = Joi.object({
    reason: Joi.string().trim().min(3).max(300).required(),
});

export const repeatStudentSchema = Joi.object({
    repeatReason: Joi.string()
        .valid(...REPEAT_REASON_ENUM)
        .required(),
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
    graduationType: Joi.string()
        .valid(...GRADUATION_TYPE_ENUM)
        .required(),
    certificateNumber: Joi.string().trim().max(50).optional().allow("", null),
    honors: Joi.string()
        .valid(...HONORS_ENUM)
        .default("NONE"),
    notes: Joi.string().trim().max(500).optional().allow("", null),
});

export const bulkGraduateSchema = Joi.object({
    cohortId: cohortIdValidator.optional(),
    classNames: Joi.array().items(classNameValidator).optional(),
    graduationDate: notInFutureDate.required(),
    graduationType: Joi.string()
        .valid(...GRADUATION_TYPE_ENUM)
        .default("STANDARD"),
    autoAssignCertificates: Joi.boolean().default(true),
    certificatePrefix: Joi.string().trim().max(20).optional().allow("", null),
    dryRun: Joi.boolean().default(false),
    notes: Joi.string().trim().max(500).optional().allow("", null),
})
    .or("cohortId", "classNames")
    .oxor("cohortId", "classNames");

export const transferOutSchema = Joi.object({
    destinationInstitution: Joi.string().trim().min(2).max(200).required(),
    destinationInstitutionType: Joi.string()
        .valid(...INSTITUTION_TYPE_ENUM)
        .required(),
    transferDate: notInFutureDate.required(),
    transferReason: Joi.string()
        .valid(...TRANSFER_REASON_ENUM)
        .required(),
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

// ─────────────────────────────────────────────────────────────────────────────
// Alumni & cohorts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `schoolId` is optional here even though the route also carries it in the
 * path. A super admin reading another school's cohorts can pass it explicitly;
 * everyone else gets it from their JWT.
 */
export const alumniQuerySchema = Joi.object({
    schoolId: objectIdValidator.optional(),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    graduationYear: Joi.number().integer().min(1900).max(2100).optional(),
    honors: Joi.string()
        .valid(...HONORS_ENUM)
        .optional(),
    search: Joi.string().trim().max(100).allow("").optional(),
    sortBy: Joi.string()
        .valid("graduationDate", "lastName", "certificateNumber")
        .default("graduationDate"),
    sortOrder: Joi.string().valid("asc", "desc").default("desc"),
});

export const cohortsQuerySchema = Joi.object({
    schoolId: objectIdValidator.optional(),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    year: Joi.number().integer().min(1900).max(2100).optional(),
    status: Joi.string().valid("ARCHIVED", "ACTIVE").optional(),
    search: Joi.string().trim().max(100).allow("").optional(),
});

export const cohortDetailQuerySchema = Joi.object({
    schoolId: objectIdValidator.optional(),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(200).default(50),
    status: Joi.string()
        .valid("GRADUATED", "TRANSFERRED", "DROPPED", "REPEATING")
        .optional(),
    sortBy: Joi.string()
        .valid("lastName", "firstName", "studentId", "graduationDate")
        .default("lastName"),
    sortOrder: Joi.string().valid("asc", "desc").default("asc"),
});

// ─────────────────────────────────────────────────────────────────────────────
// Bulk operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fields a bulk write may set — a strict subset of `updateStudentSchema`.
 * Enumerated once as a const so the `valid(...)` call below is stable.
 */
const BULK_UPDATE_FIELDS = [
    "studentName",
    "studentClass",
    "gender",
    "totalOwed",
    "deadline",
    "academicYear",
];

/**
 * Shared target for every bulk operation. `ids` and `filter` are mutually
 * exclusive; the service prefers `ids` when both are sent, and `.oxor` refuses
 * the request rather than quietly ignoring the filter.
 */
const bulkTargetFields = {
    schoolId: objectIdValidator.optional(),
    ids: Joi.array().items(objectIdValidator).max(2000).optional(),
    filter: Joi.object({
        class: classNameValidator.optional(),
        status: Joi.string()
            .valid(...STATUS_ENUM)
            .optional(),
        gender: Joi.string().valid("male", "female").optional(),
        search: Joi.string().trim().max(100).allow("").optional(),
    }).optional(),
    dryRun: Joi.boolean().default(false),
};

export const bulkUpdateSchema = Joi.object({
    ...bulkTargetFields,
    update: Joi.object({
        studentName: Joi.string().trim().min(2).max(100).optional(),
        studentClass: classNameValidator.optional(),
        gender: Joi.string().valid("male", "female").optional(),
        totalOwed: Joi.number().integer().min(0).optional(),
        deadline: notInPastDate.optional(),
        academicYear: academicYearValidator.optional(),
    })
        .min(1)
        .messages({ "object.min": "No fields to update" })
        .required(),
    fields: Joi.array()
        .items(Joi.string().valid(...BULK_UPDATE_FIELDS))
        .max(BULK_UPDATE_FIELDS.length)
        .optional(),
}).oxor("ids", "filter");

export const bulkArchiveSchema = Joi.object({
    ...bulkTargetFields,
    reason: Joi.string().trim().max(300).optional().allow("", null),
    /**
     * Required to archive a student with an outstanding balance. A school that
     * archives a debtor loses track of who to chase.
     */
    force: Joi.boolean().default(false),
}).oxor("ids", "filter");

export const bulkStatusSchema = Joi.object({
    ...bulkTargetFields,
    status: Joi.string().valid("suspended", "active").required(),
    reason: Joi.string().trim().max(300).optional().allow("", null),
}).oxor("ids", "filter");

export const bulkPayLinksSchema = Joi.object({
    ...bulkTargetFields,
}).oxor("ids", "filter");

// ─────────────────────────────────────────────────────────────────────────────
// Parent management
// ─────────────────────────────────────────────────────────────────────────────

export const addParentSchema = Joi.object({
    parentName: Joi.string().trim().min(2).max(100).required(),
    relationship: Joi.string()
        .valid(...RELATIONSHIP_ENUM)
        .required(),
    phone: phoneValidator.required(),
    email: emailValidator,
    isPrimary: Joi.boolean().default(false),
    isAlive: Joi.boolean().default(true),
});

/**
 * `isPrimary` is intentionally absent from updateParentSchema. Changing the
 * primary contact is its own endpoint (`setPrimaryParentSchema`), so the
 * "exactly one primary" rule is enforced in a single place.
 */
export const updateParentSchema = Joi.object({
    parentName: Joi.string().trim().min(2).max(100).optional(),
    relationship: Joi.string()
        .valid(...RELATIONSHIP_ENUM)
        .optional(),
    phone: phoneValidator.optional(),
    email: emailValidator,
    isAlive: Joi.boolean().optional(),
}).min(1);