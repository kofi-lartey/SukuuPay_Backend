import crypto from "crypto";
import { PaymentPlan } from "../models/paymentPlanModel.js";
import {
  addInterval,
  endOfDayAccra,
  startOfDayAccra,
  isPast,
} from "./dateHelpers.js";

// ──────────────────── Acceptance token ────────────────────
// Ambiguous glyphs (0/O, 1/I) are excluded: the token is read off an SMS by a
// parent typing it on a phone keypad.
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_LENGTH = 6;

const randomTokenChar = () =>
  TOKEN_ALPHABET[crypto.randomInt(0, TOKEN_ALPHABET.length)];

// Business rule #8: short, uppercase, unique across all live plans.
export const generateAcceptanceToken = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const token = Array.from({ length: TOKEN_LENGTH }, randomTokenChar).join("");
    const clash = await PaymentPlan.exists({ acceptanceToken: token });
    if (!clash) return token;
  }
  throw new Error("Unable to generate a unique acceptance token");
};

// ──────────────────── Installment schedule ────────────────────

// Business rule #3: base = floor(total / N); the last installment absorbs the
// remainder so the installments always sum back to totalAmount exactly.
export const splitAmount = (totalAmount, numberOfInstallments) => {
  const count = Number(numberOfInstallments);
  const base = Math.floor(totalAmount / count);
  const amounts = Array.from({ length: count }, () => base);
  amounts[count - 1] = totalAmount - base * (count - 1);
  return amounts;
};

/**
 * Builds the installment list for a new plan.
 * When `customInstallments` is supplied its explicit amounts/due dates win
 * (the caller is responsible for validating the sum — see the service layer).
 */
export const generateInstallmentSchedule = ({
  totalAmount,
  numberOfInstallments,
  startDate,
  interval,
  customInstallments,
}) => {
  const count = Number(numberOfInstallments);
  const anchor = startOfDayAccra(startDate);

  if (Array.isArray(customInstallments) && customInstallments.length) {
    return customInstallments.map((entry, index) => ({
      installmentNumber: index + 1,
      amount: entry.amount,
      dueDate: entry.dueDate ? endOfDayAccra(entry.dueDate) : endOfDayAccra(addInterval(anchor, interval, index)),
      status: "pending",
      amountPaid: 0,
      paidAt: null,
      paymentIds: [],
      reminderSentAt: null,
      overdueNotifiedAt: null,
      notes: entry.notes || "",
    }));
  }

  const amounts = splitAmount(totalAmount, count);

  return amounts.map((amount, index) => ({
    installmentNumber: index + 1,
    amount,
    dueDate: endOfDayAccra(addInterval(anchor, interval, index)),
    status: "pending",
    amountPaid: 0,
    paidAt: null,
    paymentIds: [],
    reminderSentAt: null,
    overdueNotifiedAt: null,
    notes: "",
  }));
};

// The anchor day of a plan: the first installment's due date when it exists,
// otherwise the stored startDate.
const scheduleAnchor = (plan) => {
  if (plan.installments?.length) return startOfDayAccra(plan.installments[0].dueDate);
  return startOfDayAccra(plan.startDate);
};

const isSettled = (installment) =>
  installment.status === "paid" || installment.status === "waived";

/**
 * Re-derives due dates for every unsettled installment after a startDate /
 * interval change. Settled installments keep their original dates, and the
 * unsettled ones are re-anchored on `startDate` in order.
 */
export const regenerateDueDates = (plan, { startDate, interval } = {}) => {
  const step = interval || plan.interval;
  const anchor = startOfDayAccra(startDate || plan.startDate);

  const unsettled = plan.installments.filter((i) => !isSettled(i));

  unsettled.forEach((installment, index) => {
    installment.dueDate = endOfDayAccra(addInterval(anchor, step, index));
    // A moved due date re-arms the reminder / overdue notification flags.
    installment.reminderSentAt = null;
    installment.overdueNotifiedAt = null;
  });

  if (startDate) {
    plan.startDate = startOfDayAccra(startDate);
  } else if (plan.installments.length) {
    plan.startDate = startOfDayAccra(plan.installments[0].dueDate);
  }

  if (plan.installments.length) {
    plan.endDate = endOfDayAccra(plan.installments[plan.installments.length - 1].dueDate);
  }

  return plan;
};

/**
 * Business rule #6: a payment is applied to the earliest unsettled
 * installment first and any overflow rolls onto the next one.
 * Mutates the plan; the caller saves it so the pre-save hook recomputes
 * progress and status.
 */
export const applyPaymentToPlan = (plan, amount, paymentId = null) => {
  let remaining = Math.max(0, Math.round(Number(amount) || 0));
  const applied = [];

  for (const installment of plan.installments) {
    if (remaining <= 0) break;
    if (isSettled(installment)) continue;

    const outstanding = installment.amount - installment.amountPaid;
    if (outstanding <= 0) continue;

    const appliedAmount = Math.min(outstanding, remaining);
    installment.amountPaid = (installment.amountPaid || 0) + appliedAmount;
    remaining -= appliedAmount;

    if (paymentId) installment.paymentIds.push(paymentId);

    if (installment.amountPaid >= installment.amount) {
      installment.status = "paid";
      installment.paidAt = new Date();
    } else {
      installment.status = "partial";
    }

    applied.push({
      installmentNumber: installment.installmentNumber,
      amount: appliedAmount,
    });
  }

  return { applied, unapplied: remaining };
};

/** Earliest installment that still owes money (used by the compliance view). */
export const nextUnsettledInstallment = (plan) =>
  (plan.installments || []).find(
    (i) => !isSettled(i) && i.amount > i.amountPaid
  ) || null;

/** True once the installment's due date has slipped into the past. */
export const isInstallmentOverdue = (installment, now = new Date()) =>
  isPast(installment.dueDate) &&
  (installment.status === "pending" || installment.status === "partial");

export { isSettled, scheduleAnchor };
