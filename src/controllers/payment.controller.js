import {
  getStudentByPayToken,
  initiatePayment,
  verifyPayment,
  getReceipt,
  listPayments,
  getPaymentSummary,
  exportPayments,
  getPaymentDetail,
  generateReceipt,
  handleHubtelWebhook,
  refundPayment,
} from "../services/payment.service.js";
import { streamCsv } from "../utils/csvWriter.js";

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

// ──────────────────── Admin: Payment summary (dashboard KPIs) ────────────────────
export const getPaymentSummaryController = async (req, res) => {
  try {
    const result = await getPaymentSummary(req.query, req.user);

    return res.status(200).json({
      success: true,
      message: "Payment summary retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ──────────────────── Admin: Export payments ────────────────────
// Streams the CSV straight to the response rather than buffering it, which is
// what `csvWriter` exists for. The service owns the columns and the rows so the
// list, the summary and the file cannot disagree about what the filter means.
export const exportPaymentsController = async (req, res) => {
  try {
    const result = await exportPayments(req.query, req.user);

    res.setHeader("Content-Type", result.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);

    // Writes the header row before any data row, so a filter that matched
    // nothing still returns a header-only file rather than an empty one that
    // opens as a single blank line.
    streamCsv(res, result.columns, result.rows);
  } catch (error) {
    // Once the header is on the wire the status line is already sent, so a JSON
    // error body would corrupt the download instead of describing the failure.
    if (!res.headersSent) {
      return res.status(error.status || 500).json({
        success: false,
        message: error.message,
      });
    }
    res.end();
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