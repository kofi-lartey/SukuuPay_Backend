import Joi from 'joi';
import { MOMO_NETWORKS, SMS_DELIVERY_STATUSES } from '../config/constants.js';

/**
 * Platform payment administration.
 *
 * Patch-style with `.min(1)` on objects, so a client writing back a whole document
 * cannot blank what it did not mean to change.
 *
 * Every amount is a **positive integer in pesewas** except `refundSchema`'s, which
 * is also a positive integer and is negated server-side. A negative amount from a
 * client would be ambiguous — "refund twice as much"? — and the reversal row is
 * created by the server with the sign already applied.
 */

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

/** `GET /admin/payments` — every payment on the platform. */
const listPaymentsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  // Capped at the shared console maximum. Payment history is the one list a console
  // screen is tempted to ask for "a thousand of", and there is a CSV export for
  // that, which streams and does not hold the result in memory.
  perPage: Joi.number().integer().min(1).max(200).default(20),
  schoolId: objectId,
  status: Joi.string().valid(
    'pending',
    'processing',
    'completed',
    'failed',
    'cancelled',
    'refunded'
  ),
  network: Joi.string().valid(...MOMO_NETWORKS),
  /**
   * The *provider* the payment went through (`Payment.provider`), not the school's
   * `payment.gatewayMode`. Two different enums answer two different questions — "who
   * processed this" versus "which rail did the school choose" — and offering the
   * wrong one here returns an empty list rather than an error, which is the worst
   * possible answer to a filter.
   */
  gateway: Joi.string().valid('paystack', 'hubtel', 'arke', 'mnotify', 'manual', 'mtn'),
  from: Joi.date().iso(),
  to: Joi.date().iso(),
}).unknown(false);

const paymentIdParamSchema = Joi.object({
  paymentId: objectId.required().messages({
    'string.pattern.base': 'Invalid payment ID format',
  }),
});

/**
 * `POST /admin/payments/:paymentId/refund`
 *
 * `reason` is required with a 10-character floor, and the floor is the point. A
 * refund with no stated reason is unanswerable to the parent six weeks later, when
 * they call to ask where their money went — and the reason is the only text
 * recorded anywhere with the reversal.
 *
 * `amount` is optional and defaults to the full remaining refundable balance, which
 * is the common case: a school refunds a duplicate payment in full. The server
 * rejects an amount above what remains, having summed the existing reversal rows
 * rather than comparing against the original — so two refunds of 60% each cannot
 * both pass.
 */
const refundSchema = Joi.object({
  amount: Joi.number().integer().positive(),
  reason: Joi.string().trim().min(10).max(500).required().messages({
    'string.min': 'Give a reason of at least 10 characters — the parent will be told this.',
  }),
}).min(1);

/**
 * `GET /admin/payments/stats`
 *
 * `groupBy` is required-ish rather than derived: 30 daily points and 24 monthly
 * points are different charts, and a caller that let the server pick would get a
 * shape it did not ask for. It defaults to `day` because the common window on this
 * screen is "last 30 days".
 */
const paymentStatsQuerySchema = Joi.object({
  groupBy: Joi.string().valid('day', 'week', 'month').default('day'),
  from: Joi.date().iso(),
  to: Joi.date().iso(),
  schoolId: objectId,
}).unknown(false);

/** `GET /admin/payments/export` — CSV download. */
const exportPaymentsQuerySchema = Joi.object({
  from: Joi.date().iso(),
  to: Joi.date().iso(),
  schoolId: objectId,
}).unknown(false);

/**
 * `GET /admin/health/errors` shares `SMS_DELIVERY_STATUSES`' import only for the
 * delivery-status filter it borrows from the SMS module; re-exported here so the
 * payments schema and the health schema read the same list.
 */
export { SMS_DELIVERY_STATUSES };

export {
  listPaymentsQuerySchema,
  paymentIdParamSchema,
  refundSchema,
  paymentStatsQuerySchema,
  exportPaymentsQuerySchema,
};

export default {
  listPaymentsQuerySchema,
  paymentIdParamSchema,
  refundSchema,
  paymentStatsQuerySchema,
  exportPaymentsQuerySchema,
};