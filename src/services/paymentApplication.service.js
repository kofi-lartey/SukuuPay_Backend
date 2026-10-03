import { Payment } from "../models/paymentModel.js";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import { PaymentPlan } from "../models/paymentPlanModel.js";
import { PlatformLedger } from "../models/PlatformLedger.js";
// The pure arithmetic, shared with the admin prepayment path so there is one
// implementation of "which tranche does this money land on". Aliased because this
// module exports a `applyPaymentToPlan` that wraps it, and a module cannot declare
// a binding twice.
import { applyPaymentToPlan as applyToSchedule } from "../utils/planHelpers.js";
import auditService from "../utils/auditService.js";

/**
 * Applying a settled payment to the ledger: the student's balance, the plan's
 * installments, and the platform's own revenue.
 *
 * ## Why this exists
 *
 * Both webhook paths — Hubtel and MTN — did this themselves, and both did it with
 * the same three lines:
 *
 *     await Student.findByIdAndUpdate(payment.studentId, {
 *       $inc: { totalPaid: payment.amount, balance: -payment.amount },
 *     });
 *
 * Two copies of the money movement on the two paths that move money, which is one
 * more copy than this should ever have. Neither booked a `PlatformLedger` entry,
 * even though `PlatformLedger` exists precisely to record what the platform keeps —
 * so the platform's revenue figures had no source that a settlement actually wrote
 * to. And the `$inc` is unguarded in a way that matters on the portal path; see
 * `applyPaymentToStudent`.
 *
 * This module is the one place that decides what "settled" means.
 */

/** Plan statuses a settled payment may still be applied to. */
const LIVE_PLAN_STATUSES = ["pending_acceptance", "active"];

/**
 * Credits a settled payment against a student's balance.
 *
 * @param {import('mongoose').Types.ObjectId} studentId
 * @param {number} amountCredited pesewas. **Signed** — a refund row carries a
 *   negative amount and must move `totalPaid` back down.
 * @returns {Promise<{ before: {totalPaid:number, balance:number},
 *   after: {totalPaid:number, balance:number}, clampedAtZero: boolean }>}
 */
export const applyPaymentToStudent = async (studentId, amountCredited) => {
  const delta = Math.round(Number(amountCredited) || 0);
  if (delta === 0) return null;

  // `$inc` first, then correct the balance if it went negative.
  //
  // The original was a bare `$inc: { balance: -amount }`, which is correct exactly
  // as long as no more money ever arrives than is owed. The parent portal breaks
  // that assumption: it accepts an arbitrary amount up to the balance *as it stood
  // when the page loaded*, and between that render and the parent's tap, a sibling
  // pays down part of the same account. The second payment then lands against a
  // balance that has since moved, and the raw `$inc` writes a negative balance.
  //
  // A negative balance is not a cosmetic bug. `student.balance` is what the parent
  // portal renders as the amount owed, so it would show "-GH₵ 40.00"; it is what
  // `initiatePayment` validates an amount against, so it would refuse every payment
  // on the account until someone hand-edited the student; and it is what the
  // school's arrears report sums, so it would *reduce* reported arrears by money
  // that does not exist. Clamping to zero is the honest reading — the fees are
  // settled — and the surplus belongs in `totalPaid`, which is not clamped, so the
  // overpayment is still visible to a bursar rather than silently discarded.
  const updated = await Student.findByIdAndUpdate(
    studentId,
    { $inc: { totalPaid: delta } },
    { new: true }
  );

  if (!updated) return null;

  const nextBalance = (updated.balance || 0) - delta;
  const clampedAtZero = nextBalance < 0;

  if (clampedAtZero) {
    await Student.updateOne({ _id: studentId }, { $set: { balance: 0 } });
    updated.balance = 0;
  }

  return {
    before: { balance: updated.balance + delta, totalPaid: updated.totalPaid - delta },
    after: { balance: updated.balance, totalPaid: updated.totalPaid },
    clampedAtZero,
  };
};

/**
 * Applies a settled payment to a plan's installments.
 *
 * The arithmetic — oldest unsettled installment first, overflow rolling forward —
 * is `applyPaymentToPlan` from `utils/planHelpers.js`, shared with the admin
 * prepayment path so there is one implementation of "which tranche does this money
 * land on". This wrapper adds the three things that helper deliberately does not
 * do: load the plan, refuse a plan that is not live, and report whether the whole
 * plan is now settled.
 *
 * @returns {Promise<{applied: Array, unapplied: number, planCompleted: boolean,
 *   duplicate?: boolean, plan?: object} | null>}
 *   `null` when there is no live plan to apply against — the common case, since
 *   most students pay a lump sum.
 */
export const applyPaymentToPlan = async (planId, amountCredited, paymentId = null) => {
  if (!planId) return null;

  const plan = await PaymentPlan.findOne({
    _id: planId,
    planStatus: { $in: LIVE_PLAN_STATUSES },
    deletedAt: null,
  });

  if (!plan) return null;

  // A payment already recorded against an installment is ignored. This is the
  // second line of defence behind `Payment.settlement` — that claim is taken in the
  // webhook, this one holds if the applier is ever called directly.
  const alreadyApplied = (plan.installments || []).some((i) =>
    (i.paymentIds || []).some((id) => String(id) === String(paymentId))
  );
  if (alreadyApplied) return { applied: [], unapplied: 0, planCompleted: false, duplicate: true, plan };

  const { applied, unapplied } = applyToSchedule(plan, amountCredited, paymentId);

  if (!applied.length) return { applied, unapplied, planCompleted: false, plan };

  plan.lastOverdueCheckAt = new Date();

  // The pre-save hook recomputes progressPercent, installmentsPaid,
  // installmentsMissed and totalPaid from the schedule, and flips `completed` when
  // nothing is left owing.
  await plan.save();

  return {
    applied,
    unapplied,
    planCompleted: plan.planStatus === "completed",
    plan,
  };
};

/**
 * The platform's slice of a settled payment.
 *
 * **This is the function the ledger was missing.** `PlatformLedger` documents
 * itself as "every cedi SukuuPay takes", and nothing in the settlement path wrote
 * to it — so the revenue that `GET /admin/analytics/revenue` reads had no writer in
 * the code at all. Every figure on that page was, at best, derived from somewhere
 * else by a different rule.
 *
 * The amount is read from the payment's own stored `feesBreakdown`, not recomputed
 * from the school's current markup rate. The rate can change (see
 * `currentMarkup.differsFromCharged` in the admin payments service, which exists
 * because it has changed), and recomputing would book today's rate against money
 * collected last term.
 *
 * @returns {Promise<object|null>} the created entry, or null when the payment
 *   carries no markup — an ordinary full-price payment, which is most of them.
 */
export const bookPlatformLedgerEntries = async (payment) => {
  if (!payment) return null;

  const breakdown = Array.isArray(payment.feesBreakdown) ? payment.feesBreakdown : [];

  // `admin/payments.service.js` already reads this the same way for its own
  // `markupAmount`, so the two figures agree by construction.
  const markupAmount = breakdown.reduce(
    (sum, part) => sum + (Number(part?.markupAmount ?? part?.amount) || 0),
    0
  );

  if (!markupAmount) return null;

  try {
    return await PlatformLedger.create({
      type: "markup",
      amount: Math.round(markupAmount),
      currency: "GHS",
      schoolId: payment.schoolId,
      paymentId: payment._id,
      studentId: payment.studentId,
      description: `Markup on ${payment.paymentId}`,
      reference: payment.hubtelTransactionId || payment.mtnFinancialTransactionId || payment.paymentId,
      // Accrued, not settled: the money is in Hubtel's float, not in a platform
      // account. `settled: true` here would make it look withdrawable.
      settled: false,
      settledAt: null,
      // No user behind a webhook settlement, and inventing one would put a
      // fabricated actor in the one table that must never fabricate anything.
      createdBy: null,
      metadata: {
        markupPercent: breakdown[0]?.markupPercent ?? null,
        studentRef: payment.paymentId,
      },
    });
  } catch (error) {
    // The parent's balance has already moved and cannot be moved back because a
    // ledger write failed. Failing the settlement here would make the provider
    // retry, and the retry would find the settlement claim taken and do nothing —
    // a silently under-reported revenue line. Loud, but not fatal.
    console.error(
      `[PAY-APPLY] Failed to book platform ledger entry for ${payment.paymentId}:`,
      error.message
    );
    return null;
  }
};

/**
 * Bumps a school's monthly collection stat.
 *
 * Separate from `applyPaymentToStudent` because it is a different aggregate on a
 * different collection, and because it is not corrected by a clamp — an overpayment
 * really was collected.
 */
export const recordSchoolCollection = async (payment) => {
  try {
    await School.findByIdAndUpdate(payment.schoolId, {
      $inc: { "stats.totalPaymentsThisMonth": Math.round(Number(payment.amount) || 0) },
    });
  } catch (error) {
    console.error(
      `[PAY-APPLY] Failed to update school stats for ${payment.paymentId}:`,
      error.message
    );
  }
};

/**
 * The balance, the school stat and the platform ledger, in that order.
 *
 * Plan tranches are deliberately **not** handled here. Applying a payment to a plan
 * is not just arithmetic — when the last tranche settles, the school has to be told
 * and the parent has to be told, and that already lives in `applyCompletedPaymentToPlan`
 * in `paymentPlan.service.js` where the notifications are. Duplicating the
 * arithmetic here to save one call would have meant two implementations of "which
 * tranche does this money land on" with no obvious reason to prefer either, and the
 * copy that lacks the notification would silently stop parents being told. The
 * caller runs this and then `applyCompletedPaymentToPlan`, as it did before.
 *
 * Each step here is independently recoverable and none is allowed to abort the
 * ones after it — with one exception, the balance.
 *
 * The balance is the exception because it is the only step whose absence is
 * *visible to the parent who just paid*: a settled payment that never reached the
 * student record leaves a family who have handed over money still shown as owing
 * it. The caller holds the settlement claim, so throwing here releases the claim
 * and lets the provider's retry redo the whole thing — which is correct, and which
 * is why the later steps are written to be safe to run twice.
 *
 * @param {import('mongoose').Document} payment a saved, `completed` Payment
 */
export const settlePayment = async (payment) => {
  const amount = Math.round(Number(payment.amount) || 0);

  // Not throwable by design — see above.
  await applyPaymentToStudent(payment.studentId, amount);

  await recordSchoolCollection(payment);

  await bookPlatformLedgerEntries(payment);

  await auditService.log({
    action: "APPLY_PAYMENT_SETTLEMENT",
    entity: "Payment",
    entityId: payment._id,
    userId: null,
    schoolId: payment.schoolId,
    details: { amount, paymentRef: payment.paymentId },
  });

  return { student: payment.studentId };
};