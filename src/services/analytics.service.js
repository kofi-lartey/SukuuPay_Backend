import mongoose from "mongoose";
import { PaymentPlan } from "../models/paymentPlanModel.js";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import { Payment } from "../models/paymentModel.js";
import { addDays, startOfDayAccra, endOfDayAccra } from "../utils/dateHelpers.js";
import { formatCedis } from "../utils/formatters.js";

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
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");
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

const LIVE_STATUSES = ["active", "pending_acceptance"];

const ACTIVE_PLAN_STATUSES = ["pending_acceptance", "active", "completed", "defaulted", "expired"];

const round = (num, dp = 2) => {
  const factor = Math.pow(10, dp);
  return Math.round((Number(num) || 0) * factor) / factor;
};

const rate = (collected, expected) => {
  if (!expected || expected === 0) return 0;
  return round((collected / expected) * 100);
};

// ──────────────────── 1. Overview ────────────────────

export const getOverview = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);

  const [studentAgg, planAgg] = await Promise.all([
    Student.aggregate([
      {
        $match: {
          schoolId,
          deletedAt: null,
          ...(query.class ? { studentClass: query.class } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
      },
      {
        $group: {
          _id: null,
          totalStudents: { $sum: 1 },
          totalOwed: { $sum: "$totalOwed" },
          totalPaid: { $sum: "$totalPaid" },
        },
      },
    ]),
    PaymentPlan.aggregate([
      {
        $match: {
          schoolId,
          deletedAt: null,
          planStatus: { $in: ACTIVE_PLAN_STATUSES },
        },
      },
      {
        $group: {
          _id: null,
          activePlans: {
            $sum: { $cond: [{ $eq: ["$planStatus", "active"] }, 1, 0] },
          },
          completedPlans: {
            $sum: { $cond: [{ $eq: ["$planStatus", "completed"] }, 1, 0] },
          },
          defaultedPlans: {
            $sum: { $cond: [{ $eq: ["$planStatus", "defaulted"] }, 1, 0] },
          },
          pendingAcceptancePlans: {
            $sum: { $cond: [{ $eq: ["$planStatus", "pending_acceptance"] }, 1, 0] },
          },
          overduePlans: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$planStatus", "active"] },
                    {
                      $gt: [
                        {
                          $size: {
                            $filter: {
                              input: "$installments",
                              as: "i",
                              cond: { $eq: ["$$i.status", "overdue"] },
                            },
                          },
                        },
                        0,
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);

  const studentSummary = studentAgg[0] || {
    totalStudents: 0,
    totalOwed: 0,
    totalPaid: 0,
  };
  const planSummary = planAgg[0] || {
    activePlans: 0,
    completedPlans: 0,
    defaultedPlans: 0,
    pendingAcceptancePlans: 0,
    overduePlans: 0,
  };

  const totalCollected = studentSummary.totalPaid;
  const totalExpected = studentSummary.totalOwed;

  const result = {
    school: {
      name: school.name,
      schoolCode: school.schoolCode,
    },
    period: {
      academicYear: query.academicYear || school.academic?.currentYear || null,
      term: query.term || school.academic?.currentTerm || null,
    },
    totalStudents: studentSummary.totalStudents,
    totalRevenueCollected: totalCollected,
    totalRevenueExpected: totalExpected,
    totalOutstanding: Math.max(totalExpected - totalCollected, 0),
    collectionRate: rate(totalCollected, totalExpected),
    totalRevenueCollectedDisplay: formatCedis(totalCollected),
    totalOutstandingDisplay: formatCedis(Math.max(totalExpected - totalCollected, 0)),
    activePlans: planSummary.activePlans,
    overduePlans: planSummary.overduePlans,
    defaultedPlans: planSummary.defaultedPlans,
    completedPlans: planSummary.completedPlans,
    pendingAcceptancePlans: planSummary.pendingAcceptancePlans,
  };

  await auditService.log({
    action: "report.viewed",
    entity: "AnalyticsOverview",
    entityId: schoolId,
    userId: user._id,
    details: { query },
  });

  return result;
};

// ──────────────────── 2. Revenue ────────────────────

export const getRevenue = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);

  const groupBy = query.groupBy || "month";

  let dateMatch = {};
  if (query.startDate) {
    dateMatch.$gte = new Date(query.startDate);
  }
  if (query.endDate) {
    const end = new Date(query.endDate);
    end.setHours(23, 59, 59, 999);
    dateMatch.$lte = end;
  }

  if (groupBy === "class" && query.class) {
    // Single-class filter when groupBy is class
  }

  let periodExpr;
  let sortExpr = { _id: 1 };

  switch (groupBy) {
    case "month":
      periodExpr = {
        $dateToString: { format: "%Y-%m", date: "$createdAt" },
      };
      break;
    case "term":
      periodExpr = "$term";
      break;
    case "class":
      periodExpr = "$studentClass";
      break;
    default:
      periodExpr = {
        $dateToString: { format: "%Y-%m", date: "$createdAt" },
      };
  }

  const [paymentAgg, studentAgg] = await Promise.all([
    Payment.aggregate([
      { $match: { schoolId, status: "completed", deletedAt: null, ...dateMatch } },
      {
        $lookup: {
          from: "students",
          localField: "studentId",
          foreignField: "_id",
          as: "studentDoc",
        },
      },
      { $unwind: "$studentDoc" },
      {
        $match: {
          ...(query.class ? { "studentDoc.studentClass": query.class } : {}),
        },
      },
      {
        $group: {
          _id:
            groupBy === "class"
              ? "$studentDoc.studentClass"
              : periodExpr,
          collected: { $sum: "$amount" },
        },
      },
      { $sort: sortExpr },
    ]),
    Student.aggregate([
      {
        $match: {
          schoolId,
          deletedAt: null,
          ...(query.class ? { studentClass: query.class } : {}),
        },
      },
      {
        $lookup: {
          from: "paymentplans",
          localField: "_id",
          foreignField: "studentId",
          as: "plans",
        },
      },
      { $unwind: { path: "$plans", preserveNullAndEmptyArrays: true } },
      {
        $unwind: { path: "$plans.installments", preserveNullAndEmptyArrays: true },
      },
      {
        $match: {
          $or: [
            { "plans.installments.status": { $exists: true, $ne: null } },
            { "plans._id": { $exists: false } },
          ],
        },
      },
      {
        $group: {
          _id:
            groupBy === "class"
              ? "$studentClass"
              : periodExpr,
          expected: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$plans.installments.status", "waived"] },
                    { $ne: ["$plans.installments.status", "paid"] },
                    { $ifNull: ["$plans.installments.amount", false] },
                  ],
                },
                "$plans.installments.amount",
                0,
              ],
            },
          },
        },
      },
      { $sort: sortExpr },
    ]),
  ]);

  const collectedMap = new Map(
    paymentAgg.map((r) => [String(r._id), r.collected])
  );
  const expectedMap = new Map(
    studentAgg.map((r) => [String(r._id), r.expected])
  );

  const allPeriods = new Set([
    ...collectedMap.keys(),
    ...expectedMap.keys(),
  ]);

  const series = Array.from(allPeriods).map((period) => {
    const collected = collectedMap.get(String(period)) || 0;
    const expected = expectedMap.get(String(period)) || 0;
    return {
      period: String(period),
      collected,
      expected,
      outstanding: Math.max(expected - collected, 0),
      collectionRate: rate(collected, expected),
    };
  });

  const totalCollected = paymentAgg.reduce((sum, r) => sum + r.collected, 0);
  const totalExpected = studentAgg.reduce((sum, r) => sum + r.expected, 0);

  const result = {
    school: { name: school.name, schoolCode: school.schoolCode },
    period: {
      startDate: query.startDate || null,
      endDate: query.endDate || null,
      groupBy,
    },
    summary: {
      totalCollected,
      totalExpected,
      totalPending: Math.max(totalExpected - totalCollected, 0),
      collectionRate: rate(totalCollected, totalExpected),
      totalCollectedDisplay: formatCedis(totalCollected),
      totalExpectedDisplay: formatCedis(totalExpected),
    },
    series,
  };

  await auditService.log({
    action: "report.viewed",
    entity: "AnalyticsRevenue",
    entityId: schoolId,
    userId: user._id,
    details: { query },
  });

  return result;
};

// ──────────────────── 3. Paid vs Owed ────────────────────

export const getPaidOwed = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);

  const filter = { schoolId, deletedAt: null };
  if (query.class) filter.studentClass = query.class;
  if (query.status) filter.status = query.status;

  const students = await Student.find(filter).select(
    "studentId studentName studentClass totalOwed totalPaid balance status parents"
  ).lean();

  const totalOwed = students.reduce((sum, s) => sum + (s.totalOwed || 0), 0);
  const totalPaid = students.reduce((sum, s) => sum + (s.totalPaid || 0), 0);

  const breakdown = {
    fullyPaid: { count: 0, amountOwed: 0, amountPaid: 0, students: [] },
    partiallyPaid: { count: 0, amountOwed: 0, amountPaid: 0, students: [] },
    notPaid: { count: 0, amountOwed: 0, amountPaid: 0, students: [] },
  };

  const getCategory = (s) => {
    if (!s.totalPaid || s.totalPaid === 0) return "notPaid";
    if (s.totalPaid >= s.totalOwed) return "fullyPaid";
    return "partiallyPaid";
  };

  students.forEach((s) => {
    const category = getCategory(s);
    const primaryParent =
      (s.parents || []).find((p) => p.isPrimary) || s.parents?.[0];
    const entry = {
      _id: s._id,
      studentId: s.studentId,
      studentName: s.studentName,
      studentClass: s.studentClass,
      totalOwed: s.totalOwed,
      totalPaid: s.totalPaid,
      balance: s.balance,
      status: s.status,
      paymentStatus: category === "fullyPaid" ? "paid" : category === "partiallyPaid" ? "partial" : "owing",
      primaryParentPhone: primaryParent ? maskPhone(primaryParent.phone) : null,
    };
    breakdown[category].count += 1;
    breakdown[category].amountOwed += s.totalOwed || 0;
    breakdown[category].amountPaid += s.totalPaid || 0;
    if (breakdown[category].students.length < 10) {
      breakdown[category].students.push(entry);
    }
  });

  const result = {
    school: { name: school.name },
    summary: {
      totalPaid,
      totalOwed,
      collectionRate: rate(totalPaid, totalOwed),
      totalPaidDisplay: formatCedis(totalPaid),
      totalOwedDisplay: formatCedis(totalOwed),
    },
    breakdown: Object.entries(breakdown).map(([category, data]) => ({
      category,
      count: data.count,
      amountOwed: data.amountOwed,
      amountPaid: data.amountPaid,
      amountOwedDisplay: formatCedis(data.amountOwed),
      amountPaidDisplay: formatCedis(data.amountPaid),
      students: data.students,
    })),
  };

  await auditService.log({
    action: "report.viewed",
    entity: "AnalyticsPaidOwed",
    entityId: schoolId,
    userId: user._id,
    details: { query },
  });

  return result;
};

// ──────────────────── 4. Persons ────────────────────

export const getPersons = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);

  const filter = { schoolId, deletedAt: null };
  if (query.class) filter.studentClass = query.class;
  if (query.status) filter.status = query.status;

  const sortBy = query.sortBy || "createdAt";
  const direction = query.sortOrder === "desc" ? -1 : 1;
  const skip = (Number(query.page) - 1) * Number(query.perPage);

  const [students, total] = await Promise.all([
    Student.find(filter)
      .sort({ [sortBy]: direction })
      .skip(skip)
      .limit(Number(query.perPage))
      .select(
        "studentId studentName studentClass totalOwed totalPaid balance status parents createdAt"
      )
      .lean(),
    Student.countDocuments(filter),
  ]);

  const summary = {
    fullyPaid: 0,
    partiallyPaid: 0,
    owing: 0,
    total,
    parentsContacted: 0,
  };

  const data = students.map((s) => {
    const primaryParent =
      (s.parents || []).find((p) => p.isPrimary) || s.parents?.[0];
    let paymentStatus;
    if (!s.totalPaid || s.totalPaid === 0) {
      paymentStatus = "owing";
      summary.owing += 1;
    } else if (s.totalPaid >= s.totalOwed) {
      paymentStatus = "paid";
      summary.fullyPaid += 1;
    } else {
      paymentStatus = "partial";
      summary.partiallyPaid += 1;
    }
    if (primaryParent?.phone) summary.parentsContacted += 1;

    return {
      _id: s._id,
      studentId: s.studentId,
      studentName: s.studentName,
      studentClass: s.studentClass,
      totalOwed: s.totalOwed,
      totalPaid: s.totalPaid,
      balance: s.balance,
      balanceDisplay: formatCedis(s.balance),
      status: s.status,
      paymentStatus,
      primaryParentPhone: primaryParent ? maskPhone(primaryParent.phone) : null,
    };
  });

  const result = {
    school: { name: school.name },
    summary,
    students: data,
    meta: {
      page: Number(query.page),
      perPage: Number(query.perPage),
      total,
      totalPages: Math.ceil(total / Number(query.perPage)),
    },
  };

  await auditService.log({
    action: "report.viewed",
    entity: "AnalyticsPersons",
    entityId: schoolId,
    userId: user._id,
    details: { query },
  });

  return result;
};

// ──────────────────── 5. Revenue Chart ────────────────────

export const getRevenueChart = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);

  const groupBy = query.groupBy || "month";

  let dateMatch = {};
  if (query.startDate) dateMatch.$gte = new Date(query.startDate);
  if (query.endDate) {
    const end = new Date(query.endDate);
    end.setHours(23, 59, 59, 999);
    dateMatch.$lte = end;
  }

  let periodExpr;
  const sortExpr = { _id: 1 };

  switch (groupBy) {
    case "month":
      periodExpr = { $dateToString: { format: "%Y-%m", date: "$createdAt" } };
      break;
    case "term":
      periodExpr = "$term";
      break;
    case "class":
      periodExpr = "$studentClass";
      break;
    default:
      periodExpr = { $dateToString: { format: "%Y-%m", date: "$createdAt" } };
  }

  const collectedPipeline = [
    { $match: { schoolId, status: "completed", deletedAt: null, ...dateMatch } },
    {
      $lookup: {
        from: "students",
        localField: "studentId",
        foreignField: "_id",
        as: "studentDoc",
      },
    },
    { $unwind: "$studentDoc" },
    { $match: { ...(query.class ? { "studentDoc.studentClass": query.class } : {}) } },
    {
      $group: {
        _id:
          groupBy === "class"
            ? "$studentDoc.studentClass"
            : groupBy === "term"
            ? "$studentDoc.academicYear"
            : periodExpr,
        collected: { $sum: "$amount" },
      },
    },
    { $sort: sortExpr },
  ];

  const expectedPipeline = [
    {
      $match: {
        schoolId,
        deletedAt: null,
        planStatus: { $in: LIVE_STATUSES },
        ...(query.class
          ? { studentId: { $in: await Student.find({ schoolId, studentClass: query.class, deletedAt: null }).select("_id") } }
          : {}),
        ...dateMatch,
      },
    },
    { $unwind: "$installments" },
    {
      $match: {
        "installments.status": {
          $in: ["pending", "partial", "overdue"],
        },
        "installments.dueDate": { ...dateMatch },
      },
    },
    {
      $group: {
        _id:
          groupBy === "class"
            ? "$studentClass"
            : periodExpr,
        expected: { $sum: "$installments.amount" },
        collected: {
          $sum: {
            $cond: [
              { $eq: ["$installments.status", "paid"] },
              "$installments.amountPaid",
              0,
            ],
          },
        },
      },
    },
    { $sort: sortExpr },
  ];

  let classFilterIds = null;
  if (query.class) {
    const classStudents = await Student.find({
      schoolId,
      studentClass: query.class,
      deletedAt: null,
    }).select("_id");
    classFilterIds = classStudents.map((s) => s._id);
  }

  let expectedMatch = {
    schoolId,
    deletedAt: null,
    planStatus: { $in: LIVE_STATUSES },
    ...dateMatch,
  };
  if (query.class && classFilterIds) {
    expectedMatch.studentId = { $in: classFilterIds };
  }

  expectedPipeline[0] = { $match: expectedMatch };

  const [collectedRes, expectedRes] = await Promise.all([
    Payment.aggregate(collectedPipeline),
    PaymentPlan.aggregate(expectedPipeline),
  ]);

  const collectedMap = new Map(collectedRes.map((r) => [String(r._id), r.collected]));
  const expectedMap = new Map(expectedRes.map((r) => [String(r._id), r.expected]));
  const collectedExpectedMap = new Map(
    expectedRes.map((r) => [String(r._id), { expected: r.expected, collected: r.collected }])
  );

  const allPeriods = new Set([
    ...collectedMap.keys(),
    ...collectedExpectedMap.keys(),
  ]);

  const series = Array.from(allPeriods).map((period) => {
    const periodStr = String(period);
    const collectedVal = collectedMap.get(periodStr) || 0;
    const planData = collectedExpectedMap.get(periodStr);
    const expectedVal = planData ? planData.expected : (expectedMap.get(periodStr) || 0);
    return {
      period: periodStr,
      collected: collectedVal,
      expected: expectedVal,
      outstanding: Math.max(expectedVal - collectedVal, 0),
      collectionRate: rate(collectedVal, expectedVal),
    };
  });

  series.sort((a, b) => {
    if (a.period < b.period) return 1;
    if (a.period > b.period) return -1;
    return 0;
  });

  const totalCollected = collectedRes.reduce((sum, r) => sum + r.collected, 0);
  const totalExpected = expectedRes.reduce((sum, r) => sum + r.expected, 0);

  const result = {
    school: { name: school.name },
    groupBy,
    series,
    summary: {
      totalCollected,
      totalExpected,
      collectionRate: rate(totalCollected, totalExpected),
      totalCollectedDisplay: formatCedis(totalCollected),
      totalExpectedDisplay: formatCedis(totalExpected),
    },
  };

  await auditService.log({
    action: "report.viewed",
    entity: "AnalyticsRevenueChart",
    entityId: schoolId,
    userId: user._id,
    details: { query },
  });

  return result;
};

// ──────────────────── 6. Overdue ────────────────────

export const getOverdue = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);

  const now = new Date();
  const pipeline = [
    {
      $match: {
        schoolId,
        deletedAt: null,
        planStatus: { $in: ["active", "defaulted"] },
      },
    },
    { $unwind: "$installments" },
    {
      $match: {
        "installments.status": "overdue",
        "installments.dueDate": { $lt: now },
        ...(query.class ? { studentId: { $in: await Student.find({ schoolId, studentClass: query.class, deletedAt: null }).select("_id") } } : {}),
      },
    },
    {
      $lookup: {
        from: "students",
        localField: "studentId",
        foreignField: "_id",
        as: "student",
      },
    },
    { $unwind: "$student" },
    {
      $group: {
        _id: "$_id",
        planName: { $first: "$planName" },
        planStatus: { $first: "$planStatus" },
        studentId: { $first: "$studentId" },
        studentDoc: { $first: "$student" },
        installments: { $push: "$$ROOT.installments" },
      },
    },
  ];

  let classFilterIds = null;
  if (query.class) {
    const classStudents = await Student.find({
      schoolId,
      studentClass: query.class,
      deletedAt: null,
    }).select("_id");
    classFilterIds = classStudents.map((s) => s._id);
  }

  pipeline[2].$match.studentId = classFilterIds
    ? { $in: classFilterIds }
    : { $exists: true };

  const rawPlans = await PaymentPlan.aggregate(pipeline);

  const studentsList = [];
  let totalOverdueAmount = 0;
  let totalDaysOverdue = 0;
  let totalOverdueInstallments = 0;

  for (const item of rawPlans) {
    const student = item.studentDoc;
    const primaryParent =
      (student.parents || []).find((p) => p.isPrimary) || student.parents?.[0];
    const overdueInstallments = [];
    let studentOverdueAmount = 0;
    let studentDaysOverdue = 0;

    for (const inst of item.installments) {
      const dueDate = new Date(inst.dueDate);
      const daysOverdue = Math.floor((now - dueDate) / (24 * 60 * 60 * 1000));
      const outstanding = inst.amount - (inst.amountPaid || 0);
      const severity = daysOverdue >= 14 ? "critical" : "warning";

      if (query.severity && query.severity !== "all" && severity !== query.severity) {
        continue;
      }

      overdueInstallments.push({
        installmentNumber: inst.installmentNumber,
        planName: item.planName,
        dueDate: inst.dueDate,
        daysOverdue,
        amount: inst.amount,
        amountPaid: inst.amountPaid || 0,
        outstanding,
        severity,
      });

      studentOverdueAmount += outstanding;
      studentDaysOverdue += daysOverdue;
      totalOverdueAmount += outstanding;
      totalDaysOverdue += daysOverdue;
    }

    totalOverdueInstallments += overdueInstallments.length;
    if (overdueInstallments.length === 0) continue;

    studentsList.push({
      _id: student._id,
      studentId: student.studentId,
      studentName: student.studentName,
      studentClass: student.studentClass,
      overdueInstallments,
      totalOverdueAmount: studentOverdueAmount,
      totalOverdueAmountDisplay: formatCedis(studentOverdueAmount),
      planStatus: item.planStatus,
      primaryParentPhone: primaryParent ? maskPhone(primaryParent.phone) : null,
      primaryParentName: primaryParent ? primaryParent.parentName : null,
    });
  }

  const sortBy = query.sortBy || "daysOverdue";
  const direction = query.sortOrder === "desc" ? -1 : 1;
  studentsList.sort((a, b) => {
    if (sortBy === "totalOverdueAmount") {
      return (a.totalOverdueAmount - b.totalOverdueAmount) * direction;
    }
    if (sortBy === "studentName" || sortBy === "studentClass") {
      const av = a[sortBy] || "";
      const bv = b[sortBy] || "";
      return av.localeCompare(bv) * direction;
    }
    const maxA = Math.max(...a.overdueInstallments.map((i) => i.daysOverdue), 0);
    const maxB = Math.max(...b.overdueInstallments.map((i) => i.daysOverdue), 0);
    return (maxA - maxB) * direction;
  });

  const page = Number(query.page) || 1;
  const perPage = Number(query.perPage) || 50;
  const skip = (page - 1) * perPage;
  const total = studentsList.length;
  const pagedStudents = studentsList.slice(skip, skip + perPage);

  const result = {
    school: { name: school.name },
    summary: {
      totalOverdue: total,
      totalOverdueAmount,
      totalOverdueAmountDisplay: formatCedis(totalOverdueAmount),
      avgDaysOverdue:
        totalOverdueInstallments > 0
          ? round(totalDaysOverdue / totalOverdueInstallments, 1)
          : 0,
    },
    students: pagedStudents,
    meta: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };

  await auditService.log({
    action: "report.viewed",
    entity: "AnalyticsOverdue",
    entityId: schoolId,
    userId: user._id,
    details: { query },
  });

  return result;
};

// ──────────────────── 7. Cashflow ────────────────────

export const getCashflow = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);

  const horizon = Number(query.horizon) || 90;
  const asOf = query.asOf ? new Date(query.asOf) : new Date();
  const horizonEnd = addDays(asOf, horizon);

  const match = {
    schoolId,
    deletedAt: null,
    planStatus: { $in: ["active", "pending_acceptance"] },
    endDate: { $gte: startOfDayAccra(asOf) },
  };

  if (query.class) {
    const classStudents = await Student.find({
      schoolId,
      studentClass: query.class,
      deletedAt: null,
    }).select("_id");
    match.studentId = { $in: classStudents.map((s) => s._id) };
  }

  const plans = await PaymentPlan.find(match).select(
    "studentId installments startDate endDate planStatus"
  ).lean();

  const buckets = new Map();
  let totalProjected = 0;

  const weeklyBucket = (date) => {
    const d = new Date(date);
    const dayOfWeek = d.getUTCDay();
    const startOfWeek = new Date(d);
    startOfWeek.setUTCDate(d.getUTCDate() - dayOfWeek);
    startOfWeek.setUTCHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setUTCDate(startOfWeek.getUTCDate() + 6);
    endOfWeek.setUTCHours(23, 59, 59, 999);
    return {
      label: `week_${startOfWeek.toISOString().slice(0, 10)}`,
      start: startOfWeek,
      end: endOfWeek,
    };
  };

  const existingBuckets = new Map();

  for (const plan of plans) {
    for (const inst of plan.installments) {
      if (inst.status === "paid" || inst.status === "waived") continue;

      const dueDate = new Date(inst.dueDate);
      if (dueDate < asOf || dueDate > horizonEnd) continue;

      const bucket = weeklyBucket(dueDate);
      const bucketKey = bucket.label;

      if (!existingBuckets.has(bucketKey)) {
        existingBuckets.set(bucketKey, {
          period: bucketKey,
          startDate: bucket.start,
          endDate: bucket.end,
          projected: 0,
          collectedToDate: inst.amountPaid || 0,
          outstanding: 0,
        });
        buckets.set(bucketKey, existingBuckets.get(bucketKey));
      }

      const b = existingBuckets.get(bucketKey);
      const outstanding = inst.amount - (inst.amountPaid || 0);
      b.projected += inst.amount;
      b.collectedToDate += inst.amountPaid || 0;
      b.outstanding += outstanding;
      totalProjected += outstanding;
    }
  }

  let series = Array.from(buckets.values()).sort((a, b) =>
    a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0
  );

  series = series.slice(0, 30);

  const monthlyProjected = totalProjected / Math.max(Math.ceil(horizon / 30), 1);

  const result = {
    school: { name: school.name },
    horizonDays: horizon,
    asOf: asOf.toISOString(),
    summary: {
      projectedInflow: totalProjected,
      projectedInflowDisplay: formatCedis(totalProjected),
      activePlansConsidered: plans.length,
      avgMonthlyInflow: round(monthlyProjected),
      avgMonthlyInflowDisplay: formatCedis(round(monthlyProjected)),
    },
    buckets: series.map((b) => ({
      period: b.period,
      startDate: b.startDate.toISOString(),
      endDate: b.endDate.toISOString(),
      projected: b.projected,
      collectedToDate: b.collectedToDate,
      outstanding: b.outstanding,
      projectedDisplay: formatCedis(b.projected),
      outstandingDisplay: formatCedis(b.outstanding),
    })),
  };

  await auditService.log({
    action: "report.viewed",
    entity: "AnalyticsCashflow",
    entityId: schoolId,
    userId: user._id,
    details: { query },
  });

  return result;
};

// ──────────────────── 7b. Cashflow velocity ────────────────────

export const getCashflowVelocity = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);

  const horizon = Number(query.horizon) || 90;
  const asOf = query.asOf ? new Date(query.asOf) : new Date();
  const horizonEnd = addDays(asOf, horizon);

  const match = {
    schoolId,
    deletedAt: null,
    planStatus: { $in: ["active", "pending_acceptance"] },
    endDate: { $gte: startOfDayAccra(asOf) },
  };

  if (query.class) {
    const classStudents = await Student.find({
      schoolId,
      studentClass: query.class,
      deletedAt: null,
    }).select("_id");
    match.studentId = { $in: classStudents.map((s) => s._id) };
  }

  const plans = await PaymentPlan.find(match).select(
    "studentId installments startDate endDate planStatus"
  ).lean();

  // Same Sunday-anchored weekly bucket as getCashflow, so the two endpoints agree
  // on where a given due date falls.
  const weeklyBucket = (date) => {
    const d = new Date(date);
    const dayOfWeek = d.getUTCDay();
    const startOfWeek = new Date(d);
    startOfWeek.setUTCDate(d.getUTCDate() - dayOfWeek);
    startOfWeek.setUTCHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setUTCDate(startOfWeek.getUTCDate() + 6);
    endOfWeek.setUTCHours(23, 59, 59, 999);
    return {
      label: `week_${startOfWeek.toISOString().slice(0, 10)}`,
      start: startOfWeek,
      end: endOfWeek,
    };
  };

  // Walk the horizon week by week so empty weeks are emitted as explicit zero
  // buckets rather than silently dropped — a gap would let a chart draw a straight
  // line across a quiet week (see adminAnalytics.test.js).
  const seriesMap = new Map();
  const firstWeekStart = weeklyBucket(asOf).start;
  const lastWeekStart = weeklyBucket(horizonEnd).start;
  for (let cursor = new Date(firstWeekStart); cursor <= lastWeekStart; cursor = addDays(cursor, 7)) {
    const label = `week_${cursor.toISOString().slice(0, 10)}`;
    const end = new Date(cursor);
    end.setUTCDate(cursor.getUTCDate() + 6);
    end.setUTCHours(23, 59, 59, 999);
    seriesMap.set(label, {
      period: label,
      startDate: new Date(cursor),
      endDate: end,
      projected: 0,
      collected: 0,
    });
  }

  let totalProjected = 0;
  let totalCollected = 0;
  let paidCount = 0;
  let onTimeCount = 0;
  let daysToPaySum = 0;
  let daysToPayCount = 0;

  for (const plan of plans) {
    for (const inst of plan.installments) {
      const amount = inst.amount || 0;
      const amountPaid = inst.amountPaid || 0;
      totalProjected += amount;
      totalCollected += amountPaid;

      if (inst.status === "paid") {
        paidCount += 1;
        if (inst.paidAt) {
          const paidAt = new Date(inst.paidAt);
          const dueDate = new Date(inst.dueDate);
          if (paidAt <= dueDate) onTimeCount += 1;
          daysToPaySum += (paidAt - dueDate) / 86400000;
          daysToPayCount += 1;
        }
      }

      const dueDate = new Date(inst.dueDate);
      if (dueDate < asOf || dueDate > horizonEnd) continue;

      const bucket = weeklyBucket(dueDate);
      const b = seriesMap.get(bucket.label);
      if (!b) continue;
      b.projected += amount;
      b.collected += amountPaid;
    }
  }

  const collectionVelocity =
    totalProjected === 0 ? 0 : round(totalCollected / totalProjected);
  const averageDaysToPay =
    daysToPayCount === 0 ? 0 : round(daysToPaySum / daysToPayCount, 1);
  const onTimeRate = paidCount === 0 ? 0 : round(onTimeCount / paidCount);

  const series = Array.from(seriesMap.values()).sort((a, b) =>
    a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0
  );

  const result = {
    school: { name: school.name },
    horizonDays: horizon,
    asOf: asOf.toISOString(),
    summary: {
      projectedInflow: totalProjected,
      projectedInflowDisplay: formatCedis(totalProjected),
      collectedToDate: totalCollected,
      collectedToDateDisplay: formatCedis(totalCollected),
      collectionVelocity,
      averageDaysToPay,
      onTimeRate,
      activePlansConsidered: plans.length,
    },
    series: series.map((b) => ({
      period: b.period,
      startDate: b.startDate.toISOString(),
      endDate: b.endDate.toISOString(),
      projected: b.projected,
      collected: b.collected,
      velocity: b.projected === 0 ? 0 : round(b.collected / b.projected),
    })),
  };

  await auditService.log({
    action: "report.viewed",
    entity: "AnalyticsCashflowVelocity",
    entityId: schoolId,
    userId: user._id,
    details: { query },
  });

  return result;
};

// ──────────────────── 8. Compliance ────────────────────

export const getCompliance = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);

  const match = {
    schoolId,
    deletedAt: null,
    planStatus: { $in: ACTIVE_PLAN_STATUSES },
  };

  if (query.class) {
    const classStudents = await Student.find({
      schoolId,
      studentClass: query.class,
      deletedAt: null,
    }).select("_id");
    match.studentId = { $in: classStudents.map((s) => s._id) };
  }

  const plans = await PaymentPlan.find(match).select(
    "planStatus installments studentId"
  ).lean();

  const now = new Date();
  const windowEnd = endOfDayAccra(addDays(now, 3));

  const summary = {
    overallComplianceRate: 0,
    totalPlans: plans.length,
    activePlans: 0,
    completedPlans: 0,
    overduePlans: 0,
    defaultedPlans: 0,
    pendingAcceptancePlans: 0,
    onTrack: 0,
    approachingDue: 0,
  };

  let totalInstallments = 0;
  let paidOnTime = 0;

  const monthlyTrend = new Map();

  for (const plan of plans) {
    let bucket;
    if (plan.planStatus === "completed") {
      bucket = "completed";
    } else if (plan.planStatus === "defaulted") {
      bucket = "defaulted";
    } else if (plan.planStatus === "pending_acceptance") {
      bucket = "pending_acceptance";
    } else if (plan.planStatus === "active") {
      const hasOverdue = plan.installments.some((i) => i.status === "overdue");
      if (hasOverdue) {
        bucket = "overdue";
      } else {
        const next = plan.installments
          .filter((i) => i.status !== "paid" && i.status !== "waived")
          .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0];
        if (next && new Date(next.dueDate).getTime() <= windowEnd.getTime()) {
          bucket = "approaching_due";
          summary.approachingDue += 1;
        } else {
          bucket = "on_track";
          summary.onTrack += 1;
        }
      }
    } else {
      bucket = "other";
    }

    if (bucket === "completed") summary.completedPlans += 1;
    else if (bucket === "defaulted") summary.defaultedPlans += 1;
    else if (bucket === "pending_acceptance") summary.pendingAcceptancePlans += 1;
    else if (bucket === "overdue") summary.overduePlans += 1;
    else if (bucket === "on_track") summary.activePlans += 1;
    else if (bucket === "approaching_due") summary.activePlans += 1;

    for (const inst of plan.installments) {
      totalInstallments += 1;
      const monthKey = new Date(inst.dueDate).toISOString().slice(0, 7);
      if (!monthlyTrend.has(monthKey)) {
        monthlyTrend.set(monthKey, {
          period: monthKey,
          total: 0,
          paid: 0,
          onTrack: 0,
          approachingDue: 0,
          overdue: 0,
          completed: 0,
          defaulted: 0,
        });
      }
      const mb = monthlyTrend.get(monthKey);
      mb.total += 1;
      if (inst.status === "paid") {
        mb.paid += 1;
        if (new Date(inst.paidAt || inst.dueDate).getTime() <= new Date(inst.dueDate).getTime()) {
          paidOnTime += 1;
        }
      } else if (inst.status === "waived") {
        mb.paid += 1;
        paidOnTime += 1;
      } else if (inst.status === "overdue") {
        mb.overdue += 1;
      } else if (inst.status === "pending" || inst.status === "partial") {
        const next = new Date(inst.dueDate);
        if (next.getTime() <= windowEnd.getTime()) {
          mb.approachingDue += 1;
        } else {
          mb.onTrack += 1;
        }
      }
    }
  }

  summary.overallComplianceRate = rate(paidOnTime, totalInstallments);

  const trend = Array.from(monthlyTrend.values()).sort((a, b) =>
    a.period < b.period ? -1 : a.period > b.period ? 1 : 0
  );

  const result = {
    school: { name: school.name },
    summary,
    trend,
  };

  await auditService.log({
    action: "report.viewed",
    entity: "AnalyticsCompliance",
    entityId: schoolId,
    userId: user._id,
    details: { query },
  });

  return result;
};

// ──────────────────── 9. Default Rate ────────────────────

export const getDefaultRate = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);

  const now = new Date();

  const match = {
    schoolId,
    deletedAt: null,
    planStatus: { $in: ACTIVE_PLAN_STATUSES },
    endDate: { $lte: now },
  };

  if (query.academicYear) {
    // Filter by startDate falling within the academic year
  }

  const plans = await PaymentPlan.find(match).select(
    "planStatus installments startDate endDate"
  ).lean();

  const maturedPlans = plans.length;
  let defaultedPlans = 0;
  let totalMissed = 0;

  const termTrend = new Map();

  for (const plan of plans) {
    const isDefaulted = plan.planStatus === "defaulted";
    if (isDefaulted) {
      defaultedPlans += 1;
      const missed = plan.installments.filter((i) => i.status === "overdue").length;
      totalMissed += missed;
    }

    const startDate = new Date(plan.startDate);
    const periodKey = startDate.toISOString().slice(0, 7); // YYYY-MM
    if (!termTrend.has(periodKey)) {
      termTrend.set(periodKey, {
        period: periodKey,
        defaultedPlans: 0,
        maturedPlans: 0,
      });
    }
    const entry = termTrend.get(periodKey);
    entry.maturedPlans += 1;
    if (isDefaulted) entry.defaultedPlans += 1;
  }

  const trend = Array.from(termTrend.values())
    .map((e) => ({
      ...e,
      defaultRate: rate(e.defaultedPlans, e.maturedPlans),
    }))
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));

  const result = {
    school: { name: school.name },
    summary: {
      defaultedPlans,
      maturedPlans,
      defaultRate: rate(defaultedPlans, maturedPlans),
      avgMissedInstallments:
        defaultedPlans > 0
          ? round(totalMissed / defaultedPlans, 2)
          : 0,
    },
    trend,
  };

  await auditService.log({
    action: "report.viewed",
    entity: "AnalyticsDefaultRate",
    entityId: schoolId,
    userId: user._id,
    details: { query },
  });

  return result;
};

// ──────────────────── 10. Class Performance ────────────────────

export const getClassPerformance = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await fetchSchool(schoolId);

  const pipeline = [
    {
      $match: {
        schoolId,
        deletedAt: null,
        status: "active",
      },
    },
    {
      $group: {
        _id: "$studentClass",
        studentCount: { $sum: 1 },
        totalOwed: { $sum: "$totalOwed" },
        totalPaid: { $sum: "$totalPaid" },
      },
    },
    { $sort: { _id: 1 } },
  ];

  const results = await Student.aggregate(pipeline);

  const classes = results.map((r) => {
    const totalOwed = r.totalOwed || 0;
    const totalPaid = r.totalPaid || 0;
    return {
      className: r._id,
      studentCount: r.studentCount,
      totalOwed,
      totalPaid,
      balance: Math.max(totalOwed - totalPaid, 0),
      collectionRate: rate(totalPaid, totalOwed),
      totalOwedDisplay: formatCedis(totalOwed),
      totalPaidDisplay: formatCedis(totalPaid),
      balanceDisplay: formatCedis(Math.max(totalOwed - totalPaid, 0)),
    };
  });

  classes.sort((a, b) => a.collectionRate - b.collectionRate);

  const result = {
    school: { name: school.name },
    classes,
  };

  await auditService.log({
    action: "report.viewed",
    entity: "AnalyticsClassPerformance",
    entityId: schoolId,
    userId: user._id,
    details: { query },
  });

  return result;
};

export { ApiError };
