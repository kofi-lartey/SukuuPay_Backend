import mongoose from "mongoose";
import { School } from "../models/schoolModel.js";
import { User } from "../models/userModel.js";
import { generateSchoolCode, generateUniqueSlug, validateGhanaPhone } from "../utils/generateCode.js";

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

export const createSchool = async (data, createdBy, stampUrl = null) => {
  const { email, phone } = data;

  const existingEmail = await School.findOne({ email });
  if (existingEmail) {
    throw new ApiError("A school with this email already exists", 409, "DUPLICATE_EMAIL");
  }

  const validatedPhone = validateGhanaPhone(phone);
  if (!validatedPhone) {
    throw new ApiError("Invalid Ghana phone number format", 400, "INVALID_PHONE");
  }

  const slug = await generateUniqueSlug(data.name);
  const schoolCode = await generateSchoolCode(data.name);

  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 30);

  const school = await School.create({
    ...data,
    phone: validatedPhone,
    slug,
    schoolCode,
    createdBy,
    status: "active",
    stamp: stampUrl,
    subscription: {
      plan: "trial",
      status: "trial",
      trialEndsAt,
      currentPeriodStart: new Date(),
      currentPeriodEnd: trialEndsAt,
    },
  });

  await auditService.log({
    action: "CREATE",
    entity: "School",
    entityId: school._id,
    userId: createdBy,
    details: { name: school.name, schoolCode: school.schoolCode },
  });

  return school.toJSON();
};

export const listSchools = async (query) => {
  const {
    page = 1,
    perPage = 20,
    status,
    region,
    search,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = query;

  const filter = { deletedAt: null };
  if (status) filter.status = status;
  if (region) filter.region = region;
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { schoolCode: { $regex: search, $options: "i" } },
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
      .select("-payment.hubtelApiKey -payment.hubtelClientSecret -sms.apiKey"),
    School.countDocuments(filter),
  ]);

  const schoolsWithCounts = schools.map((school) => {
    const obj = school.toJSON();
    return {
      ...obj,
      studentCount: obj.stats?.totalStudents || 0,
    };
  });

  return {
    data: schoolsWithCounts,
    meta: {
      page: Number(page),
      perPage: Number(perPage),
      total,
      pages: Math.ceil(total / Number(perPage)),
    },
  };
};

export const getSchoolById = async (schoolId, requester) => {
  if (!mongoose.Types.ObjectId.isValid(schoolId)) {
    throw new ApiError("Invalid school ID", 400, "INVALID_ID");
  }

  const school = await School.findOne({ _id: schoolId, deletedAt: null })
    .select("-payment.hubtelApiKey -payment.hubtelClientSecret -sms.apiKey")
    .lean();

  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  if (requester.role !== "super_admin" && requester.schoolId?.toString() !== schoolId) {
    throw new ApiError("You do not have access to this school", 403, "FORBIDDEN");
  }

  const [studentCount, activePlansCount, paymentsThisMonth] = await Promise.all([
    User.countDocuments({ schoolId, role: "student", deletedAt: null }),
    User.countDocuments({ schoolId, role: { $in: ["school_admin", "accountant", "teacher"] }, status: "active", deletedAt: null }),
    User.countDocuments({
      schoolId,
      "paymentRecords.0": { $exists: true },
      createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
      deletedAt: null,
    }).catch(() => 0),
  ]);

  return {
    ...school,
    studentCount,
    activePlansCount,
    paymentsThisMonth,
  };
};

export const updateSchool = async (schoolId, data, requester) => {
  if (!mongoose.Types.ObjectId.isValid(schoolId)) {
    throw new ApiError("Invalid school ID", 400, "INVALID_ID");
  }

  const school = await School.findOne({ _id: schoolId, deletedAt: null });
  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  if (requester.role !== "super_admin" && requester.schoolId?.toString() !== schoolId) {
    throw new ApiError("You do not have access to this school", 403, "FORBIDDEN");
  }

  const protectedFields = ["slug", "schoolCode", "createdBy", "stats", "subscription", "status", "suspendedReason", "suspendedAt", "deletedAt"];
  const updates = { ...data };

  protectedFields.forEach((field) => {
    delete updates[field];
  });

  if (updates.email && updates.email !== school.email) {
    const emailConflict = await School.findOne({ email: updates.email, _id: { $ne: schoolId } });
    if (emailConflict) {
      throw new ApiError("A school with this email already exists", 409, "DUPLICATE_EMAIL");
    }
  }

  if (updates.phone) {
    const validatedPhone = validateGhanaPhone(updates.phone);
    if (!validatedPhone) {
      throw new ApiError("Invalid Ghana phone number format", 400, "INVALID_PHONE");
    }
    updates.phone = validatedPhone;
  }

  if (updates.name && updates.name !== school.name) {
    updates.slug = await generateUniqueSlug(updates.name);
  }

  Object.keys(updates).forEach((key) => {
    if (key.startsWith("academic.")) {
      const subKey = key.split(".")[1];
      school.academic[subKey] = updates[key];
    } else {
      school[key] = updates[key];
    }
  });

  await school.save();

  await auditService.log({
    action: "UPDATE",
    entity: "School",
    entityId: school._id,
    userId: requester._id,
    details: { updatedFields: Object.keys(updates) },
  });

  return school.toJSON();
};

export const updateSchoolLogo = async (schoolId, logoUrl, oldLogoUrl, requester) => {
  if (!mongoose.Types.ObjectId.isValid(schoolId)) {
    throw new ApiError("Invalid school ID", 400, "INVALID_ID");
  }

  const school = await School.findOne({ _id: schoolId, deletedAt: null });
  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  if (requester.role !== "super_admin" && requester.schoolId?.toString() !== schoolId) {
    throw new ApiError("You do not have access to this school", 403, "FORBIDDEN");
  }

  school.logo = logoUrl;
  await school.save();

  await auditService.log({
    action: "UPDATE_LOGO",
    entity: "School",
    entityId: school._id,
    userId: requester._id,
    details: { oldLogo: oldLogoUrl, newLogo: logoUrl },
  });

  return { logo: school.logo };
};

export const updateSchoolStamp = async (schoolId, stampUrl, oldStampUrl, requester) => {
  if (!mongoose.Types.ObjectId.isValid(schoolId)) {
    throw new ApiError("Invalid school ID", 400, "INVALID_ID");
  }

  const school = await School.findOne({ _id: schoolId, deletedAt: null });
  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  if (requester.role !== "super_admin" && requester.schoolId?.toString() !== schoolId) {
    throw new ApiError("You do not have access to this school", 403, "FORBIDDEN");
  }

  school.stamp = stampUrl;
  await school.save();

  await auditService.log({
    action: "UPDATE_STAMP",
    entity: "School",
    entityId: school._id,
    userId: requester._id,
    details: { oldStamp: oldStampUrl, newStamp: stampUrl },
  });

  return { stamp: school.stamp };
};

export const suspendSchool = async (schoolId, reason, requester) => {
  if (requester.role !== "super_admin") {
    throw new ApiError("Only super admins can suspend schools", 403, "FORBIDDEN");
  }

  if (!mongoose.Types.ObjectId.isValid(schoolId)) {
    throw new ApiError("Invalid school ID", 400, "INVALID_ID");
  }

  const school = await School.findOne({ _id: schoolId, deletedAt: null });
  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  if (school.status === "suspended") {
    throw new ApiError("School is already suspended", 400, "ALREADY_SUSPENDED");
  }

  if (school.status === "archived") {
    throw new ApiError("Cannot suspend an archived school", 400, "INVALID_ACTION");
  }

  school.status = "suspended";
  school.suspendedReason = reason;
  school.suspendedAt = new Date();
  school.subscription.status = "suspended";

  await school.save();

  await User.updateMany(
    { schoolId, deletedAt: null },
    { $set: { status: "suspended" } }
  );

  await auditService.log({
    action: "SUSPEND",
    entity: "School",
    entityId: school._id,
    userId: requester._id,
    details: { reason },
  });

  return school.toJSON();
};

export const archiveSchool = async (schoolId, requester) => {
  if (requester.role !== "super_admin") {
    throw new ApiError("Only super admins can archive schools", 403, "FORBIDDEN");
  }

  if (!mongoose.Types.ObjectId.isValid(schoolId)) {
    throw new ApiError("Invalid school ID", 400, "INVALID_ID");
  }

  const school = await School.findOne({ _id: schoolId, deletedAt: null });
  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  if (school.status === "archived") {
    throw new ApiError("School is already archived", 400, "ALREADY_ARCHIVED");
  }

  school.status = "archived";
  school.deletedAt = new Date();

  await school.save();

  await User.updateMany(
    { schoolId, deletedAt: null },
    { $set: { status: "deactivated" } }
  );

  await auditService.log({
    action: "ARCHIVE",
    entity: "School",
    entityId: school._id,
    userId: requester._id,
    details: {},
  });

  return { message: "School archived successfully" };
};

export const unsuspendSchool = async (schoolId, requester) => {
  if (requester.role !== "super_admin") {
    throw new ApiError("Only super admins can unsuspend schools", 403, "FORBIDDEN");
  }

  if (!mongoose.Types.ObjectId.isValid(schoolId)) {
    throw new ApiError("Invalid school ID", 400, "INVALID_ID");
  }

  const school = await School.findOne({ _id: schoolId, deletedAt: null });
  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  if (school.status !== "suspended") {
    throw new ApiError("School is not suspended", 400, "NOT_SUSPENDED");
  }

  school.status = "active";
  school.suspendedReason = "";
  school.suspendedAt = null;
  school.subscription.status = "active";

  await school.save();

  await User.updateMany(
    { schoolId, deletedAt: null },
    { $set: { status: "active" } }
  );

  await auditService.log({
    action: "UNSUSPEND",
    entity: "School",
    entityId: school._id,
    userId: requester._id,
    details: {},
  });

  return school.toJSON();
};