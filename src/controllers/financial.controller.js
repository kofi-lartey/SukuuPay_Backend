import {
  createBatch,
  listBatches,
  getBatch,
  signBatch,
  approveBatch,
  rejectBatch,
} from "../services/financial.service.js";
import { resolveErrorMessage } from "../middleware/errorHandler.js";
import ApiError from "../utils/ApiError.js";

export const createBatchController = async (req, res) => {
  try {
    const { campusId, amount, description, requiredSignatures } = req.body;

    if (!campusId) {
      throw new ApiError("campusId is required", 400, "CAMPUS_ID_REQUIRED");
    }
    if (!amount || amount <= 0) {
      throw new ApiError("amount must be a positive number", 400, "INVALID_AMOUNT");
    }

    const batch = await createBatch(
      { campusId, amount, description, requiredSignatures },
      req.user,
      req
    );

    return res.status(201).json({
      success: true,
      message: "Disbursement batch created successfully",
      data: batch,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export const listBatchesController = async (req, res) => {
  try {
    const { schoolId, campusId, status } = req.query;

    const batches = await listBatches({ schoolId, campusId, status });

    return res.status(200).json({
      success: true,
      message: "Batches retrieved successfully",
      data: batches,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
    });
  }
};

export const getBatchController = async (req, res) => {
  try {
    const { id } = req.params;
    const batch = await getBatch(id);

    return res.status(200).json({
      success: true,
      message: "Batch retrieved successfully",
      data: batch,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
    });
  }
};

export const signBatchController = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    const batch = await signBatch(id, userId, ip, req);

    return res.status(200).json({
      success: true,
      message: "Batch signed successfully",
      data: batch,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export const approveBatchController = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const batch = await approveBatch(id, userId, req);

    return res.status(200).json({
      success: true,
      message: "Batch approved successfully",
      data: batch,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export const rejectBatchController = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      throw new ApiError("Rejection reason is required", 400, "REASON_REQUIRED");
    }

    const batch = await rejectBatch(id, userId, reason.trim(), req);

    return res.status(200).json({
      success: true,
      message: "Batch rejected successfully",
      data: batch,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export default {
  createBatchController,
  listBatchesController,
  getBatchController,
  signBatchController,
  approveBatchController,
  rejectBatchController,
};