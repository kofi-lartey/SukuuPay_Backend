import cron from "cron";
import { PaymentPlan } from "../models/paymentPlanModel.js";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import { sendSms } from "../utils/smsService.js";
import {
  addDays,
  endOfDayAccra,
  startOfDayAccra,
} from "../utils/dateHelpers.js";
import { sweepPlanStatuses } from "../services/paymentPlan.service.js";

// Reminders go out this many days before an installment falls due.
const REMINDER_LEAD_DAYS = 3;

const toCedis = (pesewas) => (Math.round(Number(pesewas) || 0) / 100).toFixed(2);

const formatDate = (date) =>
  new Date(date).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Accra",
  });

const getPrimaryParent = (student) =>
  (student?.parents || []).find((p) => p.isPrimary) || student?.parents?.[0] || null;

// Caches school + student so a large sweep does not re-query per installment.
const buildContext = () => {
  const cache = { schools: new Map(), students: new Map() };
  return {
    school: async (schoolId) => {
      const key = schoolId.toString();
      if (!cache.schools.has(key)) {
        cache.schools.set(
          key,
          await School.findById(schoolId).select("name schoolCode sms").lean()
        );
      }
      return cache.schools.get(key);
    },
    student: async (studentId) => {
      const key = studentId.toString();
      if (!cache.students.has(key)) {
        cache.students.set(
          key,
          await Student.findById(studentId)
            .select("studentName studentClass parents")
            .lean()
        );
      }
      return cache.students.get(key);
    },
  };
};

// ──────────────────── Pass 1: refresh overdue / expired state ────────────────────
const refreshPlanStatuses = async () => {
  const now = new Date();
  const plans = await PaymentPlan.find({
    planStatus: { $in: ["active", "pending_acceptance"] },
    deletedAt: null,
  });

  let updated = 0;
  for (const plan of plans) {
    const changed = await sweepPlanStatuses(plan);
    if (changed) updated += 1;
  }

  console.log(`[PLAN-JOB] Status sweep: ${plans.length} plans checked, ${updated} updated at ${now.toISOString()}`);
  return updated;
};

// ──────────────────── Pass 2: 3-day upcoming reminder ────────────────────
const sendDueReminders = async () => {
  const now = new Date();
  const windowStart = startOfDayAccra(addDays(now, REMINDER_LEAD_DAYS));
  const windowEnd = endOfDayAccra(addDays(now, REMINDER_LEAD_DAYS));

  const plans = await PaymentPlan.find({
    planStatus: "active",
    deletedAt: null,
    installments: {
      $elemMatch: {
        status: { $in: ["pending", "partial"] },
        dueDate: { $gte: windowStart, $lte: windowEnd },
        reminderSentAt: null,
      },
    },
  });

  const context = buildContext();
  let sent = 0;

  for (const plan of plans) {
    const due = plan.installments.filter(
      (i) =>
        (i.status === "pending" || i.status === "partial") &&
        !i.reminderSentAt &&
        new Date(i.dueDate) >= windowStart &&
        new Date(i.dueDate) <= windowEnd
    );
    if (!due.length) continue;

    const [school, student] = await Promise.all([
      context.school(plan.schoolId),
      context.student(plan.studentId),
    ]);
    const parent = getPrimaryParent(student);

    for (const installment of due) {
      if (parent) {
        const message =
          `${school?.name || "Your school"}: reminder — installment ${installment.installmentNumber} of ` +
          `${plan.numberOfInstallments} for ${student?.studentName || "your ward"} is due on ` +
          `${formatDate(installment.dueDate)}. Amount: GHS ` +
          `${toCedis(installment.amount - (installment.amountPaid || 0))}.`;

        await sendSms({ to: parent.phone, message, school });
        sent += 1;
      }

      // The flag is stamped even when the send fails so a provider outage
      // cannot turn the sweep into a repeated-send storm.
      installment.reminderSentAt = now;
    }

    plan.lastReminderSentAt = now;
    await plan.save();
  }

  console.log(`[PLAN-JOB] Reminders: ${sent} sent for ${plans.length} plans`);
  return sent;
};

// ──────────────────── Pass 3: overdue warning ────────────────────
const sendOverdueNotices = async () => {
  const now = new Date();

  const plans = await PaymentPlan.find({
    planStatus: { $in: ["active", "defaulted"] },
    deletedAt: null,
    installments: {
      $elemMatch: {
        status: "overdue",
        overdueNotifiedAt: null,
      },
    },
  });

  const context = buildContext();
  let sent = 0;

  for (const plan of plans) {
    const overdue = plan.installments.filter(
      (i) => i.status === "overdue" && !i.overdueNotifiedAt
    );
    if (!overdue.length) continue;

    const [school, student] = await Promise.all([
      context.school(plan.schoolId),
      context.student(plan.studentId),
    ]);
    const parent = getPrimaryParent(student);

    for (const installment of overdue) {
      if (parent) {
        const outstanding = installment.amount - (installment.amountPaid || 0);
        const message =
          `${school?.name || "Your school"}: installment ${installment.installmentNumber} of ` +
          `${plan.numberOfInstallments} for ${student?.studentName || "your ward"} was due on ` +
          `${formatDate(installment.dueDate)} and is still outstanding. GHS ${toCedis(outstanding)} ` +
          "is now overdue. Please make payment promptly.";

        await sendSms({ to: parent.phone, message, school });
        sent += 1;
      }

      installment.overdueNotifiedAt = now;
    }

    plan.lastOverdueCheckAt = now;
    await plan.save();
  }

  console.log(`[PLAN-JOB] Overdue notices: ${sent} sent for ${plans.length} plans`);
  return sent;
};

// ──────────────────── Entry point ────────────────────
export const runInstallmentReminders = async () => {
  const summary = { updated: 0, reminders: 0, overdueNotices: 0 };

  try {
    // Statuses first: a slipped installment must be "overdue" before the
    // warning pass sees it, and a finished plan must leave the reminder set.
    summary.updated = await refreshPlanStatuses();
    summary.reminders = await sendDueReminders();
    summary.overdueNotices = await sendOverdueNotices();
  } catch (error) {
    console.error("[PLAN-JOB] Installment sweep failed:", error.message);
  }

  return summary;
};

// Daily at 08:00 Accra time.
const job = new cron.CronJob(
  "0 8 * * *",
  runInstallmentReminders,
  null,
  false,
  "Africa/Accra"
);

export default job;
