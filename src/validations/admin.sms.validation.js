import Joi from 'joi';
import { SMS_DELIVERY_STATUSES, SMS_PROVIDERS } from '../config/constants.js';

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

/**
 * Platform SMS administration.
 *
 * Patch-style throughout, `.min(1)` on every object, so a client that reads a
 * document and writes it back cannot blank the fields it did not mean to change.
 *
 * `limit` and `schoolId` are the only two things the platform console may ask for
 * about SMS messages, and both are bounds rather than filters on content: a bursar
 * filters their own school's history by delivery status, but a platform-wide view
 * cannot offer free-text search over message bodies without handing the console a
 * searchable copy of every school's parent correspondence.
 */

/** `GET /admin/sms/logs` — delivery history across every school. */
const listSmsLogsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  // Capped lower than the default console page size of 200. Message history is the
  // one list a console screen is tempted to ask for "a thousand of", and every row
  // carries a rendered body — this is the most expensive read on the platform and
  // the least interesting in bulk.
  perPage: Joi.number().integer().min(1).max(100).default(20),
  schoolId: objectId,
  status: Joi.string().valid(...SMS_DELIVERY_STATUSES),
  from: Joi.date().iso(),
  to: Joi.date().iso(),
}).unknown(false);

/**
 * `POST /admin/sms/credits/topup`
 *
 * **`amount` is a count of messages, not money, and that is deliberate.** SMS
 * balance is denominated in credits throughout this codebase
 * (`school.sms.balance`, `SmsCreditTopUp.units`), so a field called `amount`
 * carrying cedis would be the one unit on this screen that disagrees with every
 * other one. `amountPes` exists on `SmsCreditTopUp` for the money actually paid,
 * and is **not** required here — credit is routinely granted by support or by a
 * migration, and recording a price for a decision that had none would put a
 * balance-sheet item where there was only a decision.
 *
 * `schoolIds` may be empty, and what an empty list means is the whole subtlety:
 * `SmsCreditTopUp.schoolId` is **required**, so a top-up with no schools cannot
 * create a row against anyone. An empty list is therefore a *platform credit note*
 * — recorded in `meta` on the audit entry, credited to nobody, and returned with
 * `creditedSchools: 0`. It is not an error, and it is not silently the same as
 * crediting every school.
 */
const recordSmsCreditTopUpSchema = Joi.object({
  amount: Joi.number().integer().min(1).max(10_000_000).required(),
  provider: Joi.string().valid(...SMS_PROVIDERS),
  schoolIds: Joi.array().items(objectId).max(500).default([]),
  note: Joi.string().trim().max(300).allow(''),
  // Integer pesewas, and optional: a grant has no price.
  amountPes: Joi.number().integer().min(0),
}).min(1);

/**
 * `POST /admin/sms/broadcast`
 *
 * **The 320-character ceiling is two SMS segments, and that is a cost decision
 * rather than a technical one.** One segment is 160 GSM characters, two are 306, so
 * 320 fits two segments with room for a character or two and nothing more. A
 * message that spills into a third segment is billed at three times the rate for
 * every recipient on a list that may be hundreds long — and there is no way to
 * charge that back to anybody, because a platform announcement is the platform's
 * cost.
 *
 * The schema refuses rather than truncating. Truncating a maintenance notice
 * produces a message that is *almost* right, which is worse than one that was
 * refused: a school reads "payments will be unavailable while we upgrade" and
 * misses the end time, and finds out from a parent.
 */
const broadcastToSchoolAdminsSchema = Joi.object({
  targetAudience: Joi.string()
    .valid('all_schools', 'selected_schools')
    .required(),
  schoolIds: Joi.array().items(objectId).max(500).default([]),
  message: Joi.string().trim().min(1).max(320).required(),
}).custom((value, helpers) => {
  // `selected_schools` with no schools resolves to zero recipients, which reads on
  // the console as "sent" and on the operator's screen as "queued". Caught here so
  // it is a 422 naming the field rather than a successful no-op.
  if (value.targetAudience === 'selected_schools' && !value.schoolIds.length) {
    return helpers.message({
      custom: 'Select at least one school for a targeted broadcast.',
    });
  }
  return value;
});

export {
  listSmsLogsQuerySchema,
  recordSmsCreditTopUpSchema,
  broadcastToSchoolAdminsSchema,
};

export default {
  listSmsLogsQuerySchema,
  recordSmsCreditTopUpSchema,
  broadcastToSchoolAdminsSchema,
};