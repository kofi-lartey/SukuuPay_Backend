import Joi from "joi";

/**
 * Record a payment taken at the bursar's desk.
 *
 * `amount` is an integer number of **pesewas**, like every other money field in
 * this API. 100 pesewas is GH₵ 1.00, and a client that sends `850` is recording
 * a one-cedi payment — the same hundred-fold error the student form's fee field
 * had, and the reason the UI's money input converts rather than passing a typed
 * number straight through.
 *
 * `method` excludes `momo` deliberately. A Mobile Money payment is confirmed by
 * the provider's callback; a hand-recorded "momo" row is a second, unverified
 * claim on money the gateway may also report, and the duplicate is invisible on
 * the student's record.
 */
export const recordManualPaymentSchema = Joi.object({
  // The human `studentId` (`SCH-DEMO-01-2026-8054`) or a 24-character id. The
  // bursar reads a student number off a paper register, so the human form is the
  // one that has to work.
  studentRef: Joi.string().trim().min(2).max(64).required(),
  amount: Joi.number().integer().min(1).required(),
  method: Joi.string().valid("cash", "card", "bank_transfer").default("cash"),
  // Cheque number, bank reference, or a note of what was handed over.
  reference: Joi.string().trim().max(120).allow("", null),
  notes: Joi.string().trim().max(500).allow("", null),
  // When the money actually changed hands, for a payment entered after the fact.
  receivedAt: Joi.date().max("now").optional().allow(null),
  allowOverpayment: Joi.boolean().default(false),
});

export default { recordManualPaymentSchema };
