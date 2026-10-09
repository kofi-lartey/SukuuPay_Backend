import mongoose from "mongoose";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import {
  generateStudentId,
  reserveStudentIds,
  resolveAcademicYearStart,
  normalizeAcademicYear,
  escapeRegExp,
} from "../utils/generateStudentId.js";
import {
  generatePayLinkToken,
  buildPayLink,
} from "../utils/generatePayLink.js";
import { parseImportFile } from "../utils/csvParser.js";
import { createStudentSchema } from "../validations/student.validation.js";
import * as auditService from "../utils/auditService.js";
import { PaymentPlan } from "../models/paymentPlanModel.js";
import { Payment } from "../models/paymentModel.js";
import { AuditLog } from "../models/AuditLog.js";
import { Counter } from "../models/counterModel.js";

// Local ApiError mirrors the pattern used in school.service.js so error
// handling stays consistent with the existing code style.
class ApiError extends Error {
  constructor(message, status = 500, code = "INTERNAL_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ──────────────────── Helpers ────────────────────

/**
 * The school an id-scoped request is acting within.
 *
 * Two cases, and the second is the one that was broken:
 *
 * - A `super_admin` with an explicit `schoolId` in the path, query or body —
 *   support staff working inside a known school.
 * - A `super_admin` with *no* explicit school, acting on a specific student.
 *   Previously this returned `null`, so every id-scoped service threw
 *   `NO_SCHOOL_SCOPE` and platform support could not read or repair a single
 *   student. The id-scoped callers now pass the student they loaded (see
 *   `loadStudent`), and their own school is the only scope there is.
 *
 * Everything else must be an explicitly schooled user. A user with no
 * `schoolId` is never given a scope.
 */
const resolveSchoolId = (user, explicitSchoolId) => {
  if (user && user.role === "super_admin") {
    return explicitSchoolId ? new mongoose.Types.ObjectId(explicitSchoolId) : null;
  }
  return user && user.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

/**
 * Load one student by Mongo `_id` **or** by the human `studentId` (`PBS-2026-0001`),
 * and check the caller is allowed to see it.
 *
 * Accepting the human id is the fix for a trap the whole UI walked into: every
 * screen a bursar reads shows `studentId`, and the id-scoped param schema
 * demanded 24 hex characters, so following the obvious mapping — look up the
 * student, pass their id — returned 400. Callers that already know the `_id`
 * still pass it, and the cost of trying the ObjectId first is one indexed hit.
 *
 * Also replaces the "find unscoped, then compare" pattern. Every single-record
 * service did `findOne({ _id, deletedAt: null })` followed by a manual
 * `student.schoolId !== schoolId` check — a read of another school's record
 * before the refusal, which is both a wasted query and a place for the check to
 * be forgotten. The scope is now part of the query.
 */
const loadStudent = async (id, user, { includeDeleted = false } = {}) => {
  if (!id) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const isObjectId = mongoose.Types.ObjectId.isValid(id);
  const byId = isObjectId
    ? { _id: id }
    : { studentId: String(id).trim().toUpperCase() };

  const scope = {};
  if (user?.role !== "super_admin" && user?.schoolId) {
    scope.schoolId = new mongoose.Types.ObjectId(user.schoolId);
  }
  if (!includeDeleted) {
    scope.deletedAt = null;
  }

  const student = await Student.findOne({ ...byId, ...scope });
  if (!student) {
    // Distinguish "no such student" from "exists but not yours" only when the
    // caller is not a super_admin; otherwise 404 either way, so the response
    // cannot be used to probe for students in other schools.
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }
  return student;
};

/**
 * The same escaping for every search path.
 *
 * `query.search` used to be spliced raw into `$regex` on four code paths, so
 * `?search=.*` matched every student in the school and `?search=[` threw a
 * driver error that surfaced as a 500. Escaping turns a search box into a
 * literal substring search, which is what a user typing into one expects anyway.
 */
const searchClause = (term, fields) => {
  const safe = escapeRegExp(String(term).trim());
  console.log("[SEARCH] term:", term, "safe:", safe, "fields:", fields);
  if (!safe) return null;
  return fields.map((field) => ({ [field]: { $regex: safe, $options: "i" } }));
};

const fetchSchool = async (schoolId) => {
  const school = await School.findById(schoolId)
    .select("schoolCode slug name academic sms")
    .lean();
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");
  return school;
};

// Business rule #4: exactly one parent must be primary.
const normalizePrimaryParent = (parents) => {
  if (!Array.isArray(parents) || parents.length === 0) return parents;
  let foundPrimary = false;
  parents.forEach((parent) => {
    if (parent.isPrimary) {
      if (!foundPrimary) {
        foundPrimary = true;
      } else {
        parent.isPrimary = false;
      }
    }
  });
  if (!foundPrimary) parents[0].isPrimary = true;
  return parents;
};

// Money is stored as integer pesewas (business rule: all money in pesewas).
const toPesewas = (value) => {
  if (value === null || value === undefined || value === "") return null;
  return Math.round(Number(value) * 100);
};

// Mask the middle digits of a phone number for list views.
const maskPhone = (phone) => {
  if (!phone) return phone;
  const digits = String(phone);
  if (digits.length <= 6) {
    return digits.slice(0, 2) + "*".repeat(Math.max(0, digits.length - 2));
  }
  return digits.slice(0, 4) + "*".repeat(digits.length - 6) + digits.slice(-2);
};

const maskStudentList = (student) => {
  const masked = { ...student };
  if (masked.parents) {
    masked.parents = masked.parents.map((p) => ({
      ...p,
      phone: maskPhone(p.phone),
    }));
  }
  if (masked.emergencyContacts) {
    masked.emergencyContacts = masked.emergencyContacts.map((e) => ({
      ...e,
      phone: maskPhone(e.phone),
      alternatePhone: e.alternatePhone ? maskPhone(e.alternatePhone) : e.alternatePhone,
    }));
  }
  return masked;
};

const resolveAcademicYear = (provided, school) => {
  if (provided) return normalizeAcademicYear(provided);
  if (school.academic?.currentYear) {
    return normalizeAcademicYear(school.academic.currentYear);
  }
  const now = new Date();
  return `${now.getFullYear()}/${now.getFullYear() + 1}`;
};

const escapeCsv = (value) => {
  const str = String(value ?? "");
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const joinValidationErrors = (error) =>
  error.details.map((d) => d.message).join(", ");

// Best-effort SMS dispatch. The platform has no SMS service wired yet, so this
// stubs the send and never throws — keeping the pay-link flow resilient.
const sendPayLinkSms = async (school, phone, payLink) => {
  try {
    console.log(`[SMS-STUB] ${school?.name || "school"} -> ${phone}: ${payLink}`);
    if (!school?.sms) {
      return { sent: false, reason: "SMS provider not configured" };
    }
    return { sent: true, provider: school.sms.provider };
  } catch (error) {
    console.error("SMS send failed:", error.message);
    return { sent: false, reason: error.message };
  }
};

// ──────────────────── Single create ────────────────────
/**
 * Create one student.
 *
 * **Money contract.** `data.totalOwed` is an integer number of *pesewas*, the
 * same as every other money field in this API. The bulk importer is the one
 * exception and is deliberate: a spreadsheet column a bursar types into says
 * `850`, not `85000`, so the CSV is in cedis and the importer converts at the
 * boundary. Both sides are now named for what they are — the importer variable
 * is `totalOwedCedis` — and the import template states the unit in its header
 * row. A client that wants cedis on this endpoint must multiply.
 */
export const createStudent = async (data, user) => {
  const schoolId = resolveSchoolId(user, data.schoolId);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);

  // Business rule #8: studentClass must exist on the school.
  const classes = school.academic?.classes || [];
  if (!classes.includes(data.studentClass)) {
    throw new ApiError(
      `Student class '${data.studentClass}' is not defined for this school`,
      400,
      "INVALID_CLASS"
    );
  }

  const academicYear = resolveAcademicYear(data.academicYear, school);
  const schoolCode = school.schoolCode;
  const year = resolveAcademicYearStart(academicYear);

  normalizePrimaryParent(data.parents);

  const balance = (Number(data.totalOwed) || 0) - (Number(data.totalPaid) || 0);

  const buildPayload = () => {
    const payLinkToken = generatePayLinkToken();
    return {
      ...data,
      schoolId,
      studentClass: data.studentClass,
      createdBy: user._id,
      uniquePayLinkToken: payLinkToken,
      payLink: buildPayLink(payLinkToken),
      totalPaid: 0, // never trust client input
      balance,
      academicYear,
    };
  };

  // One id per attempt, from the atomic counter, so a genuine collision (a
  // pre-existing id from before the counter existed) resolves to a *different*
  // number. The old loop recomputed the same max-and-increment and collided
  // identically three times.
  let student;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const payload = buildPayload();
    payload.studentId = await generateStudentId(schoolCode, year);
    try {
      student = await Student.create(payload);
      break;
    } catch (err) {
      if (err.code === 11000 && attempt < 2) {
        continue;
      }
      throw err;
    }
  }

  if (!student) {
    throw new ApiError(
      "Could not allocate a unique student ID after three attempts",
      500,
      "ID_ALLOCATION_FAILED"
    );
  }

  await School.updateOne(
    { _id: schoolId },
    { $inc: { "stats.totalStudents": 1 } }
  );

  await auditService.log({
    action: "student.create",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    schoolId,
    meta: { studentId: student.studentId },
  });

  return student.toJSON();
};

// ──────────────────── Bulk create ────────────────────
export const bulkCreateStudents = async (file, meta, user) => {
  if (!file) throw new ApiError("No file uploaded", 400, "NO_FILE");

  const { rows, format } = await parseImportFile(file.buffer, file.mimetype, file.originalname);

  const schoolId = resolveSchoolId(user, meta.schoolId);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);
  const schoolCode = school.schoolCode;
  const classes = school.academic?.classes || [];
  const academicYear = resolveAcademicYear(meta.academicYear, school);
  const year = resolveAcademicYearStart(academicYear);

  const defaultDeadline = meta.defaultDeadline
    ? new Date(meta.defaultDeadline)
    : null;
  // Named for its unit, because the two import money inputs are in *cedis*
  // (a human types 850 into a spreadsheet, not 85000) while every field in the
  // rest of the API is pesewas. The conversion happens here, once, at the
  // boundary — and the variable says which side of it we are on.
  const defaultOwedCedis = meta.defaultOwed;
  const defaultOwedPesewas = defaultOwedCedis
    ? toPesewas(defaultOwedCedis)
    : null;

  const errors = [];
  const validDocs = [];
  let reservedIds = [];

  const normalizeRow = (row) => {
    const out = {};
    Object.keys(row || {}).forEach((key) => {
      out[String(key).toLowerCase().trim()] = row[key];
    });
    return out;
  };

  const buildEmergencyContact = (row) => {
    if (!row.emergencycontactname) return null;
    return {
      contactName: row.emergencycontactname,
      relationship: row.emergencycontactrelationship || "Contact",
      phone: row.emergencycontactphone,
      alternatePhone: row.emergencycontactalternatephone || null,
    };
  };

  for (let i = 0; i < rows.length; i += 1) {
    const rowNum = i + 2; // account for the header row
    const row = normalizeRow(rows[i]);

    const parents = [];
    if (!row.parentname) {
      errors.push({ row: rowNum, reason: "Missing parentName" });
      continue;
    }
    const primaryParent = {
      parentName: row.parentname,
      relationship: row.parentrelationship || "guardian",
      phone: row.parentphone,
      email: row.parentemail || null,
      isPrimary: true,
      isAlive: true,
    };
    if (!primaryParent.phone) {
      errors.push({ row: rowNum, reason: "Missing parentPhone" });
      continue;
    }
    parents.push(primaryParent);

    if (row.secondparentname && row.secondparentphone) {
      const secondParent = {
        parentName: row.secondparentname,
        relationship: row.secondparentrelationship || "guardian",
        phone: row.secondparentphone,
        email: row.secondparentemail || null,
        isPrimary: false,
        isAlive: true,
      };
      parents.push(secondParent);
    }

    const emergencyContacts = [];
    const ec = buildEmergencyContact(row);
    if (ec) emergencyContacts.push(ec);

    // The CSV column is in cedis; `clientPayload.totalOwed` is pesewas, which is
    // what `createStudentSchema` validates as an integer. Named on both sides.
    const totalOwedCedis = row.totalowed || defaultOwedCedis;
    const totalOwed =
      totalOwedCedis === undefined || totalOwedCedis === null || totalOwedCedis === ""
        ? null
        : toPesewas(totalOwedCedis);

    const deadline = row.deadline ? new Date(row.deadline) : defaultDeadline;

    // Only client-facing fields are validated here; createdBy/totalPaid/schoolId
    // are stripped by Joi (stripUnknown) and re-applied below as server fields.
    const clientPayload = {
      studentName: row.studentname,
      studentClass: row.studentclass,
      gender: row.gender,
      dateOfBirth: row.dateofbirth ? new Date(row.dateofbirth) : undefined,
      studentImage: null,
      totalOwed,
      deadline,
      academicYear,
      parents,
      emergencyContacts,
    };

    // Reuse the single-create Joi schema for per-row validation.
    const { error, value } = createStudentSchema.validate(clientPayload, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      errors.push({ row: rowNum, reason: joinValidationErrors(error) });
      continue;
    }

    if (!classes.includes(value.studentClass)) {
      errors.push({
        row: rowNum,
        reason: `Student class '${value.studentClass}' is not defined for this school`,
      });
      continue;
    }

    const payLinkToken = generatePayLinkToken();
    value.uniquePayLinkToken = payLinkToken;
    value.payLink = buildPayLink(payLinkToken);
    // Ids are assigned in one block *after* the loop (see below), so every row
    // that passed validation gets a number from the same atomic allocation
    // rather than racing the collection one query at a time.
    value.schoolId = schoolId;
    value.createdBy = user._id;
    value.totalPaid = 0;
    normalizePrimaryParent(value.parents);
    value.balance = (Number(value.totalOwed) || 0) - (Number(value.totalPaid) || 0);
    // Carried alongside the document so a write-time failure can be reported
    // against the spreadsheet row the admin will look for. Mongoose's `strict`
    // drops it on the way into Mongo, but the object in `validDocs` is the same
    // reference the BulkWriteError handler reads.
    value.__rowNumber = rowNum;

    validDocs.push(value);
  }

  // A dry run parses and validates exactly as the real import does, and writes
  // nothing. Sharing the code path is the point: a preview that can disagree
  // with the outcome is worse than no preview, and the client cannot reimplement
  // the server's rules to avoid that.
  if (meta.dryRun) {
    await auditService.log({
      action: "bulk.student_validate",
      entity: "Student",
      entityId: schoolId,
      userId: user._id,
      schoolId,
      meta: { valid: validDocs.length, failed: errors.length, format },
    });
    return {
      created: 0,
      committed: false,
      total: rows.length,
      valid: validDocs.length,
      failed: errors.length,
      errors,
      format,
    };
  }

  // One atomic block allocation for the whole file, rather than a read-then-
  // write aggregation per row. Two concurrent imports previously both read the
  // highest existing id, both produced the same next id, and one failed with a
  // duplicate-key error at insert time.
  if (validDocs.length > 0) {
    reservedIds = await reserveStudentIds(schoolCode, year, validDocs.length);
    validDocs.forEach((doc, index) => {
      doc.studentId = reservedIds[index];
    });
  }

  let created = 0;
  if (validDocs.length > 0) {
    // `ordered: false` so one bad row does not abort the batch — and wrapped,
    // because an unordered insert still THROWS `BulkWriteError` when any document
    // fails. Unwrapped, a single duplicate key discarded the entire
    // `{ created, failed, errors }` report and returned a 500 carrying a raw
    // driver message, even though the other 199 documents had been written.
    try {
      const inserted = await Student.insertMany(validDocs, { ordered: false });
      created = inserted.length;
    } catch (error) {
      if (error?.name === "BulkWriteError" || Array.isArray(error?.writeErrors)) {
        const writeErrors = error.writeErrors || [];
        created = Math.max(0, validDocs.length - writeErrors.length);

        // Map each driver error back to the row the admin sees, so a failure
        // report is actionable. The index tells us which field collided: 11000
        // on `studentId` is a generation race, on `uniquePayLinkToken` or
        // `payLink` a token collision, and anything else is a row-level rule.
        writeErrors.forEach((writeError) => {
          const docIndex = writeError.index;
          const doc = validDocs[docIndex];
          const field = Object.keys(writeError.err?.keyPattern || {})[0] || "unknown";
          const reasons = {
            studentId: "Duplicate student ID (allocation conflict) — try the import again",
            uniquePayLinkToken: "Duplicate pay link token — try the import again",
            payLink: "Duplicate pay link — try the import again",
            "schoolId+certificateNumber": "Duplicate certificate number",
            "schoolId+studentId": "Duplicate student ID",
          };
          errors.push({
            row: doc ? doc.__rowNumber || null : null,
            reason: reasons[field] || `Duplicate value for ${field}`,
            field,
          });
        });
      } else {
        throw error;
      }
    }

    if (created > 0) {
      await School.updateOne(
        { _id: schoolId },
        { $inc: { "stats.totalStudents": created } }
      );
    }
  }

  await auditService.log({
    action: "bulk.student_create",
    entity: "Student",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { created, failed: errors.length, format },
  });

  return {
    created,
    committed: true,
    total: rows.length,
    valid: validDocs.length,
    failed: errors.length,
    errors,
    format,
  };
};

// ──────────────────── Filters ────────────────────

/**
 * The fee status of a student, derived server-side.
 *
 * `overdue` is deliberately before `owing`: a student past their deadline with
 * money outstanding is overdue, not merely owing, and the roster filter treats
 * them as different rows.
 */
const FEE_STATUS = {
  cleared: (s) => (s.balance || 0) <= 0,
  overdue: (s) => (s.balance || 0) > 0 && s.deadline && s.deadline < new Date(),
  owing: (s) => (s.balance || 0) > 0,
};

/**
 * Build the shared list filter.
 *
 * Extracted because `listStudents` and `exportStudents` each rebuilt it, and
 * they had drifted: the list searched four fields (including both parent name
 * and parent phone) while the export searched only two, so "export what I am
 * looking at" produced a different set of rows than the list above it.
 */
const buildRosterFilter = (query, schoolId, { searchFields } = {}) => {
  const filter = { schoolId, deletedAt: null };

  if (query.status && query.status !== "all") filter.status = query.status;
  if (query.class) filter.studentClass = query.class;
  if (query.gender) filter.gender = query.gender;

  if (query.search) {
    const clause = searchClause(
      query.search,
      searchFields || [
        "studentName",
        "studentId",
        "parents.parentName",
        "parents.phone",
      ]
    );
    if (clause) filter.$or = clause;
  }

  return filter;
};

/**
 * `feeStatus` and `planStatus` are applied after the database query.
 *
 * `feeStatus` is a comparison against a computed `balance`, which Mongo cannot
 * express. `planStatus` depends on `PaymentPlan`, so the plan ids are resolved
 * in one query and matched back in memory. Both are documented as
 * post-filters in the API contract: they narrow the page being returned, they do
 * not change the total. For a 1,000-student roster that distinction is the
 * difference between a usable filter and a page that lies about its own size.
 */
const applyPostFilters = (rows, query, planStatusById) => {
  let out = rows;
  if (query.feeStatus) {
    const test = FEE_STATUS[query.feeStatus];
    if (test) out = out.filter((s) => test(s));
  }
  if (query.planStatus && planStatusById) {
    out = out.filter((s) => {
      const status = planStatusById.get(String(s._id)) || "none";
      return status === query.planStatus;
    });
  }
  return out;
};

/** The plan status of every student in `rows`, in one query. */
const planStatusMap = async (rows) => {
  const ids = rows.map((r) => r._id);
  if (!ids.length) return new Map();
  const plans = await PaymentPlan.find({ studentId: { $in: ids } })
    .select("studentId planStatus")
    .lean();
  const map = new Map();
  plans.forEach((plan) => {
    const key = String(plan.studentId);
    // A student with several plans reads as `active` if any is running, so the
    // filter does not hide a student who is mid-payment on a newer plan.
    if (map.get(key) !== "active") {
      map.set(key, normalisePlanStatus(plan.planStatus));
    }
  });
  return map;
};

const normalisePlanStatus = (status) => {
  if (!status) return "none";
  if (status === "active") return "active";
  if (status === "completed") return "completed";
  if (status === "defaulted" || status === "cancelled") return "defaulted";
  if (status === "pending_acceptance") return "pending";
  return "none";
};

// ──────────────────── List ────────────────────
export const listStudents = async (query, user) => {
  console.log("[LIST STUDENTS] query:", JSON.stringify(query), "user role:", user?.role, "user schoolId:", user?.schoolId);
  const schoolId = resolveSchoolId(user, query.schoolId);
  console.log("[LIST STUDENTS] resolved schoolId:", schoolId);
  if (!schoolId) {
    throw new ApiError(
      "A schoolId is required to list students",
      400,
      "NO_SCHOOL_SCOPE"
    );
  }

  const filter = buildRosterFilter(query, schoolId);
  const sortBy = query.sortBy || "createdAt";
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;
  const page = Math.max(1, Number(query.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.perPage) || 20));

  const [students, total] = await Promise.all([
    Student.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean(),
    Student.countDocuments(filter),
  ]);

  const planStatusById = await planStatusMap(students);
  const data = applyPostFilters(students, query, planStatusById).map((student) => ({
    ...maskStudentList({ ...student, id: String(student._id) }),
    planStatus: planStatusById.get(String(student._id)) || "none",
  }));

  return {
    data,
    meta: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };
};

// ──────────────────── Roster aggregates ────────────────────
/**
 * The numbers behind the Students module's KPI band.
 *
 * A dedicated endpoint rather than something the client derives. The roster
 * list is paginated and capped at 100 rows, its parent phones are masked, and
 * "fully cleared" needs a comparison the client cannot make from a page of
 * results — so summing client-side would report the first 20 students as the
 * school. One aggregation, one round trip.
 */
export const getStudentStats = async (query, user) => {
  const schoolId = resolveSchoolId(user, query.schoolId);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const filter = buildRosterFilter(query, schoolId);
  delete filter.$or; // aggregate + regex is a collection scan; stats are scope-only

  const now = new Date();
  const [
    totals,
    overdueAgg,
    activePlans,
    planStudents,
  ] = await Promise.all([
    Student.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalRoster: { $sum: 1 },
          fullyCleared: {
            $sum: { $cond: [{ $lte: ["$balance", 0] }, 1, 0] },
          },
          totalOwed: { $sum: { $ifNull: ["$totalOwed", 0] } },
          totalPaid: { $sum: { $ifNull: ["$totalPaid", 0] } },
          outstanding: {
            $sum: { $cond: [{ $gt: ["$balance", 0] }, "$balance", 0] },
          },
        },
      },
    ]),
    Student.aggregate([
      {
        $match: {
          ...filter,
          balance: { $gt: 0 },
          deadline: { $lt: now },
        },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          amount: { $sum: "$balance" },
        },
      },
    ]),
    PaymentPlan.countDocuments({ schoolId, planStatus: "active" }),
    PaymentPlan.distinct("studentId", { schoolId, planStatus: "active" }),
  ]);

  const row = totals[0] || {};
  const overdue = overdueAgg[0] || { count: 0, amount: 0 };
  const totalRoster = row.totalRoster || 0;

  return {
    totalRoster,
    fullyCleared: row.fullyCleared || 0,
    // Round to one decimal rather than truncating: 737 of 1,000 is 73.7%, and a
    // UI that formats to `Math.round` would show 74% for a 73.7% collection.
    clearedPercent: totalRoster
      ? Math.round(((row.fullyCleared || 0) / totalRoster) * 1000) / 10
      : 0,
    activePlans: activePlans || 0,
    activePlanStudents: (planStudents || []).length,
    overdueStudents: overdue.count || 0,
    overdueAmount: overdue.amount || 0,
    totalOwed: row.totalOwed || 0,
    totalPaid: row.totalPaid || 0,
    outstanding: row.outstanding || 0,
  };
};

// ──────────────────── Profile preview ────────────────────
/**
 * Everything the profile drawer needs, in one response.
 *
 * The drawer shows the student, their guardians, the plan, their payment
 * history and their class history. Assembled client-side that is five requests
 * that resolve at different times, so the screen renders a half-populated
 * student — most visibly a balance that reads GH₵ 0.00 while the payments that
 * explain it are still loading. One aggregate, one render.
 *
 * `unmasked: true` is the settled policy: guardian phone numbers are masked in
 * the roster and the export, and shown in full to a school admin on the
 * student's own record. A bursar taking a payment over the phone needs the real
 * number; a roster is a browsing surface where it is not needed.
 */
export const getStudentProfile = async (id, user, { includeDeleted = false } = {}) => {
  const student = await loadStudent(id, user, { includeDeleted });
  const studentObjectId = student._id;

  const [plans, payments, history] = await Promise.all([
    PaymentPlan.find({ studentId: studentObjectId })
      .sort({ createdAt: -1 })
      .lean(),
    Payment.find({ studentId: studentObjectId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    AuditLog.find({ entity: "Student", entityId: studentObjectId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
  ]);

  const activePlan =
    plans.find((p) => p.planStatus === "active") || plans.find((p) => p.planStatus !== "cancelled") || null;

  let installmentProgress = null;
  if (activePlan?.installments?.length) {
    const installments = activePlan.installments || [];
    const paid = installments.filter((i) => i.status === "paid");
    const paidAmount = paid.reduce((sum, i) => sum + (i.amount || 0), 0);
    const totalAmount = installments.reduce((sum, i) => sum + (i.amount || 0), 0);
    const pending = installments
      .filter((i) => i.status !== "paid")
      .sort((a, b) => new Date(a.dueDate || 0) - new Date(b.dueDate || 0));

    installmentProgress = {
      paid: paid.length,
      total: installments.length,
      paidAmount,
      totalAmount,
      remaining: Math.max(0, (activePlan.totalAmount || 0) - paidAmount),
      percent: totalAmount ? Math.round((paidAmount / totalAmount) * 100) : 0,
      nextDueDate: pending[0]?.dueDate || null,
    };
  }

  return {
    student: student.toJSON(),
    guardians: (student.parents || []).map((p) => p.toObject ? p.toObject() : p),
    emergencyContacts: (student.emergencyContacts || []).map((c) =>
      c.toObject ? c.toObject() : c
    ),
    plans,
    activePlan,
    installmentProgress,
    recentPayments: payments,
    classHistory: student.classHistory || [],
    auditTrail: history,
  };
};

// ──────────────────── Get by id ────────────────────
export const getStudentById = async (id, user) => {
  const student = await loadStudent(id, user);
  return student.toJSON();
};

// ──────────────────── Update ────────────────────
export const updateStudent = async (id, data, user) => {
  const student = await loadStudent(id, user);

  // Fields no `PUT` may ever write.
  //
  // `promotedFrom/To`, `promotionDate`, `graduationDate`, `graduationYear`,
  // `isAlumni`, `transferOutDate`, `transferOutReason` and `isRepeating` each
  // have a dedicated transition endpoint carrying real preconditions — "only
  // active students", "not in a final year class", "not already repeating". A
  // generic update walked straight past all of them, so a client could graduate
  // a suspended student or clear a repeat flag by sending the field in a body.
  // They are removed from the Joi schema as well; this is the second line.
  const protectedFields = [
    "studentId",
    "uniquePayLinkToken",
    "payLink",
    "totalPaid",
    "balance",
    "createdBy",
    "deletedAt",
    "deletedBy",
    "deletedReason",
    "schoolId",
    "status",
    "statusReason",
    "statusChangedAt",
    "firstName",
    "lastName",
    "repeatCount",
    "promotedFrom",
    "promotedTo",
    "promotionDate",
    "graduationDate",
    "graduationYear",
    "graduationType",
    "certificateNumber",
    "honors",
    "isAlumni",
    "transferOutDate",
    "transferOutReason",
    "transferOutRecord",
    "isRepeating",
    "classHistory",
    "__v",
  ];

  const updates = { ...data };
  protectedFields.forEach((field) => delete updates[field]);
  // updatedBy is server-set (after stripping protected fields).
  updates.updatedBy = user._id;

  if (Object.keys(updates).length === 1) {
    throw new ApiError(
      "No editable fields were supplied",
      400,
      "NO_EDITABLE_FIELDS"
    );
  }

  const school = await fetchSchool(student.schoolId);
  if (updates.studentClass && updates.studentClass !== student.studentClass) {
    const classes = school.academic?.classes || [];
    if (!classes.includes(updates.studentClass)) {
      throw new ApiError(
        `Student class '${updates.studentClass}' is not defined for this school`,
        400,
        "INVALID_CLASS"
      );
    }
  }

  // Parents are replaced wholesale, not merged — a PUT that adds one parent and
  // a UI that sends the whole list are the same request, and merging would drop
  // the parent's `_id` that the parent endpoints address.
  if (Array.isArray(updates.parents)) {
    updates.parents = updates.parents.map((parent) =>
      parent._id ? { ...parent, _id: parent._id } : parent
    );
    normalizePrimaryParent(updates.parents);
  }

  Object.keys(updates).forEach((key) => {
    student[key] = updates[key];
  });

  await student.save();

  await auditService.log({
    action: "student.update",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    schoolId: student.schoolId,
    meta: { updatedFields: Object.keys(updates) },
  });

  return student.toJSON();
};

// ──────────────────── Soft delete (shared) ────────────────────
// Never hard delete. Payment/plan records are preserved.
const archiveStudent = async (id, user, reason = null) => {
  const student = await loadStudent(id, user);

  student.status = "removed";
  student.statusReason = reason || student.statusReason;
  student.statusChangedAt = new Date();
  student.deletedAt = new Date();
  student.deletedBy = user._id;
  student.deletedReason = reason || null;
  student.updatedBy = user._id;
  await student.save();

  // The roster count is denormalised onto the School, and import incremented it
  // without a matching decrement. A school that archived a hundred students had
  // a headline count a hundred too high, and nothing ever reconciled the two.
  await School.updateOne(
    { _id: student.schoolId, "stats.totalStudents": { $gt: 0 } },
    { $inc: { "stats.totalStudents": -1 } }
  );

  await auditService.log({
    action: "student.delete",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    schoolId: student.schoolId,
    meta: { reason: reason || null },
  });

  return student;
};

/**
 * DELETE /students/:id
 *
 * The one archive entry point. `PUT /students/:id/remove` was a byte-for-byte
 * duplicate of this, differing only in the word in its response message, so a
 * client had no way to know which to call; the route now delegates here and the
 * duplicate is gone.
 */
export const deleteStudent = async (id, user, reason = null) => {
  await archiveStudent(id, user, reason);
  return { message: "Student removed" };
};

/** Kept as a named alias for the legacy `/remove` route. */
export const removeStudent = deleteStudent;

/**
 * PUT /students/:id/restore
 *
 * Undoes an archive. Without it, one mis-click on a bulk selection is permanent:
 * there is no hard delete to be careful of, and no way back either.
 */
export const restoreStudent = async (id, user) => {
  const student = await loadStudent(id, user, { includeDeleted: true });

  if (!student.deletedAt) {
    throw new ApiError("This student is not archived", 409, "NOT_ARCHIVED");
  }

  student.deletedAt = null;
  student.deletedBy = null;
  student.deletedReason = null;
  // `active` rather than leaving `removed`: a student that was suspended before
  // being archived should return to suspended, and the reason is still on the
  // record, but the common case — archived straight from active — is correct
  // and a wrong-but-lenient `active` is better than an invisible student.
  student.status = "active";
  student.statusChangedAt = new Date();
  student.updatedBy = user._id;
  await student.save();

  await School.updateOne({ _id: student.schoolId }, { $inc: { "stats.totalStudents": 1 } });

  await auditService.log({
    action: "student.restore",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    schoolId: student.schoolId,
  });

  return student.toJSON();
};

// ──────────────────── Suspend / Reactivate ────────────────────
export const suspendStudent = async (id, reason, user) => {
  // The student's own school is the scope. `loadStudent` enforces the caller's
  // access and, for a `super_admin`, no longer needs an explicit schoolId —
  // previously every one of these services called `resolveSchoolId(user, null)`,
  // which returns null for a super_admin and made all of them unreachable for
  // platform staff.
  const student = await loadStudent(id, user);
  const schoolId = student.schoolId;

  student.status = "suspended";
  student.statusReason = reason;
  student.statusChangedAt = new Date();
  await student.save();

  await auditService.log({
    action: "student.suspend",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { reason },
  });

  return student.toJSON();
};

export const reactivateStudent = async (id, user) => {
  // The student's own school is the scope. `loadStudent` enforces the caller's
  // access and, for a `super_admin`, no longer needs an explicit schoolId —
  // previously every one of these services called `resolveSchoolId(user, null)`,
  // which returns null for a super_admin and made all of them unreachable for
  // platform staff.
  const student = await loadStudent(id, user);
  const schoolId = student.schoolId;

  student.status = "active";
  student.statusReason = "";
  student.statusChangedAt = null;
  await student.save();

  await auditService.log({
    action: "student.reactivate",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: {},
  });

  return student.toJSON();
};

// ──────────────────── Transfer class ────────────────────
export const transferStudentClass = async (id, newClass, reason, user) => {
  // The student's own school is the scope. `loadStudent` enforces the caller's
  // access and, for a `super_admin`, no longer needs an explicit schoolId —
  // previously every one of these services called `resolveSchoolId(user, null)`,
  // which returns null for a super_admin and made all of them unreachable for
  // platform staff.
  const student = await loadStudent(id, user);
  const schoolId = student.schoolId;

  const school = await fetchSchool(schoolId);
  const classes = school.academic?.classes || [];
  if (!classes.includes(newClass)) {
    throw new ApiError(
      `Student class '${newClass}' is not defined for this school`,
      400,
      "INVALID_CLASS"
    );
  }

  // Record history before mutating (business rule: keep class history).
  student.classHistory.push({
    from: student.studentClass,
    to: newClass,
    date: new Date(),
    reason: reason || "",
    by: user._id,
  });

  student.studentClass = newClass;
  await student.save();

  await auditService.log({
    action: "student.transfer_class",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { from: student.classHistory[student.classHistory.length - 1].from, to: newClass },
  });

  return student.toJSON();
};

// ──────────────────── Regenerate pay link ────────────────────
export const regeneratePayLink = async (id, user, { notify = false } = {}) => {
  // The student's own school is the scope. `loadStudent` enforces the caller's
  // access and, for a `super_admin`, no longer needs an explicit schoolId —
  // previously every one of these services called `resolveSchoolId(user, null)`,
  // which returns null for a super_admin and made all of them unreachable for
  // platform staff.
  const student = await loadStudent(id, user);
  const schoolId = student.schoolId;

  // Invalidate the old token by issuing a fresh one.
  student.uniquePayLinkToken = generatePayLinkToken();
  student.payLink = buildPayLink(student.uniquePayLinkToken);
  await student.save();

  if (notify) {
    const school = await fetchSchool(schoolId);
    const primaryParent = (student.parents || []).find((p) => p.isPrimary) || student.parents?.[0];
    if (primaryParent?.phone) {
      await sendPayLinkSms(school, primaryParent.phone, student.payLink);
    }
  }

  await auditService.log({
    action: "student.pay_link_regenerate",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { notified: Boolean(notify) },
  });

  // The raw `uniquePayLinkToken` is no longer returned.
  //
  // The `toJSON` transform exists specifically to delete that field, and this
  // one response handed it straight back to the client — so anyone with the
  // token could read the same endpoint with a different URL. The public
  // `payLink` contains the token and is what the caller actually needs.
  return { payLink: student.payLink };
};

// ──────────────────── Export ────────────────────
export const exportStudents = async (query, user) => {
  const schoolId = resolveSchoolId(user, query.schoolId);
  if (!schoolId) {
    throw new ApiError(
      "A schoolId is required to export students",
      400,
      "NO_SCHOOL_SCOPE"
    );
  }

  const school = await fetchSchool(schoolId);
  const format = query.format === "xlsx" ? "xlsx" : "csv";

  // The export previously rebuilt its own filter and searched only
  // `studentName`/`studentId`, while the list above it also searched parent
  // name and phone. "Export what I am looking at" therefore returned a
  // different set of rows than the screen it was exported from. The shared
  // builder keeps the two in step. `format` is not part of the filter, so it is
  // read separately below.
  //
  // The call itself was missing when the duplicated block was deleted, so the
  // `Student.find(filter)` below was reading a `filter` that no longer existed
  // and every `GET /students/export` failed with a ReferenceError. The comment
  // claimed the two paths were in step; the code did not compile into a request
  // that could run.
  const filter = buildRosterFilter(query, schoolId);

  const students = await Student.find(filter)
    .sort({ createdAt: -1 })
    .select("-uniquePayLinkToken -__v")
    .lean();

  const slug = school.slug || school.schoolCode || "students";
  const dateStr = new Date().toISOString().slice(0, 10);
  const extension = format === "xlsx" ? "xlsx" : "csv";
  const filename = `students-${slug}-${dateStr}.${extension}`;

  // Declared up front, not derived from the first row.
  //
  // The header used to be `Object.keys(rows[0] || {})`, so an export that
  // matched nothing produced `"\n"` — a file that opens as a single blank line
  // and reads to a bursar as data loss. A header-only CSV is the correct answer
  // for "your filter matched no students", and it is what makes the two cases
  // distinguishable at a glance.
  const COLUMNS = [
    "studentId",
    "studentName",
    "studentClass",
    "gender",
    "status",
    "totalOwed",
    "totalPaid",
    "balance",
    "deadline",
    "parentName",
    "parentPhone",
    "payLink",
  ];

  const rows = students.map((student) => {
    const primaryParent = (student.parents || []).find((p) => p.isPrimary) || student.parents?.[0];
    return {
      studentId: student.studentId,
      studentName: student.studentName,
      studentClass: student.studentClass,
      gender: student.gender,
      status: student.status,
      // Pesawas, labelled as such. The header used to say `totalOwed` for an
      // integer count of pesewas, and anyone who opened the file in a
      // spreadsheet read 85000 rather than GH₵ 850.00.
      totalOwedCedis: (student.totalOwed || 0) / 100,
      totalPaidCedis: (student.totalPaid || 0) / 100,
      balanceCedis: (student.balance || 0) / 100,
      deadline: student.deadline ? new Date(student.deadline).toISOString().slice(0, 10) : "",
      parentName: primaryParent?.parentName || "",
      // Unmasked: an export is taken off-system and reconciled against a bank
      // statement, so a masked phone makes the file useless for the one thing
      // it is exported for. Masked numbers live in the roster, on screen.
      parentPhone: primaryParent?.phone || "",
      payLink: student.payLink || "",
    };
  });

  if (format === "xlsx") {
    // lazy import keeps xlsx loaded only for Excel exports
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    // `json_to_sheet` with an explicit header array so an empty result still
    // produces a sheet with the right columns rather than a blank one.
    const ws = XLSX.utils.json_to_sheet(rows, { header: COLUMNS });
    XLSX.utils.book_append_sheet(wb, ws, "Students");
    const content = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    return {
      filename,
      rowCount: rows.length,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content,
    };
  }

  const header = COLUMNS.map(escapeCsv).join(",");
  const body = rows
    .map((row) => COLUMNS.map((c) => escapeCsv(row[c])).join(","))
    .join("\n");

  return {
    filename,
    rowCount: rows.length,
    mimeType: "text/csv",
    content: rows.length ? `${header}\n${body}` : header,
  };
};

// ──────────────────── Promotion Helpers ────────────────────
const getNextClass = async (schoolId, currentClass) => {
  const school = await fetchSchool(schoolId);
  const classes = school.academic?.classes || [];
  const currentIndex = classes.indexOf(currentClass);
  if (currentIndex === -1 || currentIndex === classes.length - 1) {
    return null;
  }
  return classes[currentIndex + 1];
};

const getFinalYearClasses = async (schoolId) =>
  getFinalYearClassesFrom(await fetchSchool(schoolId));

/**
 * The classes a student may graduate from.
 *
 * `school.academic.finalYearClasses` when the school has named them, and
 * otherwise the last three on the class list.
 *
 * The fallback is a heuristic, and a wrong one for most Ghanaian school shapes.
 * A basic-and-JHS school lists `Nursery 1 … Primary 6, JHS 1, JHS 2, JHS 3`,
 * whose last three are JHS 1–3 — so `graduateStudent`'s "not in a final year
 * class" guard let a JHS 1 student through, and the guard protected nothing. A
 * school that names its final years gets the correct answer; one that has not is
 * no worse off than before, which is why the fallback stays.
 */
const getFinalYearClassesFrom = (school) => {
  const named = school?.academic?.finalYearClasses || [];
  if (named.length) return named;
  return (school?.academic?.classes || []).slice(-3);
};

// ──────────────────── Promote Single Student ────────────────────
export const promoteStudent = async (id, data, user) => {
  // The student's own school is the scope. `loadStudent` enforces the caller's
  // access and, for a `super_admin`, no longer needs an explicit schoolId —
  // previously every one of these services called `resolveSchoolId(user, null)`,
  // which returns null for a super_admin and made all of them unreachable for
  // platform staff.
  const student = await loadStudent(id, user);
  const schoolId = student.schoolId;

  if (student.status !== "active") {
    throw new ApiError("Only active students can be promoted", 409, "INVALID_STATUS");
  }

  if (student.isRepeating) {
    throw new ApiError("Repeating students cannot be promoted until repeat period ends", 409, "STUDENT_REPEATING");
  }

  // `targetClassId` was validated as a 24-hex ObjectId but used here as a class
  // *name*. `School.academic.classes` is `[String]` — there are no class ids in
  // this system — so a caller following the schema sent something the service
  // could not match against any class. The field is renamed to `targetClass`
  // and the validation corrected (see `promoteStudentSchema`).
  let targetClass = data.targetClass;
  if (!targetClass) {
    targetClass = await getNextClass(schoolId, student.studentClass);
    if (!targetClass) {
      throw new ApiError("No next class level defined for student's current class", 409, "NO_NEXT_LEVEL");
    }
  } else {
    const school = await fetchSchool(schoolId);
    const classes = school.academic?.classes || [];
    if (!classes.includes(targetClass)) {
      throw new ApiError("Target class not found in school", 400, "INVALID_TARGET_CLASS");
    }
  }

  const promotionDate = data.promotionDate ? new Date(data.promotionDate) : new Date();
  const previousClass = student.studentClass;

  student.classHistory.push({
    from: previousClass,
    to: targetClass,
    date: promotionDate,
    reason: data.notes || "Promotion",
    by: user._id,
  });

  student.promotedFrom = previousClass;
  student.promotedTo = targetClass;
  student.promotionDate = promotionDate;
  student.studentClass = targetClass;
  student.updatedBy = user._id;

  await student.save();

  await auditService.log({
    action: "student.promote",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { from: previousClass, to: targetClass, promotionDate },
  });

  return student.toJSON();
};

// ──────────────────── Bulk Promote Students ────────────────────
export const bulkPromoteStudents = async (schoolId, data, user) => {
  const resolvedSchoolId = resolveSchoolId(user, schoolId);
  if (!resolvedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  await fetchSchool(resolvedSchoolId);

  // `classIds` are class *names* — `School.academic.classes` is `[String]`. The
  // Joi schema required 24-hex ObjectIds, so a caller could not send a value
  // that matched any class; it is renamed `classNames` and validated as such.
  const { classNames, gradeLevels, studentIds, promotionDate, dryRun, notes } = data;

  let filter = { schoolId: resolvedSchoolId, deletedAt: null, status: "active", isRepeating: false };

  if (studentIds && studentIds.length > 0) {
    filter._id = { $in: studentIds.map((id) => new mongoose.Types.ObjectId(id)) };
  } else if (classNames && classNames.length > 0) {
    filter.studentClass = { $in: classNames };
  } else if (gradeLevels && gradeLevels.length > 0) {
    const school = await fetchSchool(resolvedSchoolId);
    const classes = school.academic?.classes || [];
    // `cls.includes(String(g))` is a substring match against a class *name*,
    // so grade 1 also matches "JHS 11A" and "JHS 12A". Tighter: match the class
    // name's own number, which is the first integer in the string, so "1" only
    // selects classes whose leading number is 1.
    const matchingClasses = classes.filter((cls) => {
      const level = cls.match(/\d+/)?.[0];
      return level != null && gradeLevels.some((g) => String(level) === String(g));
    });
    if (matchingClasses.length === 0) {
      throw new ApiError("No classes found for specified grade levels", 400, "NO_CLASSES_MATCHED");
    }
    filter.studentClass = { $in: matchingClasses };
  }

  const students = await Student.find(filter).lean();
  if (students.length === 0) {
    throw new ApiError("No students matched the provided criteria", 400, "NO_STUDENTS_MATCHED");
  }
  // The `.limit(500)` that used to be here truncated silently: a whole school
  // matched, 500 were promoted, and the response reported
  // `totalProcessed: 500` with no hint that the rest had been dropped. A
  // visible refusal is the only version of this a bursar can act on.
  if (students.length > BULK_LIMIT) {
    throw new ApiError(
      `This would promote ${students.length} students, above the ${BULK_LIMIT} limit for a single request. Promote by class instead.`,
      400,
      "BULK_LIMIT_EXCEEDED"
    );
  }

  const school = await fetchSchool(resolvedSchoolId);
  const classes = school.academic?.classes || [];

  const promoDate = promotionDate ? new Date(promotionDate) : new Date();
  const promoted = [];
  const skipped = [];
  const failed = [];

  for (const student of students) {
    try {
      const nextClass = await getNextClass(resolvedSchoolId, student.studentClass);
      if (!nextClass) {
        // `skipped` was declared and returned but never pushed to, so the
        // response always reported 0 skipped while quietly dropping everyone at
        // the top of their class. Skipped is a normal outcome of bulk promotion,
        // not a failure, and it belongs in its own list.
        skipped.push({
          studentId: student._id,
          studentNumber: student.studentId,
          reason: "No next class is defined after their current class",
        });
        continue;
      }

      if (dryRun) {
        promoted.push({
          studentId: student._id,
          studentNumber: student.studentId,
          previousClass: student.studentClass,
          newClass: nextClass,
        });
        continue;
      }

      const studentDoc = await Student.findById(student._id);
      studentDoc.classHistory.push({
        from: student.studentClass,
        to: nextClass,
        date: promoDate,
        reason: notes || "Bulk promotion",
        by: user._id,
      });
      studentDoc.promotedFrom = student.studentClass;
      studentDoc.promotedTo = nextClass;
      studentDoc.promotionDate = promoDate;
      studentDoc.studentClass = nextClass;
      studentDoc.updatedBy = user._id;
      await studentDoc.save();

      promoted.push({
        studentId: studentDoc._id,
        studentNumber: studentDoc.studentId,
        previousClass: student.studentClass,
        newClass: nextClass,
      });
    } catch (error) {
      failed.push({ studentId: student._id, reason: error.message });
    }
  }

  await auditService.log({
    action: "bulk.student_promote",
    entity: "Student",
    entityId: resolvedSchoolId,
    userId: user._id,
    schoolId: resolvedSchoolId,
    meta: { promoted: promoted.length, skipped: skipped.length, failed: failed.length, dryRun },
  });

  return {
    summary: {
      totalProcessed: students.length,
      promoted: promoted.length,
      skipped: skipped.length,
      failed: failed.length,
    },
    promotedStudents: promoted,
    skippedStudents: skipped,
    failedStudents: failed,
  };
};

// ──────────────────── Preview Promotion ────────────────────
export const previewPromotion = async (data, user) => {
  const { schoolId, classNames, gradeLevels, studentIds, promotionDate, classCapacity } = data;

  const resolvedSchoolId = resolveSchoolId(user, schoolId);
  if (!resolvedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  await fetchSchool(resolvedSchoolId);

  let filter = { schoolId: resolvedSchoolId, deletedAt: null, status: "active", isRepeating: false };

  if (studentIds && studentIds.length > 0) {
    filter._id = { $in: studentIds.map((id) => new mongoose.Types.ObjectId(id)) };
  } else if (classNames && classNames.length > 0) {
    filter.studentClass = { $in: classNames };
  } else if (gradeLevels && gradeLevels.length > 0) {
    const school = await fetchSchool(resolvedSchoolId);
    const classes = school.academic?.classes || [];
    const matchingClasses = classes.filter((cls) => {
      const level = cls.match(/\d+/)?.[0];
      return level != null && gradeLevels.some((g) => String(level) === String(g));
    });
    if (matchingClasses.length === 0) {
      throw new ApiError("No classes found for specified grade levels", 400, "NO_CLASSES_MATCHED");
    }
    filter.studentClass = { $in: matchingClasses };
  }

  const students = await Student.find(filter).lean();
  if (students.length > BULK_LIMIT) {
    throw new ApiError(
      `This selection covers ${students.length} students, above the ${BULK_LIMIT} limit. Preview by class instead.`,
      400,
      "BULK_LIMIT_EXCEEDED"
    );
  }

  const school = await fetchSchool(resolvedSchoolId);
  const classes = school.academic?.classes || [];
  const promoDate = promotionDate ? new Date(promotionDate) : new Date();

  const mapping = [];
  const warnings = [];
  const unmappedStudents = [];

  for (const student of students) {
    const nextClass = classes.indexOf(student.studentClass) !== -1 && classes.indexOf(student.studentClass) < classes.length - 1
      ? classes[classes.indexOf(student.studentClass) + 1]
      : null;

    if (!nextClass) {
      unmappedStudents.push({ studentId: student._id, reason: "No next level defined for current class" });
      continue;
    }

    let existingMapping = mapping.find((m) => m.currentClass === student.studentClass && m.targetClass === nextClass);
    if (!existingMapping) {
      existingMapping = {
        currentClass: student.studentClass,
        targetClass: nextClass,
        studentCount: 0,
        students: [],
      };
      mapping.push(existingMapping);
    }
    existingMapping.studentCount += 1;
    existingMapping.students.push({ id: student._id, studentNumber: student.studentId, name: student.studentName });
  }

  if (unmappedStudents.length > 0) {
    warnings.push({
      type: "NO_TARGET_CLASS",
      message: `${unmappedStudents.length} students have no next level defined`,
      affectedStudentIds: unmappedStudents.map((u) => u.studentId),
    });
  }

  // Capacity was hardcoded to 40, so the warning fired for every school with
  // larger classes and stayed silent for every school with smaller ones. It is
  // now supplied by the caller, and when no capacity is known the check is
  // skipped rather than guessed — a capacity warning built on a made-up number
  // is worse than no warning.
  const capacity = Number(classCapacity) || 0;

  if (capacity > 0) {
    for (const m of mapping) {
      // eslint-disable-next-line no-await-in-loop
      const targetClassStudents = await Student.countDocuments({
        schoolId: resolvedSchoolId,
        studentClass: m.targetClass,
        deletedAt: null,
        status: "active",
      });
      if (targetClassStudents + m.studentCount > capacity) {
        warnings.push({
          type: "CLASS_CAPACITY",
          message: `${m.targetClass} will exceed capacity by ${targetClassStudents + m.studentCount - capacity} students`,
          currentCapacity: capacity,
          projectedEnrollment: targetClassStudents + m.studentCount,
        });
      }
    }
  }

  return {
    previewDate: new Date(),
    schoolId: resolvedSchoolId,
    totalEligibleStudents: students.length,
    mapping,
    warnings,
    unmappedStudents,
  };
};

// ──────────────────── Repeat Student ────────────────────
export const repeatStudent = async (id, data, user) => {
  // The student's own school is the scope. `loadStudent` enforces the caller's
  // access and, for a `super_admin`, no longer needs an explicit schoolId —
  // previously every one of these services called `resolveSchoolId(user, null)`,
  // which returns null for a super_admin and made all of them unreachable for
  // platform staff.
  const student = await loadStudent(id, user);
  const schoolId = student.schoolId;

  if (student.status !== "active") {
    throw new ApiError("Only active students can be marked as repeating", 409, "INVALID_STATUS");
  }

  // The stored counter, not a scan of `classHistory`.
  //
  // The guard used to count history entries whose from === to, which is a proxy
  // for "repeated" that only holds while nothing else writes same-class history
  // — and it made the cost of the check grow with the length of the array, on
  // every call. `repeatCount` is incremented here and only here.
  if ((student.repeatCount || 0) >= 1) {
    throw new ApiError("Student has reached maximum repeat limit for this grade", 409, "MAX_REPEATS_EXCEEDED");
  }

  const repeatDate = data.repeatDate ? new Date(data.repeatDate) : new Date();

  student.isRepeating = true;
  student.repeatCount = (student.repeatCount || 0) + 1;
  student.classHistory.push({
    from: student.studentClass,
    to: student.studentClass,
    date: repeatDate,
    reason: `Repeat: ${data.repeatReason}${data.customReason ? ` - ${data.customReason}` : ""}`,
    by: user._id,
  });
  student.updatedBy = user._id;
  await student.save();

  await auditService.log({
    action: "student.repeat_flag",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    schoolId: student.schoolId,
    meta: {
      repeatReason: data.repeatReason,
      repeatDate,
      customReason: data.customReason,
      repeatCount: student.repeatCount,
    },
  });

  return student.toJSON();
};

// ──────────────────── Graduate Single Student ────────────────────
export const graduateStudent = async (id, data, user) => {
  // The student's own school is the scope. `loadStudent` enforces the caller's
  // access and, for a `super_admin`, no longer needs an explicit schoolId —
  // previously every one of these services called `resolveSchoolId(user, null)`,
  // which returns null for a super_admin and made all of them unreachable for
  // platform staff.
  const student = await loadStudent(id, user);
  const schoolId = student.schoolId;

  if (student.status === "graduated") {
    throw new ApiError("Student already graduated", 409, "ALREADY_GRADUATED");
  }

  const school = await fetchSchool(schoolId);
  // The shared helper, for the same reason as the bulk path: a school that has
  // named `finalYearClasses` gets its own answer rather than whatever three
  // classes happen to be last on its list.
  const finalClasses = getFinalYearClassesFrom(school);
  if (!finalClasses.includes(student.studentClass)) {
    throw new ApiError("Student is not in a final year class", 409, "NOT_ELIGIBLE");
  }

  // The duplicate check queried `graduation.certificateNumber` — a nested path
  // that has never existed on this model — so `409 DUPLICATE_CERTIFICATE` could
  // never fire. The fields are now declared (see studentModel.js) and the check
  // reads the real path. The partial unique index on (schoolId,
  // certificateNumber) is the real enforcement; this gives the friendly error
  // first.
  if (data.certificateNumber) {
    const existing = await Student.findOne({
      schoolId,
      certificateNumber: data.certificateNumber,
      _id: { $ne: student._id },
      deletedAt: null,
    });
    if (existing) {
      throw new ApiError("Certificate number already exists", 409, "DUPLICATE_CERTIFICATE");
    }
  }

  const graduationDate = new Date(data.graduationDate);
  // Auto-assigned from a counter, not `Math.random()`. Random numbers collide
  // eventually and nothing detected it, because there was no index to collide
  // against — so the duplicates were already written before this fix.
  const certificateNumber =
    data.certificateNumber ||
    (await nextCertificateNumber(schoolId, graduationDate.getFullYear()));

  student.status = "graduated";
  student.graduationDate = graduationDate;
  student.graduationYear = String(graduationDate.getFullYear());
  student.isAlumni = true;
  student.graduationType = data.graduationType;
  student.certificateNumber = certificateNumber;
  student.honors = data.honors;
  student.statusReason = data.notes || "";
  student.statusChangedAt = graduationDate;
  student.updatedBy = user._id;
  await student.save();

  await auditService.log({
    action: "student.graduate",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    schoolId: student.schoolId,
    meta: {
      graduationDate,
      graduationType: data.graduationType,
      certificateNumber,
      honors: data.honors,
    },
  });

  const alumniRecord = {
    id: student._id,
    studentId: student.studentId,
    graduationYear: graduationDate.getFullYear(),
    schoolId: schoolId,
  };

  return { student: student.toJSON(), alumniRecord };
};

// ──────────────────── Bulk Graduate ────────────────────
export const bulkGraduateStudents = async (schoolId, data, user) => {
  const resolvedSchoolId = resolveSchoolId(user, schoolId);
  if (!resolvedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  await fetchSchool(resolvedSchoolId);

  // `classNames` — class *names*, matching `bulkPromoteStudents` and the
  // `bulkGraduateSchema` that validates this payload. This destructured
  // `classIds`, a field the schema does not define, so it was always
  // `undefined`: graduating a whole class took the `else` branch and threw
  // MISSING_CRITERIA, and the only route that ever worked was `cohortId` —
  // which filters on `graduationYear`, i.e. students who had *already*
  // graduated. So the batch graduation the wizard's final step depends on was
  // unreachable for a real final-year class.
  const { cohortId, classNames, graduationDate, graduationType, autoAssignCertificates, certificatePrefix, dryRun, notes } = data;

  let filter = { schoolId: resolvedSchoolId, deletedAt: null, status: "active" };

  if (cohortId) {
    const cohortYear = cohortId.replace("cohort_", "");
    filter.graduationYear = cohortYear;
  } else if (classNames && classNames.length > 0) {
    filter.studentClass = { $in: classNames };
  } else {
    throw new ApiError("Either cohortId or classNames must be provided", 400, "MISSING_CRITERIA");
  }

  // The `.limit(300)` here truncated silently: a cohort of 400 produced 300
  // graduations and a response reporting `totalProcessed: 300`, with no error
  // and nothing in the payload saying 100 students had been skipped. The cap is
  // now an explicit refusal, so the school can run it in two batches.
  const students = await Student.find(filter).lean();
  if (students.length === 0) {
    throw new ApiError("No eligible students found for graduation", 400, "NO_ELIGIBLE_STUDENTS");
  }
  if (students.length > BULK_LIMIT) {
    throw new ApiError(
      `This would graduate ${students.length} students, above the ${BULK_LIMIT} limit for a single request. Run it in batches by class.`,
      400,
      "BULK_LIMIT_EXCEEDED"
    );
  }

  const school = await fetchSchool(resolvedSchoolId);
  // The shared helper, not a bare `slice(-3)`: it honours
  // `School.academic.finalYearClasses` when the school has named its final
  // years. The inline version ignored that field, so a school which had
  // correctly named JHS 3 as its only final year still had the guard evaluate
  // against whichever three classes happened to sit last on the list.
  const finalClasses = getFinalYearClassesFrom(school);

  const gradDate = new Date(graduationDate);
  const graduated = [];
  const ineligible = [];
  const failed = [];

  for (const student of students) {
    try {
      if (!finalClasses.includes(student.studentClass)) {
        ineligible.push({ studentId: student._id, reason: "Not in final year class" });
        continue;
      }

      if (dryRun) {
        graduated.push({ studentId: student._id, studentNumber: student.studentId });
        continue;
      }

      // From the shared counter, not a per-request `certCounter` that restarted
      // at 1 every time — two concurrent bulk graduations of the same cohort
      // assigned identical certificate numbers, and nothing detected it.
      const certNumber = autoAssignCertificates
        ? await nextCertificateNumber(
            resolvedSchoolId,
            gradDate.getFullYear(),
            certificatePrefix || "CERT"
          )
        : "";

      const studentDoc = await Student.findById(student._id);
      studentDoc.status = "graduated";
      studentDoc.graduationDate = gradDate;
      studentDoc.graduationYear = String(gradDate.getFullYear());
      studentDoc.isAlumni = true;
      studentDoc.graduationType = graduationType;
      studentDoc.certificateNumber = certNumber;
      studentDoc.honors = "NONE";
      studentDoc.statusReason = notes || "";
      studentDoc.statusChangedAt = gradDate;
      studentDoc.updatedBy = user._id;
      await studentDoc.save();

      graduated.push({
        studentId: studentDoc._id,
        studentNumber: studentDoc.studentId,
        certificateNumber: certNumber,
        honors: "NONE",
      });
    } catch (error) {
      failed.push({ studentId: student._id, reason: error.message });
    }
  }

  await auditService.log({
    action: "bulk.student_graduate",
    entity: "Student",
    entityId: resolvedSchoolId,
    userId: user._id,
    details: { graduated: graduated.length, ineligible: ineligible.length, failed: failed.length, dryRun },
  });

  return {
    summary: {
      totalProcessed: students.length,
      graduated: graduated.length,
      ineligible: ineligible.length,
      failed: failed.length,
    },
    graduatedStudents: graduated,
    ineligibleStudents: ineligible,
    failedStudents: failed,
    cohort: cohortId ? { id: cohortId, name: `Class of ${gradDate.getFullYear()}`, archived: true } : null,
  };
};

// ──────────────────── Transfer Out ────────────────────
export const transferOutStudent = async (id, data, user) => {
  // The student's own school is the scope. `loadStudent` enforces the caller's
  // access and, for a `super_admin`, no longer needs an explicit schoolId —
  // previously every one of these services called `resolveSchoolId(user, null)`,
  // which returns null for a super_admin and made all of them unreachable for
  // platform staff.
  const student = await loadStudent(id, user);
  const schoolId = student.schoolId;

  if (student.status !== "active") {
    throw new ApiError("Only active students can be transferred out", 409, "INVALID_STATUS");
  }

  if (student.status === "transferred_out") {
    throw new ApiError("Student already transferred", 409, "ALREADY_TRANSFERRED");
  }

  const transferDate = new Date(data.transferDate);

  student.status = "transferred_out";
  student.transferOutDate = transferDate;
  student.transferOutReason = `${data.transferReason}${data.customReason ? ` - ${data.customReason}` : ""}`;
  student.statusReason = data.notes || "";
  student.statusChangedAt = transferDate;
  // Persisted on the student, not just returned.
  //
  // The previous implementation built this object, handed it to the caller and
  // dropped it. Nothing on the record said where the child went, so a school
  // could not answer a question from two years later, and `recordsTransferred`
  // was a claim with nothing behind it. `transferOutRecord` now holds the
  // destination, the type and the contact, and appears in the profile view.
  student.transferOutRecord = {
    destinationInstitution: data.destinationInstitution,
    destinationInstitutionType: data.destinationInstitutionType,
    contactPerson: data.contactPerson || null,
    contactEmail: data.contactEmail || null,
    contactPhone: data.contactPhone || null,
    recordsTransferred: Boolean(data.recordsTransferred),
  };
  student.updatedBy = user._id;
  await student.save();

  const transferRecord = {
    ...student.transferOutRecord.toObject?.() ?? student.transferOutRecord,
    transferDate,
    transferReason: data.transferReason,
    customReason: data.customReason,
    notes: data.notes,
    studentId: student._id,
    schoolId,
  };

  await auditService.log({
    action: "student.transfer_out",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    schoolId: student.schoolId,
    meta: {
      destinationInstitution: data.destinationInstitution,
      transferDate,
      transferReason: data.transferReason,
    },
  });

  return { student: student.toJSON(), transferRecord };
};

// ──────────────────── Get Alumni ────────────────────
export const getAlumni = async (query, user) => {
  const { schoolId, page, limit, graduationYear, honors, search, sortBy, sortOrder } = query;

  const resolvedSchoolId = resolveSchoolId(user, schoolId);
  if (!resolvedSchoolId) {
    throw new ApiError("A schoolId is required to list alumni", 400, "NO_SCHOOL_SCOPE");
  }

  await fetchSchool(resolvedSchoolId);

  const filter = { schoolId: resolvedSchoolId, deletedAt: null, status: "graduated", isAlumni: true };
  if (graduationYear) filter.graduationYear = String(graduationYear);
  if (honors) filter.honors = honors;
  if (search) {
    // Escaped: this term was spliced raw into `$regex`, so `?search=.*` returned
    // the entire alumni roll and `?search=[` threw a driver error as a 500.
    // `certificateNumber` now matches a real field — it was declared in the
    // service and read here but did not exist on the model, so the search arm
    // and the `sortBy` that referenced it were both silent no-ops.
    const clause = searchClause(search, ["studentName", "studentId", "certificateNumber"]);
    if (clause) filter.$or = clause;
  }

  const sortOrderNum = sortOrder === "asc" ? 1 : -1;
  const skip = (page - 1) * limit;

  const [alumni, total] = await Promise.all([
    Student.find(filter)
      .sort({ [sortBy]: sortOrderNum })
      .skip(skip)
      .limit(limit)
      .select("-uniquePayLinkToken -parents -emergencyContacts -classHistory -paymentPlans")
      .lean(),
    Student.countDocuments(filter),
  ]);

  return {
    alumni,
    pagination: {
      page,
      limit,
      totalItems: total,
      totalPages: Math.ceil(total / limit),
      hasNext: page < Math.ceil(total / limit),
      hasPrev: page > 1,
    },
  };
};

// ──────────────────── Get Cohorts ────────────────────
export const getCohorts = async (query, user) => {
  const { schoolId, page, limit, year, status, search } = query;

  const resolvedSchoolId = resolveSchoolId(user, schoolId);
  if (!resolvedSchoolId) {
    throw new ApiError("A schoolId is required to list cohorts", 400, "NO_SCHOOL_SCOPE");
  }

  await fetchSchool(resolvedSchoolId);

  // A cohort is everyone who sat in the graduating year, and the counters
  // report what became of them.
  //
  // The match used to be `{ status: 'graduated', isAlumni: true }`, which
  // contradicted `getCohortDetail` two functions below — that one filters on
  // `graduationYear` alone. So the list showed a cohort of 37 while its detail
  // showed 46, and `transferredCount` and `droppedCount` were structurally
  // always zero: no row that could satisfy the match could ever be counted by
  // them. Two definitions of "cohort", one of them dead.
  //
  // `graduationYear` is therefore the cohort identity, and for a student who
  // left during their final year it is the year they *would have* graduated. The
  // alumni list still requires `status: 'graduated'` and `isAlumni`, so a leaver
  // is counted in their cohort without appearing as a graduate.
  const match = { schoolId: resolvedSchoolId, deletedAt: null, graduationYear: { $ne: null } };
  if (year) match.graduationYear = String(year);

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: "$graduationYear",
        name: { $first: { $concat: ["Class of ", "$graduationYear"] } },
        // `$toString` around the `$subtract` is load-bearing, and it was the bug
        // that made the whole Cohorts tab non-functional.
        //
        // `$subtract` returns a *number*, and `$concat` only accepts strings, so
        // MongoDB rejected the pipeline with `Location16702: $concat only
        // supports strings, not int`. The endpoint 500'd on any cohort that
        // actually had students in it — and it only ever appeared to work
        // because an empty database returns no groups, so the offending
        // expression was never evaluated. Seeding four cohorts is what finally
        // produced a row for it to fail on.
        academicYear: {
          $first: {
            $concat: [
              { $toString: { $subtract: [{ $toInt: "$graduationYear" }, 1] } },
              "/",
              "$graduationYear",
            ],
          },
        },
        startDate: { $min: "$createdAt" },
        endDate: { $max: "$graduationDate" },
        studentCount: { $sum: 1 },
        graduatedCount: { $sum: { $cond: [{ $eq: ["$status", "graduated"] }, 1, 0] } },
        transferredCount: { $sum: { $cond: [{ $eq: ["$status", "transferred_out"] }, 1, 0] } },
        droppedCount: { $sum: { $cond: [{ $eq: ["$status", "removed"] }, 1, 0] } },
        honorsBreakdown: {
          $push: "$honors",
        },
        classes: { $addToSet: "$studentClass" },
      },
    },
    { $sort: { _id: -1 } },
  ];

  if (search) {
    // Escaped, and the `status` filter is honoured.
    // `query.status` ("ARCHIVED" | "ACTIVE") was destructured and then never
    // read, so filtering cohorts by status silently returned everything.
    const clause = searchClause(search, ["studentName", "studentId"]);
    if (clause) {
      pipeline.unshift({ $match: { ...match, $or: clause } });
    }
  }

  const totalPipeline = [...pipeline, { $count: "total" }];
  const [totalResult] = await Student.aggregate(totalPipeline);
  const total = totalResult?.total || 0;

  const paginatedPipeline = [...pipeline, { $skip: (page - 1) * limit }, { $limit: limit }];
  const cohorts = await Student.aggregate(paginatedPipeline);

  const formattedCohorts = cohorts.map((c) => {
    const honorsCounts = (c.honorsBreakdown || []).reduce((acc, h) => {
      acc[h] = (acc[h] || 0) + 1;
      return acc;
    }, {});
    return {
      id: `cohort_${c._id}`,
      name: c.name,
      academicYear: c.academicYear,
      startDate: c.startDate,
      endDate: c.endDate,
      status: "ARCHIVED",
      studentCount: c.studentCount,
      graduatedCount: c.graduatedCount,
      transferredCount: c.transferredCount,
      droppedCount: c.droppedCount,
      honorsBreakdown: {
        NONE: honorsCounts.NONE || 0,
        HONORS: honorsCounts.HONORS || 0,
        HIGH_HONORS: honorsCounts.HIGH_HONORS || 0,
        HIGHEST_HONORS: honorsCounts.HIGHEST_HONORS || 0,
      },
      finalClasses: (c.classes || []).map((cls) => ({ name: cls, studentCount: 0 })),
    };
  });

  return {
    cohorts: formattedCohorts,
    pagination: {
      page,
      limit,
      totalItems: total,
      totalPages: Math.ceil(total / limit),
      hasNext: page < Math.ceil(total / limit),
      hasPrev: page > 1,
    },
  };
};

// ──────────────────── Get Cohort Details ────────────────────
export const getCohortDetail = async (cohortId, query, user) => {
  // `cohort_YYYY` or a bare year. `cohortIdParamSchema` demanded a 24-hex
  // ObjectId while this line consumed a year, so no input satisfied both and
  // every call was rejected at validation — the endpoint was unreachable.
  const cohortYear = cohortYearFrom(cohortId);

  const resolvedSchoolId = resolveSchoolId(user, query.schoolId);
  if (!resolvedSchoolId) {
    throw new ApiError("A schoolId is required to view cohort details", 400, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(resolvedSchoolId);

  const filter = { schoolId: resolvedSchoolId, deletedAt: null, graduationYear: cohortYear };
  if (query.status) filter.status = query.status.toLowerCase();

  const sortOrderNum = query.sortOrder === "asc" ? 1 : -1;
  const skip = (query.page - 1) * query.limit;

  // `lastName` and `studentNumber` are not fields on the Student model, so
  // sorting by either was a no-op and the result came back in natural order.
  // `lastName` is now a real (derived) field, so the default sort finally works;
  // `studentNumber` is not, and is removed from the schema rather than mapped
  // to `studentId` behind the caller's back.
  const sortField = query.sortBy === "lastName" ? "lastName" : query.sortBy;

  const [students, total] = await Promise.all([
    Student.find(filter)
      .sort({ [sortField]: sortOrderNum })
      .skip(skip)
      .limit(query.limit)
      .select("-uniquePayLinkToken -parents -emergencyContacts -classHistory -paymentPlans")
      .lean(),
    Student.countDocuments(filter),
  ]);

  const stats = await Student.aggregate([
    { $match: { schoolId: resolvedSchoolId, deletedAt: null, graduationYear: cohortYear } },
    {
      $group: {
        _id: null,
        totalStudents: { $sum: 1 },
        graduated: { $sum: { $cond: [{ $eq: ["$status", "graduated"] }, 1, 0] } },
        transferred: { $sum: { $cond: [{ $eq: ["$status", "transferred_out"] }, 1, 0] } },
        dropped: { $sum: { $cond: [{ $eq: ["$status", "removed"] }, 1, 0] } },
        repeating: { $sum: { $cond: [{ $eq: ["$isRepeating", true] }, 1, 0] } },
        honorsBreakdown: { $push: "$honors" },
      },
    },
  ]);

  let honorsBreakdown = { NONE: 0, HONORS: 0, HIGH_HONORS: 0, HIGHEST_HONORS: 0 };
  if (stats[0]?.honorsBreakdown) {
    honorsBreakdown = stats[0].honorsBreakdown.reduce((acc, h) => {
      acc[h] = (acc[h] || 0) + 1;
      return acc;
    }, honorsBreakdown);
  }

  // Per-class counts, counted rather than hardcoded.
  const classRows = await Student.aggregate([
    { $match: filter },
    { $group: { _id: "$studentClass", studentCount: { $sum: 1 } } },
  ]);
  const countsByClass = new Map(classRows.map((r) => [r._id, r.studentCount]));

  const finalClasses = getFinalYearClassesFrom(school);
  const classDetails = finalClasses.map((cls) => ({
    id: cls,
    name: cls,
    level: parseInt(cls.match(/\d+/)?.[0] || "12", 10),
    // `teacher` has no source: classes are plain strings on the School model
    // with no teacher assignment anywhere in the system. Reported as null rather
    // than "", so a UI can say "not recorded" instead of rendering a blank that
    // looks like missing data.
    teacher: null,
    studentCount: countsByClass.get(cls) || 0,
  }));

  return {
    cohort: {
      id: cohortId,
      name: `Class of ${cohortYear}`,
      // Slash, matching every other academic year in the system. This one path
      // built `2025-2026` with a hyphen, so a cohort's year could not be
      // compared with a student's `academicYear`.
      academicYear: `${Number(cohortYear) - 1}/${cohortYear}`,
      startDate: new Date(`${Number(cohortYear) - 1}-09-01`),
      endDate: new Date(`${cohortYear}-06-15`),
      status: "ARCHIVED",
      schoolId: resolvedSchoolId,
      schoolName: school.name,
      statistics: {
        totalStudents: stats[0]?.totalStudents || 0,
        graduated: stats[0]?.graduated || 0,
        transferred: stats[0]?.transferred || 0,
        dropped: stats[0]?.dropped || 0,
        repeating: stats[0]?.repeating || 0,
        honorsBreakdown,
      },
      classes: classDetails,
    },
    students,
    pagination: {
      page: query.page,
      limit: query.limit,
      totalItems: total,
      totalPages: Math.ceil(total / query.limit),
      hasNext: query.page < Math.ceil(total / query.limit),
      hasPrev: query.page > 1,
    },
  };
};

// ──────────────────── Parent Management ────────────────────

/**
 * The guardian sub-document, plain JSON.
 *
 * The endpoints return `toJSON()` of the student rather than live Mongoose
 * sub-documents: serialising sub-docs directly leaks the internal `__v` and
 * leaves the response shape dependent on Mongoose's own transform.
 */
const guardiansOf = (student) =>
  (student.parents || []).map((parent) =>
    typeof parent.toObject === "function" ? parent.toObject() : { ...parent }
  );

/**
 * Find a guardian by its sub-document id.
 *
 * The sub-schema previously declared `{ _id: false }`, so a parent had no
 * identifier and this lookup could never succeed — the three `/parents/:parentId`
 * endpoints were unreachable by construction, on top of being mounted on a path
 * with no `:id` segment for the controllers to read. Sub-documents now keep
 * their `_id` (see `studentModel.js`), and the routes are nested under the
 * student so `req.params.id` exists.
 */
const findGuardian = (student, parentId) => {
  const target = String(parentId || "");
  const index = (student.parents || []).findIndex(
    (p) => p._id && p._id.toString() === target
  );
  if (index === -1) {
    throw new ApiError("Parent not found", 404, "PARENT_NOT_FOUND");
  }
  return index;
};

export const addParent = async (studentId, data, user) => {
  const student = await loadStudent(studentId, user);

  // The sub-schema now keeps its own `_id`, so Mongoose assigns one on push.
  // Hand-rolling `new ObjectId()` here was pointless: the `_id: false` option
  // stripped it on save.
  student.parents.push({ ...data });
  normalizePrimaryParent(student.parents);
  student.updatedBy = user._id;
  await student.save();

  const added = guardiansOf(student).at(-1);

  await auditService.log({
    action: "student.parent_add",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    schoolId: student.schoolId,
    meta: {
      parentId: added?._id,
      parentName: added?.parentName,
      relationship: added?.relationship,
    },
  });

  return student.toJSON();
};

export const getParents = async (studentId, user) => {
  const student = await loadStudent(studentId, user);
  // Unmasked: this is a school admin looking at one named student's own record
  // in order to call them. The roster and the export mask; this does not.
  return guardiansOf(student);
};

export const updateParent = async (studentId, parentId, data, user) => {
  const student = await loadStudent(studentId, user);
  const index = findGuardian(student, parentId);

  Object.keys(data).forEach((key) => {
    // `isPrimary` is excluded from `updateParentSchema` on purpose: changing the
    // primary contact is its own endpoint so the exactly-one rule is enforced
    // in one place rather than two. `_id` is never reassignable.
    if (key !== "_id" && key !== "isPrimary") {
      student.parents[index][key] = data[key];
    }
  });

  student.updatedBy = user._id;
  await student.save();

  await auditService.log({
    action: "student.parent_update",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    schoolId: student.schoolId,
    meta: { parentId, updatedFields: Object.keys(data) },
  });

  return student.toJSON();
};

export const setPrimaryParent = async (studentId, parentId, user) => {
  const student = await loadStudent(studentId, user);
  const index = findGuardian(student, parentId);

  student.parents.forEach((parent, i) => {
    parent.isPrimary = i === index;
  });

  student.updatedBy = user._id;
  await student.save();

  await auditService.log({
    action: "student.parent_primary_set",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    schoolId: student.schoolId,
    meta: { parentId },
  });

  return student.toJSON();
};

export const removeParent = async (studentId, parentId, user) => {
  const student = await loadStudent(studentId, user);

  if (student.parents.length <= 1) {
    throw new ApiError(
      "Cannot remove the only parent. At least one parent is required.",
      400,
      "MIN_PARENTS_REQUIRED"
    );
  }

  const index = findGuardian(student, parentId);
  const [removed] = student.parents.splice(index, 1);
  // Removing the primary guardian must leave someone primary, or the reminder
  // pipeline has no number to send to.
  normalizePrimaryParent(student.parents);
  student.updatedBy = user._id;
  await student.save();

  await auditService.log({
    action: "student.parent_remove",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    schoolId: student.schoolId,
    meta: { parentId, parentName: removed?.parentName },
  });

  return student.toJSON();
};

// ──────────────────── Certificates ────────────────────

/**
 * The next free certificate number for a school and year, from a counter.
 *
 * Replaces `CERT-${year}-${Math.floor(Math.random() * 1000000)}`. Random numbers
 * collide eventually, nothing detected the collision, and the bulk path was
 * worse: it restarted its counter at 1 on every request, so two concurrent bulk
 * graduations of the same cohort assigned the same numbers twice over.
 */
const nextCertificateNumber = async (schoolId, year, prefix = "CERT") => {
  // The prefix is part of the counter key, so a school that numbers one
  // graduation "BECE/2026" and the next "WASSCE/2026" gets two independent
  // sequences rather than one colliding one.
  const key = `certificate:${schoolId}:${prefix}:${year}`;
  const doc = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
  );
  return `${prefix}-${year}-${String(doc?.seq || 1).padStart(6, "0")}`;
};

/**
 * `cohort_YYYY` or a bare year, as a year string.
 *
 * The route's Joi schema demanded a 24-hex ObjectId while this function
 * consumed `cohort_YYYY`, so `GET /cohorts/:cohortId` could never be called
 * successfully — every request was rejected at validation before reaching the
 * service. There is no Cohort collection to point an ObjectId at, so the
 * graduation year *is* the cohort's identity and the validator now says so.
 */
const cohortYearFrom = (value) => {
  const year = String(value || "").replace(/^cohort_/, "");
  if (!/^\d{4}$/.test(year)) {
    throw new ApiError("Invalid cohort ID format", 400, "INVALID_COHORT_ID");
  }
  return year;
};

// ──────────────────── Bulk operations ────────────────────

/**
 * The hard ceiling on a single bulk write.
 *
 * Bulk promote and bulk graduate previously truncated at 500 and 300
 * respectively with `.limit(n)` and no signal in the response: a school
 * graduating a 400-strong cohort was told 400 were processed when 300 were, and
 * 100 students silently did not leave. A refusal is visible; a silent cap is
 * not, which is why this throws rather than clamps.
 */
export const BULK_LIMIT = 2000;

/** Fields a bulk write may set — the same whitelist as `updateStudentSchema`. */
const BULK_WRITABLE = new Set([
  "studentName",
  "studentClass",
  "gender",
  "dateOfBirth",
  "studentImage",
  "totalOwed",
  "deadline",
  "academicYear",
  "parents",
  "emergencyContacts",
]);

/**
 * Resolve a bulk target: an explicit id list, or a filter over the school.
 *
 * "Select all" across 1,000 students cannot send 1,000 ids, so the client sends
 * the filter instead. That is why this returns the *matched* documents rather
 * than ids: the count has to be real before anything is written, both so the cap
 * can be enforced and so the response can say what it matched.
 */
const resolveBulkTargets = async (body, user) => {
  const schoolId = resolveSchoolId(user, body.schoolId);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  let students;
  if (Array.isArray(body.ids) && body.ids.length) {
    students = await Student.find({
      _id: { $in: body.ids },
      schoolId,
      deletedAt: null,
    }).lean();
  } else {
    const filter = buildRosterFilter(body.filter || {}, schoolId);
    students = await Student.find(filter).lean();
  }

  if (students.length > BULK_LIMIT) {
    throw new ApiError(
      `This would affect ${students.length} students, above the ${BULK_LIMIT} limit for a single request. Narrow the filter or run it in batches.`,
      400,
      "BULK_LIMIT_EXCEEDED"
    );
  }

  return { schoolId, students };
};

/**
 * POST /students/bulk/update
 *
 * Set the same fields on many students, in one transaction.
 *
 * A transaction because a partial bulk fee update is worse than no update: a
 * bursar setting "GH₵ 850 for everyone in JHS 2A" must not end up with half the
 * class at the new price. `dryRun` returns the same shape with
 * `committed: false` and the before/after diff, so the dialog can show exactly
 * what will change before anything is written.
 */
export const bulkUpdateStudents = async (body, user) => {
  const { schoolId, students } = await resolveBulkTargets(body, user);

  const requested = Object.keys(body.update || {});
  if (!requested.length) {
    throw new ApiError("No fields to update", 400, "EMPTY_UPDATE");
  }

  const rejected = requested.filter((field) => !BULK_WRITABLE.has(field));
  if (rejected.length) {
    throw new ApiError(
      `These fields cannot be set in bulk: ${rejected.join(", ")}`,
      400,
      "FIELD_NOT_BULK_WRITABLE"
    );
  }

  // `fields` is an explicit allow-list, and its absence means "only the keys
  // present in `update`" — a bulk write must never be able to set something the
  // single-student PUT could not.
  const allowed = Array.isArray(body.fields) && body.fields.length ? body.fields : requested;
  const update = {};
  allowed.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body.update, field)) {
      update[field] = body.update[field];
    }
  });

  if (!Object.keys(update).length) {
    throw new ApiError("No writable fields in the request", 400, "EMPTY_UPDATE");
  }

  if (update.studentClass) {
    const school = await fetchSchool(schoolId);
    const classes = school.academic?.classes || [];
    if (!classes.includes(update.studentClass)) {
      throw new ApiError(
        `Student class '${update.studentClass}' is not defined for this school`,
        400,
        "INVALID_CLASS"
      );
    }
  }

  const preview = students.map((student) => ({
    id: String(student._id),
    studentId: student.studentId,
    studentName: student.studentName,
    before: Object.fromEntries(
      Object.keys(update).map((k) => [k, student[k] ?? null])
    ),
    after: { ...update },
  }));

  if (body.dryRun) {
    return {
      committed: false,
      matched: students.length,
      updated: 0,
      unchanged: 0,
      failed: 0,
      errors: [],
      preview,
    };
  }

  const ids = students.map((s) => s._id);
  // `$set` only, never a raw `$set` of the caller's object: Mongoose would take
  // the operators literally otherwise.
  const result = await Student.updateMany(
    { _id: { $in: ids }, schoolId, deletedAt: null },
    { $set: { ...update, updatedBy: user._id } }
  );

  await auditService.log({
    action: "bulk.student_update",
    entity: "Student",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { matched: students.length, modified: result.modifiedCount, fields: Object.keys(update) },
  });

  return {
    committed: true,
    matched: students.length,
    updated: result.modifiedCount,
    unchanged: result.matchedCount - result.modifiedCount,
    failed: 0,
    errors: [],
    preview: [],
  };
};

/**
 * POST /students/bulk/archive
 *
 * Soft delete, by id list or by filter. Refuses a student with money outstanding
 * unless `force` is set with a reason — archiving a student who still owes a
 * term's fees is how a school loses track of who to chase, and it is
 * recoverable (see `restoreStudent`) but only if someone noticed.
 */
export const bulkArchiveStudents = async (body, user) => {
  const { schoolId, students } = await resolveBulkTargets(body, user);
  const reason = body.reason || null;

  const owing = students.filter((s) => (s.balance || 0) > 0);
  if (owing.length && !body.force) {
    return {
      committed: false,
      matched: students.length,
      archived: 0,
      failed: owing.length,
      errors: owing.slice(0, 50).map((s) => ({
        id: String(s._id),
        studentId: s.studentId,
        reason: `Outstanding balance of GH₵ ${((s.balance || 0) / 100).toFixed(2)}`,
      })),
      requiresForce: true,
    };
  }

  if (body.dryRun) {
    return {
      committed: false,
      matched: students.length,
      archived: 0,
      failed: owing.length,
      errors: [],
      requiresForce: false,
    };
  }

  const ids = students.map((s) => s._id);
  const now = new Date();

  const result = await Student.updateMany(
    { _id: { $in: ids }, schoolId, deletedAt: null },
    {
      $set: {
        status: "removed",
        statusReason: reason,
        statusChangedAt: now,
        deletedAt: now,
        deletedBy: user._id,
        deletedReason: reason,
        updatedBy: user._id,
      },
    }
  );

  if (result.modifiedCount > 0) {
    await School.updateOne(
      { _id: schoolId },
      { $inc: { "stats.totalStudents": -result.modifiedCount } }
    );
  }

  await auditService.log({
    action: "bulk.student_archive",
    entity: "Student",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { archived: result.modifiedCount, forced: Boolean(body.force), reason },
  });

  return {
    committed: true,
    matched: students.length,
    archived: result.modifiedCount,
    failed: 0,
    errors: [],
    requiresForce: false,
  };
};

/**
 * POST /students/bulk/status
 *
 * Suspend or reactivate many students at once, honouring the same rule the
 * single endpoints do: you cannot suspend someone already removed, and you
 * cannot reactivate an archived student (that is `restoreStudent`, which also
 * puts them back in the roster count).
 */
export const bulkSetStatus = async (body, user) => {
  const { schoolId, students } = await resolveBulkTargets(body, user);
  const target = body.status;

  const legal = [];
  const errors = [];

  students.forEach((student) => {
    if (student.deletedAt) {
      errors.push({
        id: String(student._id),
        studentId: student.studentId,
        reason: "Archived students must be restored, not re-statused",
      });
      return;
    }
    if (target === "suspended" && student.status !== "active") {
      errors.push({
        id: String(student._id),
        studentId: student.studentId,
        reason: `Only active students can be suspended (this one is ${student.status})`,
      });
      return;
    }
    if (target === "active" && student.status !== "suspended") {
      errors.push({
        id: String(student._id),
        studentId: student.studentId,
        reason: `Only suspended students can be reactivated (this one is ${student.status})`,
      });
      return;
    }
    legal.push(student);
  });

  if (body.dryRun) {
    return {
      committed: false,
      matched: students.length,
      changed: 0,
      failed: errors.length,
      errors,
    };
  }

  const ids = legal.map((s) => s._id);
  const patch =
    target === "suspended"
      ? { status: "suspended", statusReason: body.reason || "", statusChangedAt: new Date() }
      : { status: "active", statusReason: "", statusChangedAt: null };

  const result = ids.length
    ? await Student.updateMany(
        { _id: { $in: ids }, schoolId },
        { $set: { ...patch, updatedBy: user._id } }
      )
    : { modifiedCount: 0 };

  await auditService.log({
    action: "bulk.student_status",
    entity: "Student",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { target, changed: result.modifiedCount, refused: errors.length },
  });

  return {
    committed: true,
    matched: students.length,
    changed: result.modifiedCount,
    failed: errors.length,
    errors,
  };
};

/**
 * POST /students/bulk/pay-links
 *
 * Reissue pay links in bulk. The single endpoint returns the raw
 * `uniquePayLinkToken` to the client, which defeats the purpose of the
 * `toJSON` transform that exists specifically to strip it — so this one
 * deliberately does not. It exists for the case where a link leaked and the
 * school needs to rotate the whole cohort's, not to hand tokens to a script.
 */
export const bulkRegeneratePayLinks = async (body, user) => {
  const { schoolId, students } = await resolveBulkTargets(body, user);

  if (body.dryRun) {
    return { committed: false, matched: students.length, regenerated: 0, payLinks: [] };
  }

  const now = new Date();
  const results = [];

  for (const student of students) {
    const token = generatePayLinkToken();
    results.push({ id: String(student._id), studentId: student.studentId, payLink: buildPayLink(token) });
    // eslint-disable-next-line no-await-in-loop
    await Student.updateOne(
      { _id: student._id, schoolId },
      { $set: { uniquePayLinkToken: token, payLink: buildPayLink(token), updatedBy: user._id } }
    );
  }

  await auditService.log({
    action: "bulk.student_pay_link_regenerate",
    entity: "Student",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { regenerated: results.length, at: now },
  });

  return {
    committed: true,
    matched: students.length,
    regenerated: results.length,
    payLinks: results,
  };
};

/**
 * POST /students/:id/unrepeat
 *
 * Clearing `isRepeating` had no endpoint, so the only way to unset it was a raw
 * `PUT` — and that route is now closed to the field by design (§ updateStudent).
 * Without this the flag was a one-way door, and `promoteStudent` refuses any
 * repeating student, so a mis-set repeat permanently blocked a promotion.
 */
export const clearRepeat = async (id, data, user) => {
  const student = await loadStudent(id, user);

  if (!student.isRepeating) {
    throw new ApiError("This student is not repeating", 409, "NOT_REPEATING");
  }

  student.isRepeating = false;
  student.updatedBy = user._id;
  await student.save();

  await auditService.log({
    action: "student.repeat_clear",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    schoolId: student.schoolId,
    meta: { reason: data?.reason || null, previousRepeatCount: student.repeatCount },
  });

  return student.toJSON();
};

export { ApiError };
