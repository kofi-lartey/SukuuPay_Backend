import {
  searchSchoolsDirectory,
  clearSchoolDirectoryCache,
} from "../services/schoolDirectory.service.js";
import {
  uploadKybDocument,
  getVerificationStatus,
  adminVerifySchool,
  linkExternalDirectoryMatch,
} from "../services/schoolVerification.service.js";
import ApiError from "../utils/ApiError.js";

export const searchDirectoryController = async (req, res) => {
  try {
    const { q, region, district, limit = 20 } = req.query;

    if (!q || String(q).trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "Search query must be at least 2 characters",
        code: "QUERY_TOO_SHORT",
      });
    }

    const results = await searchSchoolsDirectory({
      q: String(q).trim(),
      region: region ? String(region).trim() : undefined,
      district: district ? String(district).trim() : undefined,
      limit: Math.min(Number(limit), 50),
    });

    return res.status(200).json({
      success: true,
      message: "School directory search completed",
      data: results,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "School directory search failed",
    });
  }
};

export const uploadVerificationDocumentController = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No document file uploaded",
        code: "NO_FILE",
      });
    }

    const { documentType } = req.body;
    if (!documentType) {
      return res.status(400).json({
        success: false,
        message: "Document type is required",
        code: "MISSING_DOCUMENT_TYPE",
      });
    }

    const result = await uploadKybDocument(req.params.schoolId, req.user, documentType, req.file);

    return res.status(200).json({
      success: true,
      message: "Document uploaded successfully. Verification status updated to pending review.",
      data: result,
    });
  } catch (error) {
    if (req.file) {
      const publicId = req.file.filename;
      if (publicId) {
        import("../middleware/uploadVerification.js").then(({ deleteVerificationDocument }) =>
          deleteVerificationDocument(publicId).catch(() => {})
        );
      }
    }
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Document upload failed",
    });
  }
};

export const getVerificationStatusController = async (req, res) => {
  try {
    const status = await getVerificationStatus(req.params.schoolId, req.user);
    return res.status(200).json({
      success: true,
      message: "Verification status retrieved",
      data: status,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to get verification status",
    });
  }
};

export const adminVerifySchoolController = async (req, res) => {
  try {
    const { decision, rejectionReason } = req.body;
    if (!decision || !["approved", "rejected"].includes(decision)) {
      return res.status(400).json({
        success: false,
        message: "Decision must be 'approved' or 'rejected'",
        code: "INVALID_DECISION",
      });
    }

    if (decision === "rejected" && !rejectionReason) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required when rejecting",
        code: "MISSING_REJECTION_REASON",
      });
    }

    const result = await adminVerifySchool(req.params.schoolId, req.user, { decision, rejectionReason });

    return res.status(200).json({
      success: true,
      message: decision === "approved" ? "School verified successfully" : "School verification rejected",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Verification decision failed",
    });
  }
};

export const linkDirectoryMatchController = async (req, res) => {
  try {
    const { externalId, source, name, region, district, level, category } = req.body;

    if (!externalId || !source) {
      return res.status(400).json({
        success: false,
        message: "externalId and source are required",
        code: "MISSING_REQUIRED_FIELDS",
      });
    }

    const result = await linkExternalDirectoryMatch(req.params.schoolId, req.user, {
      externalId,
      source,
      name,
      region,
      district,
      level,
      category,
    });

    return res.status(200).json({
      success: true,
      message: "School linked to directory match",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to link directory match",
    });
  }
};

export const clearDirectoryCacheController = async (req, res) => {
  try {
    clearSchoolDirectoryCache();
    return res.status(200).json({
      success: true,
      message: "School directory cache cleared",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to clear cache",
    });
  }
};