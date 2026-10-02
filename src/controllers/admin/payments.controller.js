import {
  listAllPayments,
  getAdminPaymentDetail,
  refundPaymentAsPlatform,
  getPaymentStats,
  exportPaymentsCsv,
} from '../../services/admin/payments.service.js';
import { AUDIT_ACTIONS } from '../../config/constants.js';
import { logRequest as auditLog } from '../../utils/auditService.js';

/**
 * Platform-wide payment administration.
 *
 * Thin throughout. The one thing a controller here is not allowed to be is where a
 * business rule hides: every refusal is raised by the service with a status and a
 * `code`, so "you already refunded this" behaves the same whichever route reached it.
 */

/** `GET /admin/payments` — every payment on the platform. */
export const listAllPaymentsController = async (req, res) => {
  try {
    const result = await listAllPayments(req.query);

    return res.status(200).json({
      success: true,
      message: 'Payments retrieved successfully',
      data: result.data,
      totals: result.totals,
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/** `GET /admin/payments/:paymentId` — one payment in full. */
export const getAdminPaymentDetailController = async (req, res) => {
  try {
    const data = await getAdminPaymentDetail(req.params.paymentId);

    return res.status(200).json({
      success: true,
      message: 'Payment retrieved successfully',
      data,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * `POST /admin/payments/:paymentId/refund` — return money to a parent.
 *
 * Audited as `admin.payment_refund` here, and `refund.payment` again inside
 * `payment.service.js`'s own `refundPayment`. **Two entries on purpose.** The inner
 * one is what the school-facing path always wrote, and removing it would leave a gap
 * in the school's own history for a refund the platform processed; the outer one
 * carries what the inner one cannot — that it was the *platform owner* acting, which
 * school staff are entitled to know.
 *
 * `before`/`after` are the refundable balance rather than the payment's `status`,
 * because a partially refunded payment stays `completed` and a before/after of
 * `completed → completed` records nothing.
 *
 * `schoolId` is passed explicitly: a super admin's own `schoolId` is null, so the
 * `logRequest` fallback would file this against nobody and the school's activity log
 * would not record its own money being returned.
 */
export const refundPaymentAsPlatformController = async (req, res) => {
  try {
    const result = await refundPaymentAsPlatform(
      req.params.paymentId,
      req.body,
      req.user
    );

    await auditLog(req, {
      action: AUDIT_ACTIONS.ADMIN_PAYMENT_REFUND,
      entity: 'Payment',
      entityId: result.originalPayment?._id || req.params.paymentId,
      schoolId: result.originalPayment?.schoolId,
      before: { refundableAfter: (result.refundableAfter ?? 0) + Math.abs(Number(result.refundAmount) || 0) },
      after: { refundableAfter: result.refundableAfter },
      meta: {
        amount: result.refundAmount,
        reason: req.body?.reason,
        // The `paymentId` the caller passed is what support has in the URL; the
        // ObjectId is what every other audit entry refers to one another by.
        paymentRef: req.params.paymentId,
        reversalPaymentId: result.refundPayment?.paymentId || null,
        reversalObjectId: String(result.refundPayment?._id || ''),
        ledgerEntryId: String(result.ledgerEntry?._id || ''),
        fullyRefunded: result.refundableAfter === 0,
        ...(req.impersonation
          ? {
              impersonatedBy: String(req.impersonation.superAdminId),
              impersonationSessionId: String(req.impersonation.sessionId),
            }
          : {}),
      },
    });

    return res.status(200).json({
      success: true,
      message:
        result.refundableAfter === 0
          ? 'Payment fully refunded.'
          : `Refund recorded. ${result.refundableAfter} pesewas remain refundable on this payment.`,
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/** `GET /admin/payments/stats` — aggregates over a window. */
export const getPaymentStatsController = async (req, res) => {
  try {
    const data = await getPaymentStats(req.query);

    return res.status(200).json({
      success: true,
      message: 'Payment statistics retrieved successfully',
      data,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * `GET /admin/payments/export` — CSV download.
 *
 * Audited because it is the one read on this router that hands a copy of the whole
 * platform's payment history to one person and leaves the building. The entry is
 * written **after** the service has streamed the rows, because `rowCount` and
 * `truncated` are only known once the cap has been applied — and an export entry that
 * cannot say how much went out is not much of a record.
 */
export const exportPaymentsCsvController = async (req, res) => {
  try {
    const result = await exportPaymentsCsv(res, req.query);

    await auditLog(req, {
      action: AUDIT_ACTIONS.ADMIN_EXPORT,
      entity: 'Payment',
      entityId: null,
      meta: {
        resource: 'payments',
        from: req.query?.from || null,
        to: req.query?.to || null,
        schoolId: req.query?.schoolId ? String(req.query.schoolId) : null,
        rowCount: result.rowCount,
        truncated: result.truncated,
        cap: result.cap,
        ...(req.impersonation
          ? {
              impersonatedBy: String(req.impersonation.superAdminId),
              impersonationSessionId: String(req.impersonation.sessionId),
            }
          : {}),
      },
    });

    // No `res.json` — the service has already written the CSV and ended the response.
    // Returning a body here would corrupt the file.
    return undefined;
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export default {
  listAllPaymentsController,
  getAdminPaymentDetailController,
  refundPaymentAsPlatformController,
  getPaymentStatsController,
  exportPaymentsCsvController,
};