import mongoose from "mongoose";
import { PaymentPlan } from "../models/paymentPlanModel.js";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import { Payment } from "../models/paymentModel.js";
import {
  generateInstallmentSchedule,
  regenerateDueDates,
  generateAcceptanceToken,
  nextUnsettledInstallment,
} from "../utils/planHelpers.js";
// The plan-side half of a settlement: load the live plan, guard against a replay,
// apply the money to the earliest unsettled tranche and save. Lives in its own
// module so the prepayment path and the webhook share one implementation.
import { applyPaymentToPlan } from "./paymentApplication.service.js";
import { addDays, endOfDayAccra, startOfDayAccra } from "../utils/dateHelpers.js";
import { sendSms } from "../utils/smsService.js";
import {
  requestToPay as mtnRequestToPay,
  MtnTransportError,
} from "../utils/mtnApi.js";
import { resolveGateway } from "../utils/paymentGateway.js";
import {
  initiatePayment as moolreInitiatePayment,
  normaliseChannel as moolreNormaliseChannel,
  MoolreTransportError,
} from "../utils/moolreClient.js";
import { generatePaymentReference } from "../utils/paymentReference.js";

class ApiError extends Error {
  constructor(message, status = 500, code = "INTERNAL_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Stub audit service — mirrors student.service.js / payment.service.js.
const auditService = {
  log: async ({ action, entity, entityId, userId, details }) => {
    console.log(`[AUDIT] ${action} | ${entity}:${entityId} | User:${userId} |`, details);
  },
};

// ──────────────────── Helpers ────────────────────

/** A plan is "live" while it is running or still awaiting parent acceptance. */
const LIVE_STATUSES = ["active", "pending_acceptance"];

/**
 * The buckets that count as a plan "in flight".
 *
 * Everything else — completed, cancelled, expired, defaulted-with-nothing-to-
 * chase — is a plan the school is not actively collecting on, so it must not
 * inflate the compliance rate. Getting this wrong in the inclusive direction is
 * how a compliance dashboard reports 94% for a school that is 40% in default:
 * the finished and abandoned plans pad the denominator.
 *
 * **These are the `summary` keys, not the classifier's return values.** The
 * classifier answers `on_track` / `approaching_due`; the summary counts them under
 * `onTrack` / `approachingDue`. Summing the first three into a summary keyed by
 * the last three yields three `undefined`s, and `|| 0` turns that into a
 * confident, wrong `activePlans: 0` with a `complianceRate` of `null` — a
 * dashboard that renders "—" everywhere and never says why. The two vocabularies
 * are deliberately kept distinct, so the mapping is stated here rather than
 * inferred at three call sites.
 */
const ACTIVE_COMPLIANCE_KEYS = ["onTrack", "approachingDue", "overdue"];

const resolveSchoolId = (user, explicitSchoolId) => {
  if (user && user.role === "super_admin") {
    return explicitSchoolId ? new mongoose.Types.ObjectId(explicitSchoolId) : null;
  }
  return user && user.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

const fetchSchool = async (schoolId) => {
  const school = await School.findById(schoolId)
    .select("name schoolCode sms payment academic")
    .lean();
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");
  return school;
};

const getPrimaryParent = (student) =>
  (student?.parents || []).find((p) => p.isPrimary) || student?.parents?.[0] || null;

/**
 * Escapes a string for literal use inside a RegExp.
 *
 * Needed for the compliance search box, which builds a pattern from whatever
 * someone typed. A parent named "A+" or a student id containing a bracket would
 * otherwise either throw or match far more than intended.
 */
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// All money in the system is integer pesewas; SMS copy needs cedis.
const toCedis = (pesewas) => (Math.round(Number(pesewas) || 0) / 100).toFixed(2);

const formatDate = (date) =>
  new Date(date).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Accra",
  });

const loadPlan = async (planId, schoolId) => {
  const filter = { _id: planId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;
  const plan = await PaymentPlan.findOne(filter);
  if (!plan) throw new ApiError("Payment plan not found", 404, "PLAN_NOT_FOUND");
  return plan;
};

// ──────────────────── SMS templates ────────────────────

const notifyPlanCreated = async (school, student, plan, token) => {
  const parent = getPrimaryParent(student);
  if (!parent) return { sent: false, reason: "No parent on record" };

  const first = plan.installments[0];
  const message =
    `${school.name}: a payment plan for ${student.studentName} (${student.studentClass}) has been created. ` +
    `${plan.numberOfInstallments} installments of GHS ${toCedis(first.amount)}, ` +
    `first due ${formatDate(first.dueDate)}, last due ${formatDate(plan.endDate)}. ` +
    `Reply ACCEPT ${token} to activate the plan.`;

  return sendSms({ to: parent.phone, message, school });
};

const notifyPlanActivated = async (school, student, plan) => {
  const parent = getPrimaryParent(student);
  if (!parent) return { sent: false, reason: "No parent on record" };

  const next = nextUnsettledInstallment(plan);
  const message =
    `${school.name}: the payment plan for ${student.studentName} is now ACTIVE. ` +
    (next
      ? `Next installment of GHS ${toCedis(next.amount - (next.amountPaid || 0))} is due ${formatDate(next.dueDate)}.`
      : "All installments are settled.");

  return sendSms({ to: parent.phone, message, school });
};

const notifyPlanCancelled = async (school, student, plan, reason) => {
  const parent = getPrimaryParent(student);
  if (!parent) return { sent: false, reason: "No parent on record" };

  const message =
    `${school.name}: the payment plan for ${student.studentName} has been cancelled. ` +
    (reason ? `Reason: ${reason}. ` : "") +
    "Any payments already made are not affected.";

  return sendSms({ to: parent.phone, message, school });
};

const notifyPlanCompleted = async (school, student, plan) => {
  const parent = getPrimaryParent(student);
  if (!parent) return { sent: false, reason: "No parent on record" };

  const message =
    `${school.name}: congratulations! The payment plan for ${student.studentName} ` +
    `has been fully paid (GHS ${toCedis(plan.totalAmount)}). Thank you.`;

  return sendSms({ to: parent.phone, message, school });
};

const notifyInstallmentReminder = async (school, student, plan, installment) => {
  const parent = getPrimaryParent(student);
  if (!parent) return { sent: false, reason: "No parent on record" };

  const message =
    `${school.name}: reminder — installment ${installment.installmentNumber} of ${plan.numberOfInstallments} ` +
    `for ${student.studentName} is due on ${formatDate(installment.dueDate)}. ` +
    `Amount: GHS ${toCedis(installment.amount - (installment.amountPaid || 0))}.`;

  return sendSms({ to: parent.phone, message, school });
};

const notifyInstallmentOverdue = async (school, student, plan, installment) => {
  const parent = getPrimaryParent(student);
  if (!parent) return { sent: false, reason: "No parent on record" };

  const outstanding = installment.amount - (installment.amountPaid || 0);
  const message =
    `${school.name}: installment ${installment.installmentNumber} of ${plan.numberOfInstallments} for ` +
    `${student.studentName} was due on ${formatDate(installment.dueDate)} and is still outstanding. ` +
    `GHS ${toCedis(outstanding)} is now overdue. Please make payment promptly.`;

  return sendSms({ to: parent.phone, message, school });
};

// ──────────────────── 1. Create a plan ────────────────────
export const createPaymentPlan = async (studentId, data, user) => {
  const schoolId = resolveSchoolId(user, data.schoolId);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);

  const student = await Student.findOne({
    _id: studentId,
    schoolId,
    deletedAt: null,
  });
  if (!student) throw new ApiError("Student not found", 404, "STUDENT_NOT_FOUND");

  if (student.status !== "active") {
    throw new ApiError(
      "A payment plan can only be created for an active student",
      400,
      "STUDENT_NOT_ACTIVE"
    );
  }

  // Business rule #2: the plan is created against the balance as it stands now
  // and is locked at that figure.
  const totalAmount = student.balance;
  if (!totalAmount || totalAmount <= 0) {
    throw new ApiError(
      "Student has no outstanding balance to plan for",
      400,
      "NO_OUTSTANDING_BALANCE"
    );
  }

  // The balance to structure is whatever the ledger says is outstanding. The
  // deposit the design shows alongside it is the part already collected, so a
  // bursar can see at a glance that a "GH₵ 850 fee" is really "GH₵ 300 paid,
  // GH₵ 550 to structure" — the plan is written against the second number and
  // writing it against the first would collect the deposit twice.
  const totalOwed = student.totalOwed ?? totalAmount;
  const paidDeposit = Math.max(totalOwed - totalAmount, 0);

  // Business rule #1: only one live plan per student.
  const existing = await PaymentPlan.findOne({
    studentId: student._id,
    planStatus: { $in: LIVE_STATUSES },
    deletedAt: null,
  });
  if (existing) {
    throw new ApiError(
      `Student already has a ${existing.planStatus} payment plan (${existing.planName})`,
      409,
      "PLAN_ALREADY_EXISTS"
    );
  }

  let schedule = generateInstallmentSchedule({
    totalAmount,
    numberOfInstallments: data.numberOfInstallments,
    startDate: data.startDate,
    interval: data.interval,
    customInstallments: data.customInstallments,
  });

  if (data.customInstallments) {
    const sum = schedule.reduce((total, i) => total + i.amount, 0);
    if (sum !== totalAmount) {
      throw new ApiError(
        "Custom installment amounts must sum to the student's outstanding balance",
        400,
        "INVALID_INSTALLMENT_SPLIT"
      );
    }
  }

  // Due dates must stay in ascending order for the progress logic to read well.
  schedule.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  schedule.forEach((installment, index) => {
    installment.installmentNumber = index + 1;
  });

  // A balance too small to divide into whole pesewas.
  //
  // `splitAmount` floors and gives the remainder to the last tranche, so a
  // GH₵ 0.01 balance across six tranches is five zero-pesewa tranches and a
  // one-pesewa one. `installmentSchema.amount` is `min: 1`, so the save fails —
  // with a Mongoose validation error naming `installments.0.amount`, which says
  // nothing about the bursar's actual mistake and nothing about how to fix it.
  // GH₵ 0.01 is not a balance anyone structures, so the refusal is the honest
  // answer and it names the remedy.
  const smallest = Math.min(...schedule.map((i) => i.amount));
  if (smallest < 1) {
    throw new ApiError(
      `A balance of GHS ${toCedis(totalAmount)} cannot be split into ${data.numberOfInstallments} positive tranches. Use fewer installments, or record the amount as a direct payment.`,
      400,
      "BALANCE_TOO_SMALL_TO_SPLIT"
    );
  }

  const acceptanceToken = await generateAcceptanceToken();

  const plan = await PaymentPlan.create({
    studentId: student._id,
    schoolId,
    planName: data.planName || "Custom Plan",
    totalAmount,
    numberOfInstallments: data.numberOfInstallments,
    interval: data.customInstallments ? "custom" : data.interval,
    installments: schedule,
    planStatus: "pending_acceptance",
    acceptanceToken,
    startDate: startOfDayAccra(data.startDate),
    endDate: schedule[schedule.length - 1].dueDate,
    adminNotes: data.adminNotes || "",
    // Snapshotted from the school, not from the request: a client that could
    // choose the term could file a plan under a term it is not collecting for,
    // and the compliance dashboard would then report two terms' arrears as one.
    term: school.academic?.currentTerm || "",
    academicYear: school.academic?.currentYear || "",
    createdBy: user._id,
    updatedBy: user._id,
    // Always set explicitly. `requestSource` is what distinguishes an admin-created
    // plan from a parent-requested one now that `createdBy` is nullable, and this
    // is the only plan-creation path that has a user behind it.
    requestSource: "admin",
  });

  // Keep the student's plan back-reference in sync.
  student.paymentPlans.push(plan._id);
  await student.save();

  const sms = await notifyPlanCreated(school, student, plan, acceptanceToken);

  await auditService.log({
    action: "plan.create",
    entity: "PaymentPlan",
    entityId: plan._id,
    userId: user._id,
    details: {
      studentId: student.studentId,
      schoolId,
      totalAmount,
      numberOfInstallments: plan.numberOfInstallments,
      interval: plan.interval,
      smsSent: sms.sent,
    },
  });

  return { plan: plan.toJSON(), sms };
};

// ──────────────────── 2. Get a student's plan ────────────────────
export const getPaymentPlanByStudent = async (studentId, user) => {
  const schoolId = resolveSchoolId(user);
  const filter = { studentId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;

  const student = await Student.findOne({ _id: studentId, deletedAt: null }).select(
    "studentId studentName studentClass balance totalOwed totalPaid status parents schoolId"
  );
  if (!student) throw new ApiError("Student not found", 404, "STUDENT_NOT_FOUND");
  if (schoolId && student.schoolId?.toString() !== schoolId.toString()) {
    throw new ApiError("Student not found", 404, "STUDENT_NOT_FOUND");
  }

  const plan =
    (await PaymentPlan.findOne({
      ...filter,
      planStatus: { $in: LIVE_STATUSES },
    }).sort({ createdAt: -1 })) ||
    (await PaymentPlan.findOne(filter).sort({ createdAt: -1 }));

  if (!plan) {
    throw new ApiError("No payment plan found", 404, "PLAN_NOT_FOUND");
  }

  return {
    plan: plan.toJSON(),
    student: {
      _id: student._id,
      studentId: student.studentId,
      studentName: student.studentName,
      studentClass: student.studentClass,
      status: student.status,
      totalOwed: student.totalOwed,
      totalPaid: student.totalPaid,
      balance: student.balance,
    },
  };
};

// ──────────────────── 3. Update a plan ────────────────────
export const updatePaymentPlan = async (planId, data, user) => {
  const schoolId = resolveSchoolId(user);
  const plan = await loadPlan(planId, schoolId);

  const isPendingAcceptance = plan.planStatus === "pending_acceptance";
  const isUntouchedActive = plan.planStatus === "active" && plan.installmentsPaid === 0;

  if (!isPendingAcceptance && !isUntouchedActive) {
    throw new ApiError(
      "A plan can only be edited while it is awaiting acceptance or while it is active with no installments paid. Cancel it and create a new one instead.",
      400,
      "PLAN_NOT_EDITABLE"
    );
  }

  if (data.planName !== undefined) plan.planName = data.planName;
  if (data.adminNotes !== undefined) plan.adminNotes = data.adminNotes || "";
  if (data.interval !== undefined) plan.interval = data.interval;

  // Business rule: editing the schedule only ever touches unpaid installments.
  if (data.startDate !== undefined || data.interval !== undefined) {
    regenerateDueDates(plan, {
      startDate: data.startDate,
      interval: data.interval,
    });
  }

  if (data.installments) {
    const sum = data.installments.reduce((total, i) => total + i.amount, 0);
    if (sum !== plan.totalAmount) {
      throw new ApiError(
        "Installment amounts must sum to the plan total amount",
        400,
        "INVALID_INSTALLMENT_SPLIT"
      );
    }

    data.installments.forEach((entry) => {
      const installment = plan.installments.find(
        (i) => i.installmentNumber === entry.installmentNumber
      );
      if (!installment) return;
      installment.amount = entry.amount;
      if (entry.notes !== undefined) installment.notes = entry.notes || "";
    });
  }

  plan.endDate = plan.installments[plan.installments.length - 1].dueDate;
  plan.updatedBy = user._id;
  await plan.save();

  await auditService.log({
    action: "plan.update",
    entity: "PaymentPlan",
    entityId: plan._id,
    userId: user._id,
    details: {
      changed: Object.keys(data),
      startDate: plan.startDate,
      interval: plan.interval,
      endDate: plan.endDate,
    },
  });

  return plan.toJSON();
};

// ──────────────────── 4. Cancel a plan (soft delete) ────────────────────
// `data` defaults because a DELETE carries no body: Express 5 leaves
// `req.body` undefined when the client sends none, and the cancellation reason
// is optional, so `DELETE /payment-plans/:id` must not depend on one.
export const cancelPaymentPlan = async (planId, data = {}, user) => {
  const schoolId = resolveSchoolId(user);
  const plan = await loadPlan(planId, schoolId);

  if (!LIVE_STATUSES.includes(plan.planStatus)) {
    throw new ApiError(
      `A ${plan.planStatus} plan cannot be cancelled`,
      400,
      "PLAN_NOT_CANCELLABLE"
    );
  }

  const student = await Student.findById(plan.studentId);
  const school = await fetchSchool(plan.schoolId);

  // Business rule #7: cancelling never refunds — the plan simply stops.
  // Linked Payment records are left untouched.
  plan.planStatus = "cancelled";
  plan.cancelledAt = new Date();
  plan.cancelledBy = user._id;
  plan.cancellationReason = data.reason || "";
  plan.updatedBy = user._id;
  plan.deletedAt = new Date();
  await plan.save();

  if (student) {
    await notifyPlanCancelled(school, student, plan, data.reason);
  }

  await auditService.log({
    action: "plan.cancel",
    entity: "PaymentPlan",
    entityId: plan._id,
    userId: user._id,
    details: { reason: data.reason || "", planStatus: plan.planStatus },
  });

  return { message: "Payment plan cancelled", plan: plan.toJSON() };
};

// ──────────────────── 5. Accept a plan (public) ────────────────────
export const acceptPaymentPlan = async (planId, data) => {
  const token = (data.token || "").toUpperCase();

  if (!token) {
    throw new ApiError("Acceptance token is required", 400, "TOKEN_REQUIRED");
  }

  // The token field is `select: false` so it must be opted into explicitly.
  const plan = await PaymentPlan.findById(planId).select("+acceptanceToken");
  if (!plan || plan.deletedAt) {
    throw new ApiError("Payment plan not found", 404, "PLAN_NOT_FOUND");
  }

  if (!plan.acceptanceToken || plan.acceptanceToken.toUpperCase() !== token) {
    throw new ApiError("Invalid acceptance token", 400, "INVALID_TOKEN");
  }

  if (plan.planStatus !== "pending_acceptance") {
    throw new ApiError(
      `This plan is ${plan.planStatus} and can no longer be accepted`,
      400,
      "PLAN_NOT_ACCEPTABLE"
    );
  }

  plan.planStatus = "active";
  plan.acceptedAt = new Date();
  plan.acceptedVia = data.via || "sms";
  await plan.save();

  const [student, school] = await Promise.all([
    Student.findById(plan.studentId),
    fetchSchool(plan.schoolId),
  ]);
  if (student) {
    await notifyPlanActivated(school, student, plan);
  }

  await auditService.log({
    action: "plan.accept",
    entity: "PaymentPlan",
    entityId: plan._id,
    userId: null,
    details: { acceptedVia: plan.acceptedVia, schoolId: plan.schoolId },
  });

  return { planStatus: plan.planStatus, acceptedAt: plan.acceptedAt };
};

export const adminAcceptPaymentPlan = async (planId, user) => {
  const schoolId = resolveSchoolId(user);
  const plan = await loadPlan(planId, schoolId);

  if (plan.planStatus !== "pending_acceptance") {
    throw new ApiError(
      `This plan is ${plan.planStatus} and can no longer be accepted`,
      400,
      "PLAN_NOT_ACCEPTABLE"
    );
  }

  plan.planStatus = "active";
  plan.acceptedAt = new Date();
  plan.acceptedVia = "admin_manual";
  await plan.save();

  const [student, school] = await Promise.all([
    Student.findById(plan.studentId),
    fetchSchool(plan.schoolId),
  ]);
  if (student) {
    await notifyPlanActivated(school, student, plan);
  }

  await auditService.log({
    action: "plan.accept",
    entity: "PaymentPlan",
    entityId: plan._id,
    userId: user._id,
    details: { acceptedVia: plan.acceptedVia, schoolId: plan.schoolId },
  });

  return { planStatus: plan.planStatus, acceptedAt: plan.acceptedAt };
};

// ──────────────────── 6. Installment actions ────────────────────
export const updateInstallment = async (planId, installmentNumber, data, user) => {
  const schoolId = resolveSchoolId(user);
  const plan = await loadPlan(planId, schoolId);

  if (["cancelled", "expired", "completed"].includes(plan.planStatus)) {
    throw new ApiError(
      `Installments cannot be changed on a ${plan.planStatus} plan`,
      400,
      "PLAN_NOT_EDITABLE"
    );
  }

  const installment = plan.installments.find(
    (i) => i.installmentNumber === Number(installmentNumber)
  );
  if (!installment) {
    throw new ApiError("Installment not found", 404, "INSTALLMENT_NOT_FOUND");
  }

  const previousStatus = plan.planStatus;
  const notes = data.notes !== undefined ? data.notes : installment.notes;

  switch (data.action) {
    case "mark_paid": {
      // Manual reconciliation only — no Payment record is created here.
      const amount = data.amount ?? installment.amount;
      installment.status = "paid";
      installment.amountPaid = amount;
      installment.paidAt = new Date();
      installment.notes = notes;
      break;
    }
    case "mark_unpaid": {
      // Falls back to "overdue" when the due date has already slipped past.
      installment.status =
        new Date(installment.dueDate).getTime() < Date.now() ? "overdue" : "pending";
      installment.amountPaid = 0;
      installment.paidAt = null;
      installment.notes = notes;
      break;
    }
    case "adjust_amount": {
      if (data.amount < installment.amountPaid) {
        throw new ApiError(
          "Installment amount cannot be lower than the amount already paid",
          400,
          "INVALID_AMOUNT"
        );
      }
      // The admin owns the rebalance — totalAmount is intentionally untouched.
      installment.amount = data.amount;
      installment.notes = notes;
      break;
    }
    case "waive": {
      installment.status = "waived";
      // Recording the waived amount keeps progressPercent consistent.
      installment.amountPaid = installment.amount;
      installment.notes = notes;
      break;
    }
    default:
      throw new ApiError("Unsupported installment action", 400, "INVALID_ACTION");
  }

  plan.updatedBy = user._id;
  await plan.save();

  if (plan.planStatus === "completed" && previousStatus !== "completed") {
    const [student, school] = await Promise.all([
      Student.findById(plan.studentId),
      fetchSchool(plan.schoolId),
    ]);
    if (student) await notifyPlanCompleted(school, student, plan);
  }

  await auditService.log({
    action: "plan.installment_update",
    entity: "PaymentPlan",
    entityId: plan._id,
    userId: user._id,
    details: {
      installmentNumber: installment.installmentNumber,
      action: data.action,
      status: installment.status,
      amount: installment.amount,
      amountPaid: installment.amountPaid,
      planStatus: plan.planStatus,
    },
  });

  return plan.toJSON();
};

// ──────────────────── 7. Prepay against a plan (public) ────────────────────
const constantTimeEquals = (a = "", b = "") => {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
};

export const prepayPlan = async (planId, data) => {
  const planToken = data.planToken;

  if (!planToken) {
    throw new ApiError("planToken is required", 400, "TOKEN_REQUIRED");
  }

  const plan = await PaymentPlan.findOne({ _id: planId, deletedAt: null });
  if (!plan) throw new ApiError("Payment plan not found", 404, "PLAN_NOT_FOUND");

  // The pay-link token is the public proof that the caller owns the student's
  // account, so a leaked planId alone cannot be used to start a charge.
  const student = await Student.findOne({ uniquePayLinkToken: planToken, deletedAt: null });
  if (!student || !constantTimeEquals(student._id.toString(), plan.studentId.toString())) {
    throw new ApiError("Invalid or expired payment link", 404, "INVALID_PAY_TOKEN");
  }

  if (student.status !== "active") {
    throw new ApiError("Student account is not active", 400, "STUDENT_NOT_ACTIVE");
  }

  if (plan.planStatus !== "active") {
    throw new ApiError(
      `This plan is ${plan.planStatus} and cannot accept payments`,
      400,
      "PLAN_NOT_ACTIVE"
    );
  }

  const amount = Math.round(Number(data.amount));
  if (!amount || amount <= 0) {
    throw new ApiError("Amount must be greater than zero", 400, "INVALID_AMOUNT");
  }
  if (amount > plan.totalRemaining) {
    throw new ApiError(
      `Amount cannot exceed the outstanding balance of GHS ${toCedis(plan.totalRemaining)}`,
      400,
      "AMOUNT_EXCEEDS_REMAINING"
    );
  }

  let targetInstallment = null;
  if (data.installmentNumber) {
    targetInstallment = plan.installments.find(
      (i) => i.installmentNumber === Number(data.installmentNumber)
    );
    if (!targetInstallment) {
      throw new ApiError("Installment not found", 404, "INSTALLMENT_NOT_FOUND");
    }
    if (targetInstallment.status === "paid" || targetInstallment.status === "waived") {
      throw new ApiError(
        "That installment has already been settled",
        400,
        "INSTALLMENT_ALREADY_PAID"
      );
    }
  }

  const school = await fetchSchool(plan.schoolId);
  const primaryParent = getPrimaryParent(student);

  // The gateway is resolved before the Payment record is created, so a
  // misconfigured deployment never leaves an orphaned pending payment behind.
  // Moolre is the sole active gateway; MTN remains wired but is off by default.
  const gateway = resolveGateway(school);

  const payment = await Payment.create({
    studentId: student._id,
    schoolId: plan.schoolId,
    parentId: null,
    paymentPlanId: plan._id,
    amount,
    currency: "GHS",
    status: "pending",
    paymentMethod: "card",
    provider: gateway,
    momoPhoneNumber: data.phoneNumber || primaryParent?.phone || null,
    momoNetwork: data.momoNetwork || "UNKNOWN",
    description: `Payment plan installment for ${student.studentName}`,
    // The reference the parent polls on, and the external reference Moolre
    // echoes back on the callback.
    reference: generatePaymentReference(),
    feesBreakdown: [
      {
        type: "payment_plan",
        planId: plan._id.toString(),
        planName: plan.planName,
        installmentNumber: targetInstallment
          ? targetInstallment.installmentNumber
          : null,
      },
    ],
    createdBy: plan.createdBy,
  });

  await auditService.log({
    action: "plan.prepay",
    entity: "PaymentPlan",
    entityId: plan._id,
    userId: null,
    details: {
      paymentId: payment.paymentId,
      amount,
      installmentNumber: targetInstallment?.installmentNumber ?? null,
      provider: gateway,
    },
  });

  // The MTN branch is retained as dead code — it cannot be reached while
  // `resolveGateway` only returns 'moolre', and it exists so re-enabling that
  // gateway needs only the resolver change, not a rewrite of the dispatch table.
  if (gateway === "mtn") {
    return prepayViaMtn(payment, plan, student, primaryParent, amount, targetInstallment);
  }

  return prepayViaMoolre(payment, plan, student, amount);
};

/**
 * Starts a Moolre USSD push for an installment.
 *
 * The parent authorises the prompt on their handset; the installment is applied
 * when the callback or a status poll settles the payment.
 *
 * The payment's `reference` is the join key: it is handed to Moolre as the
 * external reference and echoed back on the callback, so the settlement can be
 * matched to this payment without a transaction id.
 */
const prepayViaMoolre = async (payment, plan, student, amount) => {
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

  // The network is stored in this platform's vocabulary (MTN / VODAFONE /
  // AIRTELTELIGO / UNKNOWN). An UNKNOWN network cannot be routed — Moolre
  // would accept the request and then fail to deliver it to any carrier.
  if (!payment.momoNetwork || payment.momoNetwork === "UNKNOWN") {
    payment.status = "failed";
    payment.failureReason = "No mobile money network selected for the payment";
    await payment.save();
    throw new ApiError(
      "Please choose the mobile money network you are paying from",
      400,
      "MOMO_NETWORK_REQUIRED"
    );
  }

  try {
    const result = await moolreInitiatePayment({
      // Moolre takes cedis; this platform stores pesewas.
      amount: amount / 100,
      phone,
      network: payment.momoNetwork,
      reference: payment.reference,
      description: payment.description,
    });

    // Moolre wants the payer's phone number verified before it will send the
    // prompt. The payment is **not** failed here: it is waiting for the parent
    // to type in the code Moolre sent them.
    if (result?.status === "otp_required") {
      payment.status = "pending";
      payment.moolreReference = payment.reference;
      payment.moolreChannel = moolreNormaliseChannel(payment.momoNetwork);
      payment.moolreResponseMessage =
        result?.message?.slice(0, 500) || "Phone number verification required";
      await payment.save();

      return {
        paymentRef: payment.paymentId,
        planId: plan._id,
        amount,
        provider: "moolre",
        requiresOtp: true,
        otpRequired: true,
        moolre: {
          reference: payment.reference,
          channel: payment.moolreChannel,
          payerPhone: phone,
        },
      };
    }

    payment.status = "processing";
    payment.moolreReference = payment.reference;
    payment.moolreTransactionId = result?.transactionId || result?.transactionid || null;
    payment.moolreChannel = moolreNormaliseChannel(payment.momoNetwork);
    await payment.save();

    await auditService.log({
      action: "payment.initiate",
      entity: "Payment",
      entityId: payment._id,
      userId: plan.createdBy,
      details: {
        paymentId: payment.paymentId,
        amount: payment.amount,
        studentId: student.studentId,
        provider: "moolre",
        reference: payment.reference,
        planId: plan._id,
      },
    });

    return {
      paymentRef: payment.paymentId,
      planId: plan._id,
      amount,
      provider: "moolre",
      requiresPayerApproval: true,
      moolre: {
        reference: payment.reference,
        channel: payment.moolreChannel,
        payerPhone: phone,
      },
    };
  } catch (error) {
    // No prompt was issued, so the payment is terminal rather than pending for
    // a callback that will never arrive.
    payment.status = "failed";
    payment.moolreResponseMessage = error.message?.slice(0, 500) || "Moolre request failed";
    await payment.save();

    if (error instanceof MoolreTransportError) {
      throw new ApiError(error.message, error.status, error.code);
    }
    throw error;
  }
};

/**
 * Charges the installment through MTN Collections.
 *
 * The parent authorises the prompt on their handset; the installment is applied
 * when the callback or a status poll settles the payment.
 */
const prepayViaMtn = async (payment, plan, student, primaryParent, amount, targetInstallment) => {
  const phone = payment.momoPhoneNumber;

  if (!phone) {
    payment.status = "failed";
    await payment.save();
    throw new ApiError(
      "No phone number on file for this payer",
      400,
      "PAYER_PHONE_MISSING"
    );
  }

  try {
    const result = await mtnRequestToPay({
      amount,
      phone,
      externalId: payment.paymentId,
      referenceId: payment.paymentId,
      payerMessage: `Installment payment for ${student.studentName}`,
      payeeNote: `Payment plan installment${targetInstallment ? ` #${targetInstallment.installmentNumber}` : ""}`,
    });

    payment.status = "processing";
    payment.mtnReferenceId = result?.referenceId || null;
    payment.mtnResponseCode = String(result?.status || "").toUpperCase() || "PENDING";
    await payment.save();

    return {
      paymentRef: payment.paymentId,
      planId: plan._id,
      amount,
      provider: "mtn",
      requiresPayerApproval: true,
      mtn: {
        referenceId: payment.mtnReferenceId,
        status: payment.mtnResponseCode,
        payerPhone: phone,
      },
    };
  } catch (error) {
    // No prompt was issued, so the payment is terminal rather than pending for
    // a callback that will never arrive.
    payment.status = "failed";
    payment.mtnResponseMessage = error.message?.slice(0, 500) || "MTN request failed";
    await payment.save();

    if (error instanceof MtnTransportError) {
      throw new ApiError(error.message, error.status, error.code);
    }
    throw error;
  }
};

/**
 * Applies a completed payment to its plan, oldest installment first. Called
 * from the Moolre webhook once a payment settles. Idempotent: a payment that
 * has already been recorded against an installment is ignored.
 */
export const applyCompletedPaymentToPlan = async (payment) => {
  if (!payment?.paymentPlanId) return null;

  // The arithmetic and the idempotency guard live in `paymentApplication`, which
  // the prepayment path and the portal share. This function keeps only what is
  // specific to *this* caller: reading the student and school so a completed plan
  // can be announced, and writing the audit line.
  const outcome = await applyPaymentToPlan(
    payment.paymentPlanId,
    payment.amount,
    payment._id
  );

  if (!outcome || outcome.duplicate || !outcome.applied?.length) return null;

  const plan = outcome.plan;

  if (plan.planStatus === "completed") {
    const [student, school] = await Promise.all([
      Student.findById(plan.studentId),
      fetchSchool(plan.schoolId),
    ]);
    if (student) {
      await notifyPlanCompleted(school, student, plan);
    }
  }

  await auditService.log({
    action: "plan.payment_applied",
    entity: "PaymentPlan",
    entityId: plan._id,
    userId: null,
    details: {
      paymentId: payment.paymentId,
      amount: payment.amount,
      applied: outcome.applied,
      unapplied: outcome.unapplied,
    },
  });

  return { plan, applied: outcome.applied, unapplied: outcome.unapplied };
};

// ──────────────────── 8. School compliance overview ────────────────────

// "approaching due" = the next due date lands within 3 days.
const COMPLIANCE_WINDOW_DAYS = 3;

const classifyPlan = (plan, windowEnd) => {
  if (plan.planStatus === "completed") return "completed";
  if (plan.planStatus === "defaulted") return "defaulted";
  if (plan.planStatus === "cancelled" || plan.planStatus === "expired") return null;
  if (plan.planStatus === "pending_acceptance") return "pending_acceptance";

  const hasOverdue = plan.installments.some((i) => i.status === "overdue");
  if (hasOverdue) return "overdue";

  const next = nextUnsettledInstallment(plan);
  if (next && new Date(next.dueDate).getTime() <= windowEnd.getTime()) {
    return "approaching_due";
  }

  return "on_track";
};

const withNextInstallment = (plan) => {
  const next = nextUnsettledInstallment(plan);
  return next
    ? {
        installmentNumber: next.installmentNumber,
        amount: next.amount,
        amountPaid: next.amountPaid,
        dueDate: next.dueDate,
        status: next.status,
        outstanding: next.amount - (next.amountPaid || 0),
      }
    : null;
};

/**
 * What a plan still owes, in pesewas.
 *
 * Summed from the installments rather than read from the plan's `totalRemaining`
 * field, because that field is a pre-save denormalisation: a plan whose
 * installment was edited outside a save (a webhook applying a payment, a manual
 * database fix) would report a stale remainder, and the compliance dashboard's
 * money figures are exactly what a bursar reconciles against. Deriving it costs
 * one reduce over an array already in memory.
 */
const outstandingOnPlan = (plan) =>
  (plan.installments || []).reduce(
    (sum, installment) =>
      sum + Math.max((installment.amount || 0) - (installment.amountPaid || 0), 0),
    0
  );

/**
 * What a plan's slipped tranches owe, in pesewas.
 *
 * Separate from `outstandingOnPlan` because the compliance dashboard asks two
 * different questions: "how much is in flight" (all of it) and "how much is late"
 * (only the slipped tranches). A plan can be entirely current *and* carry a
 * missed tranche only in the sense of a waived one, so the two are genuinely
 * different sums and not derivable from each other.
 */
const arrearsOnPlan = (plan, now) =>
  (plan.installments || []).reduce((sum, installment) => {
    const unsettled = installment.status === "pending" || installment.status === "partial" || installment.status === "overdue";
    if (!unsettled) return sum;
    if (new Date(installment.dueDate).getTime() > now.getTime()) return sum;
    return sum + Math.max((installment.amount || 0) - (installment.amountPaid || 0), 0);
  }, 0);

export const getSchoolCompliance = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  await fetchSchool(schoolId);

  const filter = { schoolId, deletedAt: null };

  if (query.term) filter.term = query.term;
  if (query.academicYear) filter.academicYear = query.academicYear;

  // Both of these narrow by *student*, so the plan filter is derived from a
  // student query rather than applied directly: a plan stores only `studentId`,
  // and there is nothing on it to match a class name or a parent's name against.
  if (query.class) {
    const students = await Student.find({
      schoolId,
      studentClass: query.class,
      deletedAt: null,
    })
      .select("_id")
      .lean();
    filter.studentId = { $in: students.map((s) => s._id) };
  }

  if (query.search) {
    // Escaped before it reaches the regex engine. An unescaped user-supplied
    // pattern is a ReDoS vector on every keystroke of a search box, and the
    // terms here (a name, an id) have no legitimate use for a wildcard.
    const pattern = new RegExp(escapeRegExp(query.search), "i");

    const matched = await Student.find({
      schoolId,
      deletedAt: null,
      $or: [
        { studentName: pattern },
        { studentId: pattern },
        { "parents.parentName": pattern },
      ],
    })
      .select("_id")
      .lean();

    // Intersect rather than replace: a class filter and a search filter are
    // both constraints on the same set, and applying the second with `$in` would
    // silently discard the first — a bursar searching within "JHS 2A" would get
    // the whole school's matches.
    const ids = matched.map((student) => student._id);
    filter.studentId = filter.studentId
      ? { $in: filter.studentId.$in.filter((id) => ids.some((other) => other.equals(id))) }
      : { $in: ids };
  }

  const plans = await PaymentPlan.find(filter).lean();

  const now = new Date();
  const windowEnd = endOfDayAccra(addDays(now, COMPLIANCE_WINDOW_DAYS));

  const summary = {
    totalPlans: plans.length,
    onTrack: 0,
    approachingDue: 0,
    overdue: 0,
    completed: 0,
    defaulted: 0,
    pendingAcceptance: 0,

    // ── Money, by bucket ──
    //
    // Computed here rather than in the client because the only way to get them
    // client-side is to ship every plan in the school to the browser and sum it
    // there — which is both a pagination bug (the endpoint returns 20 plans, so
    // a client-side sum would total 20 plans' worth of money and label it as the
    // school's) and a slow one. The dashboard's headline figures are
    // aggregates over the whole school, so they belong next to the query that
    // sees the whole school.
    onTrackValue: 0,
    approachingDueValue: 0,
    overdueValue: 0,
    /** Every plan still in flight, worth this much. The "committed" figure. */
    committedAmount: 0,
    /** Only the slipped tranches. What a chaser is actually owed today. */
    overdueArrears: 0,
    /** Only the next tranche of the plans approaching their date. */
    approachingInflow: 0,
  };

  const decorated = plans.map((plan) => {
    const bucket = classifyPlan(plan, windowEnd);
    if (bucket === "on_track") summary.onTrack += 1;
    else if (bucket === "approaching_due") summary.approachingDue += 1;
    else if (bucket === "overdue") summary.overdue += 1;
    else if (bucket === "completed") summary.completed += 1;
    else if (bucket === "defaulted") summary.defaulted += 1;
    else if (bucket === "pending_acceptance") summary.pendingAcceptance += 1;

    const next = withNextInstallment(plan);

    if (ACTIVE_COMPLIANCE_KEYS.includes(
      bucket === "on_track" ? "onTrack" : bucket === "approaching_due" ? "approachingDue" : bucket
    )) {
      const outstanding = outstandingOnPlan(plan);
      summary.committedAmount += outstanding;

      if (bucket === "on_track") summary.onTrackValue += outstanding;
      else if (bucket === "approaching_due") {
        summary.approachingDueValue += outstanding;
        // The inflow is the *next* tranche, not the whole plan: the school's
        // expectation for this week is the money that falls due this week, and
        // quoting the plan total would tell a bursar to expect GH₵ 200,000 in
        // five days.
        summary.approachingInflow += next
          ? Math.max(next.amount - (next.amountPaid || 0), 0)
          : 0;
      } else {
        summary.overdueValue += outstanding;
        summary.overdueArrears += arrearsOnPlan(plan, now);
      }
    }

    return {
      ...plan,
      complianceStatus: bucket,
      nextInstallment: next,
      outstandingAmount: outstandingOnPlan(plan),
    };
  });

  // ── The rate, and the denominator it is measured against ──
  //
  // Both are the server's to compute. A client that divided `onTrack` by
  // `totalPlans` would be dividing by a number that includes completed and
  // cancelled plans, and would report a school that finished every plan it ever
  // wrote as 40% compliant.
  summary.activePlans = ACTIVE_COMPLIANCE_KEYS.reduce(
    (sum, key) => sum + (summary[key] || 0),
    0
  );
  summary.complianceRate = summary.activePlans
    ? Math.round((summary.onTrack / summary.activePlans) * 1000) / 10
    : null;
  summary.atRiskPlans = summary.overdue + summary.approachingDue;

  const filtered =
    query.status && query.status !== "all"
      ? decorated.filter((plan) => plan.complianceStatus === query.status)
      : decorated;

  const sortBy = query.sortBy || "endDate";
  const direction = query.sortOrder === "desc" ? -1 : 1;
  filtered.sort((a, b) => {
    const left = a[sortBy] ?? 0;
    const right = b[sortBy] ?? 0;
    if (left === right) return 0;
    return (left > right ? 1 : -1) * direction;
  });

  const page = Number(query.page) || 1;
  const perPage = Number(query.perPage) || 20;
  const skip = (page - 1) * perPage;

  // Student names live on the Student collection; pull only the ids on this page.
  const pagePlans = filtered.slice(skip, skip + perPage);
  const students = await Student.find({
    _id: { $in: pagePlans.map((p) => p.studentId) },
  })
    .select("studentId studentName studentClass balance parents")
    .lean();
  const studentById = new Map(students.map((s) => [s._id.toString(), s]));

  const data = pagePlans.map((plan) => {
    const student = studentById.get(plan.studentId.toString());
    const { acceptanceToken, ...safe } = plan;
    return {
      ...safe,
      student: student
        ? {
            _id: student._id,
            studentId: student.studentId,
            studentName: student.studentName,
            studentClass: student.studentClass,
            balance: student.balance,
            // The primary parent, denormalised onto the row. The compliance table
            // shows "Parent: K. O. Mensah" on every line, and without this the
            // client has to fetch a student per row to fill it in — twenty
            // requests for one screen, against a lookup this function was already
            // doing. The *phone* is deliberately not included: a compliance list
            // has no use for twenty parents' numbers, and a full page of them is
            // exactly the kind of thing a bursar pastes into a spreadsheet.
            parentName: getPrimaryParent(student)?.parentName || null,
          }
        : null,
    };
  });

  return {
    summary,
    plans: data,
    meta: {
      page,
      perPage,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / perPage),
    },
  };
};

// ──────────────────── Cron support ────────────────────

/**
 * Sweeps a single plan: flips slipped installments to "overdue", refreshes
 * progress and the derived status. Shared by the reminder job and the expiry
 * pass. Returns the plan when something actually changed.
 */
export const sweepPlanStatuses = async (plan) => {
  const now = new Date();
  let changed = false;

  plan.installments.forEach((installment) => {
    if (
      (installment.status === "pending" || installment.status === "partial") &&
      new Date(installment.dueDate).getTime() < now.getTime()
    ) {
      installment.status = "overdue";
      changed = true;
    }
  });

  if (plan.planStatus === "active" && new Date(plan.endDate).getTime() < now.getTime()) {
    plan.planStatus = "expired";
    changed = true;
  }

  if (changed) {
    plan.lastOverdueCheckAt = now;
    await plan.save();
  }

  return changed ? plan : null;
};

export { ApiError };
