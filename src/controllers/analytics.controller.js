import {
  getOverview,
  getRevenue,
  getPaidOwed,
  getPersons,
  getRevenueChart,
  getOverdue,
  getCashflow,
  getCashflowVelocity,
  getCompliance,
  getDefaultRate,
  getClassPerformance,
} from "../services/analytics.service.js";

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export const getOverviewController = asyncHandler(async (req, res) => {
  const result = await getOverview(req.params.schoolId, req.query, req.user);

  return res.status(200).json({
    success: true,
    message: "Analytics overview retrieved successfully",
    data: result,
    meta: { generatedAt: new Date().toISOString() },
  });
});

export const getRevenueController = asyncHandler(async (req, res) => {
  const result = await getRevenue(req.params.schoolId, req.query, req.user);

  return res.status(200).json({
    success: true,
    message: "Revenue analytics retrieved successfully",
    data: result,
  });
});

export const getPaidOwedController = asyncHandler(async (req, res) => {
  const result = await getPaidOwed(req.params.schoolId, req.query, req.user);

  return res.status(200).json({
    success: true,
    message: "Paid vs owed breakdown retrieved successfully",
    data: result,
  });
});

export const getPersonsController = asyncHandler(async (req, res) => {
  const result = await getPersons(req.params.schoolId, req.query, req.user);

  return res.status(200).json({
    success: true,
    message: "Student payment status breakdown retrieved successfully",
    data: result,
  });
});

export const getRevenueChartController = asyncHandler(async (req, res) => {
  const result = await getRevenueChart(req.params.schoolId, req.query, req.user);

  return res.status(200).json({
    success: true,
    message: "Revenue chart data retrieved successfully",
    data: result,
  });
});

export const getOverdueController = asyncHandler(async (req, res) => {
  const result = await getOverdue(req.params.schoolId, req.query, req.user);

  return res.status(200).json({
    success: true,
    message: "Overdue students retrieved successfully",
    data: result,
  });
});

export const getCashflowController = asyncHandler(async (req, res) => {
  const result = await getCashflow(req.params.schoolId, req.query, req.user);

  return res.status(200).json({
    success: true,
    message: "Cashflow forecast retrieved successfully",
    data: result,
  });
});

export const getCashflowVelocityController = asyncHandler(async (req, res) => {
  const result = await getCashflowVelocity(req.params.schoolId, req.query, req.user);

  return res.status(200).json({
    success: true,
    message: "Cashflow velocity retrieved successfully",
    data: result,
  });
});

export const getComplianceController = asyncHandler(async (req, res) => {
  const result = await getCompliance(req.params.schoolId, req.query, req.user);

  return res.status(200).json({
    success: true,
    message: "Compliance overview retrieved successfully",
    data: result,
  });
});

export const getDefaultRateController = asyncHandler(async (req, res) => {
  const result = await getDefaultRate(req.params.schoolId, req.query, req.user);

  return res.status(200).json({
    success: true,
    message: "Default rate analytics retrieved successfully",
    data: result,
  });
});

export const getClassPerformanceController = asyncHandler(async (req, res) => {
  const result = await getClassPerformance(req.params.schoolId, req.query, req.user);

  return res.status(200).json({
    success: true,
    message: "Class-wise collection performance retrieved successfully",
    data: result,
  });
});
