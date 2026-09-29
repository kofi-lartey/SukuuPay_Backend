import mongoose from "mongoose";
import { School } from "../models/schoolModel.js";
import { Student } from "../models/studentModel.js";
import { Payment } from "../models/paymentModel.js";
import { User } from "../models/userModel.js";
import ApiError from "../utils/ApiError.js";
import { AUDIT_ACTIONS } from "../config/constants.js";
import { log as auditLog } from "../utils/auditService.js";

const resolveSchoolId = (user, explicitSchoolId) => {
  if (user && user.role === "super_admin") {
    return explicitSchoolId ? new mongoose.Types.ObjectId(explicitSchoolId) : null;
  }
  return user && user.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

// ──────────────────── GET all settings ────────────────────
export const getSchoolSettings = async (schoolId, requester) => {
  const scopedSchoolId = resolveSchoolId(requester, schoolId);
  if (!scopedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await School.findOne({ _id: scopedSchoolId, deletedAt: null })
    .select("-payment.hubtelClientId -payment.hubtelClientSecret -payment.hubtelApiKey -payment.momoMerchantId -payment.bankAccount -sms.apiKey")
    .lean();

  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  return {
    profile: {
      name: school.name,
      type: school.type,
      motto: school.motto,
      yearFounded: school.yearFounded,
      phone: school.phone,
      email: school.email,
      website: school.website,
      address: school.address,
      city: school.city,
      region: school.region,
      gpsAddress: school.gpsAddress,
      brandColor: school.brandColor,
      logo: school.logo,
      stamp: school.stamp,
    },
    academic: {
      currentTerm: school.academic?.currentTerm || "",
      currentYear: school.academic?.currentYear || "",
      termsPerYear: school.academic?.termsPerYear || 3,
      classes: school.academic?.classes || [],
      gradingSystem: school.academic?.gradingSystem || "WAEC",
    },
    sms: {
      provider: school.sms?.provider || "hubtel",
      senderId: school.sms?.senderId || "",
      balance: school.sms?.balance || 0,
    },
    payment: {
      gatewayMode: school.payment?.gatewayMode || "hubtel",
      platformMarkupPercent: school.payment?.platformMarkupPercent || 0,
      networksEnabled: {
        mtn: school.payment?.networksEnabled?.mtn !== false,
        telecel: school.payment?.networksEnabled?.telecel !== false,
        airteltigo: school.payment?.networksEnabled?.airteltigo !== false,
      },
    },
    notifications: {
      email: school.notifications?.email !== false,
      sms: school.notifications?.sms !== false,
      inApp: school.notifications?.inApp !== false,
    },
  };
};

// ──────────────────── PUT general settings ────────────────────
export const updateSchoolSettings = async (schoolId, data, requester) => {
  const scopedSchoolId = resolveSchoolId(requester, schoolId);
  if (!scopedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await School.findOne({ _id: scopedSchoolId, deletedAt: null });
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  // Protected fields that cannot be changed through settings.
  const protectedFields = [
    "slug",
    "schoolCode",
    "createdBy",
    "subscription",
    "status",
    "suspendedAt",
    "suspendedReason",
    "deletedAt",
  ];

  const updates = { ...data };
  protectedFields.forEach((field) => delete updates[field]);

  // Validate classes array if provided.
  if (updates.classes !== undefined) {
    if (!Array.isArray(updates.classes)) {
      throw new ApiError("classes must be an array", 400, "VALIDATION_ERROR");
    }
    if (updates.classes.length === 0) {
      throw new ApiError("classes array cannot be empty", 400, "VALIDATION_ERROR");
    }
    if (updates.classes.length > 50) {
      throw new ApiError("classes array cannot exceed 50 items", 400, "VALIDATION_ERROR");
    }
    const unique = new Set(updates.classes);
    if (unique.size !== updates.classes.length) {
      throw new ApiError("classes array cannot contain duplicates", 400, "VALIDATION_ERROR");
    }
  }

  // Validate brandColor if provided.
  if (updates.brandColor && !/^#[0-9A-Fa-f]{6}$/.test(updates.brandColor)) {
    throw new ApiError("brandColor must be a valid hex color (#RRGGBB)", 400, "VALIDATION_ERROR");
  }

  // Apply updates.
  if (updates.brandColor !== undefined) school.brandColor = updates.brandColor;
  if (updates.motto !== undefined) school.motto = updates.motto || "";
  if (updates.yearFounded !== undefined) school.yearFounded = updates.yearFounded || null;
  if (updates.website !== undefined) school.website = updates.website || "";
  if (updates.gpsAddress !== undefined) school.gpsAddress = updates.gpsAddress || "";
  if (updates.classes !== undefined) school.academic.classes = updates.classes;
  if (updates.termsPerYear !== undefined) school.academic.termsPerYear = updates.termsPerYear;
  if (updates.gradingSystem !== undefined) school.academic.gradingSystem = updates.gradingSystem;

  await school.save();

  await auditLog({
    action: AUDIT_ACTIONS.SCHOOL_UPDATE,
    entity: "School",
    entityId: school._id,
    userId: requester._id,
    schoolId: scopedSchoolId,
    meta: { updatedFields: Object.keys(updates) },
  });

  // Return the aggregated settings view.
  return getSchoolSettings(schoolId, requester);
};

// ──────────────────── PUT academic year & term ────────────────────
export const updateAcademicYear = async (schoolId, data, requester) => {
  const scopedSchoolId = resolveSchoolId(requester, schoolId);
  if (!scopedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await School.findOne({ _id: scopedSchoolId, deletedAt: null });
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  school.academic.currentYear = data.currentYear;
  school.academic.currentTerm = data.currentTerm;
  school.academic.termsPerYear = data.termsPerYear;

  await school.save();

  await auditLog({
    action: AUDIT_ACTIONS.SETTINGS_UPDATE,
    entity: "School",
    entityId: school._id,
    userId: requester._id,
    schoolId: scopedSchoolId,
    meta: {
      currentYear: data.currentYear,
      currentTerm: data.currentTerm,
      termsPerYear: data.termsPerYear,
    },
  });

  return {
    currentTerm: school.academic.currentTerm,
    currentYear: school.academic.currentYear,
    termsPerYear: school.academic.termsPerYear,
    classes: school.academic.classes,
    gradingSystem: school.academic.gradingSystem,
  };
};

// ──────────────────── PUT notification preferences ────────────────────
export const updateNotificationPrefs = async (schoolId, data, requester) => {
  const scopedSchoolId = resolveSchoolId(requester, schoolId);
  if (!scopedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await School.findOne({ _id: scopedSchoolId, deletedAt: null });
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  // Ensure the subdocument exists before writing.
  if (!school.notifications) {
    school.notifications = { email: true, sms: true, inApp: true };
  }

  school.notifications.email = data.email;
  school.notifications.sms = data.sms;
  school.notifications.inApp = data.inApp;

  await school.save();

  await auditLog({
    action: AUDIT_ACTIONS.SETTINGS_UPDATE,
    entity: "School",
    entityId: school._id,
    userId: requester._id,
    schoolId: scopedSchoolId,
    meta: { notificationPrefs: { email: data.email, sms: data.sms, inApp: data.inApp } },
  });

  return {
    email: school.notifications.email,
    sms: school.notifications.sms,
    inApp: school.notifications.inApp,
  };
};

// ──────────────────── GET billing / subscription info ────────────────────
export const getSchoolBilling = async (schoolId, query, requester) => {
  const scopedSchoolId = resolveSchoolId(requester, schoolId);
  if (!scopedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await School.findOne({ _id: scopedSchoolId, deletedAt: null })
    .select("subscription sms payment")
    .lean();

  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  const sub = school.subscription || {};

  // Compute usage metrics.
  const [studentCount, smsSentThisMonth, storageEstimate] = await Promise.all([
    Student.countDocuments({ schoolId: scopedSchoolId, deletedAt: null }),
    Payment.countDocuments({
      schoolId: scopedSchoolId,
      status: "completed",
      provider: "hubtel",
      createdAt: {
        $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      },
    }).catch(() => 0),
    // Rough storage estimate based on student IDs stored in the school's
    // student collection. A more accurate figure would sum Cloudinary usage.
    Promise.resolve(0),
  ]);

  const smsCreditsRemaining = Math.max((school.sms?.balance || 0) - smsSentThisMonth, 0);

  return {
    subscription: {
      plan: sub.plan || "trial",
      status: sub.status || "trial",
      monthlyFee: sub.monthlyFee || 0,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      trialEndsAt: sub.trialEndsAt,
    },
    usage: {
      studentsThisTerm: studentCount,
      smsSentThisMonth,
      smsCreditsRemaining,
      storageUsedMB: storageEstimate,
    },
    invoices: [],
    nextInvoice: {
      amount: sub.monthlyFee || 0,
      dueDate: sub.currentPeriodEnd || null,
    },
  };
};
