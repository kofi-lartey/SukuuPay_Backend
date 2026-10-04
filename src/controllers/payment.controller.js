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
import {
  getPaymentHistory,
  requestPaymentPlan,
  notifySchool,
  verifyPaymentByReference,
  buildParentReceipt,
} from "../services/pay.service.js";
import { generateReceiptPdf, receiptFilename } from "../utils/receiptService.js";
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

// ──────────────────── Public: Verify by portal reference ────────────────────

/**
 * `GET /pay/:token/verify/:reference` — the portal's poll while a parent approves
 * a Mobile Money prompt on their handset.
 *
 * Always `200`. A pending payment is not an error and a not-yet-created one is not
 * an error either: this endpoint exists to be called repeatedly on a slow network,
 * and a non-2xx would make the client treat "keep waiting" as "give up and show a
 * failure". The body carries the state and the HTTP status stays successful, which
 * is also what keeps the parent's browser from logging these as failed requests.
 *
 * The 404 case is the one exception and it is deliberate: a reference belonging to
 * *another* student resolves to nothing here, and saying so tells the caller the
 * reference is not theirs without confirming the payment exists at all.
 */
export const verifyPaymentByReferenceController = async (req, res) => {
  try {
    const result = await verifyPaymentByReference(req.params.token, req.params.reference);

    return res.status(200).json({
      success: true,
      message: "Payment status retrieved",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ──────────────────── Public: Payment history ────────────────────
export const getPaymentHistoryController = async (req, res) => {
  try {
    const result = await getPaymentHistory(req.params.token, {
      page: Number(req.query.page) || 1,
      perPage: Number(req.query.perPage) || 20,
    });

    return res.status(200).json({
      success: true,
      message: "Payment history retrieved",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ──────────────────── Public: Request a payment plan ────────────────────
export const requestPaymentPlanController = async (req, res) => {
  try {
    const result = await requestPaymentPlan(req.params.token, req.body);

    return res.status(201).json({
      success: true,
      // Written for a parent, not for a developer. "Request submitted" tells a
      // bursar something; what the parent needs to know is that a human will look
      // at it and they do not have to do anything yet.
      message: "Request submitted. The school will review and confirm your plan.",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ──────────────────── Public: Notify the school ────────────────────
export const notifySchoolController = async (req, res) => {
  try {
    const result = await notifySchool(req.params.token, {
      ...req.body,
      // `uploadParentAudio` puts the file on `req.file` and leaves `req.body` as the
      // text fields, so a multipart submission arrives here with both and needs no
      // special casing above this line. A JSON submission has no `req.file` and the
      // service treats the audio as absent.
      audio: req.file
        ? { buffer: req.file.buffer, mimetype: req.file.mimetype }
        : undefined,
      // Recorded on the message row and the audit entry. Taken from the raw socket
      // because `express.json()` runs before the controller and there is no trust
      // proxy setting behind this to say whether `req.ip` is the client or a hop.
      ip:
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket?.remoteAddress ||
        null,
    });

    // The wording is chosen against what actually happened. Three cases, three
    // different sentences, because the failure this replaced was a parent being told
    // "the school will be in touch" when no alert had left the building and nothing
    // had been recorded anywhere a human would look.
    let message;
    if (result.adminsNotified > 0) {
      message = result.hasAudio
        ? "Your voice note has been sent to the school."
        : "Your message has been sent to the school.";
    } else {
      message = result.schoolPhone
        ? "Your message has been saved. The school does not have an alert number set up, so please call them so they know to look."
        : "Your message has been saved. The school does not have an alert number set up, so please contact them so they know to look.";
    }

    return res.status(200).json({
      success: true,
      message,
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ──────────────────── Public: Download receipt PDF ────────────────────

/**
 * `GET /pay/:token/receipt/:paymentId` as a file.
 *
 * The same route also serves JSON, because the portal renders a receipt on screen
 * after a payment and a bursar's tooling reads it programmatically. Which one the
 * caller gets is negotiated on `Accept`, not on a second path — a parent clicking
 * "Download PDF" and a script fetching the receipt are the same request with
 * different intentions, and the intentions are exactly what the header carries.
 *
 * The JSON branch is kept first so the existing SPA and the admin tooling are
 * unaffected; `application/pdf` is only honoured when explicitly asked for.
 */
export const getReceiptDownloadController = async (req, res) => {
  const wantsPdf =
    String(req.query.download || '').toLowerCase() === 'pdf' ||
    String(req.headers.accept || '').includes('application/pdf');

  if (!wantsPdf) return getReceiptController(req, res);

  try {
    const { payment, student, school } = await buildParentReceipt(
      req.params.token,
      req.params.paymentId
    );

    const pdf = await generateReceiptPdf(payment, { student, school });
    const filename = receiptFilename(payment.receiptNumber, payment.paymentId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // A receipt is a document about one family's money. A cached copy in an
    // intermediary's disk, or in a shared phone's browser cache, outlives the
    // link it came from.
    res.setHeader('Cache-Control', 'private, no-store');

    return res.send(pdf);
  } catch (error) {
    // If the response has already begun, a JSON body would corrupt the download
    // rather than describe the failure — so the connection is simply closed.
    if (res.headersSent) return res.end();

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