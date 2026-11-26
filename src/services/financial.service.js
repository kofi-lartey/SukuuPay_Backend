import mongoose from "mongoose";
import { DisbursementBatch } from "../models/DisbursementBatch.js";
import { School } from "../models/schoolModel.js";
import { Campus } from "../models/Campus.js";
import { User } from "../models/userModel.js";
import ApiError from "../utils/ApiError.js";
import { log } from "../utils/auditService.js";
import { AUDIT_ACTIONS, normalizePlan } from "../config/constants.js";

/**
 * Creates a new disbursement batch for a campus.
 * Status starts as "pending_approval" with signatureCount 0.
 */
export const createBatch = async (data, user, req) => {
  const { campusId, amount, description, requiredSignatures } = data;

  const campus = await Campus.findById(campusId).select("schoolId name code");
  if (!campus) {
    throw new ApiError("Campus not found", 404, "CAMPUS_NOT_FOUND");
  }

  const school = await School.findById(campus.schoolId).select(
    "financialControls subscription.plan name"
  );
  if (!school) {
    throw new ApiError("School not found", 404, "SCHOOL_NOT_FOUND");
  }

  if (normalizePlan(school.subscription?.plan) !== "campus") {
    throw new ApiError(
      "Campus tier required for multi-signatory disbursement batches",
      403,
      "CAMPUS_TIER_REQUIRED"
    );
  }

  const signaturesConfig = school.financialControls?.multiSignatory
    ? school.financialControls.requiredSignatures || 1
    : 1;

  const effectiveRequiredSignatures = requiredSignatures || signaturesConfig;

  const batch = await DisbursementBatch.create({
    schoolId: campus.schoolId,
    campusId,
    grossAmount: amount,
    netAmount: amount,
    platformAmount: 0,
    paymentCount: 0,
    paymentIds: [],
    status: "pending_approval",
    requiredSignatures: effectiveRequiredSignatures,
    signatureCount: 0,
    signatures: [],
    description,
    createdBy: user._id,
    periodStart: new Date(),
    periodEnd: new Date(),
  });

  await log({
    action: AUDIT_ACTIONS.FINANCIAL_BATCH_CREATED,
    entity: "DisbursementBatch",
    entityId: batch._id,
    userId: user._id,
    schoolId: campus.schoolId,
    after: batch.toJSON(),
    req,
  });

  return batch;
};

/**
 * Lists disbursement batches with optional filters.
 */
export const listBatches = async (filter) => {
  const { schoolId, campusId, status } = filter;

  const query = { deletedAt: null };
  if (schoolId) query.schoolId = new mongoose.Types.ObjectId(schoolId);
  if (campusId) query.campusId = new mongoose.Types.ObjectId(campusId);
  if (status) query.status = status;

  const batches = await DisbursementBatch.find(query)
    .sort({ createdAt: -1 })
    .populate("campusId", "name code")
    .populate("createdBy", "name email role")
    .populate("approvedBy", "name email role")
    .lean();

  return batches;
};

/**
 * Gets a single batch with signatures populated.
 */
export const getBatch = async (batchId) => {
  const batch = await DisbursementBatch.findById(batchId)
    .populate("campusId", "name code")
    .populate("schoolId", "name schoolCode")
    .populate("createdBy", "name email role")
    .populate("approvedBy", "name email role")
    .populate("signatures.userId", "name email role")
    .lean();

  if (!batch) {
    throw new ApiError("Batch not found", 404, "BATCH_NOT_FOUND");
  }

  return batch;
};

/**
 * Signs a batch atomically. Uses $addToSet and $inc to prevent race conditions.
 * Returns the updated batch with the new signature.
 */
export const signBatch = async (batchId, userId, ip, req) => {
  const user = await User.findById(userId).select("name email role");
  if (!user) {
    throw new ApiError("User not found", 404, "USER_NOT_FOUND");
  }

  const batch = await DisbursementBatch.findById(batchId);
  if (!batch) {
    throw new ApiError("Batch not found", 404, "BATCH_NOT_FOUND");
  }

  if (batch.status !== "pending_approval") {
    throw new ApiError(
      `Cannot sign batch in ${batch.status} status`,
      400,
      "INVALID_BATCH_STATUS"
    );
  }

  const alreadySigned = batch.signatures.some(
    (s) => String(s.userId) === String(userId)
  );
  if (alreadySigned) {
    throw new ApiError("User has already signed this batch", 409, "ALREADY_SIGNED");
  }

  const updatedBatch = await DisbursementBatch.findOneAndUpdate(
    {
      _id: batchId,
      "signatures.userId": { $ne: userId },
      status: "pending_approval",
    },
    {
      $push: {
        signatures: {
          userId,
          role: user.role,
          signedAt: new Date(),
          ip,
        },
      },
      $inc: { signatureCount: 1 },
    },
    { returnDocument: "after" }
  )
    .populate("signatures.userId", "name email role")
    .populate("campusId", "name code")
    .populate("schoolId", "name schoolCode")
    .populate("createdBy", "name email role")
    .lean();

  if (!updatedBatch) {
    const recheck = await DisbursementBatch.findById(batchId);
    if (!recheck) {
      throw new ApiError("Batch not found", 404, "BATCH_NOT_FOUND");
    }
    if (recheck.signatures.some((s) => String(s.userId) === String(userId))) {
      throw new ApiError("User has already signed this batch", 409, "ALREADY_SIGNED");
    }
    throw new ApiError("Batch status changed, cannot sign", 409, "BATCH_STATUS_CHANGED");
  }

  await log({
    action: AUDIT_ACTIONS.FINANCIAL_BATCH_SIGNED,
    entity: "DisbursementBatch",
    entityId: batchId,
    userId,
    schoolId: batch.schoolId,
    after: { signatureCount: updatedBatch.signatureCount, signatures: updatedBatch.signatures },
    req,
  });

  return updatedBatch;
};

/**
 * Approves a batch if signatureCount >= requiredSignatures.
 * Only users with appropriate role can approve.
 */
export const approveBatch = async (batchId, userId, req) => {
  const user = await User.findById(userId).select("name email role");
  if (!user) {
    throw new ApiError("User not found", 404, "USER_NOT_FOUND");
  }

  const batch = await DisbursementBatch.findById(batchId);
  if (!batch) {
    throw new ApiError("Batch not found", 404, "BATCH_NOT_FOUND");
  }

  if (batch.status !== "pending_approval") {
    throw new ApiError(
      `Cannot approve batch in ${batch.status} status`,
      400,
      "INVALID_BATCH_STATUS"
    );
  }

  if (batch.signatureCount < batch.requiredSignatures) {
    throw new ApiError(
      `Insufficient signatures: ${batch.signatureCount}/${batch.requiredSignatures}`,
      400,
      "INSUFFICIENT_SIGNATURES"
    );
  }

  const updatedBatch = await DisbursementBatch.findOneAndUpdate(
    { _id: batchId, status: "pending_approval" },
    {
      $set: {
        status: "approved",
        approvedBy: userId,
        approvedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  )
    .populate("signatures.userId", "name email role")
    .populate("campusId", "name code")
    .populate("schoolId", "name schoolCode")
    .populate("createdBy", "name email role")
    .populate("approvedBy", "name email role")
    .lean();

  if (!updatedBatch) {
    throw new ApiError("Batch status changed, cannot approve", 409, "BATCH_STATUS_CHANGED");
  }

  await log({
    action: AUDIT_ACTIONS.FINANCIAL_BATCH_APPROVED,
    entity: "DisbursementBatch",
    entityId: batchId,
    userId,
    schoolId: batch.schoolId,
    before: { status: "pending_approval", approvedBy: null, approvedAt: null },
    after: { status: "approved", approvedBy: userId, approvedAt: new Date() },
    req,
  });

  return updatedBatch;
};

/**
 * Rejects a batch with a reason.
 */
export const rejectBatch = async (batchId, userId, reason, req) => {
  const user = await User.findById(userId).select("name email role");
  if (!user) {
    throw new ApiError("User not found", 404, "USER_NOT_FOUND");
  }

  const batch = await DisbursementBatch.findById(batchId);
  if (!batch) {
    throw new ApiError("Batch not found", 404, "BATCH_NOT_FOUND");
  }

  if (!["pending_approval", "draft"].includes(batch.status)) {
    throw new ApiError(
      `Cannot reject batch in ${batch.status} status`,
      400,
      "INVALID_BATCH_STATUS"
    );
  }

  const updatedBatch = await DisbursementBatch.findOneAndUpdate(
    { _id: batchId, status: { $in: ["pending_approval", "draft"] } },
    {
      $set: {
        status: "rejected",
        failureReason: reason,
        rejectedBy: userId,
        rejectedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  )
    .populate("signatures.userId", "name email role")
    .populate("campusId", "name code")
    .populate("schoolId", "name schoolCode")
    .populate("createdBy", "name email role")
    .populate("rejectedBy", "name email role")
    .lean();

  if (!updatedBatch) {
    throw new ApiError("Batch status changed, cannot reject", 409, "BATCH_STATUS_CHANGED");
  }

  await log({
    action: AUDIT_ACTIONS.FINANCIAL_BATCH_REJECTED,
    entity: "DisbursementBatch",
    entityId: batchId,
    userId,
    schoolId: batch.schoolId,
    before: { status: batch.status },
    after: { status: "rejected", failureReason: reason, rejectedBy: userId, rejectedAt: new Date() },
    req,
  });

  return updatedBatch;
};

export default {
  createBatch,
  listBatches,
  getBatch,
  signBatch,
  approveBatch,
  rejectBatch,
};