import {
  createSchool,
  listSchools,
  getSchoolById,
  updateSchool,
  updateSchoolLogo,
  updateSchoolStamp,
  suspendSchool,
  archiveSchool,
} from "../services/school.service.js";
import { extractPublicId, deleteFromCloudinary } from "../middleware/upload.js";

// ─────────────────────────────────────────────
// CREATE SCHOOL
// ─────────────────────────────────────────────
export const createSchoolController = async (req, res) => {
  try {
    const stampUrl = req.file?.path || null;
    const school = await createSchool(req.body, req.user._id, stampUrl);

    return res.status(201).json({
      success: true,
      message: "School created successfully",
      data: school,
    });
  } catch (error) {
    // cleanup uploaded file if DB write failed
    if (req.file) {
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

// ─────────────────────────────────────────────
// LIST SCHOOLS
// ─────────────────────────────────────────────
export const listSchoolsController = async (req, res) => {
  try {
    const result = await listSchools(req.query);

    return res.status(200).json({
      success: true,
      message: "Schools retrieved successfully",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET SINGLE SCHOOL
// ─────────────────────────────────────────────
export const getSchoolController = async (req, res) => {
  try {
    const school = await getSchoolById(req.params.schoolId, req.user);

    return res.status(200).json({
      success: true,
      message: "School retrieved successfully",
      data: school,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// UPDATE SCHOOL
// ─────────────────────────────────────────────
export const updateSchoolController = async (req, res) => {
  try {
    const school = await updateSchool(req.params.schoolId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "School updated successfully",
      data: school,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// UPDATE SCHOOL LOGO
// ─────────────────────────────────────────────
export const updateSchoolLogoController = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No logo file uploaded",
      });
    }

    const logoUrl = req.file.path;
    const school = await getSchoolById(req.params.schoolId, req.user);

    if (school.logo) {
      const publicId = extractPublicId(school.logo);
      if (publicId) {
        await deleteFromCloudinary(publicId).catch(() => {});
      }
    }

    const result = await updateSchoolLogo(
      req.params.schoolId,
      logoUrl,
      school.logo,
      req.user
    );

    return res.status(200).json({
      success: true,
      message: "Logo updated successfully",
      data: result,
    });
  } catch (error) {
    // cleanup the newly uploaded file if something failed
    if (req.file) {
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

// ─────────────────────────────────────────────
// UPDATE SCHOOL STAMP
// ─────────────────────────────────────────────
export const updateSchoolStampController = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No stamp file uploaded",
      });
    }

    const stampUrl = req.file.path;
    const school = await getSchoolById(req.params.schoolId, req.user);

    if (school.stamp) {
      const publicId = extractPublicId(school.stamp);
      if (publicId) {
        await deleteFromCloudinary(publicId).catch(() => {});
      }
    }

    const result = await updateSchoolStamp(
      req.params.schoolId,
      stampUrl,
      school.stamp,
      req.user
    );

    return res.status(200).json({
      success: true,
      message: "Stamp updated successfully",
      data: result,
    });
  } catch (error) {
    if (req.file) {
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

// ─────────────────────────────────────────────
// SUSPEND SCHOOL
// ─────────────────────────────────────────────
export const suspendSchoolController = async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "Suspension reason is required",
      });
    }

    const school = await suspendSchool(req.params.schoolId, reason, req.user);

    return res.status(200).json({
      success: true,
      message: "School suspended successfully",
      data: school,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// ARCHIVE SCHOOL
// ─────────────────────────────────────────────
export const archiveSchoolController = async (req, res) => {
  try {
    const result = await archiveSchool(req.params.schoolId, req.user);

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};