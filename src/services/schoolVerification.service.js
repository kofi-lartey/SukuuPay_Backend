import mongoose from "mongoose";
import { School } from "../models/schoolModel.js";
import { User } from "../models/userModel.js";
import ApiError from "../utils/ApiError.js";
import { emitVerificationUpdate } from "../sockets/verificationGateway.js";
import { AUDIT_ACTIONS } from "../config/constants.js";
import { deleteVerificationDocument, readVerificationUploaded } from "../middleware/uploadVerification.js";

const KYB_DOCUMENT_TYPES = [
  "NASIA_LICENSE",
  "RGD_CERTIFICATE",
  "AUTHORIZATION_LETTER",
  "HEADTEACHER_ID",
];

const REQUIRED_KYB_DOCUMENTS = [
  "NASIA_LICENSE",
  "RGD_CERTIFICATE",
  "AUTHORIZATION_LETTER",
];

export async function uploadKybDocument(schoolId, user, documentType, file) {
  if (!KYB_DOCUMENT_TYPES.includes(documentType)) {
    throw new ApiError("Invalid document type", 400, "INVALID_DOCUMENT_TYPE");
  }

  const school = await School.findOne({ _id: schoolId, deletedAt: null });
  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && user.schoolId?.toString() !== schoolId) {
    throw new ApiError("You do not have access to this school", 403, "FORBIDDEN");
  }

  const existingIndex = school.kybDocuments.findIndex(
    (doc) => doc.type === documentType && doc.reviewStatus !== "REJECTED"
  );

  const { url: fileUrl } = readVerificationUploaded(file);
  if (!fileUrl) {
    throw new ApiError("File upload failed - no URL returned", 500, "UPLOAD_FAILED");
  }

  if (existingIndex >= 0) {
    const oldDoc = school.kybDocuments[existingIndex];
    if (oldDoc.fileUrl) {
      await deleteVerificationDocument(oldDoc.fileUrl).catch(() => {});
    }
    school.kybDocuments[existingIndex] = {
      ...oldDoc,
      fileUrl,
      uploadedAt: new Date(),
      reviewStatus: "PENDING",
      reviewNote: "",
      reviewedAt: null,
      reviewedBy: null,
    };
  } else {
    school.kybDocuments.push({
      type: documentType,
      fileUrl,
      uploadedAt: new Date(),
      reviewStatus: "PENDING",
      reviewNote: "",
      reviewedAt: null,
      reviewedBy: null,
    });
  }

  const wasUnverified = school.verificationStatus === "UNVERIFIED";
  const wasDirectoryMatched = school.verificationStatus === "DIRECTORY_MATCHED";

  if (wasUnverified || wasDirectoryMatched) {
    school.verificationStatus = "PENDING_REVIEW";
    school.verificationTier = 1;
  }

  await school.save();

  await auditLog({
    action: AUDIT_ACTIONS.SCHOOL_UPDATE,
    entity: "School",
    entityId: school._id,
    userId: user._id,
    schoolId,
    meta: { updatedFields: ["kybDocuments", "verificationStatus", "verificationTier"], documentType },
  });

  return {
    school: school.toJSON(),
    uploadedDocument: school.kybDocuments[school.kybDocuments.length - 1],
  };
}

export async function getVerificationStatus(schoolId, requester) {
  const school = await School.findOne({ _id: schoolId, deletedAt: null })
    .select("verificationStatus verificationTier emisCode nasiaRegistrationNumber externalDirectorySource externalDirectoryId kybDocuments rejectionReason verifiedAt verifiedBy region district schoolLevel schoolOwnership")
    .lean();

  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  if (requester.role !== "super_admin" && requester.schoolId?.toString() !== schoolId) {
    throw new ApiError("You do not have access to this school", 403, "FORBIDDEN");
  }

  const missingDocuments = REQUIRED_KYB_DOCUMENTS.filter(
    (type) => !school.kybDocuments.some((doc) => doc.type === type && doc.reviewStatus !== "REJECTED")
  );

  const pendingDocuments = school.kybDocuments.filter(
    (doc) => doc.reviewStatus === "PENDING"
  ).map((doc) => doc.type);

  const approvedDocuments = school.kybDocuments.filter(
    (doc) => doc.reviewStatus === "APPROVED"
  ).map((doc) => doc.type);

  const rejectedDocuments = school.kybDocuments.filter(
    (doc) => doc.reviewStatus === "REJECTED"
  ).map((doc) => doc.type);

  let canUpgradeToVerified = false;
  let canRequestReview = false;

  if (school.verificationStatus === "PENDING_REVIEW") {
    canUpgradeToVerified = missingDocuments.length === 0;
  } else if (school.verificationStatus === "UNVERIFIED" || school.verificationStatus === "DIRECTORY_MATCHED") {
    canRequestReview = true;
  }

  return {
    verificationStatus: school.verificationStatus,
    verificationTier: school.verificationTier,
    emisCode: school.emisCode,
    nasiaRegistrationNumber: school.nasiaRegistrationNumber,
    externalDirectorySource: school.externalDirectorySource,
    externalDirectoryId: school.externalDirectoryId,
    region: school.region,
    district: school.district,
    schoolLevel: school.schoolLevel,
    schoolOwnership: school.schoolOwnership,
    documents: {
      uploaded: school.kybDocuments.map((doc) => ({
        type: doc.type,
        fileUrl: doc.fileUrl,
        uploadedAt: doc.uploadedAt,
        reviewStatus: doc.reviewStatus,
        reviewNote: doc.reviewNote,
        reviewedAt: doc.reviewedAt,
        reviewedBy: doc.reviewedBy,
      })),
      missing: missingDocuments,
      pending: pendingDocuments,
      approved: approvedDocuments,
      rejected: rejectedDocuments,
    },
    rejectionReason: school.rejectionReason,
    verifiedAt: school.verifiedAt,
    verifiedBy: school.verifiedBy,
    canUpgradeToVerified,
    canRequestReview,
    tierRequirements: {
      0: "Unverified - Manual entry or no directory match",
      1: "Directory Matched - Found in Ghana schools directory",
      2: "Fully Verified - All KYB documents approved",
    },
  };
}

export async function adminVerifySchool(schoolId, adminUser, { decision, rejectionReason }) {
  if (adminUser.role !== "super_admin") {
    throw new ApiError("Only platform administrators can verify schools", 403, "FORBIDDEN");
  }

  const school = await School.findOne({ _id: schoolId, deletedAt: null });
  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  if (school.verificationStatus !== "PENDING_REVIEW") {
    // Idempotent: if the school is already in the requested target state,
    // return success rather than erroring, so re-approval/rejection of an
    // already-decided school is a no-op instead of a 400.
    if (decision === "approved" && school.verificationStatus === "VERIFIED") {
      return { school, alreadyDecided: true };
    }
    if (decision === "rejected" && school.verificationStatus === "REJECTED") {
      return { school, alreadyDecided: true };
    }
    throw new ApiError("School is not pending review", 400, "INVALID_STATUS");
  }

  const missingDocuments = REQUIRED_KYB_DOCUMENTS.filter(
    (type) => !school.kybDocuments.some((doc) => doc.type === type && doc.reviewStatus !== "REJECTED")
  );

  if (decision === "approved") {
    if (missingDocuments.length > 0) {
      throw new ApiError(
        `Missing required documents: ${missingDocuments.join(", ")}`,
        400,
        "MISSING_DOCUMENTS"
      );
    }

    school.verificationStatus = "VERIFIED";
    school.verificationTier = 2;
    school.verifiedAt = new Date();
    school.verifiedBy = adminUser._id;
    school.rejectionReason = "";

    school.kybDocuments.forEach((doc) => {
      if (doc.reviewStatus === "PENDING") {
        doc.reviewStatus = "APPROVED";
        doc.reviewedAt = new Date();
        doc.reviewedBy = adminUser._id;
      }
    });
  } else if (decision === "rejected") {
    school.verificationStatus = "REJECTED";
    school.verificationTier = 0;
    school.rejectionReason = rejectionReason || "Verification rejected by administrator";

    school.kybDocuments.forEach((doc) => {
      if (doc.reviewStatus === "PENDING") {
        doc.reviewStatus = "REJECTED";
        doc.reviewNote = rejectionReason || "Rejected by administrator";
        doc.reviewedAt = new Date();
        doc.reviewedBy = adminUser._id;
      }
    });
  } else {
    throw new ApiError("Invalid decision. Must be 'approved' or 'rejected'", 400, "INVALID_DECISION");
  }

  await school.save();

  // Emit real-time update to all clients in the school's room
  emitVerificationUpdate(schoolId, {
    verificationStatus: school.verificationStatus,
    verificationTier: school.verificationTier,
    rejectionReason: school.rejectionReason,
    verifiedAt: school.verifiedAt,
  });

  await auditLog({
    action: decision === "approved" ? AUDIT_ACTIONS.SCHOOL_UPDATE : AUDIT_ACTIONS.SCHOOL_UPDATE,
    entity: "School",
    entityId: school._id,
    userId: adminUser._id,
    schoolId,
    meta: { verificationDecision: decision, rejectionReason: decision === "rejected" ? rejectionReason : undefined },
  });

  return {
    school: school.toJSON(),
    decision,
  };
}

export async function linkExternalDirectoryMatch(schoolId, user, { externalId, source, name, region, district, level, category }) {
  const school = await School.findOne({ _id: schoolId, deletedAt: null });
  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  if (user.role !== "super_admin" && user.schoolId?.toString() !== schoolId) {
    throw new ApiError("You do not have access to this school", 403, "FORBIDDEN");
  }

  school.externalDirectorySource = source;
  school.externalDirectoryId = externalId;
  school.region = region || school.region;
  school.district = district || school.district;
  school.schoolLevel = level || school.schoolLevel;
  school.schoolOwnership = category || school.schoolOwnership;

  if (school.verificationStatus === "UNVERIFIED") {
    school.verificationStatus = "DIRECTORY_MATCHED";
    school.verificationTier = 1;
  }

  await school.save();

  await auditLog({
    action: AUDIT_ACTIONS.SCHOOL_UPDATE,
    entity: "School",
    entityId: school._id,
    userId: user._id,
    schoolId,
    meta: { externalDirectoryMatch: { externalId, source } },
  });

  return school.toJSON();
}