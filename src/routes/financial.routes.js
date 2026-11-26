import { Router } from "express";
import {
  createBatchController,
  listBatchesController,
  getBatchController,
  signBatchController,
  approveBatchController,
  rejectBatchController,
} from "../controllers/financial.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { requireCampusTier, requireCampusAccess } from "../middleware/campus.middleware.js";
import { validate } from "../middleware/validate.js";
import { DisbursementBatch } from "../models/DisbursementBatch.js";
import {
  batchIdParamSchema,
  createBatchSchema,
  rejectBatchSchema,
  listBatchesQuerySchema,
} from "../validations/financial.validation.js";

export const financialRoute = Router();

const requireCampusRole = authorize("super_admin", "school_admin", "accountant");

const requireCampusAccessMiddleware = async (req, res, next) => {
  try {
    let campusId = req.body?.campusId;
    if (req.params.id && !campusId) {
      const batch = await DisbursementBatch.findById(req.params.id).select("campusId").lean();
      campusId = batch?.campusId;
    }

    if (campusId) {
      await requireCampusAccess(req.user, campusId);
    }
    return next();
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

financialRoute.use(authenticate);
financialRoute.use(requireCampusRole);
financialRoute.use(requireCampusTier);

financialRoute.post(
  "/",
  validate(createBatchSchema, 'body'),
  requireCampusAccessMiddleware,
  createBatchController
);

financialRoute.get(
  "/",
  validate(listBatchesQuerySchema, 'query'),
  listBatchesController
);

financialRoute.get(
  "/:id",
  validate(batchIdParamSchema, 'params'),
  requireCampusAccessMiddleware,
  getBatchController
);

financialRoute.post(
  "/:id/sign",
  validate(batchIdParamSchema, 'params'),
  requireCampusAccessMiddleware,
  signBatchController
);

financialRoute.post(
  "/:id/approve",
  validate(batchIdParamSchema, 'params'),
  requireCampusAccessMiddleware,
  approveBatchController
);

financialRoute.post(
  "/:id/reject",
  validate(batchIdParamSchema, 'params'),
  validate(rejectBatchSchema, 'body'),
  requireCampusAccessMiddleware,
  rejectBatchController
);

export default financialRoute;