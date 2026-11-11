import mongoose from "mongoose";
import { SmsPurchaseRequest } from "../models/SmsPurchaseRequest.js";
import { PlatformSmsPoolEntry } from "../models/PlatformSmsPoolEntry.js";
import { SmsCreditTopUp } from "../models/smsCreditTopUpModel.js";
import { School } from "../models/schoolModel.js";
import { Notification } from "../models/Notification.js";
import ApiError from "../utils/ApiError.js";
import auditService from "../utils/auditService.js";
import { requestToPay } from "../utils/mtnApi.js";
import { getCachedPlatformSettings } from "./platformSettings.service.js";
import { NOTIFICATION_TYPES, AUDIT_ACTIONS } from "../config/constants.js";

/**
 * Regulated SMS credit purchase.
 *
 * The school asks, the price is shown before it agrees, it pays by MoMo prompt, and an
 * admin releases the units from the platform's Arkesel pool. Money arriving is **not**
 * approval â€” that is the whole point of the feature, so nothing here credits a balance
 * off the back of a webhook.
 */

/**
 * The pool's current balance.
 *
 * `topup` and `reversal` add, `allocation` subtracts. One aggregation rather than two
 * queries, and the same `$sum`-with-`$cond` shape `admin/sms.service.js` already uses
 * for `totalHeldBySchools` â€” so the two figures are computed the same way and cannot
 * drift apart in their definitions.
 *
 * @returns {Promise<{ totalToppedUp: number, totalAllocated: number, availableUnits: number }>}
 */
export const getPoolTotals = async () => {
  const [row] = await PlatformSmsPoolEntry.aggregate([
    {
      $group: {
        _id: null,
        totalToppedUp: {
          $sum: {
            $cond: [{ $in: ["$direction", ["topup", "reversal"]] }, "$units", 0],
          },
        },
        totalAllocated: {
          $sum: {
            $cond: [{ $eq: ["$direction", "allocation"] }, "$units", 0],
          },
        },
      },
    },
  ]);

  return {
    totalToppedUp: row?.totalToppedUp || 0,
    totalAllocated: row?.totalAllocated || 0,
    availableUnits: (row?.totalToppedUp || 0) - (row?.totalAllocated || 0),
  };
};

/** The unit price, from platform settings, defaulted rather than thrown on. */
const currentUnitPricePes = async () => {
  const settings = await getCachedPlatformSettings();
  const rate = Number(settings?.sms?.ratePesewas);
  return Number.isFinite(rate) && rate >= 0 ? rate : 25;
};

/**
 * Prices a request without writing anything.
 *
 * Free and unauthenticated-in-effect (it still sits behind the school's session) so a
 * bursar can see the cost *before* committing â€” which is the requirement, and the
 * reason this is not simply the create endpoint with `dryRun`.
 *
 * `poolAvailable` is part of the answer on purpose: a school should learn the platform
 * is short before it pays, not after.
 */
export const quoteSmsRequest = async ({ units }) => {
  const unitPricePes = await currentUnitPricePes();
  const pool = await getPoolTotals();

  return {
    units,
    unitPricePes,
    totalPes: units * unitPricePes,
    poolAvailable: pool.availableUnits,
    // `false` for three different reasons â€” too many units, more than the pool, or a
    // zero rate â€” so the school is told *which* rather than being met with silence.
    canRequest:
      units > 0 && units <= pool.availableUnits && unitPricePes > 0,
    reason:
      unitPricePes <= 0
        ? "SMS credit is not currently on sale. Please contact support."
        : units > pool.availableUnits
          ? "Only part of that is available. Please reduce the quantity."
          : null,
  };
};

/** The school inbox. */
export const listRequestsForSchool = async ({ schoolId, status, page, perPage }) => {
  const filter = { schoolId: new mongoose.Types.ObjectId(schoolId) };
  if (status && status !== "all") filter.status = status;

  const skip = (page - 1) * perPage;
  const [rows, total] = await Promise.all([
    SmsPurchaseRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .lean(),
    SmsPurchaseRequest.countDocuments(filter),
  ]);

  return { rows, total, page, perPage };
};

/**
 * One request, for the school's status poll.
 *
 * **Scoped to `schoolId` in the query, not trusted from the parameter.** A
 * `SMS-REQ-` reference is guessable in shape and short enough to brute-force, so a
 * read that did not filter by school would expose another school's purchase history
 * and payment reference to any bursar who cared to try â€” the exact leak that
 * `findSchoolRecipients`' masked notification copy exists to prevent, on a record that
 * carries more than the phone number.
 */
export const getSmsRequestForSchool = async (requestId, schoolId) => {
  const request = await SmsPurchaseRequest.findOne({
    requestId,
    schoolId: new mongoose.Types.ObjectId(schoolId),
  }).lean();

  if (!request) {
    throw new ApiError("Request not found", 404, "SMS_REQUEST_NOT_FOUND");
  }
  return request;
};

/**
 * Creates the request. Supports MoMo prompt flow (existing) and manual payment flow.
 *
 * - MoMo (`paymentMethod: "mtn"`): creates request, sends MTN prompt, stays `awaiting_payment` until webhook.
 * - Manual (`paymentMethod: "manual"`): creates request with generated payment reference and returns instructions;
 *   no prompt is sent. School submits external payment reference later for admin verification.
 */
export const createSmsRequest = async (data, user) => {
  const { units, phoneNumber } = data;
  const paymentMethod = data?.paymentMethod === "manual" ? "manual" : "mtn";

  const unitPricePes = await currentUnitPricePes();
  if (unitPricePes <= 0) {
    throw new ApiError("SMS credit is not currently on sale", 503, "SMS_PRICING_UNAVAILABLE");
  }

  const pool = await getPoolTotals();
  if (units > pool.availableUnits) {
    throw new ApiError(
      `Only ${pool.availableUnits} SMS units are available right now.`,
      409,
      "SMS_POOL_EXHAUSTED"
    );
  }

  const totalPes = units * unitPricePes;
  const genRef = () => {
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const digits = "23456789";
    const pick = (s) => s[Math.floor(Math.random() * s.length)];
    const chars = [pick(letters), pick(digits), pick(letters + digits), pick(letters + digits)];
    for (let i = chars.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join("");
  };
  const requestedRef = paymentMethod === "manual" ? String(data?.paymentReference || "").trim().toUpperCase() : "";
  let reference = requestedRef && /^[A-Z0-9]{4}$/.test(requestedRef) ? requestedRef : genRef();
  for (let i = 0; i < 8; i++) {
    const exists = await SmsPurchaseRequest.exists({ "payment.reference": reference });
    if (!exists) break;
    reference = genRef();
  }

  const request = await SmsPurchaseRequest.create({
    schoolId: user.schoolId,
    requestedBy: user._id,
    units,
    unitPricePes,
    totalPes,
    status: "awaiting_payment",
    payment: {
      reference,
      method: paymentMethod,
      provider: paymentMethod === "manual" ? "manual" : "mtn",
      status: "pending",
      phoneNumber: paymentMethod === "manual" ? null : phoneNumber,
    },
  });

  if (paymentMethod === "manual") {
    await auditService.log({
      action: AUDIT_ACTIONS.SMS_CREDIT_REQUEST,
      entity: "SmsPurchaseRequest",
      entityId: request._id,
      userId: user._id,
      schoolId: user.schoolId,
      details: { ref: request.requestId, units, unitPricePes, totalPes, method: "manual" },
    });
    return { request, reference, prompted: false, manual: true };
  }

  let prompted = false;
  try {
    const result = await requestToPay({
      amount: totalPes,
      phone: phoneNumber,
      externalId: reference,
      referenceId: reference,
      payerMessage: `SukuuPay: ${units} SMS credits`,
      payeeNote: `SMS credit ${request.requestId}`,
    });

    request.payment.financialTransactionId = result?.referenceId || null;
    request.payment.externalId = result?.externalId || reference;
    request.payment.status = "processing";
    request.payment.promptedAt = new Date();
    await request.save();
    prompted = true;
  } catch (error) {
    request.payment.status = "failed";
    request.payment.failureReason = String(error?.message || "prompt failed").slice(0, 300);
    await request.save();
    throw new ApiError(
      "We could not send the payment prompt. Please contact support to complete this purchase.",
      503,
      "SMS_PAYMENT_PROMPT_FAILED"
    );
  }

  await auditService.log({
    action: AUDIT_ACTIONS.SMS_CREDIT_REQUEST,
    entity: "SmsPurchaseRequest",
    entityId: request._id,
    userId: user._id,
    schoolId: user.schoolId,
    details: { ref: request.requestId, units, unitPricePes, totalPes, prompted, method: "mtn" },
  });

  return { request, reference, prompted, manual: false };
};

/**
 * Manual flow: school submits external payment reference/proof for admin verification.
 */
export const submitManualPaymentProof = async (requestId, data, user) => {
  const request = await SmsPurchaseRequest.findOne({
    requestId,
    schoolId: new mongoose.Types.ObjectId(user.schoolId),
  });
  if (!request) throw new ApiError("Request not found", 404, "SMS_REQUEST_NOT_FOUND");

  if ((request.payment?.method || "mtn") !== "manual") {
    throw new ApiError("This request does not use manual payment verification.", 409, "SMS_REQUEST_NOT_MANUAL");
  }
  if (request.status === "approved") return { request, alreadySubmitted: false };
  if (!["awaiting_payment", "awaiting_verification"].includes(request.status)) {
    throw new ApiError(
      `A request that is ${request.status.replace(/_/g, " ")} cannot accept payment proof`,
      409,
      "SMS_REQUEST_NOT_SUBMITTABLE"
    );
  }

  request.payment.submittedReference = String(data.submittedReference || "").trim().slice(0, 200);
  request.payment.payerName = data.payerName ? String(data.payerName).trim().slice(0, 120) : null;
  request.payment.proofNote = data.proofNote ? String(data.proofNote).trim().slice(0, 500) : null;
  request.payment.submittedBy = user._id;
  request.payment.submittedAt = new Date();
  request.status = "awaiting_verification";
  await request.save();

  const admins = await mongoose.model("User").find({ role: "super_admin", status: "active", deletedAt: null }).select("_id").lean();
  if (admins.length) {
    await Notification.insertMany(
      admins.map((admin) => ({
        userId: admin._id,
        schoolId: request.schoolId,
        type: NOTIFICATION_TYPES.SMS_REQUEST,
        title: `SMS manual payment to verify â€” ${request.units.toLocaleString()} units`,
        message: `${request.requestId}: ${unitsLabel(request.units)} for ${formatPes(request.totalPes)}. Ref: ${request.payment.reference} Â· Submitted: ${request.payment.submittedReference}.`,
        link: "/admin/sms/credits",
        meta: { requestId: String(request._id), ref: request.requestId },
      }))
    );
  }

  await auditService.log({
    action: AUDIT_ACTIONS.SMS_CREDIT_REQUEST,
    entity: "SmsPurchaseRequest",
    entityId: request._id,
    userId: user._id,
    schoolId: user.schoolId,
    details: {
      ref: request.requestId,
      submittedReference: request.payment.submittedReference,
      method: "manual",
    },
  });

  return { request, alreadySubmitted: false };
};

/**
 * Moves `awaiting_payment` â†’ `awaiting_approval`.
 *
 * Called from the MTN webhook. **Stops there deliberately.** The product requirement
 * is that an admin approves every purchase, so crediting the school here would make the
 * approval step decorative. This only records that money arrived and asks a human to
 * act.
 */
export const onSmsRequestPaymentConfirmed = async (reference, gateway) => {
  const request = await SmsPurchaseRequest.findOne({
    "payment.reference": reference,
  });

  if (!request) {
    // Not an error. The webhook is a broadcast endpoint that also carries fee
    // payments, and a reference this module did not mint is the normal case.
    return { matched: false };
  }

  // Idempotent by state, not by a claim. A redelivered webhook on an already-approved
  // request is a no-op, and so is one on a `rejected` request â€” the webhook may arrive
  // after the admin rejected, and the money is already being refunded.
  if (request.status === "awaiting_approval" || request.status === "awaiting_verification" || request.status === "approved") {
    return { matched: true, changed: false, request };
  }

  request.status = "awaiting_approval";
  request.payment.status = "completed";
  request.payment.completedAt = new Date();
  if (gateway?.financialTransactionId) {
    request.payment.financialTransactionId = gateway.financialTransactionId;
  }
  if (gateway?.reason) request.payment.failureReason = String(gateway.reason).slice(0, 300);
  await request.save();

  // Every active super admin, because the approval queue is theirs alone â€”
  // `admin.routes.js` gates the queue on `authorize('super_admin')`.
  const admins = await mongoose.model("User").find({
    role: "super_admin",
    status: "active",
    deletedAt: null,
  })
    .select("_id")
    .lean();

  if (admins.length) {
    await Notification.insertMany(
      admins.map((admin) => ({
        userId: admin._id,
        schoolId: request.schoolId,
        type: NOTIFICATION_TYPES.SMS_REQUEST,
        title: `SMS purchase awaiting approval â€” ${request.units.toLocaleString()} units`,
        message: `${request.requestId}: ${unitsLabel(request.units)} for ${formatPes(
          request.totalPes
        )}. Payment received; approve to release the units.`,
        link: "/admin/sms/credits",
        meta: { requestId: String(request._id), ref: request.requestId },
      }))
    );
  }

  return { matched: true, changed: true, request };
};

/**
 * Approves: draws the units from the pool and credits the school.
 *
 * Ordering is the whole design here:
 *
 *   1. **Claim first.** Insert the `PlatformSmsPoolEntry`. Its sparse-unique
 *      `{requestId}` index is the claim â€” a second approval collides and is refused
 *      rather than allocating twice. If the credit to the school then failed, we are
 *      left with an allocation and no balance, which is the recoverable direction;
 *      the other way round is units credited twice with nothing to show for it.
 *   2. **Credit the balance.**
 *   3. **Write the school's own ledger row**, so the units appear in its existing
 *      purchase history and `GET /sms/credits/:schoolId` â€” the same place every other
 *      top-up is, which is what makes this auditable alongside them.
 *   4. **Notify.**
 *
 * @param {string} requestId our public id, `SMS-REQ-â€¦`
 * @param {{ _id: string }} admin
 */
export const approveSmsRequest = async (requestId, admin) => {
  const request = await SmsPurchaseRequest.findOne({ requestId });

  if (!request) throw new ApiError("Request not found", 404, "NOT_FOUND");

  if (request.status === "approved") {
    // Idempotent, not an error: a double-click on "Approve" is a UI mistake, and
    // answering it with a 409 makes the operator think something went wrong when in
    // fact everything is fine.
    return { request, alreadyApproved: true };
  }

  if (!["awaiting_approval", "awaiting_verification"].includes(request.status)) {
    throw new ApiError(
      `A request that is ${request.status.replace(/_/g, " ")} cannot be approved`,
      409,
      "SMS_REQUEST_NOT_APPROVABLE"
    );
  }

  // â”€â”€ 1. Claim the allocation â”€â”€
  const pool = await getPoolTotals();
  if (request.units > pool.availableUnits) {
    throw new ApiError(
      `Only ${pool.availableUnits} units are left in the pool. This request needs ${request.units}.`,
      409,
      "SMS_POOL_EXHAUSTED"
    );
  }

  let entry;
  try {
    entry = await PlatformSmsPoolEntry.create({
      direction: "allocation",
      units: request.units,
      // The amount *charged*, which is revenue â€” not the platform's own cost. Recorded
      // here so the ledger can be read either way; see the field's note on the model.
      amountPes: request.totalPes,
      provider: "arke",
      reference: request.payment?.reference || null,
      requestId: request._id,
      schoolId: request.schoolId,
      balanceAfter: pool.availableUnits - request.units,
      note: `Allocated to ${request.requestId}`,
      createdBy: admin?._id || null,
    });
  } catch (error) {
    // The sparse-unique `{requestId}` index firing means an allocation already exists.
    // That is the guard working, so it is reported as a conflict rather than a 500.
    if (error?.code === 11000) {
      throw new ApiError(
        "This request has already been allocated",
        409,
        "SMS_REQUEST_ALREADY_ALLOCATED"
      );
    }
    throw error;
  }

  // â”€â”€ 2. Credit the school's balance â”€â”€
  const school = await School.findByIdAndUpdate(
    request.schoolId,
    { $inc: { "sms.balance": request.units } },
    { returnDocument: 'after' }
  ).select("name sms.balance");

  if (!school) {
    throw new ApiError("The school no longer exists", 404, "SCHOOL_NOT_FOUND");
  }

  // â”€â”€ 3. The school's own ledger â”€â”€
  await SmsCreditTopUp.create({
    schoolId: request.schoolId,
    units: request.units,
    amountPes: request.totalPes,
    provider: request.payment?.reference || "mtn",
    reference: request.requestId,
    source: "purchase",
    note: `Approved purchase ${request.requestId}`,
    createdBy: admin?._id || null,
  });

  // â”€â”€ 4. The request's own state â”€â”€
  request.status = "approved";
  request.approvedBy = admin?._id || null;
  request.approvedAt = new Date();
  request.poolEntryId = entry._id;
  request.decisionNote = `Allocated ${unitsLabel(request.units)} to ${school.name}`;
  await request.save();

  await auditService.log({
    action: AUDIT_ACTIONS.SMS_REQUEST_APPROVE,
    entity: "SmsPurchaseRequest",
    entityId: request._id,
    userId: admin?._id || null,
    schoolId: request.schoolId,
    details: {
      ref: request.requestId,
      units: request.units,
      totalPes: request.totalPes,
      poolEntryId: String(entry._id),
      balanceAfter: entry.balanceAfter,
    },
  });

  await notifySchoolStaff(request, {
    type: NOTIFICATION_TYPES.SMS_REQUEST_APPROVED,
    title: `SMS credit approved â€” ${unitsLabel(request.units)}`,
    message: `${request.requestId} was approved. ${unitsLabel(
      request.units
    )} added to your balance, which is now ${school.sms.balance.toLocaleString()} units.`,
    link: "/dashboard/sms-reminders",
  });

  return { request, entry, schoolBalance: school.sms.balance, alreadyApproved: false };
};

/**
 * Rejects a request.
 *
 * **The money has already been taken** at this point â€” that is what
 * `awaiting_approval` means â€” so a rejection is refundable and the console says so.
 * Refusing to reject without offering the refund would leave a school out of pocket
 * with no route out of it.
 */
export const rejectSmsRequest = async (requestId, { reason }, admin) => {
  const trimmed = String(reason || "").trim();

  if (trimmed.length < 3) {
    throw new ApiError(
      "Give a reason â€” the school is told what it is",
      400,
      "REJECTION_REASON_REQUIRED"
    );
  }

  const request = await SmsPurchaseRequest.findOne({ requestId });
  if (!request) throw new ApiError("Request not found", 404, "NOT_FOUND");

  if (request.status === "approved") {
    // Too late to refuse: the units are allocated and credited. Reversing that is a
    // different operation and pretending otherwise would leave the pool and the
    // school's balance disagreeing.
    throw new ApiError(
      "This request was already approved and the units released",
      409,
      "SMS_REQUEST_ALREADY_APPROVED"
    );
  }

  if (request.status === "rejected") {
    return { request, alreadyRejected: true };
  }

  request.status = "rejected";
  request.rejectionReason = trimmed.slice(0, 300);
  request.decisionNote = `Rejected: ${trimmed.slice(0, 300)}`;
  await request.save();

  await auditService.log({
    action: AUDIT_ACTIONS.SMS_REQUEST_REJECT,
    entity: "SmsPurchaseRequest",
    entityId: request._id,
    userId: admin?._id || null,
    schoolId: request.schoolId,
    details: { ref: request.requestId, reason: trimmed.slice(0, 300) },
  });

  await notifySchoolStaff(request, {
    type: NOTIFICATION_TYPES.SMS_REQUEST_REJECTED,
    title: `SMS purchase declined â€” ${request.requestId}`,
    message: `${request.requestId} was declined: ${trimmed.slice(
      0,
      200
    )}. A refund is available â€” contact support if you do not receive it.`,
    link: "/dashboard/sms-requests",
  });

  return { request, alreadyRejected: false };
};

/**
 * Records that a rejected request's money was returned.
 *
 * Deliberately **does not perform** the refund. Moving a school administrator's MoMo
 * money is not something this module should be able to do from a state transition, and
 * the MTN reversal API is a support operation with its own confirmation. So the refund
 * is performed by an operator and *recorded* here, which is what the school and the
 * next support conversation both need.
 */
export const markSmsRequestRefunded = async (requestId, refundReference, admin) => {
  const request = await SmsPurchaseRequest.findOne({ requestId });
  if (!request) throw new ApiError("Request not found", 404, "NOT_FOUND");

  if (request.refundedAt) {
    return { request, alreadyRefunded: true };
  }

  request.refundedAt = new Date();
  request.refundReference = refundReference || null;
  request.payment.status = "refunded";
  await request.save();

  await auditService.log({
    action: AUDIT_ACTIONS.SMS_REQUEST_REJECT,
    entity: "SmsPurchaseRequest",
    entityId: request._id,
    userId: admin?._id || null,
    schoolId: request.schoolId,
    details: { ref: request.requestId, refundReference },
  });

  return { request, alreadyRefunded: false };
};

/** The console's approval queue across every school. */
export const listAllRequests = async ({ status, page, perPage }) => {
  const filter = {};
  if (status && status !== "all") filter.status = status;

  const skip = (page - 1) * perPage;
  const [rows, total] = await Promise.all([
    SmsPurchaseRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .populate("schoolId", "name logo")
      .populate("requestedBy", "firstName lastName email")
      .lean(),
    SmsPurchaseRequest.countDocuments(filter),
  ]);

  return { rows, total, page, perPage };
};

/** The console's pool view: balance, thresholds and recent entries. */
export const getPlatformSmsPool = async () => {
  const [totals, settings, entries, heldBySchools] = await Promise.all([
    getPoolTotals(),
    getCachedPlatformSettings(),
    PlatformSmsPoolEntry.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .populate("schoolId", "name")
      .populate("createdBy", "firstName lastName")
      .lean(),
    School.aggregate([
      { $match: { deletedAt: null, "sms.balance": { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$sms.balance" } } },
    ]),
  ]);

  const unitPricePes = await currentUnitPricePes();
  const threshold = Number(settings?.sms?.poolLowThreshold) || 0;

  return {
    availableUnits: totals.availableUnits,
    totalToppedUp: totals.totalToppedUp,
    totalAllocated: totals.totalAllocated,
    // The figure the console was missing before this feature: the units bought on
    // Arkesel that have not been allocated to a school.
    heldBySchools: heldBySchools?.[0]?.total || 0,
    unitPricePes,
    poolLowThreshold: threshold,
    // `availableUnits` can legitimately be negative if a pool entry was written by
    // hand with a bad figure, and a low stock warning that can say "-5 units" is worse
    // than none.
    isLow: totals.availableUnits <= threshold,
    entries,
  };
};

/** Records units the platform bought from Arkesel. */
export const recordPoolTopUp = async (data, admin) => {
  const { units, amountPes, provider, reference, note } = data;

  const totals = await getPoolTotals();

  const entry = await PlatformSmsPoolEntry.create({
    direction: "topup",
    units,
    amountPes: amountPes ?? null,
    provider: provider || "arke",
    reference: reference || null,
    balanceAfter: totals.availableUnits + units,
    note: note || "",
    createdBy: admin?._id || null,
  });

  await auditService.log({
    action: AUDIT_ACTIONS.SMS_POOL_TOPUP,
    entity: "PlatformSmsPoolEntry",
    entityId: entry._id,
    userId: admin?._id || null,
    details: {
      ref: entry.entryId,
      units,
      amountPes: amountPes ?? null,
      provider: provider || "arke",
      reference: reference || null,
    },
  });

  return { entry, availableUnits: totals.availableUnits + units };
};

/** Everyone who should know at the school: the roles `pay.service.js` alerts. */
const notifySchoolStaff = async (request, { type, title, message, link }) => {
  try {
    const staff = await mongoose
      .model("User")
      .find({
        schoolId: request.schoolId,
        role: { $in: ["school_admin", "accountant"] },
        status: "active",
        deletedAt: null,
      })
      .select("_id")
      .lean();

    if (!staff.length) return 0;

    await Notification.insertMany(
      staff.map((member) => ({
        userId: member._id,
        schoolId: request.schoolId,
        type,
        title,
        message,
        link,
        meta: { requestId: request.requestId },
      }))
    );
    return staff.length;
  } catch (error) {
    // Never fail an approval because a notification could not be written. The money is
    // already moved and the ledger row is written; the worst outcome of throwing here
    // is a request stuck at `awaiting_approval` with the units already allocated.
    console.error(
      `[SMS-REQ] Notification failed for ${request.requestId}:`,
      error.message
    );
    return 0;
  }
};

const unitsLabel = (units) => `${Number(units).toLocaleString("en-GB")} SMS`;

/** Small enough to inline. Cedi formatting is the frontend's job everywhere else. */
const formatPes = (pes) => `GHâ‚µ ${(Number(pes || 0) / 100).toFixed(2)}`;

export default {
  getPoolTotals,
  quoteSmsRequest,
  createSmsRequest,
  onSmsRequestPaymentConfirmed,
  approveSmsRequest,
  rejectSmsRequest,
  markSmsRequestRefunded,
  listAllRequests,
  listRequestsForSchool,
  getSmsRequestForSchool,
  getPlatformSmsPool,
  recordPoolTopUp,
};

