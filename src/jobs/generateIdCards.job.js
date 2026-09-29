/**
 * Background job: generate a batch of student ID card PDFs.
 *
 * In production this would be enqueued via BullMQ or Agenda and processed by
 * a dedicated worker process.  For now it is invoked directly via
 * `setImmediate` from the ID card service, which is sufficient for moderate
 * batch sizes.  Replace the `setImmediate` call in `idCard.service.js` with a
 * real queue when volumes reach >200 cards per batch.
 */
import { generateIdCardPdf } from "../services/idCard.service.js";

/**
 * Processes a single batch: generates the PDF, uploads to Cloudinary, and
 * updates the batch document with the result.
 *
 * @param {string} batchId — MongoDB ObjectId of the IdCardBatch
 */
export const generateIdCards = async (batchId) => {
  console.log(`[ID-CARD-JOB] Starting batch ${batchId}`);

  try {
    await generateIdCardPdf(batchId);
    console.log(`[ID-CARD-JOB] Completed batch ${batchId}`);
  } catch (error) {
    console.error(`[ID-CARD-JOB] Failed batch ${batchId}:`, error.message);
    // The service layer already sets status to "failed" and emails the admin.
  }
};

export default generateIdCards;
