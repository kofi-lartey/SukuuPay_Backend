import {
  initiateSubscriptionPayment,
  approveSubscriptionPayment,
  listPendingSubscriptionPayments,
} from "../services/subscriptionPayment.service.js";

export const initiateSubscriptionPaymentController = async (req, res) => {
  try {
    const { plan, monthlyFee } = req.body;
    const result = await initiateSubscriptionPayment(req.user.schoolId, {
      plan,
      monthlyFee,
    });

    return res.status(201).json({
      success: true,
      message: "Payment initiated. Pay via Mobile Money and await admin approval.",
      data: {
        referenceCode: result.referenceCode,
        payeePhone: result.payeePhone,
        expectedAmount: result.expectedAmount,
        manualPaymentId: result.manualPayment._id,
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code || "INTERNAL_ERROR",
    });
  }
};

export const approveSubscriptionPaymentController = async (req, res) => {
  try {
    const result = await approveSubscriptionPayment(
      req.params.id,
      req.user._id
    );

    return res.status(200).json({
      success: true,
      message: "Subscription payment approved and school activated.",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code || "INTERNAL_ERROR",
    });
  }
};

export const listPendingSubscriptionPaymentsController = async (req, res) => {
  try {
    const payments = await listPendingSubscriptionPayments();

    return res.status(200).json({
      success: true,
      data: payments,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code || "INTERNAL_ERROR",
    });
  }
};

export default {
  initiateSubscriptionPaymentController,
  approveSubscriptionPaymentController,
  listPendingSubscriptionPaymentsController,
};
