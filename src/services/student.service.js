import mongoose from "mongoose";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import {
  generateStudentId,
  resolveAcademicYearStart,
  normalizeAcademicYear,
} from "../utils/generateStudentId.js";
import {
  generatePayLinkToken,
  buildPayLink,
} from "../utils/generatePayLink.js";
import { parseImportFile } from "../utils/csvParser.js";
import { createStudentSchema } from "../validations/student.validation.js";

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

// Stub audit service — mirrors school.service.js. Swap for a real
// implementation (DB-backed audit log) when the audit module is added.
const auditService = {
  log: async ({ action, entity, entityId, userId, details }) => {
    console.log(`[AUDIT] ${action} | ${entity}:${entityId} | User:${userId} |`, details);
  },
};

// ──────────────────── Helpers ────────────────────

const resolveSchoolId = (user, explicitSchoolId) => {
  if (user && user.role === "super_admin") {
    return explicitSchoolId ? new mongoose.Types.ObjectId(explicitSchoolId) : null;
  }
  return user && user.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

const fetchSchool = async (schoolId) => {
  const school = await School.findById(schoolId)
    .select("schoolCode slug name academic")
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

  // Retry on rare duplicate-key collisions (counter race across concurrent
  // creates). The pre-save hook is a safety net; we generate ids here so we
  // can retry and keep generation deterministic in the service layer.
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

  await auditService.log({
    action: "CREATE",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { studentId: student.studentId, schoolId },
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
  const defaultOwedPesewas = meta.defaultOwed ? toPesewas(meta.defaultOwed) : null;

  const errors = [];
  const validDocs = [];

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

    const totalOwed = row.totalowed
      ? toPesewas(row.totalowed)
      : defaultOwedPesewas;

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
    value.studentId = await generateStudentId(schoolCode, year);
    value.schoolId = schoolId;
    value.createdBy = user._id;
    value.totalPaid = 0;
    normalizePrimaryParent(value.parents);
    value.balance = (Number(value.totalOwed) || 0) - (Number(value.totalPaid) || 0);

    validDocs.push(value);
  }

  let created = 0;
  if (validDocs.length > 0) {
    // ordered:false so one bad row doesn't abort the whole batch.
    const inserted = await Student.insertMany(validDocs, { ordered: false });
    created = inserted.length;
    await School.updateOne(
      { _id: schoolId },
      { $inc: { "stats.totalStudents": created } }
    );
  }

  await auditService.log({
    action: "BULK_CREATE",
    entity: "Student",
    entityId: schoolId,
    userId: user._id,
    details: { created, failed: errors.length, format },
  });

  return { created, failed: errors.length, errors, format };
};

// ──────────────────── List ────────────────────
export const listStudents = async (query, user) => {
  const schoolId = resolveSchoolId(user, query.schoolId);
  if (!schoolId) {
    throw new ApiError(
      "A schoolId is required to list students",
      400,
      "NO_SCHOOL_SCOPE"
    );
  }

  const filter = { schoolId, deletedAt: null };
  if (query.status && query.status !== "all") filter.status = query.status;
  if (query.class) filter.studentClass = query.class;
  if (query.search) {
    filter.$or = [
      { studentName: { $regex: query.search, $options: "i" } },
      { studentId: { $regex: query.search, $options: "i" } },
      { "parents.parentName": { $regex: query.search, $options: "i" } },
      { "parents.phone": { $regex: query.search, $options: "i" } },
    ];
  }

  const sortBy = query.sortBy || "createdAt";
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;
  const skip = (Number(query.page) - 1) * Number(query.perPage);

  const [students, total] = await Promise.all([
    Student.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(Number(query.perPage)),
    Student.countDocuments(filter),
  ]);

  const data = students.map((student) => maskStudentList(student.toJSON()));

  return {
    data,
    meta: {
      page: Number(query.page),
      perPage: Number(query.perPage),
      total,
      totalPages: Math.ceil(total / Number(query.perPage)),
    },
  };
};

// ──────────────────── Get by id ────────────────────
export const getStudentById = async (id, user) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError(
      "A schoolId is required to view a student",
      400,
      "NO_SCHOOL_SCOPE"
    );
  }

  const student = await Student.findOne({ _id: id, schoolId: schoolId, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  return student.toJSON();
};

// ──────────────────── Update ────────────────────
export const updateStudent = async (id, data, user) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError(
      "A schoolId is required to update a student",
      400,
      "NO_SCHOOL_SCOPE"
    );
  }

  const student = await Student.findOne({ _id: id, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

  const protectedFields = [
    "studentId",
    "uniquePayLinkToken",
    "payLink",
    "totalPaid",
    "balance",
    "createdBy",
    "deletedAt",
    "schoolId",
    "__v",
  ];

  const updates = { ...data };
  protectedFields.forEach((field) => delete updates[field]);
  // updatedBy is server-set (after stripping protected fields).
  updates.updatedBy = user._id;

  if (updates.studentClass && updates.studentClass !== student.studentClass) {
    const school = await fetchSchool(schoolId);
    const classes = school.academic?.classes || [];
    if (!classes.includes(updates.studentClass)) {
      throw new ApiError(
        `Student class '${updates.studentClass}' is not defined for this school`,
        400,
        "INVALID_CLASS"
      );
    }
  }

  Object.keys(updates).forEach((key) => {
    student[key] = updates[key];
  });

  await student.save();

  await auditService.log({
    action: "UPDATE",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { updatedFields: Object.keys(updates) },
  });

  return student.toJSON();
};

// ──────────────────── Soft delete (shared) ────────────────────
// Never hard delete. Payment/plan records are preserved.
const archiveStudent = async (id, schoolId, user) => {
  const student = await Student.findOne({ _id: id, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

  student.status = "removed";
  student.deletedAt = new Date();
  await student.save();

  await auditService.log({
    action: "REMOVE",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: {},
  });

  return student;
};

// DELETE /students/:id
export const deleteStudent = async (id, user) => {
  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  await archiveStudent(id, schoolId, user);
  return { message: "Student removed" };
};

// PUT /students/:id/remove  — same operation, separate endpoint
export const removeStudent = async (id, user) => {
  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  await archiveStudent(id, schoolId, user);
  return { message: "Student archived" };
};

// ──────────────────── Suspend / Reactivate ────────────────────
export const suspendStudent = async (id, reason, user) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const student = await Student.findOne({ _id: id, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

  student.status = "suspended";
  student.statusReason = reason;
  student.statusChangedAt = new Date();
  await student.save();

  await auditService.log({
    action: "SUSPEND",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { reason },
  });

  return student.toJSON();
};

export const reactivateStudent = async (id, user) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const student = await Student.findOne({ _id: id, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

  student.status = "active";
  student.statusReason = "";
  student.statusChangedAt = null;
  await student.save();

  await auditService.log({
    action: "REACTIVATE",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: {},
  });

  return student.toJSON();
};

// ──────────────────── Transfer class ────────────────────
export const transferStudentClass = async (id, newClass, reason, user) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const student = await Student.findOne({ _id: id, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

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
    action: "TRANSFER_CLASS",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { from: student.classHistory[student.classHistory.length - 1].from, to: newClass },
  });

  return student.toJSON();
};

// ──────────────────── Regenerate pay link ────────────────────
export const regeneratePayLink = async (id, user, { notify = false } = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const student = await Student.findOne({ _id: id, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

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
    action: "REGENERATE_PAY_LINK",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { notified: Boolean(notify) },
  });

  return { payLink: student.payLink, token: student.uniquePayLinkToken };
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

  const filter = { schoolId, deletedAt: null };
  if (query.status && query.status !== "all") filter.status = query.status;
  if (query.class) filter.studentClass = query.class;
  if (query.search) {
    filter.$or = [
      { studentName: { $regex: query.search, $options: "i" } },
      { studentId: { $regex: query.search, $options: "i" } },
    ];
  }

  const students = await Student.find(filter)
    .sort({ createdAt: -1 })
    .select("-uniquePayLinkToken -__v")
    .lean();

  const slug = school.slug || school.schoolCode || "students";
  const dateStr = new Date().toISOString().slice(0, 10);
  const extension = format === "xlsx" ? "xlsx" : "csv";
  const filename = `students-${slug}-${dateStr}.${extension}`;

  const rows = students.map((student) => {
    const primaryParent = (student.parents || []).find((p) => p.isPrimary) || student.parents?.[0];
    return {
      studentId: student.studentId,
      studentName: student.studentName,
      studentClass: student.studentClass,
      gender: student.gender,
      status: student.status,
      totalOwed: student.totalOwed,
      totalPaid: student.totalPaid,
      balance: student.balance,
      deadline: student.deadline ? new Date(student.deadline).toISOString().slice(0, 10) : "",
      parentName: primaryParent?.parentName || "",
      parentPhone: primaryParent?.phone || "",
      payLink: student.payLink || "",
    };
  });

  if (format === "xlsx") {
    // lazy import keeps xlsx loaded only for Excel exports
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Students");
    const content = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    return {
      filename,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content,
    };
  }

  const columns = Object.keys(rows[0] || {});
  const header = columns.map(escapeCsv).join(",");
  const body = rows
    .map((row) => columns.map((c) => escapeCsv(row[c])).join(","))
    .join("\n");

  return {
    filename,
    mimeType: "text/csv",
    content: `${header}\n${body}`,
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

const getFinalYearClasses = async (schoolId) => {
  const school = await fetchSchool(schoolId);
  const classes = school.academic?.classes || [];
  return classes.slice(-3);
};

// ──────────────────── Promote Single Student ────────────────────
export const promoteStudent = async (id, data, user) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const student = await Student.findOne({ _id: id, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

  if (student.status !== "active") {
    throw new ApiError("Only active students can be promoted", 409, "INVALID_STATUS");
  }

  if (student.isRepeating) {
    throw new ApiError("Repeating students cannot be promoted until repeat period ends", 409, "STUDENT_REPEATING");
  }

  let targetClass = data.targetClassId;
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
    action: "PROMOTE",
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

  const { classIds, gradeLevels, studentIds, promotionDate, dryRun, notes } = data;

  let filter = { schoolId: resolvedSchoolId, deletedAt: null, status: "active", isRepeating: false };

  if (studentIds && studentIds.length > 0) {
    filter._id = { $in: studentIds.map((id) => new mongoose.Types.ObjectId(id)) };
  } else if (classIds && classIds.length > 0) {
    filter.studentClass = { $in: classIds };
  } else if (gradeLevels && gradeLevels.length > 0) {
    const school = await fetchSchool(resolvedSchoolId);
    const classes = school.academic?.classes || [];
    const matchingClasses = classes.filter((cls) => gradeLevels.some((g) => cls.includes(String(g))));
    if (matchingClasses.length === 0) {
      throw new ApiError("No classes found for specified grade levels", 400, "NO_CLASSES_MATCHED");
    }
    filter.studentClass = { $in: matchingClasses };
  }

  const students = await Student.find(filter).limit(500).lean();
  if (students.length === 0) {
    throw new ApiError("No students matched the provided criteria", 400, "NO_STUDENTS_MATCHED");
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
        failed.push({ studentId: student._id, reason: "No next level defined" });
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
    action: "BULK_PROMOTE",
    entity: "Student",
    entityId: resolvedSchoolId,
    userId: user._id,
    details: { promoted: promoted.length, skipped: skipped.length, failed: failed.length, dryRun },
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
  const { schoolId, classIds, gradeLevels, studentIds, promotionDate } = data;

  const resolvedSchoolId = resolveSchoolId(user, schoolId);
  if (!resolvedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  await fetchSchool(resolvedSchoolId);

  let filter = { schoolId: resolvedSchoolId, deletedAt: null, status: "active", isRepeating: false };

  if (studentIds && studentIds.length > 0) {
    filter._id = { $in: studentIds.map((id) => new mongoose.Types.ObjectId(id)) };
  } else if (classIds && classIds.length > 0) {
    filter.studentClass = { $in: classIds };
  } else if (gradeLevels && gradeLevels.length > 0) {
    const school = await fetchSchool(resolvedSchoolId);
    const classes = school.academic?.classes || [];
    const matchingClasses = classes.filter((cls) => gradeLevels.some((g) => cls.includes(String(g))));
    if (matchingClasses.length === 0) {
      throw new ApiError("No classes found for specified grade levels", 400, "NO_CLASSES_MATCHED");
    }
    filter.studentClass = { $in: matchingClasses };
  }

  const students = await Student.find(filter).lean();

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

  for (const m of mapping) {
    const targetClassStudents = await Student.countDocuments({
      schoolId: resolvedSchoolId,
      studentClass: m.targetClass,
      deletedAt: null,
      status: "active",
    });
    const capacity = 40;
    if (targetClassStudents + m.studentCount > capacity) {
      warnings.push({
        type: "CLASS_CAPACITY",
        message: `${m.targetClass} will exceed capacity by ${targetClassStudents + m.studentCount - capacity} students`,
        currentCapacity: capacity,
        projectedEnrollment: targetClassStudents + m.studentCount,
      });
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
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const student = await Student.findOne({ _id: id, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

  if (student.status !== "active") {
    throw new ApiError("Only active students can be marked as repeating", 409, "INVALID_STATUS");
  }

  const repeatCount = student.classHistory.filter((h) => h.from === student.studentClass && h.to === student.studentClass).length;
  if (repeatCount >= 1) {
    throw new ApiError("Student has reached maximum repeat limit for this grade", 409, "MAX_REPEATS_EXCEEDED");
  }

  const repeatDate = data.repeatDate ? new Date(data.repeatDate) : new Date();

  student.isRepeating = true;
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
    action: "REPEAT",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { repeatReason: data.repeatReason, repeatDate, customReason: data.customReason },
  });

  return student.toJSON();
};

// ──────────────────── Graduate Single Student ────────────────────
export const graduateStudent = async (id, data, user) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const student = await Student.findOne({ _id: id, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

  if (student.status === "graduated") {
    throw new ApiError("Student already graduated", 409, "ALREADY_GRADUATED");
  }

  const school = await fetchSchool(schoolId);
  const finalClasses = school.academic?.classes?.slice(-3) || [];
  if (!finalClasses.includes(student.studentClass)) {
    throw new ApiError("Student is not in a final year class", 409, "NOT_ELIGIBLE");
  }

  if (data.certificateNumber) {
    const existing = await Student.findOne({ schoolId, "graduation.certificateNumber": data.certificateNumber, deletedAt: null });
    if (existing) {
      throw new ApiError("Certificate number already exists", 409, "DUPLICATE_CERTIFICATE");
    }
  }

  const graduationDate = new Date(data.graduationDate);
  const certificateNumber = data.certificateNumber || `CERT-${graduationDate.getFullYear()}-${String(Math.floor(Math.random() * 1000000)).padStart(6, "0")}`;

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
    action: "GRADUATE",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { graduationDate, graduationType: data.graduationType, certificateNumber, honors: data.honors },
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

  const { cohortId, classIds, graduationDate, graduationType, autoAssignCertificates, certificatePrefix, dryRun, notes } = data;

  let filter = { schoolId: resolvedSchoolId, deletedAt: null, status: "active" };

  if (cohortId) {
    const cohortYear = cohortId.replace("cohort_", "");
    filter.graduationYear = cohortYear;
  } else if (classIds && classIds.length > 0) {
    filter.studentClass = { $in: classIds };
  } else {
    throw new ApiError("Either cohortId or classIds must be provided", 400, "MISSING_CRITERIA");
  }

  const students = await Student.find(filter).limit(300).lean();
  if (students.length === 0) {
    throw new ApiError("No eligible students found for graduation", 400, "NO_ELIGIBLE_STUDENTS");
  }

  const school = await fetchSchool(resolvedSchoolId);
  const finalClasses = school.academic?.classes?.slice(-3) || [];

  const gradDate = new Date(graduationDate);
  const graduated = [];
  const ineligible = [];
  const failed = [];

  let certCounter = 0;

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

      let certNumber = "";
      if (autoAssignCertificates) {
        certCounter += 1;
        const prefix = certificatePrefix || "CERT";
        certNumber = `${prefix}-${gradDate.getFullYear()}-${String(certCounter).padStart(6, "0")}`;
      }

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
    action: "BULK_GRADUATE",
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
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const student = await Student.findOne({ _id: id, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

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
  student.updatedBy = user._id;
  await student.save();

  const transferRecord = {
    id: new mongoose.Types.ObjectId(),
    destinationInstitution: data.destinationInstitution,
    destinationInstitutionType: data.destinationInstitutionType,
    transferDate,
    transferReason: data.transferReason,
    customReason: data.customReason,
    contactPerson: data.contactPerson,
    contactEmail: data.contactEmail,
    contactPhone: data.contactPhone,
    recordsTransferred: data.recordsTransferred,
    notes: data.notes,
    studentId: student._id,
    schoolId,
  };

  await auditService.log({
    action: "TRANSFER_OUT",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { destinationInstitution: data.destinationInstitution, transferDate, transferReason: data.transferReason },
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
    filter.$or = [
      { studentName: { $regex: search, $options: "i" } },
      { studentId: { $regex: search, $options: "i" } },
      { certificateNumber: { $regex: search, $options: "i" } },
    ];
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

  const match = { schoolId: resolvedSchoolId, deletedAt: null, status: "graduated", isAlumni: true };
  if (year) match.graduationYear = String(year);

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: "$graduationYear",
        name: { $first: { $concat: ["Class of ", "$graduationYear"] } },
        academicYear: { $first: { $concat: [{ $subtract: [{ $toInt: "$graduationYear" }, 1]}, "/", "$graduationYear"] } },
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
    pipeline.unshift({
      $match: {
        $or: [
          { studentName: { $regex: search, $options: "i" } },
          { studentId: { $regex: search, $options: "i" } },
        ],
      },
    });
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
  const cohortYear = cohortId.replace("cohort_", "");
  if (!/^\d{4}$/.test(cohortYear)) {
    throw new ApiError("Invalid cohort ID format", 400, "INVALID_COHORT_ID");
  }

  const resolvedSchoolId = resolveSchoolId(user, null);
  if (!resolvedSchoolId) {
    throw new ApiError("A schoolId is required to view cohort details", 400, "NO_SCHOOL_SCOPE");
  }

  await fetchSchool(resolvedSchoolId);

  const filter = { schoolId: resolvedSchoolId, deletedAt: null, graduationYear: cohortYear };
  if (query.status) filter.status = query.status.toLowerCase();

  const sortOrderNum = query.sortOrder === "asc" ? 1 : -1;
  const skip = (query.page - 1) * query.limit;

  const [students, total] = await Promise.all([
    Student.find(filter)
      .sort({ [query.sortBy]: sortOrderNum })
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

  const school = await fetchSchool(resolvedSchoolId);

  let honorsBreakdown = { NONE: 0, HONORS: 0, HIGH_HONORS: 0, HIGHEST_HONORS: 0 };
  if (stats[0]?.honorsBreakdown) {
    honorsBreakdown = stats[0].honorsBreakdown.reduce((acc, h) => {
      acc[h] = (acc[h] || 0) + 1;
      return acc;
    }, honorsBreakdown);
  }

  const finalClasses = school.academic?.classes?.slice(-3) || [];
  const classDetails = finalClasses.map((cls) => ({
    id: cls,
    name: cls,
    level: parseInt(cls.match(/\d+/)?.[0] || "12"),
    teacher: "",
    studentCount: 0,
  }));

  return {
    cohort: {
      id: cohortId,
      name: `Class of ${cohortYear}`,
      academicYear: `${Number(cohortYear) - 1}-${cohortYear}`,
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

export const addParent = async (studentId, data, user) => {
  if (!mongoose.Types.ObjectId.isValid(studentId)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const student = await Student.findOne({ _id: studentId, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

  const newParent = {
    ...data,
    _id: new mongoose.Types.ObjectId(),
  };

  student.parents.push(newParent);
  normalizePrimaryParent(student.parents);
  student.updatedBy = user._id;
  await student.save();

  await auditService.log({
    action: "ADD_PARENT",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { parentId: newParent._id, parentName: newParent.parentName, relationship: newParent.relationship },
  });

  return student.toJSON();
};

export const getParents = async (studentId, user) => {
  if (!mongoose.Types.ObjectId.isValid(studentId)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const student = await Student.findOne({ _id: studentId, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

  return student.parents;
};

export const updateParent = async (studentId, parentId, data, user) => {
  if (!mongoose.Types.ObjectId.isValid(studentId)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const student = await Student.findOne({ _id: studentId, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

  const parentIndex = student.parents.findIndex((p) => p._id.toString() === parentId);
  if (parentIndex === -1) {
    throw new ApiError("Parent not found", 404, "NOT_FOUND");
  }

  Object.keys(data).forEach((key) => {
    if (key !== "_id") {
      student.parents[parentIndex][key] = data[key];
    }
  });

  student.updatedBy = user._id;
  await student.save();

  await auditService.log({
    action: "UPDATE_PARENT",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { parentId, updatedFields: Object.keys(data) },
  });

  return student.toJSON();
};

export const setPrimaryParent = async (studentId, parentId, user) => {
  if (!mongoose.Types.ObjectId.isValid(studentId)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const student = await Student.findOne({ _id: studentId, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

  const parentIndex = student.parents.findIndex((p) => p._id.toString() === parentId);
  if (parentIndex === -1) {
    throw new ApiError("Parent not found", 404, "NOT_FOUND");
  }

  student.parents.forEach((p, i) => {
    p.isPrimary = i === parentIndex;
  });

  student.updatedBy = user._id;
  await student.save();

  await auditService.log({
    action: "SET_PRIMARY_PARENT",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { parentId },
  });

  return student.toJSON();
};

export const removeParent = async (studentId, parentId, user) => {
  if (!mongoose.Types.ObjectId.isValid(studentId)) {
    throw new ApiError("Invalid student ID", 400, "INVALID_ID");
  }

  const schoolId = resolveSchoolId(user, null);
  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const student = await Student.findOne({ _id: studentId, deletedAt: null });
  if (!student) {
    throw new ApiError("Student not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && student.schoolId.toString() !== schoolId.toString()) {
    throw new ApiError("You do not have access to this student", 403, "FORBIDDEN");
  }

  if (student.parents.length <= 1) {
    throw new ApiError("Cannot remove the only parent. At least one parent is required.", 400, "MIN_PARENTS_REQUIRED");
  }

  const parentIndex = student.parents.findIndex((p) => p._id.toString() === parentId);
  if (parentIndex === -1) {
    throw new ApiError("Parent not found", 404, "NOT_FOUND");
  }

  const removedParent = student.parents[parentIndex];
  student.parents.splice(parentIndex, 1);
  normalizePrimaryParent(student.parents);
  student.updatedBy = user._id;
  await student.save();

  await auditService.log({
    action: "REMOVE_PARENT",
    entity: "Student",
    entityId: student._id,
    userId: user._id,
    details: { parentId, parentName: removedParent.parentName },
  });

  return student.toJSON();
};

export { ApiError };
