import mongoose from "mongoose";
import { PaymentPlan } from "../models/paymentPlanModel.js";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import { Payment } from "../models/paymentModel.js";
import { ReportTemplate } from "../models/ReportTemplate.js";
import { ReportJob } from "../models/ReportJob.js";
import {
  addDays,
  addMonths,
  startOfDayAccra,
  endOfDayAccra,
  differenceInDays,
} from "../utils/dateHelpers.js";
import { formatCedis } from "../utils/formatters.js";
import * as auditService from "../utils/auditService.js";
import { AUDIT_ACTIONS } from "../config/constants.js";
import { cloudinary } from "../utils/cloudinary.js";
import { csvFor, workbookFor } from "../utils/reportExport.js";
import { pdfFor } from "../utils/reportPdf.js";
import { CLOUDINARY_UPLOAD_FOLDER } from "../config/env.js";

class ApiError extends Error {
  constructor(message, status = 500, code = "INTERNAL_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

const resolveSchoolId = (user, explicitSchoolId) => {
  if (user && user.role === "super_admin") {
    return explicitSchoolId
      ? new mongoose.Types.ObjectId(explicitSchoolId)
      : null;
  }
  return user && user.schoolId
    ? new mongoose.Types.ObjectId(user.schoolId)
    : null;
};

const fetchSchool = async (schoolId) => {
  const school = await School.findById(schoolId)
    .select("name schoolCode academic")
    .lean();
  if (!school) throw new ApiError("School not found", 404, "SCHOOL_NOT_FOUND");
  return school;
};

const maskPhone = (phone) => {
  if (!phone) return phone;
  const digits = String(phone);
  if (digits.length <= 6) {
    return digits.slice(0, 2) + "*".repeat(Math.max(0, digits.length - 2));
  }
  return digits.slice(0, 4) + "*".repeat(digits.length - 6) + digits.slice(-2);
};

const LIVE_PLAN_STATUSES = [
  "pending_acceptance",
  "active",
  "completed",
  "defaulted",
  "expired",
];

const round = (num, dp = 2) => {
  const factor = Math.pow(10, dp);
  return Math.round((Number(num) || 0) * factor) / factor;
};

const rate = (collected, expected) => {
  if (!expected || expected === 0) return 0;
  return round((collected / expected) * 100);
};

const startOfMonthAccra = (date) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
};

// An export must contain the full filtered set, so pagination is bypassed
// whenever a file format is requested — otherwise a CSV would silently carry
// only the first page of rows.
const paginationFor = (query) => {
  if (query.format) return { skip: 0, limit: 0, unbounded: true };
  const page = query.page || 1;
  const perPage = query.perPage || 50;
  return { skip: (page - 1) * perPage, limit: perPage, unbounded: false };
};

/**
 * Term and month windows are adjacent partitions of the same calendar, so
 * their end must be the true last instant of the day. `endOfDayAccra` stops at
 * 23:59:00, which would leave a one-minute gap in which a payment on the last
 * day of a term belongs to no term at all.
 */
const lastDayOfMonth = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));

/**
 * The school model stores no term calendar, so a term window is derived from
 * the academic year label ("2025/2026") using the Ghanaian September-to-August
 * academic year, split into `termsPerYear` terms. Falls back to the calendar
 * year when the label is not in YYYY/YYYY form.
 */
const resolveTermWindow = (academicYear, term, termsPerYear = 3) => {
  const match = String(academicYear || "").match(/^(\d{4})\/(\d{4})$/);
  // Ghanaian academic years run September to August.
  const yearStart = match
    ? new Date(Date.UTC(Number(match[1]), 8, 1, 0, 0, 0, 0))
    : new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1, 0, 0, 0, 0));

  const MONTHS_PER_YEAR = 12;
  const terms = Math.max(1, Number(termsPerYear) || 1);
  // Terms are split on whole calendar months, never on equal millisecond spans,
  // so a 3-term year lands on Sept–Dec / Jan–Apr / May–Aug rather than on
  // arbitrary mid-week cut points.
  const monthsPerTerm = Math.ceil(MONTHS_PER_YEAR / terms);

  if (!term) {
    return { start: yearStart, end: lastDayOfMonth(addMonths(yearStart, MONTHS_PER_YEAR - 1)) };
  }

  const index = Math.max(
    1,
    Math.min(Number(String(term).replace(/\D/g, "")) || 1, terms)
  );
  return {
    start: addMonths(yearStart, (index - 1) * monthsPerTerm),
    end: lastDayOfMonth(addMonths(yearStart, index * monthsPerTerm - 1)),
  };
};

const monthWindow = (month) => {
  if (month) {
    const [year, mon] = month.split("-").map(Number);
    return {
      start: new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0, 0)),
      end: lastDayOfMonth(new Date(Date.UTC(year, mon - 1, 1))),
    };
  }
  const now = new Date();
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)),
    end: lastDayOfMonth(now),
  };
};

const buildMeta = (query, total) => {
  const perPage = query.perPage || 50;
  return {
    page: query.page || 1,
    perPage,
    total,
    totalPages: Math.max(Math.ceil(total / perPage), 1),
    generatedAt: new Date().toISOString(),
  };
};

const classScope = async (schoolId, className) => {
  if (!className) return null;
  const students = await Student.find({ schoolId, studentClass: className, deletedAt: null })
    .select("_id")
    .lean();
  return students.map((s) => s._id);
};

// ──────────────────── 1. Daily collection report ────────────────────

export const getDailyReport = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");

  const school = await fetchSchool(schoolId);
  const day = query.date ? new Date(query.date) : new Date();
  const start = startOfDayAccra(day);
  const end = endOfDayAccra(day);
  const status = query.status || "completed";

  const match = {
    schoolId,
    deletedAt: null,
    status,
    createdAt: { $gte: start, $lte: end },
  };
  if (query.paymentMethod) match.paymentMethod = query.paymentMethod;

  const studentIds = await classScope(schoolId, query.class);
  if (studentIds) match.studentId = { $in: studentIds };

  const { skip, limit, unbounded } = paginationFor(query);

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: Student.collection.name,
        localField: "studentId",
        foreignField: "_id",
        as: "student",
      },
    },
    { $unwind: { path: "$student", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        receiptNumber: 1,
        invoiceNumber: 1,
        amount: 1,
        currency: 1,
        status: 1,
        paymentMethod: 1,
        provider: 1,
        description: 1,
        completedAt: 1,
        createdAt: 1,
        studentId: 1,
        studentName: { $ifNull: ["$student.studentName", "Unknown student"] },
        studentCode: { $ifNull: ["$student.studentId", null] },
        studentClass: { $ifNull: ["$student.studentClass", null] },
      },
    },
    { $sort: { completedAt: 1, createdAt: 1 } },
  ];

  if (!unbounded) {
    pipeline.push({ $facet: {
      rows: [{ $skip: skip }, { $limit: limit }],
      total: [{ $count: "count" }],
    } });
  }

  const agg = await Payment.aggregate(pipeline, { allowDiskUse: true });

  const rowsDoc = unbounded ? agg : agg[0]?.rows || [];
  const total = unbounded ? agg.length : agg[0]?.total?.[0]?.count || 0;

  const rows = rowsDoc.map((r) => ({
    ...r,
    amountDisplay: formatCedis(r.amount),
  }));

  const totalCollected = rows.reduce((sum, r) => sum + (r.amount || 0), 0);

  const byMethod = new Map();
  for (const r of rows) {
    const key = r.paymentMethod || "unknown";
    const entry = byMethod.get(key) || { paymentMethod: key, amount: 0, count: 0 };
    entry.amount += r.amount || 0;
    entry.count += 1;
    byMethod.set(key, entry);
  }

  const result = {
    report: "daily",
    school: { name: school.name, schoolCode: school.schoolCode },
    period: { startDate: start, endDate: end },
    filters: { class: query.class || null, paymentMethod: query.paymentMethod || null, status },
    summary: {
      totalCollected,
      totalCollectedDisplay: formatCedis(totalCollected),
      transactionCount: rows.length,
      averagePayment: rows.length ? Math.round(totalCollected / rows.length) : 0,
    },
    byMethod: Array.from(byMethod.values()).map((m) => ({
      ...m,
      amountDisplay: formatCedis(m.amount),
    })),
    rows,
    meta: buildMeta(query, total),
  };

  await auditService.log({
    action: AUDIT_ACTIONS.REPORT_VIEWED,
    entity: "DailyReport",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { query },
  });

  return result;
};

// ──────────────────── 2. Term report ────────────────────

export const getTermReport = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");

  const school = await fetchSchool(schoolId);
  const academicYear = query.academicYear || school.academic?.currentYear || null;
  // `school.academic.currentYear` is a bare year ("2026") while students store
  // the full label ("2025/2026"), so only an explicit, well-formed query param
  // is safe to filter on — otherwise the default case matches nothing.
  const studentAcademicYear = /^\d{4}\/\d{4}$/.test(query.academicYear || "")
    ? query.academicYear
    : null;
  const termsPerYear = school.academic?.termsPerYear || 3;
  const { start, end } = resolveTermWindow(academicYear, query.term, termsPerYear);

  const studentMatch = { schoolId, deletedAt: null };
  if (query.class) studentMatch.studentClass = query.class;
  if (studentAcademicYear) studentMatch.academicYear = studentAcademicYear;

  const students = await Student.find(studentMatch)
    .select("studentId studentName studentClass totalOwed totalPaid balance")
    .lean();

  const paymentMatch = {
    schoolId,
    deletedAt: null,
    status: "completed",
    completedAt: { $gte: start, $lte: end },
  };

  const payments = await Payment.find(paymentMatch)
    .select("studentId amount completedAt")
    .lean();

  const collectedInWindow = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const expected = students.reduce((sum, s) => sum + (s.totalOwed || 0), 0);
  const billedPaid = students.reduce((sum, s) => sum + (s.totalPaid || 0), 0);

  const classMap = new Map();
  for (const s of students) {
    const key = s.studentClass || "Unassigned";
    const entry = classMap.get(key) || {
      className: key,
      studentCount: 0,
      expected: 0,
      collected: 0,
    };
    entry.studentCount += 1;
    entry.expected += s.totalOwed || 0;
    entry.collected += s.totalPaid || 0;
    classMap.set(key, entry);
  }

  const rows = Array.from(classMap.values())
    .map((c) => {
      const balance = c.expected - c.collected;
      return {
        ...c,
        balance,
        collectionRate: rate(c.collected, c.expected),
        expectedDisplay: formatCedis(c.expected),
        collectedDisplay: formatCedis(c.collected),
        balanceDisplay: formatCedis(balance),
      };
    })
    .sort((a, b) => a.collectionRate - b.collectionRate);

  const monthlyMap = new Map();
  for (const p of payments) {
    const key = new Date(p.completedAt).toISOString().slice(0, 7);
    const entry = monthlyMap.get(key) || { period: key, collected: 0, count: 0 };
    entry.collected += p.amount || 0;
    entry.count += 1;
    monthlyMap.set(key, entry);
  }

  const monthly = Array.from(monthlyMap.values())
    .map((m) => ({ ...m, collectedDisplay: formatCedis(m.collected) }))
    .sort((a, b) => (a.period < b.period ? -1 : 1));

  const topOwing = students
    .filter((s) => (s.balance || 0) > 0)
    .sort((a, b) => (b.balance || 0) - (a.balance || 0))
    .slice(0, 10)
    .map((s) => ({
      studentId: s.studentId,
      studentName: s.studentName,
      studentClass: s.studentClass,
      balance: s.balance,
      balanceDisplay: formatCedis(s.balance),
    }));

  const result = {
    report: "term",
    school: { name: school.name, schoolCode: school.schoolCode },
    period: { academicYear, term: query.term || null, startDate: start, endDate: end },
    summary: {
      studentCount: students.length,
      expected,
      expectedDisplay: formatCedis(expected),
      collectedToDate: billedPaid,
      collectedToDateDisplay: formatCedis(billedPaid),
      collectedInWindow: collectedInWindow,
      collectedInWindowDisplay: formatCedis(collectedInWindow),
      outstanding: Math.max(expected - billedPaid, 0),
      outstandingDisplay: formatCedis(Math.max(expected - billedPaid, 0)),
      collectionRate: rate(billedPaid, expected),
    },
    monthly,
    topOwing,
    rows,
    meta: buildMeta(query, rows.length),
  };

  await auditService.log({
    action: AUDIT_ACTIONS.REPORT_VIEWED,
    entity: "TermReport",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { query },
  });

  return result;
};

// ──────────────────── 3. Outstanding balances ────────────────────

export const getOutstandingReport = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");

  const school = await fetchSchool(schoolId);

  const match = { schoolId, deletedAt: null, balance: { $gt: 0 } };
  if (query.class) match.studentClass = query.class;
  if (query.academicYear) match.academicYear = query.academicYear;
  if (query.minAmount) match.balance = { $gt: Math.max(query.minAmount - 1, 0) };
  if (query.status === "not_paid") match.totalPaid = 0;
  if (query.status === "partial") match.totalPaid = { $gt: 0 };

  const students = await Student.find(match)
    .select("studentId studentName studentClass academicYear totalOwed totalPaid balance parents")
    .lean();

  const withAge = await Promise.all(
    students.map(async (s) => {
      let oldestDueDate = null;
      if (query.minAgeDays) {
        const plans = await PaymentPlan.find({
          schoolId,
          studentId: s._id,
          deletedAt: null,
        })
          .select("installments")
          .lean();
        const dueDates = [];
        for (const plan of plans) {
          for (const inst of plan.installments || []) {
            if (inst.status === "overdue" || inst.status === "pending" || inst.status === "partial") {
              if (inst.amount > (inst.amountPaid || 0)) dueDates.push(new Date(inst.dueDate));
            }
          }
        }
        if (dueDates.length) {
          oldestDueDate = dueDates.sort((a, b) => a - b)[0];
        }
      }
      const primary = (s.parents || []).find((p) => p.isPrimary) || (s.parents || [])[0] || null;
      return {
        _id: s._id,
        studentId: s.studentId,
        studentName: s.studentName,
        studentClass: s.studentClass,
        academicYear: s.academicYear,
        totalOwed: s.totalOwed,
        totalPaid: s.totalPaid,
        balance: s.balance,
        balanceDisplay: formatCedis(s.balance),
        oldestDueDate,
        daysOutstanding: oldestDueDate ? differenceInDays(new Date(), oldestDueDate) : null,
        primaryParentName: primary ? primary.parentName : null,
        primaryParentPhone: primary ? maskPhone(primary.phone) : null,
      };
    })
  );

  let filtered = withAge;
  if (query.minAgeDays) {
    filtered = filtered.filter(
      (r) => r.daysOutstanding !== null && r.daysOutstanding >= query.minAgeDays
    );
  }

  const { skip, limit, unbounded } = paginationFor(query);
  const sortField = query.sortBy || "balance";
  const order = query.sortOrder || "desc";

  const sorted = [...filtered].sort((a, b) => {
    if (sortField === "studentName" || sortField === "studentClass" || sortField === "oldestDueDate") {
      const av = a[sortField] ? new Date(a[sortField]).getTime() : 0;
      const bv = b[sortField] ? new Date(b[sortField]).getTime() : 0;
      if (av === bv) return 0;
      return order === "asc" ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
    }
    const av = Number(a[sortField]) || 0;
    const bv = Number(b[sortField]) || 0;
    if (av === bv) return 0;
    return order === "asc" ? av - bv : bv - av;
  });

  const total = sorted.length;
  const rows = unbounded ? sorted : sorted.slice(skip, skip + limit);
  const totalOutstanding = sorted.reduce((sum, r) => sum + r.balance, 0);

  const result = {
    report: "outstanding",
    school: { name: school.name, schoolCode: school.schoolCode },
    period: { academicYear: query.academicYear || null },
    summary: {
      studentCount: total,
      totalOutstanding,
      totalOutstandingDisplay: formatCedis(totalOutstanding),
      fullyUnpaidCount: sorted.filter((r) => (r.totalPaid || 0) === 0).length,
      partiallyPaidCount: sorted.filter((r) => (r.totalPaid || 0) > 0).length,
    },
    rows,
    meta: buildMeta(query, total),
  };

  await auditService.log({
    action: AUDIT_ACTIONS.REPORT_VIEWED,
    entity: "OutstandingReport",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { query },
  });

  return result;
};

// ──────────────────── 4. Installment compliance report ────────────────────

export const getComplianceReport = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");

  const school = await fetchSchool(schoolId);
  const now = new Date();
  const windowEnd = endOfDayAccra(addDays(now, 3));

  const match = { schoolId, deletedAt: null, planStatus: { $in: LIVE_PLAN_STATUSES } };
  if (query.planStatus) match.planStatus = query.planStatus;

  const studentIds = await classScope(schoolId, query.class);
  if (studentIds) match.studentId = { $in: studentIds };

  const plans = await PaymentPlan.find(match)
    .select("studentId planName planStatus startDate endDate installments")
    .lean();

  const students = await Student.find({ schoolId, deletedAt: null, _id: { $in: [...new Set(plans.map((p) => p.studentId))] } })
    .select("studentId studentName studentClass")
    .lean();
  const studentMap = new Map(students.map((s) => [String(s._id), s]));

  const summary = {
    totalPlans: plans.length,
    onTrack: 0,
    approachingDue: 0,
    overdue: 0,
    completed: 0,
    defaulted: 0,
    pendingAcceptance: 0,
    totalInstallments: 0,
    paidOnTime: 0,
  };

  const allRows = plans.map((plan) => {
    const student = studentMap.get(String(plan.studentId));
    const installments = plan.installments || [];
    summary.totalInstallments += installments.length;

    let onTime = 0;
    for (const inst of installments) {
      if (inst.status === "paid" && inst.paidAt && new Date(inst.paidAt) <= endOfDayAccra(inst.dueDate)) {
        onTime += 1;
      }
    }
    summary.paidOnTime += onTime;

    let bucket;
    if (plan.planStatus === "completed") {
      bucket = "completed";
      summary.completed += 1;
    } else if (plan.planStatus === "defaulted") {
      bucket = "defaulted";
      summary.defaulted += 1;
    } else if (plan.planStatus === "pending_acceptance") {
      bucket = "pending_acceptance";
      summary.pendingAcceptance += 1;
    } else {
      const hasOverdue = installments.some((i) => i.status === "overdue");
      if (hasOverdue) {
        bucket = "overdue";
        summary.overdue += 1;
      } else {
        const nextDue = installments
          .filter((i) => i.status === "pending" || i.status === "partial")
          .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0];
        if (nextDue && new Date(nextDue.dueDate) <= windowEnd) {
          bucket = "approaching_due";
          summary.approachingDue += 1;
        } else {
          bucket = "on_track";
          summary.onTrack += 1;
        }
      }
    }

    return {
      planId: plan._id,
      planName: plan.planName,
      planStatus: plan.planStatus,
      studentId: student ? student.studentId : null,
      studentName: student ? student.studentName : "Unknown student",
      studentClass: student ? student.studentClass : null,
      startDate: plan.startDate,
      endDate: plan.endDate,
      totalInstallments: installments.length,
      installmentsPaidOnTime: onTime,
      installmentsOverdue: installments.filter((i) => i.status === "overdue").length,
      complianceRate: rate(onTime, installments.length),
      bucket,
    };
  });

  const { skip, limit, unbounded } = paginationFor(query);
  const order = query.sortOrder || "desc";
  const sortField = query.sortBy || "complianceRate";

  const sorted = [...allRows].sort((a, b) => {
    if (sortField === "studentName" || sortField === "studentClass") {
      const av = String(a[sortField] || "");
      const bv = String(b[sortField] || "");
      if (av === bv) return 0;
      return order === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    const av = Number(a[sortField]) || 0;
    const bv = Number(b[sortField]) || 0;
    if (av === bv) return 0;
    return order === "asc" ? av - bv : bv - av;
  });

  const total = sorted.length;
  const rows = unbounded ? sorted : sorted.slice(skip, skip + limit);

  const result = {
    report: "compliance",
    school: { name: school.name, schoolCode: school.schoolCode },
    period: { academicYear: query.academicYear || null, term: query.term || null },
    summary: {
      ...summary,
      overallComplianceRate: rate(summary.paidOnTime, summary.totalInstallments),
    },
    rows,
    meta: buildMeta(query, total),
  };

  await auditService.log({
    action: AUDIT_ACTIONS.REPORT_VIEWED,
    entity: "ComplianceReport",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { query },
  });

  return result;
};

// ──────────────────── 5. Payment method breakdown ────────────────────

export const getPaymentMethodsReport = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");

  const school = await fetchSchool(schoolId);
  const groupBy = query.groupBy || "method";

  const start = query.startDate
    ? startOfDayAccra(new Date(query.startDate))
    : startOfMonthAccra(new Date());
  const end = query.endDate
    ? endOfDayAccra(new Date(query.endDate))
    : endOfDayAccra(new Date());

  const match = {
    schoolId,
    deletedAt: null,
    status: "completed",
    completedAt: { $gte: start, $lte: end },
  };

  const studentIds = await classScope(schoolId, query.class);
  if (studentIds) match.studentId = { $in: studentIds };

  const groupExpr = {
    method: "$paymentMethod",
    month: { $dateToString: { format: "%Y-%m", date: "$completedAt" } },
    term: { $dateToString: { format: "%Y-Q", date: "$completedAt" } },
    class: "$studentClass",
  };

  let pipeline = [{ $match: match }];

  if (groupBy === "class") {
    pipeline.push({
      $lookup: {
        from: Student.collection.name,
        localField: "studentId",
        foreignField: "_id",
        as: "student",
      },
    });
    pipeline.push({ $unwind: { path: "$student", preserveNullAndEmptyArrays: true } });
    pipeline.push({
      $addFields: { studentClass: { $ifNull: ["$student.studentClass", "Unassigned"] } },
    });
  }

  pipeline.push({
    $group: {
      _id: { $ifNull: [groupExpr[groupBy], "unknown"] },
      amount: { $sum: "$amount" },
      count: { $sum: 1 },
    },
  });
  pipeline.push({ $sort: { amount: -1 } });

  const buckets = await Payment.aggregate(pipeline, { allowDiskUse: true });

  const totalAmount = buckets.reduce((sum, b) => sum + b.amount, 0);
  const totalCount = buckets.reduce((sum, b) => sum + b.count, 0);

  const rows = buckets.map((b) => ({
    groupBy,
    label: b._id,
    amount: b.amount,
    count: b.count,
    percentage: rate(b.amount, totalAmount),
    amountDisplay: formatCedis(b.amount),
  }));

  const result = {
    report: "payment-methods",
    school: { name: school.name, schoolCode: school.schoolCode },
    period: { startDate: start, endDate: end, groupBy },
    summary: {
      totalCollected: totalAmount,
      totalCollectedDisplay: formatCedis(totalAmount),
      transactionCount: totalCount,
      groupCount: rows.length,
    },
    rows,
    meta: buildMeta(query, rows.length),
  };

  await auditService.log({
    action: AUDIT_ACTIONS.REPORT_VIEWED,
    entity: "PaymentMethodsReport",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { query },
  });

  return result;
};

// ──────────────────── 6. Class-wise collections ────────────────────

export const getClassCollectionsReport = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");

  const school = await fetchSchool(schoolId);

  const match = { schoolId, deletedAt: null };
  if (query.academicYear) match.academicYear = query.academicYear;

  const students = await Student.find(match)
    .select("studentClass totalOwed totalPaid")
    .lean();

  let windowed = null;
  if (query.startDate || query.endDate) {
    const start = query.startDate ? startOfDayAccra(new Date(query.startDate)) : null;
    const end = query.endDate ? endOfDayAccra(new Date(query.endDate)) : null;
    const win = { schoolId, deletedAt: null, status: "completed" };
    if (start) win.completedAt = { $gte: start };
    if (end) win.completedAt = { ...(win.completedAt || {}), $lte: end };

    const payments = await Payment.find(win).select("studentId amount").lean();
    const perStudent = new Map();
    for (const p of payments) {
      const key = String(p.studentId);
      perStudent.set(key, (perStudent.get(key) || 0) + (p.amount || 0));
    }
    windowed = perStudent;
  }

  const classMap = new Map();
  for (const s of students) {
    const key = s.studentClass || "Unassigned";
    const entry = classMap.get(key) || {
      className: key,
      studentCount: 0,
      expected: 0,
      collected: 0,
    };
    entry.studentCount += 1;
    entry.expected += s.totalOwed || 0;
    if (windowed) {
      entry.collected += windowed.get(String(s._id)) || 0;
    } else {
      entry.collected += s.totalPaid || 0;
    }
    classMap.set(key, entry);
  }

  const order = query.sortOrder || "asc";
  const sortField = query.sortBy || "collectionRate";

  const rows = Array.from(classMap.values())
    .map((c) => {
      const balance = c.expected - c.collected;
      return {
        ...c,
        balance,
        collectionRate: rate(c.collected, c.expected),
        expectedDisplay: formatCedis(c.expected),
        collectedDisplay: formatCedis(c.collected),
        balanceDisplay: formatCedis(balance),
      };
    })
    .sort((a, b) => {
      if (sortField === "className") {
        return order === "asc"
          ? a.className.localeCompare(b.className)
          : b.className.localeCompare(a.className);
      }
      const av = Number(a[sortField]) || 0;
      const bv = Number(b[sortField]) || 0;
      if (av === bv) return 0;
      return order === "asc" ? av - bv : bv - av;
    });

  const totalExpected = rows.reduce((sum, r) => sum + r.expected, 0);
  const totalCollected = rows.reduce((sum, r) => sum + r.collected, 0);

  const result = {
    report: "class-collections",
    school: { name: school.name, schoolCode: school.schoolCode },
    period: {
      academicYear: query.academicYear || school.academic?.currentYear || null,
      term: query.term || null,
      startDate: query.startDate || null,
      endDate: query.endDate || null,
    },
    summary: {
      classCount: rows.length,
      studentCount: rows.reduce((sum, r) => sum + r.studentCount, 0),
      totalExpected,
      totalExpectedDisplay: formatCedis(totalExpected),
      totalCollected,
      totalCollectedDisplay: formatCedis(totalCollected),
      totalBalance: Math.max(totalExpected - totalCollected, 0),
      totalBalanceDisplay: formatCedis(Math.max(totalExpected - totalCollected, 0)),
      collectionRate: rate(totalCollected, totalExpected),
    },
    rows,
    meta: buildMeta(query, rows.length),
  };

  await auditService.log({
    action: AUDIT_ACTIONS.REPORT_VIEWED,
    entity: "ClassCollectionsReport",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { query },
  });

  return result;
};

// ──────────────────── 7. Parent contact list ────────────────────

export const getParentContactsReport = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");

  const school = await fetchSchool(schoolId);

  const match = { schoolId, deletedAt: null };
  if (query.class) match.studentClass = query.class;
  if (query.onlyWithBalance) match.balance = { $gt: 0 };
  if (query.search) {
    const rx = new RegExp(escapeRegex(query.search), "i");
    match.$or = [{ studentName: rx }, { studentId: rx }, { "parents.parentName": rx }];
  }

  const students = await Student.find(match)
    .select("studentId studentName studentClass balance parents")
    .lean();

  let flattened = [];
  for (const s of students) {
    for (const parent of s.parents || []) {
      if (query.relationship && parent.relationship !== query.relationship) continue;
      if (query.onlyPrimary && !parent.isPrimary) continue;
      flattened.push({
        studentRef: s.studentId,
        studentName: s.studentName,
        studentClass: s.studentClass,
        parentName: parent.parentName,
        relationship: parent.relationship,
        phone: maskPhone(parent.phone),
        email: parent.email || null,
        isPrimary: parent.isPrimary,
        isAlive: parent.isAlive,
        balance: s.balance,
        balanceDisplay: formatCedis(s.balance),
      });
    }
  }

  const order = query.sortOrder || "asc";
  const sortField = query.sortBy || "studentName";
  flattened.sort((a, b) => {
    const av = String(a[sortField] ?? "");
    const bv = String(b[sortField] ?? "");
    if (av === bv) return 0;
    return order === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  const { skip, limit, unbounded } = paginationFor(query);
  const total = flattened.length;
  const rows = unbounded ? flattened : flattened.slice(skip, skip + limit);

  const result = {
    report: "parent-contacts",
    school: { name: school.name, schoolCode: school.schoolCode },
    period: { class: query.class || null },
    summary: {
      studentCount: students.length,
      contactCount: total,
      uniquePhoneCount: new Set(flattened.map((r) => r.phone)).size,
      studentsOwing: new Set(flattened.filter((r) => (r.balance || 0) > 0).map((r) => r.studentRef)).size,
    },
    rows,
    meta: buildMeta(query, total),
  };

  await auditService.log({
    action: AUDIT_ACTIONS.REPORT_VIEWED,
    entity: "ParentContactsReport",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { query },
  });

  return result;
};

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ──────────────────── 8. Overdue students ────────────────────

export const getOverdueReport = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");

  const school = await fetchSchool(schoolId);
  const now = new Date();

  const match = { schoolId, deletedAt: null, planStatus: { $in: LIVE_PLAN_STATUSES } };
  if (query.planStatus) match.planStatus = query.planStatus;

  const studentIds = await classScope(schoolId, query.class);
  if (studentIds) match.studentId = { $in: studentIds };

  const plans = await PaymentPlan.find(match)
    .select("studentId planName planStatus installments")
    .lean();

  const overdueStudents = new Set();
  for (const plan of plans) {
    if ((plan.installments || []).some((i) => i.status === "overdue")) {
      overdueStudents.add(plan.studentId);
    }
  }

  const students = await Student.find({
    schoolId,
    deletedAt: null,
    _id: { $in: [...overdueStudents] },
  })
    .select("studentId studentName studentClass parents")
    .lean();
  const planByStudent = new Map();
  for (const plan of plans) planByStudent.set(String(plan.studentId), plan);

  let allRows = students.map((s) => {
    const plan = planByStudent.get(String(s._id));
    const overdue = (plan?.installments || []).filter((i) => i.status === "overdue");
    const installments = overdue.map((inst) => {
      const daysOverdue = Math.max(differenceInDays(now, inst.dueDate), 0);
      return {
        installmentNumber: inst.installmentNumber,
        planName: plan.planName,
        dueDate: inst.dueDate,
        daysOverdue,
        amount: inst.amount,
        amountPaid: inst.amountPaid || 0,
        outstanding: inst.amount - (inst.amountPaid || 0),
        severity: daysOverdue >= 14 ? "critical" : "warning",
      };
    });
    const totalOverdueAmount = installments.reduce((sum, i) => sum + i.outstanding, 0);
    const maxDays = installments.length ? Math.max(...installments.map((i) => i.daysOverdue)) : 0;
    const primary = (s.parents || []).find((p) => p.isPrimary) || (s.parents || [])[0] || null;

    return {
      studentId: s.studentId,
      studentName: s.studentName,
      studentClass: s.studentClass,
      planName: plan?.planName || null,
      planStatus: plan?.planStatus || null,
      daysOverdue: maxDays,
      totalOverdueAmount,
      totalOverdueAmountDisplay: formatCedis(totalOverdueAmount),
      severity: maxDays >= 14 ? "critical" : "warning",
      primaryParentName: primary ? primary.parentName : null,
      primaryParentPhone: primary ? maskPhone(primary.phone) : null,
      installments,
    };
  });

  if (query.severity && query.severity !== "all") {
    allRows = allRows.filter((r) => r.severity === query.severity);
  }
  if (query.minDaysOverdue) {
    allRows = allRows.filter((r) => r.daysOverdue >= query.minDaysOverdue);
  }

  const order = query.sortOrder || "desc";
  const sortField = query.sortBy || "daysOverdue";
  allRows.sort((a, b) => {
    if (sortField === "studentName" || sortField === "studentClass") {
      const av = String(a[sortField] || "");
      const bv = String(b[sortField] || "");
      if (av === bv) return 0;
      return order === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    const av = Number(a[sortField]) || 0;
    const bv = Number(b[sortField]) || 0;
    if (av === bv) return 0;
    return order === "asc" ? av - bv : bv - av;
  });

  const { skip, limit, unbounded } = paginationFor(query);
  const total = allRows.length;
  const rows = unbounded ? allRows : allRows.slice(skip, skip + limit);

  const totalOverdueAmount = allRows.reduce((sum, r) => sum + r.totalOverdueAmount, 0);

  const result = {
    report: "overdue",
    school: { name: school.name, schoolCode: school.schoolCode },
    period: { academicYear: query.academicYear || null, term: query.term || null },
    summary: {
      totalOverdue: total,
      totalOverdueAmount,
      totalOverdueAmountDisplay: formatCedis(totalOverdueAmount),
      criticalCount: allRows.filter((r) => r.severity === "critical").length,
      warningCount: allRows.filter((r) => r.severity === "warning").length,
      avgDaysOverdue: total ? round(allRows.reduce((sum, r) => sum + r.daysOverdue, 0) / total, 1) : 0,
    },
    rows,
    meta: buildMeta(query, total),
  };

  await auditService.log({
    action: AUDIT_ACTIONS.REPORT_VIEWED,
    entity: "OverdueReport",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { query },
  });

  return result;
};

// ──────────────────── 9. Monthly headmaster summary ────────────────────

export const getHeadmasterMonthlyReport = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");

  const school = await fetchSchool(schoolId);
  const { start, end } = monthWindow(query.month);
  // UTC getters and constructor throughout, so the month-on-month step cannot
  // drift with the server's own timezone.
  const previousMonthLabel = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1)
  )
    .toISOString()
    .slice(0, 7);
  const previous = monthWindow(previousMonthLabel);

  const collectFor = async (window) => {
    const payments = await Payment.find({
      schoolId,
      deletedAt: null,
      status: "completed",
      completedAt: { $gte: window.start, $lte: window.end },
    })
      .select("amount paymentMethod")
      .lean();
    return {
      collected: payments.reduce((sum, p) => sum + (p.amount || 0), 0),
      count: payments.length,
    };
  };

  const [current, prior] = await Promise.all([collectFor({ start, end }), collectFor(previous)]);

  const students = await Student.find({ schoolId, deletedAt: null }).lean();
  const activeStudents = students.filter((s) => s.status === "active");
  const totalOwed = students.reduce((sum, s) => sum + (s.totalOwed || 0), 0);
  const totalPaid = students.reduce((sum, s) => sum + (s.totalPaid || 0), 0);

  const headcountMap = new Map();
  for (const s of activeStudents) {
    const key = s.studentClass || "Unassigned";
    headcountMap.set(key, (headcountMap.get(key) || 0) + 1);
  }

  const monthLabel = start.toISOString().slice(0, 7);
  const outstanding = Math.max(totalOwed - totalPaid, 0);

  const rows = [
    { metric: "Collected this month", value: current.collected, display: formatCedis(current.collected) },
    { metric: "Transactions this month", value: current.count, display: String(current.count) },
    { metric: "Collected last month", value: prior.collected, display: formatCedis(prior.collected) },
    {
      metric: "Month-on-month change",
      value: current.collected - prior.collected,
      display: formatCedis(current.collected - prior.collected),
    },
    { metric: "Total expected (all students)", value: totalOwed, display: formatCedis(totalOwed) },
    { metric: "Total collected to date", value: totalPaid, display: formatCedis(totalPaid) },
    { metric: "Total outstanding", value: outstanding, display: formatCedis(outstanding) },
    { metric: "Collection rate", value: rate(totalPaid, totalOwed), display: `${rate(totalPaid, totalOwed)}%` },
  ];

  if (query.includeHeadcount !== false) {
    rows.push({ metric: "Active students", value: activeStudents.length, display: String(activeStudents.length) });
    for (const [className, count] of Array.from(headcountMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      rows.push({ metric: `Headcount — ${className}`, value: count, display: String(count) });
    }
  }

  const result = {
    report: "headmaster-monthly",
    school: { name: school.name, schoolCode: school.schoolCode },
    period: { month: monthLabel, startDate: start, endDate: end },
    summary: {
      collected: current.collected,
      collectedDisplay: formatCedis(current.collected),
      previousCollected: prior.collected,
      monthOnMonthChange: current.collected - prior.collected,
      transactionCount: current.count,
      totalExpected: totalOwed,
      totalCollectedToDate: totalPaid,
      totalOutstanding: outstanding,
      totalOutstandingDisplay: formatCedis(outstanding),
      collectionRate: rate(totalPaid, totalOwed),
      activeStudents: activeStudents.length,
    },
    rows,
    meta: buildMeta(query, rows.length),
  };

  await auditService.log({
    action: AUDIT_ACTIONS.REPORT_VIEWED,
    entity: "HeadmasterMonthlyReport",
    entityId: schoolId,
    userId: user._id,
    schoolId,
    meta: { query },
  });

  return result;
};

// ──────────────────── Wave 3: custom audit templates & report jobs ────────────────────

const REPORT_JOB_EXPIRES_IN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const slugFor = (name) => String(name || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

const timestampForFile = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

const uploadFileBuffer = async (buffer, { filename, folder }) => {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ApiError("Report file buffer is empty", 500, "EMPTY_REPORT_BUFFER");
  }
  const ext = filename.split(".").pop() || "bin";
  const mimeType = {
    csv: "text/csv",
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }[ext] || "application/octet-stream";
  const publicId = `sukuupay-reports-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const dataUri = `data:${mimeType};base64,${buffer.toString("base64")}`;
  return new Promise((resolve, reject) => {
    cloudinary.v2.uploader.upload(
      dataUri,
      {
        folder: folder || CLOUDINARY_UPLOAD_FOLDER,
        public_id: publicId,
        resource_type: "raw",
        ...(ext ? { format: ext } : {}),
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
  });
};

const signedDownloadUrl = (publicId, expiresAt) =>
  cloudinary.v2.url(publicId, {
    resource_type: "raw",
    sign_url: true,
    expires_at: Math.floor(expiresAt.getTime() / 1000),
  });

// ── Fixed MoE compliance column set (owned by SukuuPay) ─────────────────────────────
const MOE_COLUMNS = [
  { key: "studentId", header: "Student EMIS Code" },
  { key: "studentName", header: "Name" },
  { key: "studentClass", header: "Class" },
  { key: "term", header: "Term" },
  { key: "academicYear", header: "Academic Year" },
  { key: "totalOwed", header: "Fees Assessed" },
  { key: "totalPaid", header: "Fees Paid" },
  { key: "balance", header: "Balance" },
  { key: "paymentDate", header: "Payment Date" },
  { key: "receiptNumber", header: "Receipt Number" },
  { key: "auditActor", header: "Audit Actor" },
  { key: "timestamp", header: "Timestamp" },
];

const buildMoeRows = async (schoolId, parameters, actorName) => {
  const match = { schoolId, deletedAt: null };
  if (parameters.class) match.studentClass = parameters.class;
  if (parameters.academicYear) match.academicYear = parameters.academicYear;

  const students = await Student.find(match)
    .select("studentId studentName studentClass academicYear totalOwed totalPaid balance")
    .lean();

  const studentIds = students.map((s) => s._id);
  const latestPayments = await Payment.aggregate([
    {
      $match: {
        schoolId,
        studentId: { $in: studentIds },
        status: "completed",
        deletedAt: null,
      },
    },
    { $sort: { completedAt: -1 } },
    {
      $group: {
        _id: "$studentId",
        paymentDate: { $first: "$completedAt" },
        receiptNumber: { $first: "$receiptNumber" },
      },
    },
  ]);
  const paymentByStudent = new Map(
    latestPayments.map((p) => [String(p._id), { paymentDate: p.paymentDate, receiptNumber: p.receiptNumber }])
  );

  const term = parameters.term || null;
  const auditActor = actorName || "system";
  const timestamp = new Date();

  return students.map((s) => {
    const p = paymentByStudent.get(String(s._id));
    return {
      studentId: s.studentId,
      studentName: s.studentName,
      studentClass: s.studentClass,
      term,
      academicYear: s.academicYear || null,
      totalOwed: s.totalOwed || 0,
      totalPaid: s.totalPaid || 0,
      balance: s.balance || 0,
      paymentDate: p ? p.paymentDate : null,
      receiptNumber: p ? p.receiptNumber : null,
      auditActor,
      timestamp,
    };
  });
};

const buildCustomAuditRows = async (schoolId, parameters, actorName) => {
  const columns = Array.isArray(parameters.columns) ? parameters.columns : [];
  const match = { schoolId, deletedAt: null, ...(parameters.filter || {}) };
  const students = await Student.find(match).lean();
  const auditActor = actorName || "system";
  const timestamp = new Date();
  return students.map((s) => {
    const row = { auditActor, timestamp };
    for (const column of columns) {
      row[column.key] = s[column.key];
    }
    return row;
  });
};

const buildFinancialSummaryRows = async (schoolId, parameters, actorName) => {
  const match = { schoolId, deletedAt: null, status: "completed" };
  if (parameters.startDate || parameters.endDate) {
    match.completedAt = {};
    if (parameters.startDate) match.completedAt.$gte = new Date(parameters.startDate);
    if (parameters.endDate) match.completedAt.$lte = new Date(parameters.endDate);
  }
  if (parameters.class) {
    const studentIds = await classScope(schoolId, parameters.class);
    if (studentIds) match.studentId = { $in: studentIds };
  }

  const payments = await Payment.aggregate([
    { $match: match },
    {
      $lookup: {
        from: Student.collection.name,
        localField: "studentId",
        foreignField: "_id",
        as: "student",
      },
    },
    { $unwind: { path: "$student", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        receiptNumber: 1,
        invoiceNumber: 1,
        amount: 1,
        paymentMethod: 1,
        provider: 1,
        status: 1,
        completedAt: 1,
        createdAt: 1,
        studentName: { $ifNull: ["$student.studentName", "Unknown student"] },
        studentCode: { $ifNull: ["$student.studentId", null] },
        studentClass: { $ifNull: ["$student.studentClass", null] },
      },
    },
    { $sort: { completedAt: -1, createdAt: -1 } },
  ]);

  const auditActor = actorName || "system";
  const timestamp = new Date();
  return payments.map((p) => ({
    studentId: p.studentCode,
    studentName: p.studentName,
    studentClass: p.studentClass,
    term: null,
    academicYear: null,
    totalOwed: null,
    totalPaid: p.amount || 0,
    balance: null,
    paymentDate: p.completedAt,
    receiptNumber: p.receiptNumber,
    auditActor,
    timestamp,
  }));
};

const buildSections = async (template, schoolId, actorName) => {
  const title = template.name || "Report";
  const generatedAt = new Date().toISOString();

  let columns = [];
  let rows = [];

  if (template.type === "moe_compliant" || template.type === "moe_compliance") {
    columns = MOE_COLUMNS;
    rows = await buildMoeRows(schoolId, template.parameters || {}, actorName);
  } else if (template.type === "custom_audit") {
    columns = Array.isArray(template.parameters.columns)
      ? template.parameters.columns.map((c) => ({ key: c.key, header: c.header || c.key }))
      : [];
    rows = await buildCustomAuditRows(schoolId, template.parameters || {}, actorName);
  } else {
    // financial_summary
    columns = [
      { key: "studentId", header: "Student EMIS Code" },
      { key: "studentName", header: "Name" },
      { key: "studentClass", header: "Class" },
      { key: "term", header: "Term" },
      { key: "academicYear", header: "Academic Year" },
      { key: "totalOwed", header: "Fees Assessed" },
      { key: "totalPaid", header: "Fees Paid" },
      { key: "balance", header: "Balance" },
      { key: "paymentDate", header: "Payment Date" },
      { key: "receiptNumber", header: "Receipt Number" },
      { key: "auditActor", header: "Audit Actor" },
      { key: "timestamp", header: "Timestamp" },
    ];
    rows = await buildFinancialSummaryRows(schoolId, template.parameters || {}, actorName);
  }

  // Pad any missing columns so every row serialises consistently.
  const normalizedRows = rows.map((row) => {
    const out = { ...row };
    for (const column of columns) {
      if (!(column.key in out)) out[column.key] = null;
    }
    return out;
  });

  const sections = [
    {
      name: "Summary",
      title: "Summary",
      columns: [
        { key: "rows", header: "Row Count" },
        { key: "generatedAt", header: "Generated At" },
      ],
      rows: [{ rows: normalizedRows.length, generatedAt }],
    },
    {
      name: "Details",
      title: title,
      columns,
      rows: normalizedRows,
    },
  ];
  return sections;
};

const serializeBuffer = async (template, sections) => {
  const format = (template.format || "csv").toLowerCase();
  const base = `${slugFor(template.name || "report")}-${timestampForFile()}`;
  if (format === "csv") {
    return { buffer: Buffer.from(csvFor(sections), "utf-8"), filename: `${base}.csv` };
  }
  if (format === "xlsx") {
    return { buffer: workbookFor(sections), filename: `${base}.xlsx` };
  }
  if (format === "pdf") {
    const buffer = pdfFor(sections, {
      title: template.name || "Report",
      subtitle: `Generated ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`,
    });
    return { buffer, filename: `${base}.pdf` };
  }
  throw new ApiError(`Unsupported report format: ${format}`, 400, "UNSUPPORTED_FORMAT");
};

export const createTemplate = async (data, user) => {
  const schoolId = user && user.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
  if (!schoolId) throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");

  const template = await ReportTemplate.create({
    schoolId,
    name: data.name,
    type: data.type,
    format: data.format || "csv",
    moeCompliant: !!data.moeCompliant,
    parameters: data.parameters || {},
    createdBy: user._id,
  });

  await auditService.log({
    action: AUDIT_ACTIONS.REPORT_EXPORTED,
    entity: "ReportTemplate",
    entityId: template._id,
    userId: user._id,
    schoolId,
    meta: { name: template.name, type: template.type, format: template.format },
  });

  return template;
};

export const listTemplates = async (schoolId) => {
  const match = schoolId ? { schoolId } : {};
  return ReportTemplate.find(match).sort({ createdAt: -1 }).lean();
};

export const createJob = async (templateId, user, overrideParams) => {
  const schoolId = user && user.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
  if (!schoolId) throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");

  const template = await ReportTemplate.findById(templateId).lean();
  if (!template) throw new ApiError("Template not found", 404, "TEMPLATE_NOT_FOUND");
  if (String(template.schoolId) !== String(schoolId)) {
    throw new ApiError("Template not accessible", 403, "TEMPLATE_NOT_ACCESSIBLE");
  }

  const job = await ReportJob.create({
    templateId,
    schoolId,
    status: "queued",
    requestedBy: user._id,
  });

  return job;
};

export const getJob = async (jobId) => {
  const job = await ReportJob.findById(jobId).lean();
  if (!job) throw new ApiError("Job not found", 404, "JOB_NOT_FOUND");

  // Handing out the signed download URL is the disclosure moment: the file
  // leaves the platform, so it is audited as `report.download` (distinct from
  // the on-screen read `report.viewed` and the file generation `report.exported`).
  if (job.fileUrl) {
    await auditService.log({
      action: AUDIT_ACTIONS.REPORT_DOWNLOAD,
      entity: "ReportJob",
      entityId: job._id,
      userId: job.requestedBy,
      schoolId: job.schoolId,
      meta: { fileUrl: job.fileUrl },
    });
  }

  return job;
};

export const listJobs = async (schoolId, options = {}) => {
  const match = schoolId ? { schoolId } : {};
  if (options.status) match.status = options.status;
  const page = Math.max(Number(options.page || 1), 1);
  const perPage = Math.min(Math.max(Number(options.perPage || 50), 1), 200);
  const [jobs, total] = await Promise.all([
    ReportJob.find(match)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean(),
    ReportJob.countDocuments(match),
  ]);
  return {
    jobs,
    total,
    page,
    perPage,
    totalPages: Math.max(Math.ceil(total / perPage), 1),
  };
};

export const runReportJob = async (jobId) => {
  const job = await ReportJob.findById(jobId);
  if (!job) throw new ApiError("Job not found", 404, "JOB_NOT_FOUND");

  const template = await ReportTemplate.findById(job.templateId).lean();
  if (!template) {
    job.status = "failed";
    job.errorMessage = "Template not found";
    await job.save();
    return job;
  }

  const schoolId = job.schoolId;
  const actorName = "system";
  try {
    job.status = "processing";
    await job.save();

    const sections = await buildSections(template, schoolId, actorName);
    const { buffer, filename } = await serializeBuffer(template, sections);

    const uploadResult = await uploadFileBuffer(buffer, {
      filename,
      folder: CLOUDINARY_UPLOAD_FOLDER,
    });

    const expiresAt = new Date(Date.now() + REPORT_JOB_EXPIRES_IN_MS);
    const downloadUrl = signedDownloadUrl(uploadResult.public_id, expiresAt);

    job.fileUrl = downloadUrl || uploadResult.secure_url;
    job.expiresAt = expiresAt;
    job.status = "completed";
    await job.save();

    await auditService.log({
      action: AUDIT_ACTIONS.REPORT_EXPORTED,
      entity: "ReportJob",
      entityId: job._id,
      userId: job.requestedBy,
      schoolId,
      meta: {
        templateId: template._id,
        format: template.format,
        fileUrl: job.fileUrl,
        filename,
      },
    });

    return job;
  } catch (error) {
    job.status = "failed";
    job.errorMessage = String(error?.message || error);
    await job.save();
    throw error;
  }
};
