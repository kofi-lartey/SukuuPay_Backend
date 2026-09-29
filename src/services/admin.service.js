import mongoose from "mongoose";
import { School } from "../models/schoolModel.js";
import { User } from "../models/userModel.js";
import { Payment } from "../models/paymentModel.js";
import { AuditLog } from "../models/AuditLog.js";
import ApiError from "../utils/ApiError.js";
import { AUDIT_ACTIONS } from "../config/constants.js";
import {
  suspendSchool,
  unsuspendSchool,
} from "./school.service.js";

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// ──────────────────── List all schools (platform view) ────────────────────
export const listAllSchools = async (query) => {
  const {
    page = 1,
    perPage = 20,
    status,
    region,
    plan,
    search,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = query;

  const filter = { deletedAt: null };
  if (status) filter.status = status;
  if (region) filter.region = region;
  if (plan) filter["subscription.plan"] = plan;
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { schoolCode: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
      { city: { $regex: search, $options: "i" } },
    ];
  }

  const sort = { [sortBy]: sortOrder === "desc" ? -1 : 1 };
  const skip = (Number(page) - 1) * Number(perPage);

  const [schools, total] = await Promise.all([
    School.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(Number(perPage))
      .select("-payment.hubtelApiKey -payment.hubtelClientSecret -sms.apiKey")
      .lean(),
    School.countDocuments(filter),
  ]);

  const schoolIds = schools.map((s) => s._id);
  const schoolIdObjs = schoolIds.map((id) => new mongoose.Types.ObjectId(id));

  const [studentCounts, paymentVolume, userCounts] = await Promise.all([
    User.aggregate([
      { $match: { schoolId: { $in: schoolIdObjs }, role: "student", deletedAt: null } },
      { $group: { _id: "$schoolId", count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      {
        $match: {
          schoolId: { $in: schoolIdObjs },
          status: "completed",
          deletedAt: null,
        },
      },
      { $group: { _id: "$schoolId", totalAmount: { $sum: "$amount" } } },
    ]),
    User.aggregate([
      { $match: { schoolId: { $in: schoolIdObjs }, role: { $in: ["school_admin", "accountant", "teacher"] }, deletedAt: null } },
      { $group: { _id: "$schoolId", count: { $sum: 1 } } },
    ]),
  ]);

  const studentCountMap = new Map();
  studentCounts.forEach((entry) => studentCountMap.set(String(entry._id), entry.count));

  const paymentVolumeMap = new Map();
  paymentVolume.forEach((entry) => paymentVolumeMap.set(String(entry._id), entry.totalAmount));

  const userCountMap = new Map();
  userCounts.forEach((entry) => userCountMap.set(String(entry._id), entry.count));

  const schoolsWithStats = schools.map((school) => ({
    ...school,
    studentCount: studentCountMap.get(String(school._id)) || 0,
    staffCount: userCountMap.get(String(school._id)) || 0,
    paymentVolume: paymentVolumeMap.get(String(school._id)) || 0,
  }));

  return {
    data: schoolsWithStats,
    meta: {
      page: Number(page),
      perPage: Number(perPage),
      total,
      pages: Math.ceil(total / Number(perPage)),
    },
  };
};

// ──────────────────── Platform-wide revenue ────────────────────
export const getPlatformRevenue = async (query) => {
  const {
    startDate,
    endDate,
    period = "all",
    plan,
    region,
  } = query;

  const matchFilter = { status: "completed", deletedAt: null };

  if (startDate) {
    matchFilter.createdAt = { ...matchFilter.createdAt, $gte: new Date(startDate) };
  }
  if (endDate) {
    matchFilter.createdAt = { ...matchFilter.createdAt, $lte: new Date(endDate) };
  }

  let dateRanges = null;
  const now = new Date();

  if (period === "mtd") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    dateRanges = { gte: start, lte: now };
  } else if (period === "ytd") {
    const start = new Date(now.getFullYear(), 0, 1);
    dateRanges = { gte: start, lte: now };
  } else if (period === "last30") {
    const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    dateRanges = { gte: start, lte: now };
  }

  if (dateRanges) {
    matchFilter.createdAt = {
      ...(matchFilter.createdAt || {}),
      $gte: dateRanges.gte,
      $lte: dateRanges.lte,
    };
  }

  const basePipeline = [{ $match: matchFilter }];

  const schoolLookup = {
    $lookup: {
      from: "schools",
      localField: "schoolId",
      foreignField: "_id",
      as: "school",
    },
  };

  const unwindSchool = { $unwind: "$school" };

  const schoolMatch = {};
  if (plan) schoolMatch["school.subscription.plan"] = plan;
  if (region) schoolMatch["school.region"] = region;

  if (Object.keys(schoolMatch).length) {
    basePipeline.push(schoolLookup, unwindSchool, { $match: schoolMatch });
  }

  const [revenueResult, platformMarkupResult] = await Promise.all([
    Payment.aggregate([
      ...basePipeline,
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$amount" },
          totalPayments: { $sum: 1 },
          avgPayment: { $avg: "$amount" },
        },
      },
    ]),
    Payment.aggregate([
      ...basePipeline,
      {
        $lookup: {
          from: "schools",
          localField: "schoolId",
          foreignField: "_id",
          as: "school",
        },
      },
      { $unwind: "$school" },
      {
        $addFields: {
          markupAmount: {
            $multiply: [
              { $divide: ["$amount", 100] },
              { $ifNull: ["$school.payment.platformMarkupPercent", 0] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          totalMarkup: { $sum: "$markupAmount" },
        },
      },
    ]),
  ]);

  const totalRevenue = revenueResult[0]?.totalRevenue || 0;
  const totalMarkup = platformMarkupResult[0]?.totalMarkup || 0;

  return {
    summary: {
      totalRevenue,
      totalPayments: revenueResult[0]?.totalPayments || 0,
      avgPayment: revenueResult[0]?.avgPayment || 0,
      platformMarkupRevenue: Math.round(totalMarkup),
    },
    filters: {
      period: period === "all" ? "all" : period,
      startDate: startDate || null,
      endDate: endDate || null,
      plan: plan || null,
      region: region || null,
    },
  };
};

// ──────────────────── Platform-wide SMS balance ────────────────────
export const getPlatformSmsBalance = async () => {
  const [schoolSms, userCounts] = await Promise.all([
    School.aggregate([
      { $match: { deletedAt: null } },
      {
        $group: {
          _id: null,
          totalBalance: { $sum: "$sms.balance" },
          totalSchools: { $sum: 1 },
          providerBreakdown: {
            $push: {
              provider: "$sms.provider",
              balance: "$sms.balance",
            },
          },
        },
      },
    ]),
    User.aggregate([
      { $match: { deletedAt: null, role: "student" } },
      { $count: "totalStudents" },
    ]),
  ]);

  const result = schoolSms[0];

  return {
    totalBalance: result?.totalBalance || 0,
    totalSchools: result?.totalSchools || 0,
  };
};

// ──────────────────── School usage stats ────────────────────
export const getSchoolUsage = async (schoolId) => {
  if (!isValidObjectId(schoolId)) {
    throw new ApiError("Invalid school ID", 400, "INVALID_ID");
  }

  const school = await School.findOne({ _id: schoolId, deletedAt: null }).select(
    "name schoolCode subscription stats sms"
  ).lean();

  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  const schoolObjId = new mongoose.Types.ObjectId(schoolId);

  const [
    studentCount,
    staffCount,
    parentCount,
    paymentStats,
    pendingPlanCount,
    recentAuditLogs,
  ] = await Promise.all([
    User.countDocuments({ schoolId: schoolObjId, role: "student", deletedAt: null }),
    User.countDocuments({
      schoolId: schoolObjId,
      role: { $in: ["school_admin", "accountant", "teacher"] },
      deletedAt: null,
    }),
    User.countDocuments({ schoolId: schoolObjId, role: "parent", deletedAt: null }),
    Payment.aggregate([
      { $match: { schoolId: schoolObjId, deletedAt: null } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
    ]),
    Payment.countDocuments({
      schoolId: schoolObjId,
      status: { $in: ["pending", "processing"] },
      deletedAt: null,
    }),
    AuditLog.find({ schoolId: schoolObjId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
  ]);

  const statusBreakdown = {};
  let totalRevenueAll = 0;
  let totalPending = 0;

  paymentStats.forEach((entry) => {
    statusBreakdown[entry._id] = {
      count: entry.count,
      amount: entry.totalAmount,
    };
    if (entry._id === "completed") {
      totalRevenueAll += entry.totalAmount;
    }
    if (entry._id === "pending" || entry._id === "processing") {
      totalPending += entry.totalAmount;
    }
  });

  return {
    school: {
      _id: school._id,
      name: school.name,
      schoolCode: school.schoolCode,
      status: school.status,
      subscription: school.subscription,
      sms: {
        provider: school.sms.provider,
        balance: school.sms.balance,
        senderId: school.sms.senderId,
      },
    },
    counts: {
      students: studentCount,
      staff: staffCount,
      parents: parentCount,
    },
    payments: {
      totalRevenue: totalRevenueAll,
      statusBreakdown,
      pendingAmount: totalPending,
      pendingPlans: pendingPlanCount,
    },
    stats: school.stats || {},
    recentActivity: recentAuditLogs,
  };
};

// ──────────────────── Suspend school (platform admin) ────────────────────
export const suspendSchoolPlatform = async (schoolId, reason, requester) => {
  return suspendSchool(schoolId, reason, requester);
};

// ──────────────────── Unsuspend school (platform admin) ────────────────────
export const unsuspendSchoolPlatform = async (schoolId, requester) => {
  return unsuspendSchool(schoolId, requester);
};

// ──────────────────── Dashboard KPIs ────────────────────
export const getDashboardKpis = async () => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  const [
    schoolStats,
    userStats,
    paymentStats,
    mtdRevenue,
    ytdRevenue,
    platformMarkup,
    pendingPayouts,
    smsBalance,
    recentSchools,
  ] = await Promise.all([
    School.aggregate([
      { $match: { deletedAt: null } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
          suspended: { $sum: { $cond: [{ $eq: ["$status", "suspended"] }, 1, 0] } },
          archived: { $sum: { $cond: [{ $eq: ["$status", "archived"] }, 1, 0] } },
          trial: { $sum: { $cond: [{ $eq: ["$subscription.status", "trial"] }, 1, 0] } },
          paid: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ["$subscription.status", "trial"] }, { $ne: ["$subscription.status", "suspended"] }, { $ne: ["$subscription.status", "cancelled"] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    User.aggregate([
      { $match: { deletedAt: null } },
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          totalStudents: { $sum: { $cond: [{ $eq: ["$role", "student"] }, 1, 0] } },
          totalStaff: {
            $sum: {
              $cond: [
                { $in: ["$role", ["school_admin", "accountant", "teacher"]] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    Payment.aggregate([
      { $match: { deletedAt: null, status: "completed" } },
      {
        $group: {
          _id: null,
          totalPayments: { $sum: 1 },
          totalRevenue: { $sum: "$amount" },
        },
      },
    ]),
    Payment.aggregate([
      {
        $match: {
          deletedAt: null,
          status: "completed",
          createdAt: { $gte: startOfMonth, $lte: now },
        },
      },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),
    Payment.aggregate([
      {
        $match: {
          deletedAt: null,
          status: "completed",
          createdAt: { $gte: startOfYear, $lte: now },
        },
      },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),
    Payment.aggregate([
      {
        $match: { deletedAt: null, status: "completed" },
      },
      {
        $lookup: {
          from: "schools",
          localField: "schoolId",
          foreignField: "_id",
          as: "school",
        },
      },
      { $unwind: "$school" },
      {
        $addFields: {
          markup: {
            $multiply: [
              { $divide: ["$amount", 100] },
              { $ifNull: ["$school.payment.platformMarkupPercent", 0] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          totalMarkup: { $sum: "$markup" },
        },
      },
    ]),
    Payment.aggregate([
      { $match: { deletedAt: null, status: "pending" } },
      {
        $group: {
          _id: null,
          amount: { $sum: "$amount" },
        },
      },
    ]),
    School.aggregate([
      { $match: { deletedAt: null } },
      {
        $group: {
          _id: null,
          total: { $sum: "$sms.balance" },
        },
      },
    ]),
    School.find({ deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(5)
      .select("name schoolCode status subscription createdAt")
      .lean(),
  ]);

  return {
    schools: {
      total: schoolStats[0]?.total || 0,
      active: schoolStats[0]?.active || 0,
      suspended: schoolStats[0]?.suspended || 0,
      archived: schoolStats[0]?.archived || 0,
      onTrial: schoolStats[0]?.trial || 0,
      paid: schoolStats[0]?.paid || 0,
    },
    users: {
      total: userStats[0]?.totalUsers || 0,
      students: userStats[0]?.totalStudents || 0,
      staff: userStats[0]?.totalStaff || 0,
    },
    payments: {
      totalCompleted: paymentStats[0]?.totalPayments || 0,
      totalRevenue: paymentStats[0]?.totalRevenue || 0,
      mtdRevenue: mtdRevenue[0]?.revenue || 0,
      mtdCount: mtdRevenue[0]?.count || 0,
      ytdRevenue: ytdRevenue[0]?.revenue || 0,
      ytdCount: ytdRevenue[0]?.count || 0,
      platformMarkup: Math.round(platformMarkup[0]?.totalMarkup || 0),
      pendingPayouts: pendingPayouts[0]?.amount || 0,
    },
    sms: {
      totalBalance: smsBalance[0]?.total || 0,
    },
    recentSchools,
  };
};
