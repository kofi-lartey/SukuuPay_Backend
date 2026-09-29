import mongoose from "mongoose";
import { AuditLog } from "../models/AuditLog.js";
import { User } from "../models/userModel.js";
import { School } from "../models/schoolModel.js";
import ApiError from "../utils/ApiError.js";

const resolveSchoolId = (user, explicitSchoolId) => {
  if (user && user.role === "super_admin") {
    return explicitSchoolId ? new mongoose.Types.ObjectId(explicitSchoolId) : null;
  }
  return user && user.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// ──────────────────── List audit logs ────────────────────
export const listAuditLogs = async (schoolId, query, requester) => {
  const scopedSchoolId = resolveSchoolId(requester, schoolId);
  if (!scopedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  // Verify the school exists (also confirms the requester has access).
  const school = await School.findById(scopedSchoolId).select("slug").lean();
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  const filter = { schoolId: scopedSchoolId };

  if (query.userId) {
    if (!isValidObjectId(query.userId)) {
      throw new ApiError("Invalid userId filter", 400, "INVALID_ID");
    }
    filter.userId = query.userId;
  }
  if (query.action) filter.action = query.action;
  if (query.entity) filter.entity = query.entity;
  if (query.entityId) {
    if (!isValidObjectId(query.entityId)) {
      throw new ApiError("Invalid entityId filter", 400, "INVALID_ID");
    }
    filter.entityId = query.entityId;
  }
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) {
      // End of day Accra so `to` is inclusive.
      const end = new Date(query.to);
      filter.createdAt.$lte = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 23, 59, 59, 999));
    }
  }

  const page = Number(query.page) || 1;
  const perPage = Math.min(Number(query.perPage) || 20, 100);
  const skip = (page - 1) * perPage;

  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .populate("userId", "name email role")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  return {
    data: logs,
    meta: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };
};

// ──────────────────── Export audit logs ────────────────────
export const exportAuditLogs = async (schoolId, query, requester) => {
  const scopedSchoolId = resolveSchoolId(requester, schoolId);
  if (!scopedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await School.findById(scopedSchoolId).select("slug").lean();
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  const filter = { schoolId: scopedSchoolId };

  if (query.userId) {
    if (!isValidObjectId(query.userId)) {
      throw new ApiError("Invalid userId filter", 400, "INVALID_ID");
    }
    filter.userId = query.userId;
  }
  if (query.action) filter.action = query.action;
  if (query.entity) filter.entity = query.entity;
  if (query.entityId) {
    if (!isValidObjectId(query.entityId)) {
      throw new ApiError("Invalid entityId filter", 400, "INVALID_ID");
    }
    filter.entityId = query.entityId;
  }
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) {
      const end = new Date(query.to);
      filter.createdAt.$lte = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 23, 59, 59, 999));
    }
  }

  // Capped at 50k rows to prevent unbounded memory usage.
  const logs = await AuditLog.find(filter)
    .populate("userId", "name email role")
    .sort({ createdAt: -1 })
    .lean()
    .limit(50000);

  return { logs, schoolSlug: school.slug || schoolId.toString() };
};

// ──────────────────── Get logs for a specific user ────────────────────
export const getUserAuditLogs = async (userId, query, requester) => {
  // Resolve the school from the requester.  Super admins can query any
  // user, so the school is derived from the target user's record.
  let scopedSchoolId;

  if (requester.role === "super_admin") {
    const targetUser = await User.findById(userId).select("schoolId").lean();
    if (!targetUser) throw new ApiError("User not found", 404, "NOT_FOUND");
    scopedSchoolId = targetUser.schoolId;
  } else {
    scopedSchoolId = requester.schoolId;
  }

  if (!scopedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  // For school admins, verify the target user belongs to the same school.
  if (requester.role !== "super_admin") {
    const targetUser = await User.findOne({
      _id: userId,
      schoolId: scopedSchoolId,
    }).select("_id")
      .lean();
    if (!targetUser) {
      throw new ApiError("User not found in your school", 404, "NOT_FOUND");
    }
  }

  const filter = { schoolId: scopedSchoolId, userId };

  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) {
      const end = new Date(query.to);
      filter.createdAt.$lte = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 23, 59, 59, 999));
    }
  }

  const page = Number(query.page) || 1;
  const perPage = Math.min(Number(query.perPage) || 20, 100);
  const skip = (page - 1) * perPage;

  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .populate("userId", "name email role")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  return {
    data: logs,
    meta: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };
};
