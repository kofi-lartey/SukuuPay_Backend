import mongoose from "mongoose";
import { ManualPayment } from "../models/ManualPayment.js";
import { School } from "../models/schoolModel.js";
import ApiError from "../utils/ApiError.js";
import * as auditService from "../utils/auditService.js";
import { PlatformLedger } from "../models/PlatformLedger.js";

/**
 * Phone number schools pay their subscription to via Mobile Money.
 *
 * This is the single source of truth for the manual-payment payee number
 * shown on the frontend payment page and in receipts.
 */
export const SUBSCRIPTION_MOMO_PHONE = "05576655008";

/**
 * Generate a unique reference code for a subscription payment.
 *
 * Format: SUB + 6 random digits, e.g. SUB784921. Checked against existing
 * pending records so two schools never get the same code at the same time.
 */
const generateSubscriptionReferenceCode = async () => {
  let isUnique = false;
  let code = "";

  while (!isUnique) {
    const numbers = Math.floor(100000 + Math.random() * 900000).toString();
    code = `SUB${numbers}`;
    const existing = await ManualPayment.findOne({
      referenceCode: code,
      status: "pending",
    });
    if (!existing) isUnique = true;
  }

  return code;
};

/**
 * `POST /schools/:schoolId/subscription/payment`
 *
 * A school on trial, expired, or active (upgrading) selects a paid tier and
 * initiates a manual payment. Creates a `ManualPayment` record in `pending`
 * state, flips the school's subscription to `paymentStatus: "pending"` and
 * `status: "suspended"`, so no features unlock until an administrator approves
 * the payment.
 *
 * Returns the reference code and the payee phone number so the frontend can
 * show the school exactly what to pay and where.
 */
export const initiateSubscriptionPayment = async (
  schoolId,
  { plan, monthlyFee }
) => {
  const school = await School.findById(schoolId);
  if (!school) throw new ApiError("School not found", 404, "SCHOOL_NOT_FOUND");

  const now = new Date();

  // Any school may initiate a subscription payment or upgrade, regardless of its
  // current subscription status (trial, active, expired, suspended, cancelled).
  // An active school is upgrading to a higher tier; a suspended/expired one is
  // (re)subscribing. In every case the new plan only takes effect once a super
  // admin approves, so there is no reason to gate initiation on the old status.
  //
  // The one guard that remains is a duplicate pending payment below.

  // A pending payment already exists — the school is waiting on approval.
  if (school.subscription.paymentStatus === "pending") {
    throw new ApiError(
      "A payment is already pending approval for this school",
      409,
      "PAYMENT_PENDING"
    );
  }

  const referenceCode = await generateSubscriptionReferenceCode();

  const manualPayment = await ManualPayment.create({
    schoolId: school._id,
    studentId: null,
    referenceCode,
    expectedAmount: Number(monthlyFee) || 0,
  });

  school.subscription.plan = plan;
  school.subscription.paymentStatus = "pending";
  school.subscription.status = "suspended";
  school.subscription.currentPeriodStart = now;
  school.subscription.currentPeriodEnd = addMonths(now, 1);
  school.subscription.monthlyFee = Number(monthlyFee) || 0;
  school.subscription.paymentMethod = "manual";

  await school.save();

  await auditService.log({
    /*
     * `subscription.payment_initiated` was written here, and it is in neither the
     * `AuditLog` enum nor `AUDIT_ACTIONS` in `config/constants.js`. `auditService.log`
     * catches the Mongoose ValidationError that raises and logs it, so this write
     * has always silently produced no row: a school moved to `suspended` with no
     * trace of who initiated it.
     *
     * `payment.record_manual` is the existing action for an administrator keying in
     * a payment by hand, which is what this is.
     */
    action: "payment.record_manual",
    entity: "School",
    entityId: school._id,
    userId: null,
    schoolId: school._id,
    meta: { plan, monthlyFee, referenceCode },
  });

  return {
    manualPayment: manualPayment.toJSON ? manualPayment.toJSON() : manualPayment,
    referenceCode,
    payeePhone: SUBSCRIPTION_MOMO_PHONE,
    expectedAmount: manualPayment.expectedAmount,
    school,
  };
};

/**
 * `PUT /admin/manual-payments/subscription/:id/approve`
 *
 * An administrator reviews a pending subscription payment and approves it.
 * Activates the school's subscription: `status: "active"`,
 * `paymentStatus: "completed"`, and records who approved it.
 *
 * The school's `subscription.plan` was already set to the target tier at
 * initiation time, so approving simply flips the status to `active` — which
 * re-applies every feature and permission the new tier unlocks (the entitlement
 * resolver reads `subscription.plan`).
 *
 * Rejected payments are left `pending` — the caller should use the reject
 * endpoint separately. This endpoint only approves.
 */
export const approveSubscriptionPayment = async (manualPaymentId, adminUserId) => {
  const manualPayment = await ManualPayment.findById(manualPaymentId);
  if (!manualPayment) {
    throw new ApiError("Manual payment not found", 404, "NOT_FOUND");
  }

  if (manualPayment.status !== "pending") {
    throw new ApiError(
      `Payment is already ${manualPayment.status}`,
      400,
      "PAYMENT_NOT_PENDING"
    );
  }

  const school = await School.findById(manualPayment.schoolId);
  if (!school) {
    throw new ApiError("School not found", 404, "SCHOOL_NOT_FOUND");
  }

  const now = new Date();

  manualPayment.status = "completed";
  manualPayment.completedAt = now;
  manualPayment.completedBy = adminUserId;
  manualPayment.amountReceived = manualPayment.expectedAmount;
  await manualPayment.save();

  school.subscription.status = "active";
  school.subscription.paymentStatus = "completed";
  school.subscription.currentPeriodStart = now;
  school.subscription.currentPeriodEnd = addMonths(now, 1);
  await school.save();

  // Create a platform ledger entry for the subscription payment
  try {
    await PlatformLedger.create({
      type: "subscription",
      amount: manualPayment.expectedAmount || school.subscription.monthlyFee || 0,
      currency: "GHS",
      schoolId: school._id,
      paymentId: null,
      description: `Subscription payment for ${school.subscription.plan} plan`,
      reference: manualPayment.referenceCode,
      settled: true,
      settledAt: now,
      createdBy: adminUserId,
    });
  } catch (ledgerError) {
    console.error("Failed to create platform ledger entry for subscription:", ledgerError.message);
  }

  await auditService.log({
    /*
     * `subscription.payment_approved` was outside the enum for the same reason as
     * the initiation row above, so the moment a school's subscription was activated
     * left no audit trail at all. `payment.success` is the existing action for a
     * payment reaching completion — and until now nothing in the product wrote it.
     */
    action: "payment.success",
    entity: "School",
    entityId: school._id,
    userId: adminUserId,
    schoolId: school._id,
    meta: {
      manualPaymentId,
      referenceCode: manualPayment.referenceCode,
      amount: manualPayment.expectedAmount,
      plan: school.subscription.plan,
    },
  });

  return {
    manualPayment: manualPayment.toJSON ? manualPayment.toJSON() : manualPayment,
    school: school.toJSON ? school.toJSON() : school,
  };
};

/**
 * `GET /admin/manual-payments/subscription/pending`
 *
 * Lists all pending subscription payments awaiting admin review, with the
 * school name and plan so the administrator can decide.
 */
export const listPendingSubscriptionPayments = async () => {
  const payments = await ManualPayment.find({
    studentId: null,
    status: "pending",
  })
    .sort({ createdAt: -1 })
    .lean();

  const schoolIds = payments.map((p) => p.schoolId);
  const schools = await School.find({ _id: { $in: schoolIds } })
    .select("name schoolCode subscription.plan subscription.trialEndsAt")
    .lean();

  const schoolById = new Map(schools.map((s) => [s._id.toString(), s]));

  return payments.map((p) => {
    const school = schoolById.get(p.schoolId.toString());
    return {
      ...p,
      schoolName: school?.name || "Unknown",
      schoolCode: school?.schoolCode || "",
      plan: school?.subscription?.plan || "",
    };
  });
};

/**
 * Add `count` months to `date`, returning a new Date.
 * Kept as a local helper so the billing period math lives in one place.
 */
function addMonths(date, count) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + count);
  return result;
}

export default {
  initiateSubscriptionPayment,
  approveSubscriptionPayment,
  listPendingSubscriptionPayments,
  SUBSCRIPTION_MOMO_PHONE,
};