import mongoose from "mongoose";
import { Payment } from "../models/paymentModel.js";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import { buildPayLink } from "../utils/generatePayLink.js";
import { applyCompletedPaymentToPlan } from "./paymentPlan.service.js";
import {
  requestToPay as mtnRequestToPay,
  getTransactionStatus as mtnGetTransactionStatus,
  normaliseTransaction,
  mapMtnStatus,
  isAccountActive as mtnIsAccountActive,
  MtnTransportError,
} from "../utils/mtnApi.js";
import { resolveGateway } from "../utils/paymentGateway.js";
import { WEBHOOK_BASE_URL } from "../config/env.js";

class ApiError extends Error {
  constructor(message, status = 500, code = "INTERNAL_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

const auditService = {
  log: async ({ action, entity, entityId, userId, details }) => {
    console.log(`[AUDIT] ${action} | ${entity}:${entityId} | User:${userId} |`, details);
  },
};

const fetchSchool = async (schoolId) => {
  const school = await School.findById(schoolId)
    .select("schoolCode name payment hubtelClientId hubtelClientSecret hubtelApiKey")
    .lean();
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");
  return school;
};

// ──────────────────── Gateway selection ────────────────────
// MTN is the primary gateway for v1; Hubtel is the fallback. Selection lives in
// utils/paymentGateway.js so the plan-prepay path can share it without importing
// this module (the two already import each other).
const hubtelIsConfigured = (school) =>
  Boolean(
    school?.payment?.hubtelClientId &&
    school?.payment?.hubtelClientSecret &&
    school?.payment?.hubtelApiKey
  );

// ──────────────────── Helper: Generate Hubtel payment request ────────────────────
const buildHubtelPaymentRequest = (school, payment, callbackUrl) => {
  const clientId = school.payment?.hubtelClientId || school.payment?.hubtelClientId;
  const clientSecret = school.payment?.hubtelClientSecret || school.payment?.hubtelClientSecret;
  const apiKey = school.payment?.hubtelApiKey;

  if (!clientId || !clientSecret || !apiKey) {
    throw new ApiError("School payment credentials not configured", 400, "PAYMENT_CONFIG_MISSING");
  }

  return {
    clientId,
    clientSecret,
    apiKey,
    amount: payment.amount / 100, // Hubtel expects amount in cedis, we store in pesewas
    customerPhone: payment.momoPhoneNumber,
    customerEmail: payment.parentEmail || "",
    customerName: payment.studentName || "Parent",
    callbackUrl,
    returnUrl: `${callbackUrl}/return`,
    description: payment.description || `Payment for ${payment.studentName}`,
    clientReference: payment.paymentId,
  };
};

// ──────────────────── Public: Get student by pay token ────────────────────
export const getStudentByPayToken = async (token) => {
  const student = await Student.findOne({ uniquePayLinkToken: token, deletedAt: null })
    .select("studentId studentName studentClass totalOwed totalPaid balance deadline schoolId parents")
    .populate("schoolId", "name schoolCode")
    .lean();

  if (!student) {
    throw new ApiError("Invalid or expired payment link", 404, "INVALID_PAY_TOKEN");
  }

  // Mask parent phone numbers
  if (student.parents) {
    student.parents = student.parents.map((p) => ({
      ...p,
      phone: p.phone ? p.phone.replace(/(\d{3})\d{4}(\d{2})/, "$1****$2") : p.phone,
    }));
  }

  return {
    student: {
      id: student._id,
      studentId: student.studentId,
      studentName: student.studentName,
      studentClass: student.studentClass,
      totalOwed: student.totalOwed,
      totalPaid: student.totalPaid,
      balance: student.balance,
      deadline: student.deadline,
      school: student.schoolId,
    },
    payLink: buildPayLink(token),
  };
};

// ──────────────────── Public: Initiate payment ────────────────────
export const initiatePayment = async (token, data) => {
  const student = await Student.findOne({ uniquePayLinkToken: token, deletedAt: null });
  if (!student) {
    throw new ApiError("Invalid or expired payment link", 404, "INVALID_PAY_TOKEN");
  }

  if (student.status !== "active") {
    throw new ApiError("Student account is not active", 400, "STUDENT_NOT_ACTIVE");
  }

  const school = await fetchSchool(student.schoolId);

  // Find primary parent for contact info
  const primaryParent = (student.parents || []).find((p) => p.isPrimary) || student.parents?.[0];

  const gateway = resolveGateway(school);

  // Create payment record
  const payment = await Payment.create({
    studentId: student._id,
    schoolId: student.schoolId,
    parentId: primaryParent?._id || null,
    amount: data.amount,
    currency: "GHS",
    status: "pending",
    paymentMethod: "momo",
    provider: gateway,
    momoPhoneNumber: data.phoneNumber || primaryParent?.phone,
    momoNetwork: data.momoNetwork || "UNKNOWN",
    description: data.description || `School fees payment for ${student.studentName}`,
    feesBreakdown: data.feesBreakdown || [],
    createdBy: student.createdBy,
  });

  if (gateway === "mtn") {
    return initiateMtnPayment(payment, student, school, token);
  }

  return initiateHubtelPayment(payment, student, school, token);
};

// ──────────────────── MTN: initiate ────────────────────
/**
 * Charges the payer through MTN Collections (Request To Pay).
 *
 * The payer is prompted on their handset and authorises the debit; the money
 * only moves once they do, so the Payment stays `processing` until the callback
 * or a status poll settles it. `X-Reference-Id` is the paymentId, which makes a
 * client retry of the same payment replay rather than debit twice.
 */
const initiateMtnPayment = async (payment, student, school, token) => {
  const phone = payment.momoPhoneNumber;

  if (!phone) {
    payment.status = "failed";
    payment.failureReason = "No phone number on file for the payer";
    await payment.save();
    throw new ApiError(
      "No phone number on file for this payer",
      400,
      "PAYER_PHONE_MISSING"
    );
  }

  try {
    const result = await mtnRequestToPay({
      amount: payment.amount,
      phone,
      externalId: payment.paymentId,
      referenceId: payment.paymentId,
      payerMessage: `Payment for ${student.studentName}`,
      payeeNote: payment.description,
    });

    payment.status = "processing";
    payment.mtnReferenceId = result?.referenceId || null;
    payment.mtnResponseCode = String(result?.status || "").toUpperCase() || "PENDING";
    await payment.save();

    await auditService.log({
      action: "INITIATE_PAYMENT",
      entity: "Payment",
      entityId: payment._id,
      userId: student.createdBy,
      details: {
        paymentId: payment.paymentId,
        amount: payment.amount,
        studentId: student.studentId,
        provider: "mtn",
        referenceId: payment.mtnReferenceId,
      },
    });

    return {
      payment: payment.toJSON(),
      provider: "mtn",
      // The parent must authorise on their handset; there is no server-side
      // confirmation to wait for.
      requiresPayerApproval: true,
      mtn: {
        referenceId: payment.mtnReferenceId,
        status: payment.mtnResponseCode,
        payerPhone: phone,
      },
      payLink: buildPayLink(token),
    };
  } catch (error) {
    // A rejected initiation is terminal: no prompt was issued, so the payment
    // must not be left pending for a callback that will never arrive.
    payment.status = "failed";
    payment.mtnResponseMessage = error.message?.slice(0, 500) || "MTN request failed";
    await payment.save();

    if (error instanceof MtnTransportError) {
      throw new ApiError(error.message, error.status, error.code);
    }
    throw error;
  }
};

// ──────────────────── Hubtel: initiate (fallback) ────────────────────
/**
 * Builds the Hubtel request and moves the payment to `processing`.
 *
 * Retained unchanged as the fallback path: the Hubtel callback
 * (POST /pay/webhook/hubtel) and its settlement handler are untouched.
 */
const initiateHubtelPayment = async (payment, student, school, token) => {
  // Backend origin, not PAY_LINK_BASE_URL: this is a server-to-server POST from
  // Hubtel, and the route is mounted at /api/webhooks/... (plural). Building this
  // from the frontend base produced a URL Hubtel could never reach.
  const callbackUrl = `${WEBHOOK_BASE_URL}/api/webhooks/hubtel/payment`;
  const hubtelRequest = buildHubtelPaymentRequest(school, payment, callbackUrl);

  // TODO: replace with the live Hubtel initialize-payment call. The request
  // payload is assembled here so the integration point is explicit; the
  // webhook drives the actual application of the payment.
  payment.status = "processing";
  payment.hubtelOrderId = `ORDER-${payment.paymentId}`;
  await payment.save();

  await auditService.log({
    action: "INITIATE_PAYMENT",
    entity: "Payment",
    entityId: payment._id,
    userId: student.createdBy,
    details: {
      paymentId: payment.paymentId,
      amount: payment.amount,
      studentId: student.studentId,
      provider: "hubtel",
    },
  });

  return {
    payment: payment.toJSON(),
    provider: "hubtel",
    hubtelRequest,
    payLink: buildPayLink(token),
  };
};

// ──────────────────── Public: Verify payment ────────────────────
export const verifyPayment = async (token, data) => {
  const student = await Student.findOne({ uniquePayLinkToken: token, deletedAt: null });
  if (!student) {
    throw new ApiError("Invalid or expired payment link", 404, "INVALID_PAY_TOKEN");
  }

  // Find the most recent pending/processing payment for this student
  const filter = {
    studentId: student._id,
    status: { $in: ["pending", "processing"] },
  };

  if (data.hubtelTransactionId) filter.hubtelTransactionId = data.hubtelTransactionId;
  if (data.hubtelOrderId) filter.hubtelOrderId = data.hubtelOrderId;
  if (data.mtnReferenceId) filter.mtnReferenceId = data.mtnReferenceId;

  const payment = await Payment.findOne(filter).sort({ createdAt: -1 });
  if (!payment) {
    throw new ApiError("No pending payment found for verification", 404, "PAYMENT_NOT_FOUND");
  }

  // An MTN payment is settled by polling the provider's status endpoint, which
  // is the system of record — the callback is only a notification. Polling here
  // lets the parent's browser confirm a prompt they have already approved.
  if (payment.provider === "mtn" && payment.mtnReferenceId) {
    try {
      const raw = await mtnGetTransactionStatus(payment.mtnReferenceId);
      const transaction = normaliseTransaction(raw);
      const mapped = mapMtnStatus(transaction?.status);
      if (mapped && mapped !== payment.status) {
        await applyMtnStatus(payment, transaction, mapped);
        return payment.toJSON();
      }
    } catch (error) {
      // A provider outage must not surface as a payment failure; the stored
      // state remains authoritative until the next poll.
      console.error(`[MTN] Status poll failed for ${payment.paymentId}:`, error.message);
    }
    return payment.toJSON();
  }

  // TODO: Hubtel verification API. For now, return the current payment status.
  return payment.toJSON();
};

// ──────────────────── Public: Get receipt ────────────────────
export const getReceipt = async (token, paymentId) => {
  const student = await Student.findOne({ uniquePayLinkToken: token, deletedAt: null });
  if (!student) {
    throw new ApiError("Invalid or expired payment link", 404, "INVALID_PAY_TOKEN");
  }

  const payment = await Payment.findOne({
    paymentId,
    studentId: student._id,
    status: "completed",
  });

  if (!payment) {
    throw new ApiError("Receipt not found", 404, "RECEIPT_NOT_FOUND");
  }

  const school = await fetchSchool(student.schoolId);

  return {
    receipt: {
      receiptNumber: payment.receiptNumber,
      paymentId: payment.paymentId,
      date: payment.completedAt,
      student: {
        studentId: student.studentId,
        studentName: student.studentName,
        studentClass: student.studentClass,
      },
      school: {
        name: school.name,
        schoolCode: school.schoolCode,
        address: school.address,
        city: school.city,
        region: school.region,
      },
      amount: payment.amount,
      currency: payment.currency,
      paymentMethod: payment.paymentMethod,
      description: payment.description,
      feesBreakdown: payment.feesBreakdown,
    },
  };
};

// ──────────────────── Admin: List payments ────────────────────
export const listPayments = async (query, user) => {
  const schoolId = user.role === "super_admin" && query.schoolId
    ? new mongoose.Types.ObjectId(query.schoolId)
    : user.schoolId
      ? new mongoose.Types.ObjectId(user.schoolId)
      : null;

  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const filter = { schoolId, deletedAt: null };
  if (query.studentId) filter.studentId = new mongoose.Types.ObjectId(query.studentId);
  if (query.status && query.status !== "all") filter.status = query.status;
  if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
  if (query.provider) filter.provider = query.provider;

  if (query.startDate || query.endDate) {
    filter.createdAt = {};
    if (query.startDate) filter.createdAt.$gte = new Date(query.startDate);
    if (query.endDate) filter.createdAt.$lte = new Date(query.endDate);
  }

  if (query.minAmount || query.maxAmount) {
    filter.amount = {};
    if (query.minAmount) filter.amount.$gte = query.minAmount;
    if (query.maxAmount) filter.amount.$lte = query.maxAmount;
  }

  if (query.search) {
    filter.$or = [
      { paymentId: { $regex: query.search, $options: "i" } },
      { hubtelTransactionId: { $regex: query.search, $options: "i" } },
      { receiptNumber: { $regex: query.search, $options: "i" } },
    ];
  }

  const sortBy = query.sortBy || "createdAt";
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;
  const skip = (Number(query.page) - 1) * Number(query.limit);

  const [payments, total] = await Promise.all([
    Payment.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(Number(query.limit))
      .populate("studentId", "studentId studentName studentClass")
      .lean(),
    Payment.countDocuments(filter),
  ]);

  return {
    data: payments,
    meta: {
      page: Number(query.page),
      limit: Number(query.limit),
      total,
      totalPages: Math.ceil(total / Number(query.limit)),
    },
  };
};

// ──────────────────── Admin: Get payment detail ────────────────────
export const getPaymentDetail = async (paymentId, query, user) => {
  const schoolId = user.role === "super_admin"
    ? null
    : user.schoolId
      ? new mongoose.Types.ObjectId(user.schoolId)
      : null;

  if (!schoolId && user.role !== "super_admin") {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const filter = { paymentId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;

  const payment = await Payment.findOne(filter)
    .populate("studentId", "studentId studentName studentClass schoolId parents")
    .populate("schoolId", "name schoolCode")
    .lean();

  if (!payment) {
    throw new ApiError("Payment not found", 404, "NOT_FOUND");
  }

  // Optionally include webhook payload
  if (!query.includeWebhookData) {
    delete payment.webhookPayload;
  }

  return payment;
};

// ──────────────────── Admin: Generate receipt ────────────────────
export const generateReceipt = async (paymentId, user) => {
  const schoolId = user.role === "super_admin"
    ? null
    : user.schoolId
      ? new mongoose.Types.ObjectId(user.schoolId)
      : null;

  if (!schoolId && user.role !== "super_admin") {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const filter = { paymentId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;

  const payment = await Payment.findOne(filter)
    .populate("studentId", "studentId studentName studentClass")
    .populate("schoolId", "name schoolCode address city region")
    .lean();

  if (!payment) {
    throw new ApiError("Payment not found", 404, "NOT_FOUND");
  }

  if (payment.status !== "completed") {
    throw new ApiError("Can only generate receipt for completed payments", 400, "INVALID_PAYMENT_STATUS");
  }

  // Generate receipt number if not exists
  if (!payment.receiptNumber) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const count = await Payment.countDocuments({
      schoolId: payment.schoolId._id,
      status: "completed",
      createdAt: {
        $gte: new Date(new Date().setHours(0, 0, 0, 0)),
        $lt: new Date(new Date().setHours(23, 59, 59, 999)),
      },
    });
    payment.receiptNumber = `RCP-${dateStr}-${String(count + 1).padStart(4, "0")}`;
    payment.receiptGeneratedAt = new Date();
    await Payment.findByIdAndUpdate(payment._id, {
      receiptNumber: payment.receiptNumber,
      receiptGeneratedAt: payment.receiptGeneratedAt,
    });
  }

  return {
    receipt: {
      receiptNumber: payment.receiptNumber,
      paymentId: payment.paymentId,
      date: payment.completedAt,
      student: {
        studentId: payment.studentId.studentId,
        studentName: payment.studentId.studentName,
        studentClass: payment.studentId.studentClass,
      },
      school: {
        name: payment.schoolId.name,
        schoolCode: payment.schoolId.schoolCode,
        address: payment.schoolId.address,
        city: payment.schoolId.city,
        region: payment.schoolId.region,
      },
      amount: payment.amount,
      currency: payment.currency,
      paymentMethod: payment.paymentMethod,
      description: payment.description,
      feesBreakdown: payment.feesBreakdown,
    },
  };
};

// ──────────────────── Hubtel Webhook Handler ────────────────────
// Settlement is claimed before the balance moves. `Payment.settlement.appliedAt`
// is set with a conditional update, so of N retries of the same "Success"
// callback exactly one proceeds to the $inc below; the rest return a duplicate
// acknowledgement and leave the parent's balance alone.
export const claimPaymentSettlement = async (payment) => {
  const claim = await Payment.findOneAndUpdate(
    { _id: payment._id, "settlement.appliedAt": null },
    { $set: { "settlement.appliedAt": new Date() } },
    { new: true }
  );

  if (!claim) return null;
  // Keep the in-memory document consistent, so the save() below does not write
  // the stale null back over the claim.
  payment.settlement = payment.settlement || {};
  payment.settlement.appliedAt = claim.settlement.appliedAt;
  return claim;
};

/** Releases a claim whose settlement failed, so a provider retry can retry it. */
export const releasePaymentSettlement = async (paymentId) => {
  await Payment.updateOne({ _id: paymentId }, { $set: { "settlement.appliedAt": null } });
};

// ──────────────────── MTN: settlement ────────────────────

/**
 * Applies an MTN transaction state to a payment, moving the student's balance
 * only on settlement.
 *
 * The settlement claim is taken before the balance moves, exactly as in the
 * Hubtel path: MTN delivers the same "SUCCESSFUL" callback more than once, and
 * without the claim each delivery would re-run the `$inc` and credit the parent
 * several times over.
 */
const applyMtnStatus = async (payment, transaction, mappedStatus) => {
  const isSettlement = mappedStatus === "completed";

  if (isSettlement) {
    const claim = await claimPaymentSettlement(payment);
    if (!claim) {
      return { duplicate: true };
    }
  }

  payment.mtnStatusReason = transaction?.statusReason || null;
  payment.mtnFinancialTransactionId =
    transaction?.financialTransactionId || payment.mtnFinancialTransactionId;

  if (isSettlement) {
    payment.status = "completed";
    payment.completedAt = new Date();
    payment.settlement.reference =
      transaction?.financialTransactionId || payment.settlement?.reference || null;

    try {
      await Student.findByIdAndUpdate(payment.studentId, {
        $inc: { totalPaid: payment.amount, balance: -payment.amount },
      });

      await School.findByIdAndUpdate(payment.schoolId, {
        $inc: { "stats.totalPaymentsThisMonth": payment.amount },
      });
    } catch (error) {
      // Releasing the claim lets the next callback or poll settle this payment
      // rather than leaving it completed-but-uncounted.
      await releasePaymentSettlement(payment._id);
      throw error;
    }
  } else if (mappedStatus === "failed") {
    payment.status = "failed";
    payment.failedAt = new Date();
    payment.failureReason = transaction?.statusReason?.slice(0, 500) || "Reported failed by MTN";
  } else if (mappedStatus === "refunded") {
    // A provider-side reversal returned the money to the payer. It is terminal
    // and must never be treated as a settlement.
    payment.status = "refunded";
    payment.refundedAt = new Date();
  } else if (mappedStatus === "processing") {
    payment.status = "processing";
  }

  await payment.save();

  if (isSettlement && payment.paymentPlanId) {
    await applyCompletedPaymentToPlan(payment);
  }

  return { duplicate: false, payment };
};

/**
 * Handles an MTN transaction result, from either the callback or a status poll.
 *
 * Accepts the payload in both the bare transaction shape and the
 * `{ status, ... }` envelope MTN posts to the callback URL, so the two ingress
 * paths cannot diverge.
 */
export const handleMtnResult = async (rawPayload) => {
  const transaction = normaliseTransaction(rawPayload?.data || rawPayload);
  if (!transaction?.referenceId && !transaction?.externalId) {
    throw new ApiError("No valid payment reference in payload", 400, "INVALID_WEBHOOK_PAYLOAD");
  }

  const filter = { deletedAt: null };
  if (transaction.referenceId) filter.mtnReferenceId = transaction.referenceId;
  else filter.mtnFinancialTransactionId = transaction.financialTransactionId;
  // The externalId is our paymentId, so a callback that omits MTN's own
  // reference can still be matched.
  if (Object.keys(filter).length === 1 && transaction.externalId) {
    filter.paymentId = transaction.externalId;
  }

  const payment = await Payment.findOne(filter);
  if (!payment) {
    console.warn("[MTN-WEBHOOK] Payment not found for payload:", transaction);
    // Acknowledged rather than retried: MTN will redeliver a reference this
    // deployment never issued, and a retry loop turns that into a support
    // incident.
    return { success: true, message: "Payment not found in system" };
  }

  const mapped = mapMtnStatus(transaction.status);
  if (!mapped) {
    console.warn(`[MTN-WEBHOOK] Unmapped MTN status "${transaction.status}"`);
    return { success: true, message: "Status not recognised", payment: payment.toJSON() };
  }

  payment.webhookPayload = rawPayload;
  payment.webhookReceivedAt = new Date();

  const result = await applyMtnStatus(payment, transaction, mapped);
  if (result.duplicate) {
    return { success: true, duplicate: true, message: "Payment already settled", payment: payment.toJSON() };
  }

  await auditService.log({
    action: "WEBHOOK_RECEIVED",
    entity: "Payment",
    entityId: payment._id,
    userId: payment.createdBy,
    details: {
      provider: "mtn",
      status: transaction.status,
      transactionId: transaction.financialTransactionId,
      amount: transaction.amount,
    },
  });

  return { success: true, payment: payment.toJSON() };
};

/**
 * Whether an MSISDN is an active MTN MoMo account.
 *
 * Proactive check: an inactive number fails the debit at the provider, and
 * telling the parent before prompting is better than a payment left pending.
 */
export const checkMtnPayerActive = async (phone) => {
  try {
    const result = await mtnIsAccountActive(phone);
    return { active: result?.result === true, raw: result };
  } catch (error) {
    if (error instanceof MtnTransportError) {
      throw new ApiError(error.message, error.status, error.code);
    }
    throw error;
  }
};

export const handleHubtelWebhook = async (payload) => {
  const { Status, TransactionId, OrderId, Amount, Currency, MobileNumber, Network, ClientReference } = payload;

  // Find payment by hubtelTransactionId or hubtelOrderId or paymentId (ClientReference)
  const filter = { deletedAt: null };
  if (TransactionId) filter.hubtelTransactionId = TransactionId;
  else if (OrderId) filter.hubtelOrderId = OrderId;
  else if (ClientReference) filter.paymentId = ClientReference;
  else {
    throw new ApiError("No valid payment reference in webhook", 400, "INVALID_WEBHOOK_PAYLOAD");
  }

  const payment = await Payment.findOne(filter);
  if (!payment) {
    console.warn(`[WEBHOOK] Payment not found for payload:`, payload);
    // Return success to prevent Hubtel retries for unknown payments
    return { success: true, message: "Payment not found in system" };
  }

  if (Status === "Success") {
    // Claim first. A second delivery of a callback we already settled finds the
    // claim taken and stops here, so the student's totalPaid is never
    // incremented twice for one payment.
    const claim = await claimPaymentSettlement(payment);
    if (!claim) {
      return { success: true, duplicate: true, message: "Payment already settled", payment: payment.toJSON() };
    }
  }

  // Update payment with webhook data
  payment.webhookPayload = payload;
  payment.webhookReceivedAt = new Date();
  payment.hubtelTransactionId = TransactionId || payment.hubtelTransactionId;
  payment.hubtelOrderId = OrderId || payment.hubtelOrderId;
  payment.hubtelResponseMessage = payload.Message;

  if (Status === "Success") {
    payment.status = "completed";
    payment.completedAt = new Date();
    payment.momoPhoneNumber = MobileNumber || payment.momoPhoneNumber;
    payment.momoNetwork = Network || payment.momoNetwork;
    payment.settlement.reference = TransactionId || payment.settlement?.reference || null;

    try {
      // Update student balance
      await Student.findByIdAndUpdate(payment.studentId, {
        $inc: { totalPaid: payment.amount, balance: -payment.amount },
      });

      // Update school stats
      await School.findByIdAndUpdate(payment.schoolId, {
        $inc: { "stats.totalPaymentsThisMonth": payment.amount },
      });
    } catch (error) {
      // The claim is released so a provider retry settles this payment instead
      // of leaving it stuck as completed-but-uncounted.
      await releasePaymentSettlement(payment._id);
      throw error;
    }
  } else if (Status === "Failed") {
    payment.status = "failed";
    payment.failedAt = new Date();
  } else if (Status === "Pending") {
    payment.status = "processing";
  }

  await payment.save();

  // Payments that settle a payment-plan installment are applied to the plan
  // (oldest installment first, with overflow rolling onto the next).
  if (payment.paymentPlanId) {
    await applyCompletedPaymentToPlan(payment);
  }

  await auditService.log({
    action: "WEBHOOK_RECEIVED",
    entity: "Payment",
    entityId: payment._id,
    userId: payment.createdBy,
    details: { status: Status, transactionId: TransactionId, amount: Amount },
  });

  return { success: true, payment: payment.toJSON() };
};

// ──────────────────── Admin: Refund payment ────────────────────
export const refundPayment = async (paymentId, data, user) => {
  const schoolId = user.role === "super_admin"
    ? null
    : user.schoolId
      ? new mongoose.Types.ObjectId(user.schoolId)
      : null;

  if (!schoolId && user.role !== "super_admin") {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const filter = { paymentId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;

  const payment = await Payment.findOne(filter);
  if (!payment) {
    throw new ApiError("Payment not found", 404, "NOT_FOUND");
  }

  if (payment.status !== "completed") {
    throw new ApiError("Can only refund completed payments", 400, "INVALID_PAYMENT_STATUS");
  }

  const refundAmount = data.amount || payment.amount;

  if (refundAmount > payment.amount) {
    throw new ApiError("Refund amount cannot exceed payment amount", 400, "INVALID_REFUND_AMOUNT");
  }

  // Create refund payment record (negative amount)
  const refundPayment = await Payment.create({
    studentId: payment.studentId,
    schoolId: payment.schoolId,
    parentId: payment.parentId,
    amount: -refundAmount,
    currency: payment.currency,
    status: "completed",
    paymentMethod: payment.paymentMethod,
    provider: payment.provider,
    description: `Refund: ${data.reason}`,
    createdBy: user._id,
  });

  // Update original payment
  payment.status = refundAmount === payment.amount ? "refunded" : "completed"; // partial refund stays completed
  if (refundAmount === payment.amount) {
    payment.refundedAt = new Date();
  }
  await payment.save();

  // Update student balance
  await Student.findByIdAndUpdate(payment.studentId, {
    $inc: { totalPaid: -refundAmount, balance: refundAmount },
  });

  // Update school stats
  await School.findByIdAndUpdate(payment.schoolId, {
    $inc: { "stats.totalPaymentsThisMonth": -refundAmount },
  });

  await auditService.log({
    action: "REFUND_PAYMENT",
    entity: "Payment",
    entityId: payment._id,
    userId: user._id,
    details: { refundAmount, reason: data.reason, refundPaymentId: refundPayment.paymentId },
  });

  return {
    originalPayment: payment.toJSON(),
    refundPayment: refundPayment.toJSON(),
  };
};

export { ApiError };