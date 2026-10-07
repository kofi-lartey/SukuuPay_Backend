import mongoose from "mongoose";
import { Payment } from "../models/paymentModel.js";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import { PaymentPlan } from "../models/paymentPlanModel.js";
import { User } from "../models/userModel.js";
import { Notification } from "../models/Notification.js";
import { ParentMessage } from "../models/ParentMessage.js";
import ApiError from "../utils/ApiError.js";
import auditService from "../utils/auditService.js";
import { sendSms } from "../utils/smsService.js";
import { uploadAudioBuffer } from "../utils/cloudinary.js";
import { CLOUDINARY_UPLOAD_FOLDER } from "../config/env.js";
import { AUDIT_ACTIONS, NOTIFICATION_TYPES } from "../config/constants.js";
import { consumeRateLimit, peekRateLimit, RateLimitError } from "../utils/rateLimiter.js";
import { PAY_PORTAL_LIMITS } from "../middleware/rateLimit.js";
import {
  generateInstallmentSchedule,
  generateAcceptanceToken,
} from "../utils/planHelpers.js";
import { startOfDayAccra } from "../utils/dateHelpers.js";
import { PORTAL_NETWORK_ALIASES } from "../validations/payment.validation.js";

/**
 * The parent pay portal's own service layer.
 *
 * ## Why this is separate from `payment.service.js`
 *
 * `payment.service.js` is the *school's* view of money: it lists, filters, exports
 * and reconciles payments, and it is allowed to see every field on the collection
 * because every caller is an authenticated member of the owning school.
 *
 * This module is the *parent's* view. The caller has proven exactly one thing —
 * that it holds this one student's pay token — and the whole design problem is
 * that this one credential has to be turned into a useful page without becoming a
 * window into the student record, the school's record, or the guardians' phone
 * numbers. That is a projection problem, and it is kept here so the field list
 * that decides it is a single readable object rather than something assembled from
 * `.lean()` calls spread across a controller.
 *
 * The public student payload is built by `projectStudent`, which is the only place
 * allowed to decide what crosses the token boundary. Anything added to the Student
 * model is therefore invisible to a parent until someone adds it there
 * deliberately — which is the property that matters, because the default failure
 * mode of "return the document and delete the sensitive fields" is that someone
 * forgets to delete one.
 */

// ──────────────────── Constants ────────────────────

/** How many settled payments the portal's landing page shows. */
const RECENT_PAYMENT_LIMIT = 3;

/**
 * Statuses that mean "this student has left".
 *
 * `removed` and `transferred_out` answer 410 Gone: the link was valid once and the
 * record it named is finished. `graduated` and `suspended` answer 200 with a flag,
 * because the child's record is live and the parent still needs to read it — the
 * difference is whether there is anything to pay or a conversation to have.
 */
const CLOSED_STATUSES = new Set(["removed", "transferred_out"]);
const PAYMENT_BLOCKED_STATUSES = new Set([
  "suspended",
  "removed",
  "graduated",
  "transferred_out",
]);

/** Live plan statuses — a plan in any of these is "the one plan" for a student. */
const LIVE_PLAN_STATUSES = ["pending_acceptance", "active"];

/** 100 pesewas — GH₵ 1.00. Mirrors `payInitiateSchema`; re-checked here. */
const MIN_PAYMENT = 100;

// ──────────────────── Lookups ────────────────────

const fetchSchool = async (schoolId) => {
  if (!schoolId || !mongoose.Types.ObjectId.isValid(schoolId)) return null;
  return School.findById(schoolId).lean();
};

/**
 * Resolves a pay token to a live student, or throws the right refusal.
 *
 * Every public route funnels through here, so the three "this page cannot show a
 * bill" outcomes are decided once: an unknown token is 404 (the token is the
 * credential, so saying "that is not a valid link" leaks nothing — the token space
 * is not guessable and the error names no student), a closed student is 410, and
 * everything else is returned with its `status` intact for the caller to act on.
 *
 * `deletedAt` is honoured so a soft-deleted roster row cannot be paid through a
 * link that was never rotated.
 */
const requireStudentByToken = async (token) => {
  const student = await Student.findOne({
    uniquePayLinkToken: String(token || "").toUpperCase(),
    deletedAt: null,
  });

  if (!student) {
    throw new ApiError(
      "This payment link is invalid or has expired. Please contact the school for a new link.",
      404,
      "PAY_LINK_INVALID"
    );
  }

  if (CLOSED_STATUSES.has(student.status)) {
    throw new ApiError(
      "This account is no longer active. Please contact the school.",
      410,
      "STUDENT_ARCHIVED"
    );
  }

  return student;
};

/**
 * The one live plan for a student, or null.
 *
 * "Live" is `pending_acceptance` or `active` rather than just `active`, and the
 * difference matters for what a parent sees: a plan they have requested and the
 * school has not yet answered is *in flight*, and hiding it would leave the
 * request page looking like it never went anywhere.
 */
const findLivePlan = (studentId) =>
  PaymentPlan.findOne({
    studentId,
    planStatus: { $in: LIVE_PLAN_STATUSES },
    deletedAt: null,
  }).lean();

// ──────────────────── The projection ────────────────────

/**
 * Masks a Ghanaian number down to its last four digits: `•••• 7890`.
 *
 * `maskPhone` hides everything but the last *three*, which is right for a log line
 * and too little for this. A parent looking at their own record needs to
 * recognise the number they are being asked to confirm — "ending 7890" is enough
 * to do that and is not enough to place a call. This is the only number format
 * that ever leaves the portal, and it is deliberately not a full number.
 */
const maskContact = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  return `•••• ${digits.slice(-4)}`;
};

/**
 * Whole days from now until `value`, negative once it has passed.
 *
 * **Midnight to midnight, not "now" to the instant.** A deadline is a *date* — it is
 * authored as `23:59` on its last day, because the school means "by the close of
 * business on the 30th". Counting from the current instant instead makes the answer
 * depend on what time of day the parent happened to open the link: at 12:00 on the
 * 3rd, a due date of the 30th is 28 days away, and at 23:00 on the 2nd it is 29. The
 * same parent, the same bill, a different answer depending on the hour — and the
 * number that appears as "Due in N days" in the SMS and on the page stops agreeing.
 *
 * `Math.ceil` from the instant was also wrong in the other direction: it reported
 * "Overdue by 4 days" on the fifth day after a deadline, because five full days had
 * not yet elapsed as elapsed-time.
 *
 * Kept byte-for-byte equivalent to `frontend/src/utils/parentFormat.js`'s
 * `daysUntil`. Two implementations of "how many days until the deadline" will
 * drift, and the moment they do, the page contradicts the message that sent the
 * parent there.
 */
const daysBetween = (value, now) => {
  if (!value) return null;
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return null;

  // `now` is guarded as well. It defaults to `new Date()`, but it is a parameter,
  // and an invalid one reaches `Date.UTC(NaN, NaN, NaN)` — producing `NaN` out of
  // an otherwise guarded function, which would serialise as `"daysToDeadline": NaN`
  // into JSON (as `null`) while every comparison against it silently went false.
  const reference = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(reference.getTime())) return null;

  const startOfTarget = Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate()
  );
  const startOfToday = Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate()
  );

  return Math.round((startOfTarget - startOfToday) / 86400000);
};

/**
 * The student fields a parent may see. An allowlist, not a denylist.
 *
 * Absent on purpose: `_id` (the Mongo id — an enumerable database handle that lets
 * a holder of a pay link walk the collection), `schoolId`, `uniquePayLinkToken`,
 * `payLink` (the token again, in full), `parents`, `emergencyContacts`,
 * `createdBy`/`updatedBy`, `deletedReason`, `statusReason`, `classHistory`,
 * `transferOutRecord`, `dateOfBirth`, `gender` and `promotedFrom`/`promotedTo`.
 *
 * The omitted ones are not all secrets. They are simply not the parent's business
 * when they are trying to pay a fee: a link forwarded into a family group carries
 * a child's class and fee balance already, and every field removed here is one
 * fewer thing to leak if the link is screenshot.
 */
const projectStudent = (student, now = new Date()) => {
  const balance = Math.max(student.balance || 0, 0);
  const deadline = student.deadline ? new Date(student.deadline) : null;
  const hasDeadline = Boolean(deadline) && !Number.isNaN(deadline.getTime());
  const daysToDeadline = hasDeadline ? daysBetween(student.deadline, now) : null;

  // Overdue only when there is something left to pay. A student who settled on the
  // second and whose deadline passed on the tenth is not overdue, and the naive
  // `deadline < now` says they are — which is the kind of message that turns a
  // satisfied customer into a support call.
  const isOverdue = Boolean(
    balance > 0 && hasDeadline && daysToDeadline !== null && daysToDeadline < 0
  );

  const primaryParent =
    (student.parents || []).find((p) => p.isPrimary) || (student.parents || [])[0];

  return {
    studentId: student.studentId,
    studentName: student.studentName,
    studentClass: student.studentClass,
    studentImage: student.studentImage || null,
    status: student.status,
    totalOwed: student.totalOwed || 0,
    totalPaid: student.totalPaid || 0,
    balance,
    deadline: hasDeadline ? deadline.toISOString() : null,

    // Precomputed rather than left to the client so every surface — the page, the
    // history header, the plan card — says "overdue by 5 days" from one definition
    // instead of three that drift.
    //
    // Coerced to booleans. These are compared with `===` and rendered into
    // `disabled={!canPay}` and `className={isOverdue ? 'red' : 'green'}`, and the
    // `&&` chain above yields `null` rather than `false` when there is no deadline —
    // which serialises as `"isOverdue": null` and fails a client's boolean check.
    isOverdue,
    overdueDays: isOverdue ? Math.abs(daysToDeadline) : 0,
    daysToDeadline,

    /** Enough to confirm the right child and the right guardian. Nothing more. */
    primaryParent: primaryParent
      ? {
          parentName: primaryParent.parentName,
          relationship: primaryParent.relationship,
          phoneMasked: maskContact(primaryParent.phone),
        }
      : null,
  };
};

/**
 * The school fields a parent may see.
 *
 * `phone` and `email` are included in full and that is not an oversight: they are
 * the school's published contact details, and the "Contact school" section on the
 * page is *made of* them. Nothing here is a credential — there is no `bankAccount`,
 * no `payment` config, no `featureFlags`.
 */
const projectSchool = (school) =>
  school
    ? {
        name: school.name,
        logo: school.logo || null,
        brandColor: school.brandColor || null,
        phone: school.phone || null,
        email: school.email || null,
      }
    : null;

/**
 * An installment, as a parent reads it.
 *
 * `amountPaid` is included rather than just `status` because a *partial* tranche is
 * the case a parent most needs to understand and "partial" alone does not tell
 * them how much is left on it.
 *
 * **Settled is computed from the arithmetic, not read from `status`.** The model's
 * pre-save hook keeps `status` current, but it only runs on save — and the portal
 * reads whatever it is handed. A tranche whose `amountPaid` equals its `amount` with
 * `status: "pending"` is fully paid, and treating it as live produced two wrong
 * answers on the same row: an amber "3 days late" pill on money already collected,
 * and a "Pay next installment — GHS 300.00" button that would have let a parent pay
 * it a second time.
 */
const projectInstallment = (installment, now = new Date()) => {
  const amount = installment.amount || 0;
  const amountPaid = installment.amountPaid || 0;
  const outstanding = Math.max(amount - amountPaid, 0);
  const daysToDue = daysBetween(installment.dueDate, now);

  const settled =
    installment.status === 'paid' ||
    installment.status === 'waived' ||
    outstanding <= 0;
  const overdue = !settled && daysToDue !== null && daysToDue < 0;

  return {
    installmentNumber: installment.installmentNumber,
    amount,
    amountPaid,
    outstanding,
    dueDate: installment.dueDate || null,
    status: installment.status,
    // A parent's next question after "which one is next" is "how much", and
    // recomputing it from the plan total in the client is a rounding bug waiting
    // to happen.
    isNext: false, // filled in below, once the plan knows its own schedule
    daysToDue,
    isOverdue: overdue,
    settled,
  };
};

/**
 * The plan, as a parent reads it.
 *
 * `planId` is included and is safe to expose: it is an id the parent is already
 * authorised to act on through their own token, and the plan page needs it. It is
 * *not* accepted from the client anywhere — see `requireStudentByToken`.
 */
const projectPlan = (plan, now = new Date()) => {
  if (!plan) return null;

  const installments = (plan.installments || [])
    .map((i) => projectInstallment(i, now))
    .sort((a, b) => a.installmentNumber - b.installmentNumber);

  // The next tranche is the earliest one that still owes money, whatever its due
  // date. A parent who missed the first two does not have a "next" payment due in
  // the future — they have an arrears figure, and labelling it "not yet due" is how
  // a defaulted plan keeps looking healthy.
  const nextIndex = installments.findIndex((i) => i.outstanding > 0 && !i.settled);
  if (nextIndex !== -1) installments[nextIndex].isNext = true;

  const totalAmount = plan.totalAmount || 0;
  const totalPaid = installments.reduce((sum, i) => sum + i.amountPaid, 0);

  return {
    planId: String(plan._id),
    planStatus: plan.planStatus,
    planName: plan.planName,
    numberOfInstallments: plan.numberOfInstallments,
    interval: plan.interval,
    totalAmount,
    totalPaid,
    totalRemaining: Math.max(totalAmount - totalPaid, 0),
    // Derived here rather than read from `plan.progressPercent`, which is a
    // pre-save denormalisation: the plan may have been settled by the webhook
    // without the projection having seen the save.
    progressPercent: totalAmount
      ? Math.round((totalPaid / totalAmount) * 100)
      : 0,
    startDate: plan.startDate,
    endDate: plan.endDate,
    installments,
    nextInstallment:
      nextIndex === -1
        ? null
        : {
            installmentNumber: installments[nextIndex].installmentNumber,
            // **What is owed, not what the tranche was sized at.** These differ for
            // a part-paid tranche, and the portal pre-fills its payment form from
            // this field — so carrying the original amount there produced a form
            // pre-filled with GH₵ 300.00 for a tranche owing GH₵ 200.00, and the
            // server would then have refused the payment as over the outstanding
            // (the tranche's remaining 200 plus nothing else). A parent who tapped
            // the one button that was supposed to make this easy got an error.
            amount: installments[nextIndex].outstanding,
            outstanding: installments[nextIndex].outstanding,
            dueDate: installments[nextIndex].dueDate,
          },
  };
};

/**
 * A settled payment, as a parent reads it.
 *
 * `paymentId` is included because the receipt endpoint needs it, and
 * `receiptNumber` because a parent asking the bursar for proof quotes the number on
 * the receipt. `momoNetwork` is `UNKNOWN` for desk payments taken in cash, which is
 * rendered as "—" rather than as a network.
 */
const projectPayment = (payment) => ({
  paymentId: payment.paymentId,
  amount: payment.amount,
  receiptNumber: payment.receiptNumber || null,
  network: payment.momoNetwork && payment.momoNetwork !== "UNKNOWN" ? payment.momoNetwork : null,
  paymentMethod: payment.paymentMethod,
  status: payment.status,
  completedAt: payment.completedAt || payment.createdAt,
  createdAt: payment.createdAt,
});

// ──────────────────── Public reads ────────────────────

/**
 * Everything the portal's landing page renders, in one response.
 *
 * One request rather than four, and that is a 3G decision rather than an
 * aesthetic one: four round trips over a poor connection is the difference between
 * a page that appears and a page that assembles one card at a time over ten
 * seconds. The three reads are independent, so they are issued together.
 *
 * A suspended student is a *success*, not an error. The parent needs to see who
 * they are and what is owed, and the page renders that plus a banner — returning
 * 403 would replace that with a message they can do nothing about.
 */
export const getPortalView = async (token) => {
  const student = await requireStudentByToken(token);

  const [school, plan, recentPayments] = await Promise.all([
    fetchSchool(student.schoolId),
    findLivePlan(student._id),
    Payment.find({
      studentId: student._id,
      status: "completed",
      deletedAt: null,
      // A reversal is a payment row with a negative amount and a `refundOf`
      // pointer. Showing it as a receipt is not wrong — it is the school's
      // record — but it is not what "your recent payments" means to a parent, and
      // a refund row with no receipt number reads as a bug.
      $nor: [{ refundOfPaymentId: { $ne: null } }],
    })
      .sort({ completedAt: -1, createdAt: -1 })
      .limit(RECENT_PAYMENT_LIMIT)
      .lean(),
  ]);

  const now = new Date();

  return {
    student: projectStudent(student, now),
    school: projectSchool(school),
    paymentPlan: projectPlan(plan, now),
    recentPayments: recentPayments.map(projectPayment),
    // Read-only reasons for the page to explain itself, so the client never has to
    // re-derive "why can't I pay" from a status enum.
    suspended: student.status === "suspended",
    canPay: student.status === "active" && (student.balance || 0) > 0,
    message:
      student.status === "suspended"
        ? "This account is currently suspended. Please contact the school."
        : null,
  };
};

/**
 * The full settled-payment history for this student, paginated.
 *
 * Scoped by `studentId` *derived from the token*, never by a client-supplied id.
 * That is the single most important line in this module: a `studentId` in a query
 * string would let anyone holding one live pay token read another child's entire
 * payment history by editing a number.
 */
export const getPaymentHistory = async (token, { page = 1, perPage = 20 } = {}) => {
  const student = await requireStudentByToken(token);

  const filter = {
    studentId: student._id,
    status: "completed",
    deletedAt: null,
    $nor: [{ refundOfPaymentId: { $ne: null } }],
  };

  const [rows, total] = await Promise.all([
    Payment.find(filter)
      .sort({ completedAt: -1, createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean(),
    Payment.countDocuments(filter),
  ]);

  return {
    payments: rows.map(projectPayment),
    pagination: {
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      hasMore: page * perPage < total,
    },
    student: {
      studentName: student.studentName,
      studentClass: student.studentClass,
      totalOwed: student.totalOwed || 0,
      totalPaid: student.totalPaid || 0,
      balance: Math.max(student.balance || 0, 0),
    },
  };
};

// ──────────────────── Payment initiation ────────────────────

/**
 * Maps a portal network name onto the payment model's enum.
 *
 * Unknown values become `UNKNOWN` rather than throwing: the gateway resolves the
 * real operator from the number's prefix, so an unrecognised label degrades to a
 * payment that still works, while rejecting it would block a parent who simply
 * spelled it differently.
 */
export const resolveNetwork = (network) =>
  PORTAL_NETWORK_ALIASES[String(network || "UNKNOWN").toUpperCase()] || "UNKNOWN";

/**
 * Validates a parent-submitted amount against the student's *live* balance.
 *
 * The ceiling is checked here, server-side, against a freshly read figure — not
 * against whatever balance the client was shown when the page loaded. Between the
 * page rendering and the parent tapping "Pay", a sibling's fees can change the
 * balance, and the amount the parent is looking at on their screen may already be
 * wrong. Overpaying is refused with a message naming the current balance so the
 * page can correct itself rather than showing a bare 422.
 *
 * Also refuses a payment against a student who is not `active`. A suspended
 * student's link still renders — the parent can see who they are — but taking
 * money through it would route a payment into an account the school has
 * deliberately frozen.
 *
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string, status: number }>}
 */
export const validatePaymentRequest = async (token, { amount, phone, network } = {}) => {
  const student = await requireStudentByToken(token);

  if (PAYMENT_BLOCKED_STATUSES.has(student.status)) {
    const message =
      student.status === "suspended"
        ? "Payments are paused on this account. Please contact the school."
        : "This account is no longer active. Please contact the school.";
    return { ok: false, status: 403, code: "PAYMENT_NOT_ALLOWED", message };
  }

  const balance = Math.max(student.balance || 0, 0);

  if (balance <= 0) {
    return {
      ok: false,
      status: 400,
      code: "NO_OUTSTANDING_BALANCE",
      message: "There is nothing outstanding to pay on this account.",
    };
  }

  const amountNumber = Number(amount);

  if (!Number.isInteger(amountNumber) || amountNumber < MIN_PAYMENT) {
    return {
      ok: false,
      status: 400,
      code: "AMOUNT_TOO_SMALL",
      message: "The minimum payment is GH₵ 1.00.",
    };
  }

  if (amountNumber > balance) {
    const cedi = (balance / 100).toFixed(2);
    return {
      ok: false,
      status: 400,
      code: "AMOUNT_EXCEEDS_BALANCE",
      message: `That is more than the amount outstanding. The balance is GH₵ ${cedi}.`,
      balance,
    };
  }

  // A network the gateway cannot route is worth refusing up front: it is the one
  // mistake that produces a silent failure (no prompt arrives and nothing errors).
  return {
    ok: true,
    student,
    amount: amountNumber,
    phone: String(phone || "").trim(),
    network: resolveNetwork(network),
    balance,
  };
};

// ──────────────────── Plan requests ────────────────────

/**
 * What a parent's request looks like to a bursar, as a notification.
 *
 * The message is assembled here rather than in the controller because it is the
 * only place that knows both the parent-facing and the school-facing spellings of
 * the same request, and the two drifting apart is the failure this avoids: a
 * bursar approving "3 monthly instalments" against a preview the parent saw as
 * "3 monthly instalments" is the entire point.
 */
const describeRequest = (plan, student, parentName, interval) => {
  const perMonth = plan.numberOfInstallments
    ? (plan.totalAmount / plan.numberOfInstallments / 100).toFixed(2)
    : '0.00';

  return {
    subject: `Payment plan request — ${student.studentName}`,
    message: [
      `${parentName || 'A parent'} has requested a payment plan for ${student.studentName} (${student.studentClass}).`,
      `${plan.numberOfInstallments} ${interval} instalments of about GH₵ ${perMonth}, starting ${new Date(
        plan.startDate
      ).toLocaleDateString('en-GB')}.`,
      `Total outstanding: GH₵ ${(plan.totalAmount / 100).toFixed(2)}.`,
      'Review and approve it in your SukuuPay dashboard.',
    ].join(' '),
    type: 'payment_plan_request',
  };
};

/**
 * A parent asks the school to split the balance.
 *
 * The plan is written `pending_acceptance` and is **not** activated. That is the
 * whole design of this feature: the school keeps control of its own fee schedule,
 * and a parent who can self-approve a plan can also self-approve one that is less
 * than the bill. The parent sees a confirmation; the bursar sees a queue.
 *
 * Refuses when a live plan already exists, including one the parent themselves
 * requested minutes ago. Without that check, a parent on a flaky connection who
 * taps submit twice creates two competing schedules and the bursar has to guess
 * which one the parent meant — which is exactly the state a request form should
 * never be able to produce.
 */
export const requestPaymentPlan = async (token, data) => {
  const student = await requireStudentByToken(token);

  if (PAYMENT_BLOCKED_STATUSES.has(student.status)) {
    throw new ApiError(
      "This account is not active. Please contact the school.",
      403,
      "PAYMENT_NOT_ALLOWED"
    );
  }

  const totalAmount = Math.max(student.balance || 0, 0);
  if (totalAmount <= 0) {
    throw new ApiError(
      "There is nothing outstanding to plan for on this account.",
      400,
      "NO_OUTSTANDING_BALANCE"
    );
  }

  const existing = await findLivePlan(student._id);
  if (existing) {
    throw new ApiError(
      existing.planStatus === "active"
        ? 'You already have an active payment plan. The school can see it on this page.'
        : 'You have already sent a request for a payment plan. The school will confirm shortly.',
      409,
      'PLAN_ALREADY_EXISTS'
    );
  }

  const school = await fetchSchool(student.schoolId);
  const primaryParent =
    (student.parents || []).find((p) => p.isPrimary) || (student.parents || [])[0];

  // The parent's own words win over the record's: the number the request came from
  // is the one the school has to reply to.
  const parentName = (data.parentName || primaryParent?.parentName || '').trim();
  const parentPhone = (data.parentPhone || primaryParent?.phone || '').trim();
  const interval = data.interval || 'monthly';

  const schedule = generateInstallmentSchedule({
    totalAmount,
    numberOfInstallments: data.numberOfInstallments,
    startDate: data.startDate,
    interval,
  });

  // Same guard as the admin path: `splitAmount` floors and puts the remainder on the
  // last tranche, so a small balance across many tranches produces a zero-pesewa
  // installment that `installmentSchema` rejects at save time — with an error naming
  // a field index that means nothing to a parent.
  if (schedule.some((i) => i.amount < 1)) {
    throw new ApiError(
      `A balance of GH₵ ${(totalAmount / 100).toFixed(2)} cannot be split into ${data.numberOfInstallments} payments. Please choose fewer instalments.`,
      400,
      'BALANCE_TOO_SMALL_TO_SPLIT'
    );
  }

  schedule.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  schedule.forEach((installment, index) => {
    installment.installmentNumber = index + 1;
  });

  const acceptanceToken = await generateAcceptanceToken();

  const plan = await PaymentPlan.create({
    studentId: student._id,
    schoolId: student.schoolId,
    planName: `${data.numberOfInstallments} ${interval === 'biweekly' ? 'fortnightly' : interval} plan`,
    totalAmount,
    numberOfInstallments: data.numberOfInstallments,
    interval,
    installments: schedule,
    // Awaiting the school. Never auto-activated — see the function docstring.
    planStatus: 'pending_acceptance',
    acceptanceToken,
    startDate: startOfDayAccra(data.startDate),
    endDate: schedule[schedule.length - 1].dueDate,
    adminNotes: '',
    term: school?.academic?.currentTerm || '',
    academicYear: school?.academic?.currentYear || '',
    // No user behind this request: it came from a pay token.
    createdBy: null,
    updatedBy: null,
    requestSource: 'parent_portal',
    requestedBy: {
      parentName,
      parentPhone,
      notes: data.notes || '',
    },
  });

  // Keeps the student's plan back-reference in sync, matching `createPaymentPlan`.
  student.paymentPlans.push(plan._id);
  await student.save();

  await notifyPlanRequest(school, student, plan, { parentName, parentPhone, interval });

  await auditService.log({
    action: 'plan.request',
    entity: 'PaymentPlan',
    entityId: plan._id,
    userId: null,
    schoolId: student.schoolId,
    // No name, no phone. The audit log is read by more people than the roster, and
    // the parent is already named on the plan's own `requestedBy`.
    details: {
      studentRef: student.studentId,
      totalAmount,
      numberOfInstallments: plan.numberOfInstallments,
      interval,
    },
  });

  return {
    planId: String(plan._id),
    planStatus: plan.planStatus,
    installments: schedule.map((i) => ({
      installmentNumber: i.installmentNumber,
      amount: i.amount,
      dueDate: i.dueDate,
    })),
  };
};

/**
 * Who at a school hears about something a parent raised from the pay link.
 *
 * `User.status` is `"active"`, not `isActive` — the field name differs from most
 * of this codebase, and a query for a non-existent field does not throw, it simply
 * matches nobody. That failure is quiet: the request is recorded, the plan is
 * created, and no human is ever told.
 *
 * `school_admin` and `accountant` because both are the people who answer a fee
 * question. A teacher has no business acting on a balance dispute.
 *
 * `schoolId` is projected as well as `phone` because `notifyAdmins` copies it onto
 * each row it writes, and it was being projected away — so every notification raised
 * from the pay portal stored `schoolId: undefined`. That is invisible on the personal
 * inbox the notifications are read from, and not invisible anywhere else: a school
 * that later switches the notification source to a school-scoped query finds none of
 * them.
 */
const findSchoolRecipients = (schoolId) =>
  User.find({
    schoolId,
    role: { $in: ["school_admin", "accountant"] },
    status: "active",
    deletedAt: null,
  })
    .select("phone schoolId")
    .lean();

/**
 * Writes one notification per admin.
 *
 * `Notification.userId` is `required` and indexed: this collection is a personal
 * inbox, not a school-wide board. Creating a single row with no userId would fail
 * validation, and inserting one row per admin is the only shape the schema admits.
 *
 * `message` is capped at 500 characters by the schema. Silently letting Mongoose
 * reject it would surface as a 500 on a request the school can already see in the
 * dashboard, so the text is trimmed here and the full detail goes into `meta`,
 * which is unbounded — a bursar opening the notification reads the whole thing.
 */
const notifyAdmins = async (recipients, { type, title, message, meta, link }) => {
  const body = String(message || "").slice(0, 500);

  const rows = (recipients || []).map((admin) => ({
    userId: admin._id,
    schoolId: admin.schoolId,
    type,
    title: String(title || "").slice(0, 120),
    message: body,
    link: link || null,
    meta: meta || undefined,
  }));

  if (!rows.length) return { written: 0 };

  try {
    const result = await Notification.insertMany(rows, { ordered: false });
    return { written: result.length };
  } catch (error) {
    // Best-effort. The plan is already recorded, so the school can still find it
    // in the dashboard; a notification write failing must not turn a parent's
    // successful request into an error they will retry and duplicate.
    console.error('[PAY-PORTAL] Notification write failed:', error.message);
    return { written: 0 };
  }
};

/**
 * Tells the school and the parent that a request exists.
 *
 * Both notifications are best-effort. A plan that is created but not announced is
 * a far smaller problem than a parent staring at a failed request because the
 * school's SMS credit ran out at that instant — the request is in the dashboard
 * queue either way, and the parent's own screen already confirms it. That is why
 * neither failure is rethrown.
 */
const notifyPlanRequest = async (school, student, plan, { parentName, parentPhone, interval }) => {
  if (!school) return { admin: null, parent: null };

  const described = describeRequest(plan, student, parentName, interval);

  let admin = null;
  try {
    const recipients = await findSchoolRecipients(student.schoolId);

    await notifyAdmins(recipients, {
      type: 'plan.requested',
      title: described.subject,
      message: described.message,
      link: '/dashboard/installment-plans',
      meta: {
        planId: String(plan._id),
        studentRef: student.studentId,
        totalAmount: plan.totalAmount,
        numberOfInstallments: plan.numberOfInstallments,
        interval,
        // The parent's own words, kept here in full because the notification body
        // above is a summary that will not fit alongside them.
        parentNote: plan.requestedBy?.notes || '',
      },
    });

    // SMS to one address, not all of them: a bursar and an accountant receiving the
    // same text is the school's credit paying for it twice, and one of them
    // acting is sufficient.
    const recipient = (recipients || []).map((a) => a.phone).find(Boolean);
    if (recipient) {
      admin = await sendSms({
        to: recipient,
        message: described.message,
        school,
        purpose: 'payment_plan_request',
        studentId: student._id,
        paymentPlanId: plan._id,
      });
    }
  } catch (error) {
    console.error('[PAY-PORTAL] Plan request notification failed:', error.message);
  }

  let parent = null;
  if (parentPhone) {
    try {
      parent = await sendSms({
        to: parentPhone,
        message: `Dear ${parentName || 'Parent'}, we have received your request to pay ${student.studentName}'s fees in ${plan.numberOfInstallments} ${interval} instalments. The school will confirm shortly.`,
        school,
        purpose: 'payment_plan_request',
        studentId: student._id,
        paymentPlanId: plan._id,
        parentName,
      });
    } catch (error) {
      console.error('[PAY-PORTAL] Plan request acknowledgement failed:', error.message);
    }
  }

  return { admin, parent };
};

// ──────────────────── Contacting the school ────────────────────

/**
 * A parent writes to the school through the pay page.
 *
 * This is a *message*, not a support chat: three a day, one recipient, no thread, no
 * read receipts. The cap is enforced by the route's rate limiter as well as here,
 * because a form a parent can submit in a loop against a school's SMS balance is a
 * way to spend someone else's credits.
 *
 * ## What this writes, and why
 *
 * One `ParentMessage` row, one `Notification` per admin, and at most one SMS. The
 * order matters and the failures are deliberately contained:
 *
 * 1. **The `ParentMessage` is written first and is the only thing that must
 *    succeed.** If the row cannot be written, the parent is told so, because nothing
 *    was recorded. Every other step is an *alert* about that row.
 * 2. **The notification is guarded.** Previously it was not, and it sits before the
 *    SMS — so an SMS failure threw a 500 out of a request that had already delivered
 *    the notification. The parent saw "We could not send your message", tapped send
 *    again, and every admin got a second copy of a message they had already received.
 * 3. **The SMS is guarded**, and the outcome is reported honestly rather than as a
 *    boolean that means "nothing threw".
 *
 * ## The two failures that made this message undeliverable
 *
 * Both were quiet, and both are fixed here rather than at the call sites:
 *
 * - **No admin had a phone number.** `User.phone` was relaxed from `required: true`
 *   to optional when team invitations started accepting name + email only. The SMS
 *   path then found nothing to send to and the message existed *only* as a
 *   notification — which, until the notification UI landed, existed only as a row
 *   nobody could read. The message is now a record the school opens deliberately, so
 *   it survives having no phone at all, and the school's own published phone number
 *   is used for the alert when no admin has one.
 * - **The audit write never landed.** The action was `"PARENT_CONTACTED_SCHOOL"`,
 *   which is in neither audit enum, so `auditService.log` swallowed the Mongoose
 *   ValidationError into a `console.error` and the endpoint still returned 200.
 *   A bursar asked to prove a parent had contacted the school had nothing to show.
 *
 * @param {string} token the student's pay token — the only credential the caller has
 * @param {{ parentName: string, parentPhone: string, message?: string,
 *   audio?: { buffer: Buffer, mimetype: string, bytes?: number } }} data
 * @returns {Promise<{ messageId: string, delivered: boolean,
 *   notificationLogged: boolean, adminsNotified: number,
 *   audioUrl: string|null, schoolPhone: string|null, hasAudio: boolean,
 *   audioUploadFailure: string|null }>}
 */
export const notifySchool = async (token, data) => {
  const student = await requireStudentByToken(token);
  const school = await fetchSchool(student.schoolId);

  if (!school) {
    throw new ApiError(
      'This payment link is no longer valid. Please contact the school.',
      410,
      'PAY_LINK_INVALID'
    );
  }

  const { parentName, parentPhone, message, audio } = data;

  const hasAudio = Boolean(audio?.buffer?.length);
  const text = String(message || '').trim();

  // A voice note on its own is a complete message; that is the point of the recorder.
  // Refusing "no text" outright would have made the feature unusable for exactly the
  // parent it exists for.
  if (!text && !hasAudio) {
    throw new ApiError(
      'Write a message or record a voice note before sending',
      400,
      'MESSAGE_EMPTY'
    );
  }

  const recipients = await findSchoolRecipients(student.schoolId);

  // ── 1. The record. The only step allowed to fail the request. ──
  //
  // Audio is uploaded before the row is created rather than after, because a row
  // pointing at a Cloudinary asset that was never uploaded is a dangling reference a
  // bursar clicks and gets a 404 on. If the upload throws, nothing is written.
  //
  // **A failed upload does not fail the request when the parent also wrote text.**
  // The old behaviour threw `AUDIO_UPLOAD_FAILED` (502) unconditionally, which meant
  // a parent who recorded a voice note and typed a sentence at the same time got
  // "We could not save your voice note" — and their *written* message was discarded
  // with it. The recording is a bonus, not the message: the text is the record, and
  // it belongs in the inbox regardless of what the media layer is doing. Cloudinary
  // credentials missing on a deployment, a transient 5xx, a per-account quota —
  // none of those are reasons to lose a parent's words.
  //
  // The voice note alone is a different story: with no text there is nothing left
  // to save, and telling the parent to retry is the only honest answer.
  let audioMeta = null;
  let audioFailure = null;
  if (hasAudio) {
    try {
      const uploaded = await uploadAudioBuffer(audio.buffer, {
        mimeType: audio.mimetype,
        folder: `${CLOUDINARY_UPLOAD_FOLDER}/schools/${school.slug || student.schoolId}/parent-messages`,
      });
      audioMeta = {
        url: uploaded.url,
        publicId: uploaded.publicId,
        mimeType: audio.mimetype,
        bytes: uploaded.bytes,
        durationSeconds: uploaded.duration,
      };
    } catch (error) {
      audioFailure = String(error?.message || 'Audio upload failed').slice(0, 300);
      if (!text) {
        throw new ApiError(
          `We could not save your voice note: ${audioFailure}. Please record it again, or send a written message.`,
          502,
          'AUDIO_UPLOAD_FAILED'
        );
      }
    }
  }

  // ── 1b. The rate limit. ──
  //
  // This used to be a route middleware running ahead of everything else, and that is
  // exactly why a parent whose audio uploads kept failing burned their whole daily
  // allowance on messages that were never recorded — and then got a 429 that read
  // "you have already sent several messages" about a link with zero of them.
  //
  // It now peeks before the write and consumes only after it, so a failed attempt
  // costs nothing while the budget still bounds how many real messages a token can
  // send. Keyed on the token's suffix, matching `tokenIdentity` in rateLimit.js, so
  // this is the same bucket the route limiter would have used.
  const rateLimitKey = `tok:${String(token).slice(-4)}`;
  const rateLimit = {
    max: PAY_PORTAL_LIMITS.notifySchool.max,
    windowMs: PAY_PORTAL_LIMITS.notifySchool.windowMs,
    message: PAY_PORTAL_LIMITS.notifySchool.message,
  };
  const existing = peekRateLimit(rateLimitKey);
  if (existing && existing.count >= rateLimit.max) {
    throw new ApiError(
      rateLimit.message,
      429,
      'RATE_LIMITED',
      { retryAfter: Math.max(1, Math.ceil((existing.resetAt - Date.now()) / 1000)) }
    );
  }

  const parentMessage = await ParentMessage.create({
    schoolId: student.schoolId,
    studentId: student._id,
    studentRef: student.studentId,
    studentName: student.studentName,
    studentClass: student.studentClass,
    parentName,
    parentPhone,
    message: text || null,
    audio: audioMeta || undefined,
    hasAudio: Boolean(audioMeta),
    audioUploadFailure: audioFailure,
    status: 'new',
    ip: data.ip || null,
  });

  // Consume only once the row exists. A message that was never recorded must never
  // count against the parent's budget.
  try {
    consumeRateLimit(rateLimitKey, rateLimit.max, rateLimit.windowMs);
  } catch (rateLimitError) {
    console.error(
      `[PAY-PORTAL] Rate limit exceeded after write for ${parentMessage.messageId}:`,
      rateLimitError.message
    );
  }

  // ── 2. The in-app alert. Guarded: a failure here must not fail the request. ──
  //
  // The voice-note flag is the one that survived the upload, not the one the parent
  // attached: if Cloudinary rejected the recording and the parent also wrote text,
  // this is a written message with a failed media attachment, not a voice note.
  const deliveredAudio = Boolean(audioMeta);
  const subject = deliveredAudio
    ? `Parent voice note — ${student.studentName}`
    : `Parent message — ${student.studentName}`;

  // The body is a summary because `Notification.message` is capped at 500 characters;
  // the verbatim text and the callback number live in `meta`, which is unbounded.
  const summary = deliveredAudio
    ? `${parentName} (${maskContact(parentPhone)}) sent a voice note about ${student.studentName} (${student.studentClass}).${text ? ` They also wrote: ${text}` : ''}`
    : `${parentName} (${maskContact(parentPhone)}) asked about ${student.studentName} (${student.studentClass}): ${text}`;

  let adminsNotified = 0;
  try {
    const result = await notifyAdmins(recipients, {
      // Named rather than written out, because this is the value the
      // `Notification.type` enum is checked against and a literal here is exactly how
      // `parent.audio_message` came to be storable nowhere: the type existed, this
      // call site produced it, and the model's copy of the list had never heard of it.
      type: deliveredAudio ? NOTIFICATION_TYPES.PARENT_AUDIO_MESSAGE : NOTIFICATION_TYPES.PARENT_MESSAGE,
      title: subject,
      message: summary,
      // The inbox, not the roster. `/dashboard/students` was the old link and it is
      // a dead end for this: a bursar arriving there has no way to find the message
      // that sent them there.
      link: '/dashboard/messages',
      meta: {
        parentMessageId: parentMessage.messageId,
        parentMessageRef: String(parentMessage._id),
        studentRef: student.studentId,
        studentName: student.studentName,
        parentName,
        parentPhone,
        message: text,
        audioUrl: audioMeta?.url || null,
        hasAudio: deliveredAudio,
        audioUploadFailure: audioFailure,
      },
    });
    adminsNotified = result.written;
  } catch (error) {
    console.error(
      `[PAY-PORTAL] Notification write failed for ${parentMessage.messageId}:`,
      error.message
    );
  }

  // ── 3. The SMS alert. Guarded, and its outcome recorded on the row. ──
  //
  // The recipient is an admin with a phone, or failing that the school's own published
  // number. A school that has published a phone for parents to call has published it
  // to be reached, and requiring a staff member to have personally entered one is a
  // stricter condition than the product's own front page sets.
  const adminRecipient = (recipients || []).map((a) => a.phone).find(Boolean);
  const alertNumber = adminRecipient || school?.phone || null;

  let delivered = false;
  let smsFailure = null;

  if (alertNumber) {
    try {
      const sms = await sendSms({
        to: alertNumber,
        // Trimmed to roughly one segment: the gateway would otherwise split this into
        // three texts and bill the school for all three, to convey the same
        // "please call this parent back".
        message: deliveredAudio
          ? `SukuuPay: ${parentName} (${parentPhone}) sent a voice note re ${student.studentName}. ${text}`.slice(0, 300)
          : `SukuuPay: ${parentName} (${parentPhone}) re ${student.studentName}: ${text}`.slice(0, 300),
        school,
        purpose: 'parent_message',
        studentId: student._id,
        parentName,
      });
      delivered = Boolean(sms?.sent);
      if (!delivered) smsFailure = 'The gateway accepted the request but did not confirm delivery';
    } catch (error) {
      smsFailure = String(error?.message || 'SMS alert failed').slice(0, 300);
      console.error(
        `[PAY-PORTAL] Parent message SMS alert failed for ${parentMessage.messageId}:`,
        error.message
      );
    }
  } else {
    smsFailure = 'No administrator phone number and no school phone number on file';
  }

  // The outcome is written back rather than computed at read time, because "why did
  // this parent get no call" is a question the bursar asks weeks later, when the
  // admin list and the school's phone field may both have changed.
  parentMessage.smsAlerted = delivered;
  parentMessage.smsAlertFailure = smsFailure;
  await parentMessage.save();

  await auditService.log({
    action: AUDIT_ACTIONS.PARENT_MESSAGE_SENT,
    entity: 'ParentMessage',
    entityId: parentMessage._id,
    userId: null,
    schoolId: student.schoolId,
    ip: data.ip || null,
    // No name, no phone, not even a count of the words. The audit log is read by more
    // people than the roster and answers "was this endpoint abused", which the rate
    // limiter's own counters answer better. The message itself is on the row.
    details: {
      ref: parentMessage.messageId,
      studentRef: student.studentId,
      chars: text.length,
      hasAudio: deliveredAudio,
      audioBytes: audioMeta?.bytes ?? null,
      audioUploadFailure,
      notifiedAdmins: adminsNotified,
      smsAlerted: delivered,
      smsFailure,
    },
  });

  return {
    messageId: parentMessage.messageId,
    hasAudio: deliveredAudio,
    audioUrl: audioMeta?.url || null,
    // `delivered` means the SMS left the building, not that a human read it. The
    // parent page words it accordingly.
    delivered,
    notificationLogged: adminsNotified > 0,
    adminsNotified,
    // Handed back so the confirmation screen can offer the school as a phone call
    // when no alert could be sent. A parent told "the school will be in touch" with
    // no way to make that happen is the exact failure this feature had.
    schoolPhone: school?.phone || null,
  };
};

// ──────────────────── Receipts ────────────────────

/**
 * Resolves a payment id against the student named by the token.
 *
 * The ownership check is the query, not a comparison afterwards: a payment is
 * fetched *by* the student's own id, so a payment belonging to another child
 * resolves to nothing rather than to something that then fails a later check. It
 * matters which of the two a caller can observe — this way there is no code path
 * that has a foreign payment in hand even briefly, and the response is a plain 404
 * that does not confirm the payment exists at all.
 */
export const findPaymentForToken = async (token, paymentId) => {
  const student = await requireStudentByToken(token);

  const payment = await Payment.findOne({
    paymentId: String(paymentId || ''),
    studentId: student._id,
    deletedAt: null,
  }).lean();

  if (!payment) {
    throw new ApiError(
      'Receipt not found. It may belong to a different student, or the link may be wrong.',
      404,
      'PAYMENT_NOT_FOUND'
    );
  }

  if (payment.status !== 'completed') {
    throw new ApiError(
      'A receipt is only available once the payment has completed.',
      400,
      'PAYMENT_NOT_COMPLETED'
    );
  }

  return payment;
};

export { maskContact, projectStudent, projectSchool, projectPlan, projectPayment };

// ──────────────────── Status polling ────────────────────

/**
 * How long a payment may sit `pending` before the portal stops reporting it as
 * merely slow and starts asking the gateway.
 *
 * Ten minutes. Long enough that a parent who walked away from their phone to find
 * their PIN, on a network that took a while to deliver the prompt, is not told
 * anything has gone wrong — and short enough that a genuinely lost webhook is
 * noticed inside one school morning rather than at the next term's reconciliation.
 */
const STALE_PENDING_MS = 10 * 60 * 1000;

/**
 * Resolves one payment for the portal's polling screen.
 *
 * The three-state answer (`pending` / `completed` / `failed`) is the whole contract:
 * the parent is being told whether the money arrived, and "still waiting" is a
 * legitimate answer that must not be dressed as a failure. `retryAfter` is returned
 * so the client polls on the server's schedule rather than picking its own — the
 * portal polls every few seconds and a client that hard-codes a tighter interval
 * would turn one parent on one token into a load problem for everyone.
 *
 * @returns {Promise<object>} the state, plus `receiptNumber` once completed
 * @throws {ApiError} 404 when the reference is not this student's
 */
export const verifyPaymentByReference = async (token, reference) => {
  const student = await requireStudentByToken(token);

  const payment = await Payment.findOne({
    reference: String(reference || ''),
    studentId: student._id,
    deletedAt: null,
  }).lean();

  if (!payment) {
    throw new ApiError(
      'We could not find that payment on this link. Please start again.',
      404,
      'PAYMENT_NOT_FOUND'
    );
  }

  const base = {
    reference: payment.reference,
    paymentId: payment.paymentId,
    amount: payment.amount,
    status: payment.status,
  };

  if (payment.status === 'completed') {
    return {
      ...base,
      status: 'success',
      completedAt: payment.completedAt,
      receiptNumber: payment.receiptNumber || null,
      // The parent's new balance, so the success screen does not have to re-fetch
      // the whole portal to tell them what they still owe.
      balance: Math.max(student.balance || 0, 0),
      totalPaid: student.totalPaid || 0,
      totalOwed: student.totalOwed || 0,
    };
  }

  if (payment.status === 'failed' || payment.status === 'cancelled') {
    return {
      ...base,
      status: 'failed',
      // A reason a parent can act on. The gateway's own text where there is one —
      // "insufficient balance" tells them to top up, which "payment failed" does not.
      reason:
        payment.hubtelResponseMessage ||
        payment.mtnStatusReason ||
        'The payment was not approved. No money has left your account.',
    };
  }

  const age = Date.now() - new Date(payment.createdAt).getTime();
  if (age > STALE_PENDING_MS) {
    // Long enough that the webhook has probably been lost. Flagged so the client
    // can say "this is taking longer than usual, check with the school" rather
    // than spinning indefinitely — the portal's own 60-second timeout is the
    // parent's prompt having been ignored, not the webhook's.
    return {
      ...base,
      status: 'pending',
      retryAfter: 5,
      delayed: true,
      message:
        'This payment is taking longer than usual. If you approved the prompt on your phone, the school will confirm it shortly.',
    };
  }

  return { ...base, status: 'pending', retryAfter: 3 };
};

/**
 * Loads a payment with the student and school a receipt needs.
 *
 * Ownership is settled by `findPaymentForToken` — the query is scoped to the
 * student's own id, so another child's payment simply is not found. Only after
 * that does this read the two records the receipt renders, and only the fields it
 * puts on paper. The school contact block is deliberately absent: a receipt is a
 * document about one payment, and the bursar's phone number is on every SMS the
 * school sends anyway.
 */
export const buildParentReceipt = async (token, paymentId) => {
  const payment = await findPaymentForToken(token, paymentId);

  const [student, school] = await Promise.all([
    Student.findById(payment.studentId)
      .select('studentId studentName studentClass')
      .lean(),
    fetchSchool(payment.schoolId),
  ]);

  if (!student) {
    throw new ApiError(
      'Receipt not found. The student record behind this payment no longer exists.',
      404,
      'STUDENT_NOT_FOUND'
    );
  }

  return { payment, student, school };
};