import { recordManualPayment } from "../services/manualPayment.service.js";

/**
 * `POST /api/payments/record` — a payment taken at the bursar's desk.
 *
 * Wraps the service so the envelope and the error code are the same as every
 * other student-module controller: a client must be able to branch on `code`
 * without special-casing this route.
 */
export const recordManualPaymentController = async (req, res) => {
  try {
    const result = await recordManualPayment(req.body, req.user);
    return res.status(201).json({
      success: true,
      message: "Payment recorded",
      data: result,
    });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json({
        success: false,
        message: error.message,
        code: error.code || "INTERNAL_ERROR",
      });
  }
};

export default recordManualPaymentController;
