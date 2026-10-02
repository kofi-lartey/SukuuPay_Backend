import {
  getSmsOverview,
  getSmsCredits,
  recordSmsCreditTopUp,
  listSmsLogs,
  broadcastToSchoolAdmins,
} from '../../services/admin/sms.service.js';
import { AUDIT_ACTIONS } from '../../config/constants.js';
import { logRequest as auditLog } from '../../utils/auditService.js';

/**
 * Platform SMS administration.
 *
 * Thin throughout: parse nothing, decide nothing, call one service, shape the
 * response. The one thing a controller here is not allowed to be is a place where a
 * business rule hides — every refusal in this file is raised by the service with a
 * status and a `code`, so the same rule behaves identically whichever route reaches
 * it.
 */

/**
 * `GET /admin/sms/overview`
 *
 * No audit entry. It is a read, and the ones this console does audit are the ones
 * that let data *leave* — exports and broadcasts.
 */
export const getSmsOverviewController = async (req, res) => {
  try {
    const data = await getSmsOverview(req.query);

    return res.status(200).json({
      success: true,
      message: 'SMS overview retrieved successfully',
      data,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/** `GET /admin/sms/credits` — the per-school credit position. */
export const getSmsCreditsController = async (req, res) => {
  try {
    const data = await getSmsCredits(req.query);

    return res.status(200).json({
      success: true,
      message: 'SMS credits retrieved successfully',
      data,
      meta: data.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * `POST /admin/sms/credits/topup` — record credit arriving.
 *
 * Audited because it moves money-adjacent value: a school's SMS balance is
 * something they can see and reconcile against an invoice. The `meta` records which
 * of the two shapes this was — credit granted to named schools, or a platform-level
 * credit note that credited nobody — because those two are indistinguishable in the
 * response's happy path and only one of them changed a balance.
 */
export const recordSmsCreditTopUpController = async (req, res) => {
  try {
    const result = await recordSmsCreditTopUp(req.body, req.user);

    await auditLog(req, {
      action: AUDIT_ACTIONS.ADMIN_SMS_CREDIT_TOPUP,
      entity: 'SmsCreditTopUp',
      entityId: null,
      meta: {
        units: result.units,
        creditedSchools: result.creditedSchools,
        platformCreditNote: result.platformCreditNote === true,
        schoolIds: (req.body?.schoolIds || []).map(String),
        note: req.body?.note || '',
        ...(req.impersonation
          ? {
              impersonatedBy: String(req.impersonation.superAdminId),
              impersonationSessionId: String(req.impersonation.sessionId),
            }
          : {}),
      },
    });

    return res.status(201).json({
      success: true,
      message: result.platformCreditNote
        ? 'Platform credit note recorded. No school was credited.'
        : `Credit added to ${result.creditedSchools} school${result.creditedSchools === 1 ? '' : 's'}.`,
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/** `GET /admin/sms/logs` — delivery history across every school. */
export const listSmsLogsController = async (req, res) => {
  try {
    const result = await listSmsLogs(req.query);

    return res.status(200).json({
      success: true,
      message: 'SMS history retrieved successfully',
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

/**
 * `POST /admin/sms/broadcast` — send a message to school administrators.
 *
 * Audited before the response, and the `meta` is what makes the entry useful later:
 * the resolved recipient count, the school count, the segment count, and the
 * per-status split. A broadcast audit entry that recorded only "sent: true" could
 * not answer the question that actually gets asked — "did every school's admin
 * receive it?" — and that question is asked after an incident, not before one.
 *
 * `impersonatedBy` is included even though the impersonation middleware refuses
 * writes, so the shape is uniform across every audit entry in the console and a
 * future route on the allowlist cannot be the one that forgets it.
 */
export const broadcastToSchoolAdminsController = async (req, res) => {
  try {
    const result = await broadcastToSchoolAdmins(req.body, req.user);

    await auditLog(req, {
      action: AUDIT_ACTIONS.ADMIN_SMS_BROADCAST,
      entity: 'SmsBroadcast',
      entityId: null,
      meta: {
        targetAudience: req.body?.targetAudience,
        schoolIds: (req.body?.schoolIds || []).map(String),
        // The body is recorded. This is the one audit entry in the product that
        // keeps the message text, and deliberately so: an operator who sent 400
        // people a wrong instruction needs to be able to reconstruct exactly what
        // they were told, and "a broadcast happened" cannot do that.
        message: req.body?.message,
        recipients: result.recipients,
        schools: result.schools,
        sent: result.sent,
        failed: result.failed,
        segmentsTotal: result.segmentsTotal,
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
      message: result.failed
        ? `Broadcast queued for ${result.recipients} administrators; ${result.failed} could not be sent.`
        : `Broadcast sent to ${result.recipients} administrators across ${result.schools} schools.`,
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.meta ? { meta: error.meta } : {}),
    });
  }
};

export default {
  getSmsOverviewController,
  getSmsCreditsController,
  recordSmsCreditTopUpController,
  listSmsLogsController,
  broadcastToSchoolAdminsController,
};