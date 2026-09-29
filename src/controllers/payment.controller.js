import {
  getStudentByPayToken,
  initiatePayment,
  verifyPayment,
  getReceipt,
  listPayments,
  getPaymentDetail,
  generateReceipt,
  handleHubtelWebhook,
  refundPayment,
} from "../services/payment.service.js";

// ──────────────────── Public: Get student by pay token ────────────────────
export const getStudentByPayTokenController = async (req, res) => {
  try {
    const result = await getStudentByPayToken(req.params.token);

    return res.status(200).json({
      success: true,
      message: "Student details retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ──────────────────── Public: Initiate payment ────────────────────
export const initiatePaymentController = async (req, res) => {
  try {
    const result = await initiatePayment(req.params.token, req.body);

    return res.status(200).json({
      success: true,
      message: "Payment initiated successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ──────────────────── Public: Verify payment ────────────────────
export const verifyPaymentController = async (req, res) => {
  try {
    const result = await verifyPayment(req.params.token, req.body);

    return res.status(200).json({
      success: true,
      message: "Payment status retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ──────────────────── Public: Get receipt ────────────────────
export const getReceiptController = async (req, res) => {
  try {
    const result = await getReceipt(req.params.token, req.params.paymentId);

    return res.status(200).json({
      success: true,
      message: "Receipt retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ──────────────────── Admin: List payments ────────────────────
export const listPaymentsController = async (req, res) => {
  try {
    const result = await listPayments(req.query, req.user);

    return res.status(200).json({
      success: true,
      message: "Payments retrieved successfully",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ──────────────────── Admin: Get payment detail ────────────────────
export const getPaymentDetailController = async (req, res) => {
  try {
    const result = await getPaymentDetail(req.params.paymentId, req.query, req.user);

    return res.status(200).json({
      success: true,
      message: "Payment details retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ──────────────────── Admin: Generate/download receipt ────────────────────
export const getPaymentReceiptController = async (req, res) => {
  try {
    const result = await generateReceipt(req.params.paymentId, req.user);

    return res.status(200).json({
      success: true,
      message: "Receipt generated successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ──────────────────── Webhook: Hubtel callback ────────────────────
export const hubtelWebhookController = async (req, res) => {
  try {
    const result = await handleHubtelWebhook(req.body);

    // Always return 200 to Hubtel to acknowledge receipt
    return res.status(200).json(result);
  } catch (error) {
    console.error("Hubtel webhook error:", error);
    // Still return 200 to prevent Hubtel retries for processing errors
    return res.status(200).json({
      success: false,
      message: error.message,
    });
  }
};

// ──────────────────── Admin: Refund payment ────────────────────
export const refundPaymentController = async (req, res) => {
  try {
    const result = await refundPayment(req.params.paymentId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Payment refunded successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};