import { School } from "../models/schoolModel.js";
import ApiError from "../utils/ApiError.js";

export const requireVerifiedSchool = (minTier = 2) => async (req, res, next) => {
  try {
    if (!req.user || !req.user.schoolId) {
      return res.status(403).json({
        success: false,
        message: "No school in scope",
        code: "NO_SCHOOL_SCOPE",
        requiredTier: minTier,
      });
    }

    const school = await School.findOne({
      _id: req.user.schoolId,
      deletedAt: null,
    }).select("verificationStatus verificationTier name schoolCode");

    if (!school) {
      return res.status(404).json({
        success: false,
        message: "School not found",
        code: "SCHOOL_NOT_FOUND",
      });
    }

    if (school.verificationTier < minTier) {
      const tierLabels = {
        0: "Unverified",
        1: "Directory Matched",
        2: "Fully Verified",
      };

      const requiredLabel = tierLabels[minTier] || `Tier ${minTier}`;
      const currentLabel = tierLabels[school.verificationTier] || `Tier ${school.verificationTier}`;

      return res.status(403).json({
        success: false,
        message: `This action requires ${requiredLabel} verification (Tier ${minTier}). Current status: ${currentLabel} (Tier ${school.verificationTier}).`,
        code: "INSUFFICIENT_VERIFICATION_TIER",
        requiredTier: minTier,
        currentTier: school.verificationTier,
        verificationStatus: school.verificationStatus,
        schoolName: school.name,
        schoolCode: school.schoolCode,
        upgradeUrl: "/dashboard/settings?section=verification",
      });
    }

    req.school = school;
    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Verification check failed",
      code: "VERIFICATION_CHECK_FAILED",
    });
  }
};

export const getSchoolVerificationInfo = async (schoolId) => {
  const school = await School.findOne({ _id: schoolId, deletedAt: null })
    .select("verificationStatus verificationTier emisCode nasiaRegistrationNumber externalDirectorySource externalDirectoryId")
    .lean();

  return school
    ? {
        verificationStatus: school.verificationStatus,
        verificationTier: school.verificationTier,
        emisCode: school.emisCode,
        nasiaRegistrationNumber: school.nasiaRegistrationNumber,
        externalDirectorySource: school.externalDirectorySource,
        externalDirectoryId: school.externalDirectoryId,
      }
    : null;
};