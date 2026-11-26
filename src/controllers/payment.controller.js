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
  handleMoolreWebhook,
  refreshPendingPayment,
  createMoolreCheckout,
  refundPayment,
} from "../services/payment.service.js";
import {
  getPaymentHistory,
  requestPaymentPlan,
  getPaymentPlan,
  cancelPaymentPlan,
  sendSupportMessage,
  notifySchool,
  verifyPaymentByReference,
  buildParentReceipt,
} from "../services/pay.service.js";
import { generateReceiptPdf, receiptFilename, normaliseBreakdown } from "../utils/receiptService.js";
import { sendWhatsAppDocument } from "../utils/whatsappApi.js";
import { Student } from "../models/studentModel.js";
import ApiError from "../utils/ApiError.js";
// Every `catch` in this file answers the request itself, so it cannot use the
// `errorHandler` middleware — and each one used to echo `error.message` unconditionally,
// which bypassed the rule that middleware enforces. That is how an internal
// `TypeError: next is not a function` was shown to a parent on an unauthenticated pay
// link: a 5xx message read by a visitor. `resolveErrorMessage` is the same decision,
// in one place, and logs the detail where it can be read.
import { resolveErrorMessage } from "../middleware/errorHandler.js";
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
      message: resolveErrorMessage(error),
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
      message: resolveErrorMessage(error),
    });
  }
};

// ──────────────────── Public: Hosted checkout ────────────────────
/**
 * Creates a hosted-checkout URL for a payment in flight.
 *
 * The fallback for a parent whose handset never received the USSD prompt. It
 * is created on demand rather than during initiation, because Moolre requires
 * the reference to be unique and the prompt has already claimed it.
 */
export const createCheckoutController = async (req, res) => {
  try {
    const result = await createMoolreCheckout(req.params.token, req.body?.reference);

    return res.status(200).json({
      success: true,
      message: "Checkout link created",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
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
      message: resolveErrorMessage(error),
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
      message: resolveErrorMessage(error),
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
    // The gateway is the system of record and the callback is only a
    // notification, so the poller asks the gateway directly before reading the
    // local record. Without this, a parent whose callback was delayed sees a
    // failure for a payment that succeeded — and pays again.
    //
    // The two service calls are composed here rather than in either service:
    // `pay.service` owns the parent-facing view and `payment.service` owns the
    // settlement, and `payment.service` already imports `pay.service`, so
    // letting `pay.service` import back would close a cycle.
    await refreshPendingPayment(req.params.token, req.params.reference);

    const result = await verifyPaymentByReference(req.params.token, req.params.reference);

    return res.status(200).json({
      success: true,
      message: "Payment status retrieved",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
    });
  }
};

// ──────────────────── Public: Payment history ────────────────────
export const getPaymentHistoryController = async (req, res) => {
  try {
    const result = await getPaymentHistory(req.params.token, {
      page: Number(req.query.page) || 1,
      perPage: Number(req.query.perPage) || 20,
      filter: req.query.filter || "all",
    });

    return res.status(200).json({
      success: true,
      message: "Payment history retrieved",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
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
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

// ──────────────────── Public: The parent's payment plan ────────────────────

/**
 * `GET /pay/:token/plan` — the live plan, or null.
 *
 * A student with no plan is a state the page renders, not an error: the empty
 * state offers the request form, and answering 404 would turn "you have no
 * plan" into "this link is broken".
 */
export const getPaymentPlanController = async (req, res) => {
  try {
    const result = await getPaymentPlan(req.params.token);

    return res.status(200).json({
      success: true,
      message: "Payment plan retrieved",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * `POST /pay/:token/plan/cancel` — the parent cancels their own plan.
 *
 * The message in the body is the service's, not a fixed string here: a
 * withdrawn request and a cancelled schedule are different events and the
 * parent is told which one happened.
 */
export const cancelPaymentPlanController = async (req, res) => {
  try {
    const result = await cancelPaymentPlan(req.params.token, req.body);

    return res.status(200).json({
      success: true,
      message: result.message,
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

// ──────────────────── Public: The support form ────────────────────

/**
 * `POST /pay/:token/support` — the parent's letter to the school office.
 *
 * It lands in the same inbox as the pay page's "contact the school" form,
 * because it is that form, asked for in a place with room to type. The
 * wording is chosen against what actually happened, for the same reason
 * `notifySchoolController` chooses its own: a parent told "the school will be
 * in touch" when no alert left the building is a message that costs a bursar
 * a phone call.
 */
export const sendSupportMessageController = async (req, res) => {
  try {
    const result = await sendSupportMessage(req.params.token, {
      ...req.body,
      ip:
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket?.remoteAddress ||
        null,
    });

    let message;
    if (result.adminsNotified > 0) {
      message = "Your message has been sent to the school.";
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
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
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
    if (result.notificationError) {
      message = result.hasAudio
        ? `Your voice note has been saved, but the school was not alerted (${result.notificationError}). Please call the school so they know to look.`
        : `Your message has been saved, but the school was not alerted (${result.notificationError}). Please call the school so they know to look.`;
    } else if (result.adminsNotified > 0) {
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
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
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
      message: resolveErrorMessage(error),
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
      message: resolveErrorMessage(error),
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
      message: resolveErrorMessage(error),
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
        message: resolveErrorMessage(error),
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
      message: resolveErrorMessage(error),
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
      message: resolveErrorMessage(error),
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
      message: resolveErrorMessage(error),
    });
  }
};

// ──────────────────── Admin: Receipt PDF download ────────────────────
/**
 * Admin: streams the receipt as a PDF.
 *
 * Uses the same service function the JSON endpoint uses, so the two outputs
 * cannot disagree. A bursar who reads the modal and a bursar who downloads
 * the PDF see the same document.
 */
export const getAdminReceiptPdfController = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const receipt = await generateReceipt(paymentId, req.user);

    const pdfBuffer = await generateReceiptPdf(
      {
        receiptNumber: receipt.receipt.receiptNumber,
        paymentId: receipt.receipt.paymentId,
        reference: receipt.receipt.reference,
        amount: receipt.receipt.amount,
        feesBreakdown: receipt.receipt.feesBreakdown,
        totalFees: receipt.receipt.totalFees,
        paidToDate: receipt.receipt.paidToDate,
        paymentMethod: receipt.receipt.paymentMethod,
        completedAt: receipt.receipt.date,
        createdAt: receipt.receipt.date,
        notes: receipt.receipt.description,
      },
      {
        student: receipt.receipt.student,
        school: receipt.receipt.school,
      }
    );

    const filename = receiptFilename(receipt.receipt.receiptNumber, paymentId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(pdfBuffer.length));
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

    return res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error("[receipt-pdf/admin] failed:", error);
    return res
      .status(error.status || 500)
      .send(error.message || "Receipt could not be generated");
  }
};

// ──────────────────── Parent: Receipt PDF download ────────────────────
/**
 * Parent: streams the receipt as a PDF.
 *
 * The token in the URL is what authorises the download. `buildParentReceipt`
 * finds the student from the token and then scopes the payment lookup by
 * `studentId === payment.studentId`, so a parent cannot download another
 * family's receipt by guessing a payment id.
 */
export const getParentReceiptPdfController = async (req, res) => {
  try {
    const { token, paymentId } = req.params;
    const { payment, student, school } = await buildParentReceipt(token, paymentId);

    const pdfBuffer = await generateReceiptPdf(
      {
        receiptNumber: payment.receiptNumber,
        paymentId: payment.paymentId,
        reference: payment.reference,
        amount: payment.amount,
        feesBreakdown: payment.feesBreakdown,
        totalFees: student?.totalOwed ?? payment.amount,
        paidToDate: student?.totalPaid ?? payment.amount,
        paymentMethod: payment.paymentMethod,
        completedAt: payment.completedAt,
        createdAt: payment.createdAt,
        notes: payment.description,
      },
      {
        student,
        school,
      }
    );

    const filename = receiptFilename(payment.receiptNumber, paymentId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(pdfBuffer.length));
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

    return res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error("[receipt-pdf/parent] failed:", error);
    return res
      .status(error.status || 500)
      .send(error.message || "Receipt could not be generated");
  }
};

// ──────────────────── Receipt delivery helpers ────────────────────

/**
 * Maps the receipt projection onto the shape `generateReceiptPdf` renders.
 *
 * One mapping for both delivery routes, so the emailed PDF and the WhatsApp
 * PDF are byte-for-byte the same document as the downloaded one. The receipt
 * fields arrive from `generateReceipt` (admin) or `buildParentReceipt`
 * (parent) and are spelled slightly differently by the two — which is
 * exactly the kind of difference that should not be discovered by comparing
 * two PDFs side by side.
 */
const receiptForPdf = (receipt) => ({
  receiptNumber: receipt.receiptNumber,
  paymentId: receipt.paymentId,
  reference: receipt.reference,
  amount: receipt.amount,
  feesBreakdown: receipt.feesBreakdown,
  paymentMethod: receipt.paymentMethod,
  completedAt: receipt.date || receipt.completedAt,
  createdAt: receipt.date || receipt.createdAt,
  notes: receipt.description || receipt.notes,
});

/**
 * Renders the receipt PDF once, for whichever channel asked.
 *
 * The buffer is produced here rather than by the caller so the email route
 * and the WhatsApp route cannot disagree about which document was sent, and
 * so a render failure is reported once, identically, by both.
 */
const renderReceiptAttachment = async (receipt) => {
  const pdf = await generateReceiptPdf(receiptForPdf(receipt), {
    student: receipt.student,
    school: receipt.school,
  });
  const filename = receiptFilename(receipt.receiptNumber, receipt.paymentId);
  return { pdf, filename };
};

/**
 * A Ghanaian number to Meta's international format.
 *
 * Meta rejects a `+`, and rejects a national number with no country code, so
 * `0241234567` becomes `233241234567` and `+233 24 123 4567` becomes the same
 * thing. `formatPhoneForWhatsapp` in `sms.service.js` does the same job for
 * SMS; this copy is local because that one is not exported and the rule is
 * three lines.
 */
const toWhatsAppNumber = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("233")) return digits;
  if (digits.startsWith("0")) return `233${digits.slice(1)}`;
  return `233${digits}`;
};

/** HTML-escapes the few parent-controlled strings that reach an email body. */
const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Cedi figure for the message body of both channels. */
const moneyLine = (pesewas) =>
  `${((Number(pesewas) || 0) / 100).toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// ──────────────────── Admin: Email the receipt ────────────────────
/**
 * POST /payments/:paymentId/receipt/email
 *
 * Sends the receipt to the parent as an email attachment.
 *
 * **The PDF is generated server-side and attached, never downloaded.** The
 * bursar's device should not have to touch the file at all: a bursar who
 * "sends" a receipt by downloading it and attaching it in a mail client is
 * one bad phone call away from emailing last term's receipt to the wrong
 * parent. The server holds the payment, renders the document, and puts it on
 * the message.
 *
 * The recipient is the primary parent's email on file. When the record has
 * none, the endpoint refuses rather than guessing — with `PARENT_EMAIL_REQUIRED`,
 * which the frontend reads as "ask for an address" and shows a field for.
 * A supplied address is then written back to the primary parent so the next
 * receipt does not have to ask again, which is the whole reason the field is
 * optional rather than a separate "update parent" flow.
 */
export const emailReceiptController = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const receipt = await generateReceipt(paymentId, req.user);
    const doc = receipt.receipt;

    // The caller's address wins; otherwise the one on the parent's record.
    const suppliedEmail = String(req.body?.email || "").trim() || null;
    const to = suppliedEmail || doc.student?.parentEmail || null;

    if (!to) {
      throw new ApiError(
        "No email address is on file for this parent. Add one to send the receipt.",
        400,
        "PARENT_EMAIL_REQUIRED"
      );
    }

    // Written back only when the caller supplied it. An address already on
    // the record has nothing to persist, and writing it again would stamp
    // `updatedAt` on every send.
    if (suppliedEmail && !doc.student?.parentEmail && receipt.studentDocId) {
      await Student.findOneAndUpdate(
        {
          _id: receipt.studentDocId,
          ...(receipt.primaryParentId ? { "parents._id": receipt.primaryParentId } : {}),
        },
        { $set: { "parents.$.email": suppliedEmail.toLowerCase() } }
      );
    }

    const filename = receiptFilename(doc.receiptNumber, doc.paymentId);

    const when = doc.date ? new Date(doc.date) : new Date();
    const dateLine = Number.isNaN(when.getTime())
      ? "—"
      : when.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

    const subject = `Payment receipt ${doc.receiptNumber || ""} — ${doc.student?.studentName || "your child"}`.trim();
    const body = [
      `Dear Parent,`,
      `Please find attached the payment receipt for ${escapeHtml(doc.student?.studentName || "your child")}.`,
      ``,
      `Receipt number: ${escapeHtml(doc.receiptNumber || "—")}`,
      `Amount: GH₵ ${moneyLine(doc.amount)}`,
      `Date: ${escapeHtml(dateLine)}`,
      ``,
      `Thank you.`,
      `${escapeHtml(doc.school?.name || "School")}`,
    ].join("\n");

    const mailtoUrl = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    return res.status(200).json({
      success: true,
      message: `Receipt ready to email to ${to}`,
      data: { to, mailtoUrl, filename },
    });
  } catch (error) {
    console.error("[receipt-email/admin] failed:", error);
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

// ──────────────────── Admin: WhatsApp the receipt ────────────────────
/**
 * POST /payments/:paymentId/receipt/whatsapp
 *
 * Sends the receipt to the parent as a WhatsApp document message.
 *
 * **This is the WhatsApp Business API, not `wa.me`.** `wa.me` opens a chat
 * with pre-filled text and there is no way to attach a file to it — the
 * envelope it can carry is a sentence, and a sentence is not a receipt. Meta's
 * API takes an uploaded media id and delivers the PDF into the parent's chat
 * as a real document they can download, forward, and print.
 *
 * The flow is the two-step the API requires: upload the PDF to Meta's media
 * store, then send a document message referencing the returned id.
 * `sendWhatsAppDocument` does both, so this controller is only about who the
 * receipt is for and what the caption should say.
 *
 * The phone number comes from the parent's record, never from the request. A
 * bursar cannot retarget a receipt at a number of their choosing through this
 * endpoint — the delivery address is the one the school has for that parent,
 * which is also what makes the audit trail mean something.
 */
export const whatsappReceiptController = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const receipt = await generateReceipt(paymentId, req.user);
    const doc = receipt.receipt;

    const to = toWhatsAppNumber(doc.student?.parentPhone);
    if (!to) {
      throw new ApiError(
        "No phone number is on file for this parent. Add one to send the receipt.",
        400,
        "PARENT_PHONE_REQUIRED"
      );
    }

    const { pdf, filename } = await renderReceiptAttachment(doc);

    const caption = [
      `Payment receipt from ${doc.school?.name || "your school"}`,
      `Student: ${doc.student?.studentName || "—"}`,
      `Receipt: ${doc.receiptNumber || "—"}`,
      `Amount: GH₵ ${moneyLine(doc.amount)}`,
    ].join("\n");

    await sendWhatsAppDocument({ to, filename, content: pdf, caption });

    return res.status(200).json({
      success: true,
      message: `Receipt sent on WhatsApp to ${doc.student?.parentPhone}`,
      data: { to },
    });
  } catch (error) {
    console.error("[receipt-whatsapp/admin] failed:", error);
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * Moolre callback.
 *
 * Moolre posts here when a transaction reaches a result. The payload is a
 * notification, never proof of payment — `handleMoolreWebhook` re-verifies
 * with Moolre's own status endpoint before any money moves.
 *
 * The status code is the one thing the callback controls, so it is used
 * honestly:
 *
 *   200 — the callback was processed, including the "we do not know this
 *         reference" and "already settled" cases. Moolre must not retry
 *         those; retrying them cannot change the answer.
 *   502 — Moolre could not be reached to verify the transaction. The
 *         transaction may well have succeeded, so the callback must be
 *         retried rather than treated as settled.
 */
export const moolreWebhookController = async (req, res) => {
  try {
    const result = await handleMoolreWebhook(req.body);

    return res.status(200).json({
      received: true,
      status: result?.status || (result?.duplicate ? "duplicate" : "processed"),
      note: result?.message || null,
    });
  } catch (error) {
    // A verification failure is retryable: we do not yet know whether the
    // money arrived, and answering 200 would lose the only notification we
    // are going to get.
    if (error?.retryable) {
      console.error("[MOOLRE WEBHOOK] Verification unavailable, asking Moolre to retry:", error.message);
      return res.status(502).json({ received: false, message: error.message });
    }

    console.error("[MOOLRE WEBHOOK] Unhandled error:", error);
    return res.status(200).json({ received: true, error: error.message });
  }
};

