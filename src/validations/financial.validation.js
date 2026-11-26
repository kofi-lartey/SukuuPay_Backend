import Joi from 'joi';

/** Validation schemas for the multi-signatory financial batches API. */

export const batchIdParamSchema = Joi.object({
  id: Joi.string().hex().length(24).required(),
});

export const createBatchSchema = Joi.object({
  campusId: Joi.string().hex().length(24).required(),
  amount: Joi.number().integer().positive().required(),
  description: Joi.string().max(1000).optional().allow(''),
  requiredSignatures: Joi.number().integer().min(1).default(1),
});

export const rejectBatchSchema = Joi.object({
  reason: Joi.string().min(1).max(1000).required(),
});

export const listBatchesQuerySchema = Joi.object({
  schoolId: Joi.string().hex().length(24).optional(),
  campusId: Joi.string().hex().length(24).optional(),
  status: Joi.string()
    .valid(
      'draft',
      'pending_approval',
      'approved',
      'rejected',
      'processing',
      'paid',
      'failed',
      'cancelled',
    )
    .optional(),
});

export default {
  batchIdParamSchema,
  createBatchSchema,
  rejectBatchSchema,
  listBatchesQuerySchema,
};
