import { uploadStudentPhoto, uploadStudentPhotosBulk, uploadSchoolLogo } from "../services/upload.service.js";
import { extractPublicId, deleteFromCloudinary } from "../middleware/upload.js";

// ── POST /upload/student-photo — upload a single student photo ──
export const uploadStudentPhotoController = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No image file uploaded",
      });
    }

    // studentId is optional — when provided, the service updates the student record.
    const studentId = req.body?.studentId || null;
    const result = await uploadStudentPhoto(req.file, studentId, req.user);

    return res.status(200).json({
      success: true,
      message: "Student photo uploaded successfully",
      data: result,
    });
  } catch (error) {
    // Cleanup: if the file was uploaded to Cloudinary but processing
    // failed, remove it so we do not leak orphaned assets.
    if (req.file?.path) {
      const publicId = extractPublicId(req.file.path);
      if (publicId) {
        await deleteFromCloudinary(publicId).catch(() => {});
      }
    }

    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── POST /upload/student-photos/bulk — upload a ZIP of photos ──
export const uploadStudentPhotosBulkController = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No ZIP file uploaded",
      });
    }

    const result = await uploadStudentPhotosBulk(req.file, req.user);

    return res.status(200).json({
      success: true,
      message: `${result.uploaded} photos uploaded, ${result.skipped} skipped`,
      data: {
        uploaded: result.uploaded,
        skipped: result.skipped,
        errors: result.errors,
      },
    });
  } catch (error) {
    if (req.file?.path) {
      const publicId = extractPublicId(req.file.path);
      if (publicId) {
        await deleteFromCloudinary(publicId).catch(() => {});
      }
    }

    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── POST /upload/school-logo — upload a school logo ──
export const uploadSchoolLogoController = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No logo file uploaded",
      });
    }

    const result = await uploadSchoolLogo(req.file, req.params.schoolId, req.user);

    return res.status(200).json({
      success: true,
      message: "School logo uploaded successfully",
      data: result,
    });
  } catch (error) {
    // Cleanup the uploaded logo if the service failed after upload.
    if (req.file?.path) {
      const publicId = extractPublicId(req.file.path);
      if (publicId) {
        await deleteFromCloudinary(publicId).catch(() => {});
      }
    }

    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};
