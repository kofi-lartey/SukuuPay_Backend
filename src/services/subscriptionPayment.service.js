import mongoose from "mongoose";
import { ManualPayment } from "../models/ManualPayment.js";
import { School } from "../models/schoolModel.js";
import ApiError from "../utils/ApiError.js";
import * as auditService from "../utils/auditService.js";
import { addMonths } from "../utils/dateHelpers.js";

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
 * A school on trial (or expired) selects a paid tier and initiates a manual
 * payment. Creates a `ManualPayment` record in `pending` state, flips the
 * school's subscription to `paymentStatus: "pending"` and `status: "suspended"`,
 * so no features unlock until an administrator approves the payment.
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

  // Only a trial or expired school can initiate a subscription payment.
  if (
    school.subscription.status !== "trial" &&
    school.subscription.status !== "expired"
  ) {
    throw new ApiError(
      "Only a trial or expired school can initiate a subscription payment",
      400,
      "INVALID_SUBSCRIPTION_STATE"
    );
  }

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

export default {
  initiateSubscriptionPayment,
  approveSubscriptionPayment,
  listPendingSubscriptionPayments,
  SUBSCRIPTION_MOMO_PHONE,
};
