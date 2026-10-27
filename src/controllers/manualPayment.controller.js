import { createManualPaymentIntent, confirmManualPayment } from '../services/manualPayment.service.js';

export const initiateManualPaymentController = async (req, res) => {
  try {
    const { amount } = req.body;
    const result = await createManualPaymentIntent(req.params.token, amount);
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const confirmManualPaymentController = async (req, res) => {
  try {
    const { referenceCode, amountReceived } = req.body;
    const payment = await confirmManualPayment(referenceCode, amountReceived, req.user._id);
    return res.status(200).json({ success: true, message: "Payment recorded", data: payment });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

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

export const resendManualPaymentReceiptController = async (req, res) => {
  try {
    const result = await resendManualPaymentReceipt(req.params.id, req.user);
    return res.status(200).json({ success: true, message: "Receipt resend attempted", data: result });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json({ success: false, message: error.message, code: error.code || "INTERNAL_ERROR" });
  }
};

export default { recordManualPaymentController, resendManualPaymentReceiptController };
