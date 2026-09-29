import {
  listAllSchools,
  getPlatformRevenue,
  getPlatformSmsBalance,
  getSchoolUsage,
  suspendSchoolPlatform,
  unsuspendSchoolPlatform,
  getDashboardKpis,
} from "../services/admin.service.js";

// ─────────────────────────────────────────────
// GET /admin/schools — list all schools on platform
// ─────────────────────────────────────────────
export const listAllSchoolsController = async (req, res) => {
  try {
    const result = await listAllSchools(req.query);

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
// GET /admin/revenue — platform-wide revenue
// ─────────────────────────────────────────────
export const getPlatformRevenueController = async (req, res) => {
  try {
    const result = await getPlatformRevenue(req.query);

    return res.status(200).json({
      success: true,
      message: "Platform revenue retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /admin/sms-balance — master SMS balance
// ─────────────────────────────────────────────
export const getPlatformSmsBalanceController = async (req, res) => {
  try {
    const result = await getPlatformSmsBalance();

    return res.status(200).json({
      success: true,
      message: "SMS balance retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /admin/schools/:id/usage — school usage stats
// ─────────────────────────────────────────────
export const getSchoolUsageController = async (req, res) => {
  try {
    const result = await getSchoolUsage(req.params.id);

    return res.status(200).json({
      success: true,
      message: "School usage stats retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// PUT /admin/schools/:id/suspend — suspend school
// ─────────────────────────────────────────────
export const suspendSchoolPlatformController = async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "Suspension reason is required",
      });
    }

    const school = await suspendSchoolPlatform(req.params.id, reason, req.user);

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
// PUT /admin/schools/:id/unsuspend — unsuspend school
// ─────────────────────────────────────────────
export const unsuspendSchoolPlatformController = async (req, res) => {
  try {
    const school = await unsuspendSchoolPlatform(req.params.id, req.user);

    return res.status(200).json({
      success: true,
      message: "School unsuspended successfully",
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
// GET /admin/dashboard — super admin KPIs
// ─────────────────────────────────────────────
export const getDashboardKpisController = async (req, res) => {
  try {
    const result = await getDashboardKpis();

    return res.status(200).json({
      success: true,
      message: "Dashboard KPIs retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};
