import mongoose from "mongoose";
import { School } from "../models/schoolModel.js";
import { User } from "../models/userModel.js";
import { SchoolJoinRequest } from "../models/SchoolJoinRequest.js";
import { Notification } from "../models/Notification.js";
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

/**
 * Create the caller's own school and link them to it in one atomic operation.
 *
 * This is the action that was missing behind the "contact support" dead end.
 * Before it, the only way to obtain a `schoolId` was `POST /schools`, which is
 * gated on `authorize("super_admin")` — so a self-service signup could never
 * finish onboarding no matter how much of the wizard it completed.
 *
 * Idempotent by design (FR-7). A double-clicked Continue, a replayed request, or
 * an admin who provisioned on a laptop and comes back on a phone all arrive
 * here with a `schoolId` already set. Returning the existing school is the
 * correct answer in every one of those cases; creating a second School would
 * leave the bursar administering a duplicate of their own institution.
 *
 * The link write and the School insert share a session so a failure cannot
 * leave an orphan School that nobody administers — the failure mode that would
 * be worst here, because the retry would then collide with the orphan on
 * `School.email`.
 */
export const provisionSchoolForUser = async (data, user) => {
  if (user.role === "super_admin") {
    throw new ApiError(
      "Platform staff accounts are not linked to a school",
      403,
      "FORBIDDEN"
    );
  }

  // Only a school administrator registers a school. The upload endpoint agrees:
  // `POST /upload/school-logo` is guarded by `authorize("super_admin",
  // "school_admin")`, so an accountant who created their own school would finish
  // provisioning and then be refused their own logo — a state with no way out.
  // Non-admins are sent to `POST /schools/join` instead, which routes them
  // through the existing school's approval flow.
  if (user.role !== "school_admin") {
    throw new ApiError(
      "Only a school administrator can create a school. Enter your school code to join one instead.",
      403,
      "ROLE_CANNOT_CREATE_SCHOOL"
    );
  }

  if (user.schoolId) {
    const existing = await School.findOne({ _id: user.schoolId, deletedAt: null });
    if (existing) {
      return { school: existing.toJSON(), user: user.toJSON(), created: false };
    }
    // Dangling reference — the school was archived out from under this account.
    // Fall through and let them provision again, which is what D6 in the
    // onboarding decision table calls for.
  }

  const { email, phone } = data;

  const existingEmail = await School.findOne({ email });
  if (existingEmail) {
    // Not a generic 409. This is the second-bursar case, and the response names
    // the only route that resolves it so the client can offer a join sheet
    // instead of showing an error the user cannot act on.
    throw new ApiError(
      "A school with this email is already registered. Enter your school code to join it instead.",
      409,
      "SCHOOL_ALREADY_REGISTERED"
    );
  }

  const validatedPhone = validateGhanaPhone(phone);
  if (!validatedPhone) {
    throw new ApiError("Invalid Ghana phone number format", 400, "INVALID_PHONE");
  }

  const slug = await generateUniqueSlug(data.name);
  const schoolCode = await generateSchoolCode(data.name);

  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 30);

  const session = await mongoose.startSession();
  let result;

  try {
    result = await session.withTransaction(async () => {
      const [school] = await School.create(
        [
          {
            ...data,
            phone: validatedPhone,
            slug,
            schoolCode,
            createdBy: user._id,
            status: "active",
            subscription: {
              plan: "trial",
              status: "trial",
              trialEndsAt,
              currentPeriodStart: new Date(),
              currentPeriodEnd: trialEndsAt,
            },
          },
        ],
        { session }
      );

      user.schoolId = school._id;
      await user.save({ session });

      return { school: school.toJSON(), user: user.toJSON(), created: true };
    });
  } catch (error) {
    // A unique-index violation here means two submissions raced. The loser gets
    // the same 409 as a deliberate duplicate, so the client behaves identically.
    if (error.code === 11000) {
      throw new ApiError(
        "A school with this email is already registered. Enter your school code to join it instead.",
        409,
        "SCHOOL_ALREADY_REGISTERED"
      );
    }
    throw error;
  } finally {
    await session.endSession();
  }

  await auditService.log({
    action: "PROVISION",
    entity: "School",
    entityId: result.school._id,
    userId: user._id,
    details: {
      name: result.school.name,
      schoolCode: result.school.schoolCode,
    },
  });

  return result;
};

/**
 * Ask to join a school that already exists.
 *
 * The school code identifies the school; it does not authenticate the applicant.
 * Codes are initials plus a three-digit counter, so they are guessable, and
 * `School` grants full bursary access. The request therefore parks as `pending`
 * until an admin of that school decides — see models/SchoolJoinRequest.js.
 */
export const requestToJoinSchool = async (user, { schoolCode, applicantName, applicantPosition }) => {
  if (user.schoolId) {
    throw new ApiError("Your account is already linked to a school", 409, "ALREADY_LINKED");
  }

  const code = schoolCode.trim().toUpperCase();
  const school = await School.findOne({ schoolCode: code, deletedAt: null });
  if (!school) {
    throw new ApiError("That school code is not recognised", 404, "INVALID_SCHOOL_CODE");
  }
  if (school.status !== "active") {
    throw new ApiError(
      "That school is not accepting new staff right now",
      409,
      "SCHOOL_NOT_ACCEPTING"
    );
  }

  const alreadyPending = await SchoolJoinRequest.findOne({
    userId: user._id,
    schoolId: school._id,
    status: "pending",
  });
  if (alreadyPending) {
    // Idempotent, so a bursar who taps "resend" is not told they have applied
    // twice or left staring at a duplicate-request error.
    return { request: alreadyPending.toJSON(), school, created: false };
  }

  const request = await SchoolJoinRequest.create({
    userId: user._id,
    schoolId: school._id,
    applicantName: applicantName || user.name,
    applicantPosition: applicantPosition || user.position || "",
    status: "pending",
  });

  // Tell the people who can actually approve. Best-effort: a notification
  // failure must not lose the request, which is already committed.
  try {
    const approvers = await User.find({
      schoolId: school._id,
      role: { $in: ["school_admin", "accountant"] },
      status: "active",
      deletedAt: null,
    })
      .select("_id")
      .lean();

    await Notification.insertMany(
      approvers.map((approver) => ({
        userId: approver._id,
        schoolId: school._id,
        type: "school.join_request",
        title: `${request.applicantName || "Someone"} wants to join ${school.name}`,
        message:
          "Review the request and approve or reject their access. Your school code was used to apply.",
        link: "/dashboard/settings/staff",
        meta: { requestId: request._id, applicantId: user._id },
      })),
      { ordered: false }
    );
  } catch (error) {
    console.error("Join-request notification failed:", error.message);
  }

  await auditService.log({
    action: "JOIN_REQUEST",
    entity: "School",
    entityId: school._id,
    userId: user._id,
    details: { requestId: request._id, schoolCode: code },
  });

  return { request: request.toJSON(), school, created: true };
};

/** Pending requests for the caller's own school. Admins only. */
export const listJoinRequests = async (user) => {
  if (!user.schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }
  if (user.role !== "super_admin" && !["school_admin", "accountant"].includes(user.role)) {
    throw new ApiError("Only school admins can review join requests", 403, "FORBIDDEN");
  }

  const requests = await SchoolJoinRequest.find({ schoolId: user.schoolId })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate("userId", "name email phone position status")
    .lean();

  return requests.map((row) => ({
    ...row,
    userId: row.userId || null,
  }));
};

/**
 * Approve or reject a pending join request.
 *
 * On approval the applicant is linked inside the same transaction that flips the
 * status, so a crash cannot leave a request marked approved whose applicant
 * still has no school — which would strand them on Step 1 with a request the
 * bursar believes they already handled.
 */
export const decideJoinRequest = async (user, requestId, { decision, note }) => {
  if (!user.schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }
  if (user.role !== "super_admin" && !["school_admin", "accountant"].includes(user.role)) {
    throw new ApiError("Only school admins can review join requests", 403, "FORBIDDEN");
  }

  const request = await SchoolJoinRequest.findOne({
    _id: requestId,
    schoolId: user.schoolId,
  });
  if (!request) {
    throw new ApiError("Join request not found", 404, "NOT_FOUND");
  }
  if (request.status !== "pending") {
    throw new ApiError(
      `This request was already ${request.status}`,
      409,
      "ALREADY_DECIDED"
    );
  }

  const applicant = await User.findOne({ _id: request.userId, deletedAt: null });
  if (!applicant) {
    throw new ApiError("That account no longer exists", 404, "USER_NOT_FOUND");
  }
  // An applicant who provisioned their own school in the meantime must not be
  // silently moved into someone else's — that would hand them access to data
  // they never asked for.
  if (decision === "approved" && applicant.schoolId) {
    throw new ApiError(
      "That account already belongs to a school",
      409,
      "APPLICANT_ALREADY_LINKED"
    );
  }

  if (decision !== "approved") {
    request.status = "rejected";
    request.decidedBy = user._id;
    request.decidedAt = new Date();
    request.decidedNote = note || "";
    await request.save();

    await auditService.log({
      action: "JOIN_REJECTED",
      entity: "SchoolJoinRequest",
      entityId: request._id,
      userId: user._id,
      details: { applicantId: applicant._id },
    });

    return { request: request.toJSON(), linked: false };
  }

  const session = await mongoose.startSession();
  try {
    const saved = await session.withTransaction(async () => {
      request.status = "approved";
      request.decidedBy = user._id;
      request.decidedAt = new Date();
      request.decidedNote = note || "";
      await request.save({ session });

      applicant.schoolId = user.schoolId;
      await applicant.save({ session });

      return request.toJSON();
    });

    await auditService.log({
      action: "JOIN_APPROVED",
      entity: "SchoolJoinRequest",
      entityId: request._id,
      userId: user._id,
      details: { applicantId: applicant._id, schoolId: user.schoolId },
    });

    return { request: saved, linked: true };
  } finally {
    await session.endSession();
  }
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

  // Paths that address a nested field rather than a top-level one. Joi accepts
  // them as dotted keys, and `School` has no literal `"location.latitude"`
  // property, so writing them straight onto the document would invent one.
  // `academic.classes` already needed this; `location.*` is the second member.
  const NESTED_PATHS = ["academic.", "location."];

  // Read before the write loop below, so the freshness stamp can tell a moved
  // pin from an unchanged one.
  const previousLatitude = school.location?.latitude;
  const previousLongitude = school.location?.longitude;

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
    const nested = NESTED_PATHS.find((prefix) => key.startsWith(prefix));
    if (nested) {
      const subKey = key.slice(nested.length);
      const parent = key.slice(0, nested.length - 1); // strip the trailing dot
      school[parent][subKey] = updates[key];
    } else {
      school[key] = updates[key];
    }
  });

  // Stamped whenever coordinates actually change, so the dashboard can show how
  // fresh a pin is. A pin a bursar set two years ago should not be presented
  // with the same confidence as one they just dropped.
  const lat = school.location?.latitude;
  const lng = school.location?.longitude;
  const hadCoords = Boolean(previousLatitude != null && previousLongitude != null);
  if (typeof lat === "number" && typeof lng === "number") {
    if (!hadCoords || lat !== previousLatitude || lng !== previousLongitude) {
      school.location.updatedAt = new Date();
    }
  }

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