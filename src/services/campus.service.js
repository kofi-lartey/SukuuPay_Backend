import mongoose from "mongoose";
import { Campus } from "../models/Campus.js";
import { School } from "../models/schoolModel.js";
import { log as auditLog } from "../utils/auditService.js";
import { AUDIT_ACTIONS, CAMPUS_PLAN, normalizePlan } from "../config/constants.js";
import ApiError from "../utils/ApiError.js";

const normalizeFilter = (filter = {}) => {
  const page = Math.max(1, Number(filter.page || 1));
  const perPage = Math.min(100, Math.max(1, Number(filter.perPage || 20)));
  const query = { schoolId: filter.schoolId };
  if (filter.status) query.status = filter.status;
  if (filter.region) query.region = filter.region;
  return { query, page, perPage, skip: (page - 1) * perPage };
};

/**
 * List campuses for a school.
 *
 * Signature: listCampuses(schoolId, filter)
 * filter: { status?, region?, page?, perPage? }
 */
export const listCampuses = async (schoolId, filter = {}) => {
  if (!mongoose.Types.ObjectId.isValid(schoolId)) {
    throw new ApiError("Invalid school ID", 400, "INVALID_ID");
  }

  const school = await School.findById(schoolId).select("_id status");
  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  const { query, page, perPage, skip } = normalizeFilter({ ...filter, schoolId });

  const [campuses, total] = await Promise.all([
    Campus.find(query).sort({ createdAt: -1 }).skip(skip).limit(perPage).lean(),
    Campus.countDocuments(query),
  ]);

  return {
    data: campuses,
    meta: {
      page,
      perPage,
      total,
      pages: Math.ceil(total / perPage),
    },
  };
};

/**
 * Create a campus under the caller's school.
 *
 * Signature: createCampus(data, user)
 * data: { name, code, address, region, bursarEmail }
 */
export const createCampus = async (data, user) => {
  if (!user) {
    throw new ApiError("Authentication required", 401, "UNAUTHENTICATED");
  }

  const schoolId = user.schoolId;
  if (!schoolId || !mongoose.Types.ObjectId.isValid(schoolId)) {
    throw new ApiError("A school is required to create a campus", 400, "NO_SCHOOL_SCOPE");
  }

  const school = await School.findById(schoolId).select("_id subscription.plan status");
  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }
  if (normalizePlan(school.subscription.plan) !== CAMPUS_PLAN) {
    throw new ApiError("Campus tier required", 403, "CAMPUS_TIER_REQUIRED");
  }

  const { name, code, address, region, bursarEmail } = data;
  if (!name || !String(name).trim()) {
    throw new ApiError("name is required", 400, "VALIDATION_ERROR");
  }
  if (!code || !String(code).trim()) {
    throw new ApiError("code is required", 400, "VALIDATION_ERROR");
  }

  const normalizedCode = String(code).trim().toUpperCase();
  const existing = await Campus.findOne({ schoolId, code: normalizedCode });
  if (existing) {
    throw new ApiError("A campus with this code already exists in this school", 409, "DUPLICATE_CAMPUS_CODE");
  }

  const campus = await Campus.create({
    schoolId,
    name: String(name).trim(),
    code: normalizedCode,
    address: String(address || "").trim(),
    region: String(region || "").trim(),
    bursarEmail: String(bursarEmail || "").trim().toLowerCase(),
    status: "active",
    createdBy: user._id,
  });

  await auditLog({
    action: AUDIT_ACTIONS.CAMPUS_CREATE,
    entity: "Campus",
    entityId: campus._id,
    userId: user._id,
    schoolId,
    meta: { name: campus.name, code: campus.code },
  });

  return campus.toJSON();
};

/** GET /:id — get campus detail. */
export const getCampus = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError("Invalid campus ID", 400, "INVALID_ID");
  }

  const campus = await Campus.findById(id).lean();
  if (!campus) {
    throw new ApiError("Campus not found", 404, "NOT_FOUND");
  }

  return campus;
};

/**
 * PUT /:id — update campus.
 *
 * Signature: updateCampus(id, data, user)
 * data: { name?, code?, address?, region?, bursarEmail?, status? }
 */
export const updateCampus = async (id, data, user) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError("Invalid campus ID", 400, "INVALID_ID");
  }
  if (!user) {
    throw new ApiError("Authentication required", 401, "UNAUTHENTICATED");
  }

  const campus = await Campus.findById(id);
  if (!campus) {
    throw new ApiError("Campus not found", 404, "NOT_FOUND");
  }

  const { name, code, address, region, bursarEmail, status } = data;
  const updates = {};

  if (name !== undefined) {
    if (!String(name).trim()) {
      throw new ApiError("name must not be empty", 400, "VALIDATION_ERROR");
    }
    updates.name = String(name).trim();
  }
  if (code !== undefined) {
    updates.code = String(code).trim().toUpperCase();
  }
  if (address !== undefined) {
    updates.address = String(address).trim();
  }
  if (region !== undefined) {
    updates.region = String(region).trim();
  }
  if (bursarEmail !== undefined) {
    updates.bursarEmail = String(bursarEmail).trim().toLowerCase();
  }
  if (status !== undefined) {
    updates.status = status;
  }

  if (updates.code && updates.code !== campus.code) {
    const conflict = await Campus.findOne({
      schoolId: campus.schoolId,
      code: updates.code,
      _id: { $ne: id },
    });
    if (conflict) {
      throw new ApiError("A campus with this code already exists in this school", 409, "DUPLICATE_CAMPUS_CODE");
    }
  }

  const before = {
    name: campus.name,
    code: campus.code,
    address: campus.address,
    region: campus.region,
    bursarEmail: campus.bursarEmail,
    status: campus.status,
  };

  Object.assign(campus, updates);
  await campus.save();

  const after = {
    name: campus.name,
    code: campus.code,
    address: campus.address,
    region: campus.region,
    bursarEmail: campus.bursarEmail,
    status: campus.status,
  };

  await auditLog({
    action: AUDIT_ACTIONS.CAMPUS_UPDATE,
    entity: "Campus",
    entityId: campus._id,
    userId: user._id,
    schoolId: campus.schoolId,
    before,
    after,
    meta: { updatedFields: Object.keys(updates) },
  });

  return campus.toJSON();
};

/**
 * DELETE /:id — soft archive (set status: "archived").
 *
 * Signature: archiveCampus(id, user)
 */
export const archiveCampus = async (id, user) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError("Invalid campus ID", 400, "INVALID_ID");
  }
  if (!user) {
    throw new ApiError("Authentication required", 401, "UNAUTHENTICATED");
  }

  const campus = await Campus.findById(id);
  if (!campus) {
    throw new ApiError("Campus not found", 404, "NOT_FOUND");
  }
  if (campus.status === "archived") {
    throw new ApiError("Campus is already archived", 400, "ALREADY_ARCHIVED");
  }

  const before = { status: campus.status };
  campus.status = "archived";
  await campus.save();

  await auditLog({
    action: AUDIT_ACTIONS.CAMPUS_ARCHIVE,
    entity: "Campus",
    entityId: campus._id,
    userId: user._id,
    schoolId: campus.schoolId,
    before,
    after: { status: "archived" },
  });

  return {
    message: "Campus archived successfully",
    campus: campus.toJSON(),
  };
};
