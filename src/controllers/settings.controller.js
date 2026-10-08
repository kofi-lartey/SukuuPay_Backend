import {
  getSchoolSettings,
  updateSchoolSettings,
  updateAcademicYear,
  updateNotificationPrefs,
  getSchoolBilling,
  getIdCardSettings,
  updateIdCardSettings,
} from "../services/settings.service.js";

// ── GET /id-cards/settings/:schoolId — get ID card settings ──
export const getIdCardSettingsController = async (req, res) => {
  try {
    const settings = await getIdCardSettings(req.params.schoolId, req.user);

    return res.status(200).json({
      success: true,
      message: "ID card settings retrieved successfully",
      data: settings,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── PUT /id-cards/settings/:schoolId — save ID card settings ──
export const updateIdCardSettingsController = async (req, res) => {
  try {
    const settings = await updateIdCardSettings(req.params.schoolId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "ID card settings updated successfully",
      data: settings,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── GET /settings/:schoolId — get all school settings ──
export const getSchoolSettingsController = async (req, res) => {
  try {
    const settings = await getSchoolSettings(req.params.schoolId, req.user);

    return res.status(200).json({
      success: true,
      message: "School settings retrieved successfully",
      data: settings,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── PUT /settings/:schoolId — update general settings ──
export const updateSchoolSettingsController = async (req, res) => {
  try {
    const settings = await updateSchoolSettings(req.params.schoolId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "School settings updated successfully",
      data: settings,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── PUT /settings/:schoolId/academic-year — set current academic year & term ──
export const updateAcademicYearController = async (req, res) => {
  try {
    const academic = await updateAcademicYear(req.params.schoolId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Academic year and term updated successfully",
      data: academic,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── PUT /settings/:schoolId/notifications — set notification preferences ──
export const updateNotificationPrefsController = async (req, res) => {
  try {
    const prefs = await updateNotificationPrefs(req.params.schoolId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Notification preferences updated successfully",
      data: prefs,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── GET /settings/:schoolId/billing — get subscription + billing info ──
export const getSchoolBillingController = async (req, res) => {
  try {
    const billing = await getSchoolBilling(req.params.schoolId, req.query, req.user);

    return res.status(200).json({
      success: true,
      message: "Billing information retrieved successfully",
      data: billing,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};
