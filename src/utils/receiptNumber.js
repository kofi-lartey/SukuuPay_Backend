import { Counter } from "../models/counterModel.js";

/**
 * The receipt number for a payment.
 *
 * ## Why a counter and not a count
 *
 * The number used to be `RCP-<today>-<how many receipts this school has issued
 * today + 1>`, which is a read-then-write race: two payments settling in the
 * same moment both read the same count, both write the same number, and one of
 * them dies on the unique index — with the money already taken and the payment
 * left unsettled. This is the same defect `counterModel.js` exists to prevent,
 * and the same one `manualPayment.service.js` documents for the manual-payment
 * id ("two bursars recording cash at the same moment would produce the same
 * `paymentId` and trip the unique index on one of them").
 *
 * `Counter.findOneAndUpdate({key},{$inc:{seq:1}},{upsert:true})` is a single
 * atomic document operation, so two concurrent callers are guaranteed distinct
 * numbers.
 *
 * ## The key
 *
 * `receipt:<schoolId>:<YYYYMMDD>` — one sequence per school per day, so the
 * number still reads as "the school's fourth receipt today", and two schools
 * cannot mint the same one.
 */
export const receiptNumberFor = (dateStr, seq) =>
  `RCP-${dateStr}-${String(seq).padStart(4, "0")}`;

/**
 * Mint the next receipt number for a school on a day.
 *
 * @param {string} schoolId the school's id — the sequence is per school
 * @param {Date} [at] the day the receipt belongs to; defaults to now
 * @returns {Promise<string>} e.g. `RCP-20261019-0004`
 */
export const nextReceiptNumber = async (schoolId, at = new Date()) => {
  if (!schoolId) {
    throw new Error("Cannot generate a receipt number: the school id is missing");
  }

  const dateStr = at.toISOString().slice(0, 10).replace(/-/g, "");
  const key = `receipt:${schoolId}:${dateStr}`;

  // `upsert` creates the counter on first use; a simultaneous upsert from
  // another process throws a duplicate-key error, which is the signal to
  // retry — the counter itself is unique.
  let doc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      doc = await Counter.findOneAndUpdate(
        { key },
        { $inc: { seq: 1 } },
        { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
      );
      break;
    } catch (error) {
      if (error?.code === 11000 && attempt < 2) continue;
      throw error;
    }
  }

  if (!doc) {
    throw new Error("Could not allocate a receipt number counter");
  }

  return receiptNumberFor(dateStr, doc.seq);
};

export default nextReceiptNumber;
