import {
  createPaymentPlan,
  getPaymentPlanByStudent,
  updatePaymentPlan,
  cancelPaymentPlan,
  acceptPaymentPlan,
  adminAcceptPaymentPlan,
  updateInstallment,
  prepayPlan,
  getSchoolCompliance,
} from "../services/paymentPlan.service.js";

// ─────────────────────────────────────────────
// CREATE PAYMENT PLAN
// ─────────────────────────────────────────────
export const createPaymentPlanController = async (req, res) => {
  try {
    const result = await createPaymentPlan(req.params.studentId, req.body, req.user);

    return res.status(201).json({
      success: true,
      message:
        "Payment plan created. An SMS has been sent to the parent for acceptance.",
      data: result.plan,
      meta: { sms: result.sms },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET A STUDENT'S PAYMENT PLAN
// ─────────────────────────────────────────────
export const getPaymentPlanController = async (req, res) => {
  try {
    const result = await getPaymentPlanByStudent(req.params.studentId, req.user);

    return res.status(200).json({
      success: true,
      message: "Payment plan retrieved successfully",
      data: { plan: result.plan, student: result.student },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// UPDATE PAYMENT PLAN
// ─────────────────────────────────────────────
export const updatePaymentPlanController = async (req, res) => {
  try {
    const plan = await updatePaymentPlan(req.params.planId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Payment plan updated successfully",
      data: plan,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// CANCEL PAYMENT PLAN (soft delete)
// ─────────────────────────────────────────────
export const cancelPaymentPlanController = async (req, res) => {
  try {
    const result = await cancelPaymentPlan(req.params.planId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: result.message,
      data: result.plan,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// ACCEPT PAYMENT PLAN (public — parent replies via SMS)
// ─────────────────────────────────────────────
export const acceptPaymentPlanController = async (req, res) => {
  try {
    // The token may arrive in the body (SMS gateway) or the query string (link).
    const data = {
      token: req.body?.token || req.query?.token,
      via: req.body?.via || req.query?.via || "sms",
    };

    const result = await acceptPaymentPlan(req.params.planId, data);

    return res.status(200).json({
      success: true,
      message: "Plan activated",
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
// UPDATE A SINGLE INSTALLMENT
// ─────────────────────────────────────────────
export const updateInstallmentController = async (req, res) => {
  try {
    const plan = await updateInstallment(
      req.params.planId,
      req.params.num,
      req.body,
      req.user
    );

    return res.status(200).json({
      success: true,
      message: "Installment updated successfully",
      data: plan,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// PREPAY AGAINST A PLAN (public — parent pay link)
// ─────────────────────────────────────────────
export const prepayPlanController = async (req, res) => {
  try {
    const data = {
      ...req.body,
      planToken: req.body?.planToken || req.query?.planToken,
    };

    const result = await prepayPlan(req.params.planId, data);

    return res.status(200).json({
      success: true,
      message: "Payment initiated",
      data: {
        paymentRef: result.paymentRef,
        planId: result.planId,
        amount: result.amount,
        provider: result.provider,
        requiresPayerApproval: result.requiresPayerApproval ?? false,
        requiresOtp: result.requiresOtp ?? false,
        moolre: result.moolre,
        mtn: result.mtn,
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// SCHOOL COMPLIANCE OVERVIEW
// ─────────────────────────────────────────────
export const getSchoolComplianceController = async (req, res) => {
  try {
    const result = await getSchoolCompliance(
      req.params.schoolId,
      req.query,
      req.user
    );

    return res.status(200).json({
      success: true,
      message: "Compliance overview retrieved successfully",
      data: {
        summary: result.summary,
        plans: result.plans,
      },
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export const adminAcceptPaymentPlanController = async (req, res) => {
  try {
    const result = await adminAcceptPaymentPlan(req.params.planId, req.user);
    return res.status(200).json({ success: true, message: 'Plan activated', data: result });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

