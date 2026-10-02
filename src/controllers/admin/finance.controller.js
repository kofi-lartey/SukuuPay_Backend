/**
 * Platform-console finance endpoints: disbursements and the money read side.
 *
 * Controllers are thin by rule (`SUKUU_ADMIN_CONVENTIONS.md` §3) — parse nothing,
 * decide nothing, call one service, shape the response — and the two things that
 * live here rather than in the service are both about **who did it**: the audit
 * entry, and the impersonation attribution on it.
 *
 * Neither could go in the service. `logRequest(req, …)` needs the request to fill
 * in ip and user-agent, and `req.impersonation` is set by middleware
 * (`middleware/impersonation.js:207`) which a service has no business knowing
 * about. The consequence is that the *rule* — every state change is audited, and
 * an impersonated request names the operator behind it — is enforced once per
 * handler here rather than once per write in the service, which is why the audit
 * calls are written out in full instead of being wrapped in a helper that could
 * be forgotten.
 */

import {
  buildDisbursementBatch,
  approveDisbursementBatch,
  retryDisbursementBatch,
  listDisbursements,
  getDisbursementBatch,
  getFinanceOverview,
} from "../../services/admin/disbursements.service.js";
import {
  listLedgerEntries,
  exportLedgerCsv,
  reconcileDay,
  listInvoices,
  getInvoicesForMonth,
} from "../../services/admin/finance.service.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import { logRequest as auditLog } from "../../utils/auditService.js";

/**
 * Fold impersonation attribution into an audit entry's `meta`.
 *
 * Required on **every** entry when `req.impersonation` is set, not just the ones
 * an auditor would think to check. The reason is that an impersonation entry
 * without these two fields is indistinguishable from a super admin acting
 * normally: same `userId`, same `action`, same everything. The only record that
 * an operator was looking at this school through this school's own banner is
 * these two fields, so leaving them off is how a read-only session quietly looks
 * like a normal one. The session id is included as well as the operator id
 * because a support session can be long — one operator, several sessions, one
 * afternoon — and "which session" is the question an investigation actually
 * asks.
 */
const withImpersonation = (req, meta = {}) => {
  if (!req?.impersonation) return meta;

  return {
    ...meta,
    impersonatedBy: String(req.impersonation.superAdminId),
    impersonationSessionId: String(req.impersonation.sessionId),
  };
};

// ─────────────────────────────────────────────
// POST /admin/finance/disbursements
// ─────────────────────────────────────────────
export const buildDisbursementBatchController = async (req, res) => {
  try {
    const batch = await buildDisbursementBatch(
      {
        schoolId: req.body?.schoolId,
        periodStart: req.body?.periodStart,
        periodEnd: req.body?.periodEnd,
      },
      req.user
    );

    await auditLog(req, {
      action: AUDIT_ACTIONS.ADMIN_DISBURSEMENT_CREATE,
      entity: "DisbursementBatch",
      entityId: batch._id,
      /*
       * `schoolId` is passed explicitly rather than left to `logRequest`, which
       * falls back to `req.user.schoolId` — and that is null for a super admin,
       * by design (`middleware/impersonation.js:141`). Without this the entry
       * would land in the platform log only, and the school's own activity feed
       * would show no trace of money being staged for it out of its own
       * collected payments. A school asking "why was my money held" is answered
       * from its own log.
       */
      schoolId: batch.schoolId,
      meta: withImpersonation(req, {
        batchNumber: batch.batchNumber,
        periodStart: batch.periodStart,
        periodEnd: batch.periodEnd,
        grossAmount: batch.grossAmount,
        platformAmount: batch.platformAmount,
        netAmount: batch.netAmount,
        paymentCount: batch.paymentCount,
        markupPercent: batch.breakdown?.markupPercent,
        status: batch.status,
      }),
    });

    return res.status(201).json({
      success: true,
      message: `Disbursement batch ${batch.batchNumber} created with ${batch.paymentCount} payment(s) awaiting approval`,
      data: batch,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// POST /admin/finance/disbursements/:batchId/approve
// ─────────────────────────────────────────────
export const approveDisbursementBatchController = async (req, res) => {
  try {
    const result = await approveDisbursementBatch(req.params.batchId, req.user, req);

    /*
     * Audited on the way out whatever the outcome.
     *
     * Not "only if it succeeded": the approval attempt is the event, and an
     * attempt that ended in a provider failure is *more* interesting than one
     * that worked — it is the row that answers "why does this school not have
     * their money". The service returns the batch either way (it parks the batch
     * rather than throwing on a provider failure), so this single call covers
     * paid, failed and parked-at-approved alike.
     *
     * The `status` in `meta` is the batch's status *after* the payout attempt,
     * not "approved", so the entry cannot claim a payout succeeded when the
     * status says otherwise.
     */
    await auditLog(req, {
      action: AUDIT_ACTIONS.ADMIN_DISBURSEMENT_APPROVE,
      entity: "DisbursementBatch",
      entityId: result.batch._id,
      schoolId: result.batch.schoolId,
      meta: withImpersonation(req, {
        batchNumber: result.batch.batchNumber,
        netAmount: result.batch.netAmount,
        grossAmount: result.batch.grossAmount,
        status: result.batch.status,
        attempts: result.batch.attempts,
        payoutReference: result.batch.payoutReference ?? null,
        payoutMovedMoney: result.paid,
        failureReason: result.batch.failureReason || null,
        approvedBy: result.batch.approvedBy ?? null,
        approvedByRule: result.batch.metadata?.approvedByRule ?? null,
      }),
    });

    return res.status(200).json({
      success: true,
      /*
       * The message states whether money actually moved, rather than reporting
       * "approved" either way. A console that says "Payout sent" for a batch no
       * provider has seen is the exact failure this section exists to avoid, so
       * the two outcomes are worded as the two different things they are.
       */
      message: result.paid
        ? `Batch ${result.batch.batchNumber} paid out to the school (${result.batch.payoutReference})`
        : `Batch ${result.batch.batchNumber} approved, but no payout provider is wired — the money has NOT been sent. See the comments in disbursements.service.js.`,
      data: result.batch,
      meta: {
        paid: result.paid,
        settled: result.settled,
        payoutReference: result.batch.payoutReference ?? null,
        payoutProviderWired: result.paid,
        failure: result.failure
          ? { message: result.failure.message, code: result.failure.code ?? null }
          : null,
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
// POST /admin/finance/disbursements/:batchId/retry
// ─────────────────────────────────────────────
export const retryDisbursementBatchController = async (req, res) => {
  try {
    const result = await retryDisbursementBatch(req.params.batchId, req.user);

    await auditLog(req, {
      action: AUDIT_ACTIONS.ADMIN_DISBURSEMENT_RETRY,
      entity: "DisbursementBatch",
      entityId: result.batch._id,
      schoolId: result.batch.schoolId,
      meta: withImpersonation(req, {
        batchNumber: result.batch.batchNumber,
        netAmount: result.batch.netAmount,
        grossAmount: result.batch.grossAmount,
        status: result.batch.status,
        attempts: result.batch.attempts,
        payoutReference: result.batch.payoutReference ?? null,
        payoutMovedMoney: result.paid,
        failureReason: result.batch.failureReason || null,
      }),
    });

    return res.status(200).json({
      success: true,
      message: result.paid
        ? `Batch ${result.batch.batchNumber} paid out on retry (${result.batch.payoutReference})`
        : `Batch ${result.batch.batchNumber} retried, but no payout provider is wired — the money has NOT been sent.`,
      data: result.batch,
      meta: {
        paid: result.paid,
        settled: result.settled,
        payoutReference: result.batch.payoutReference ?? null,
        payoutProviderWired: result.paid,
        failure: result.failure
          ? { message: result.failure.message, code: result.failure.code ?? null }
          : null,
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
// GET /admin/finance/disbursements
// ─────────────────────────────────────────────
export const listDisbursementsController = async (req, res) => {
  try {
    const result = await listDisbursements(req.query);

    return res.status(200).json({
      success: true,
      message: "Disbursement batches retrieved successfully",
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
// GET /admin/finance/disbursements/:batchId
// ─────────────────────────────────────────────
export const getDisbursementBatchController = async (req, res) => {
  try {
    const batch = await getDisbursementBatch(req.params.batchId);

    return res.status(200).json({
      success: true,
      message: "Disbursement batch retrieved successfully",
      data: batch,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /admin/finance/overview
// ─────────────────────────────────────────────
export const getFinanceOverviewController = async (req, res) => {
  try {
    const overview = await getFinanceOverview();

    return res.status(200).json({
      success: true,
      message: "Finance overview retrieved successfully",
      data: overview,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /admin/finance/ledger
// ─────────────────────────────────────────────
export const listLedgerEntriesController = async (req, res) => {
  try {
    const result = await listLedgerEntries(req.query);

    return res.status(200).json({
      success: true,
      message: "Platform ledger retrieved successfully",
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
// GET /admin/finance/ledger/export
// ─────────────────────────────────────────────
/*
 * The response headers — `Content-Type`, `Content-Disposition` and the
 * `X-Export-Truncated` notice — are set by the *service*, not here, because the
 * truncation count is only known once the rows are fetched and the stream has to
 * start immediately afterwards. See the comment on `exportLedgerCsv`.
 */
export const exportLedgerCsvController = async (req, res) => {
  try {
    const result = await exportLedgerCsv(res, {
      from: req.query?.from,
      to: req.query?.to,
      schoolId: req.query?.schoolId,
    });

    /*
     * The export leaves the platform, so it is audited like a write.
     *
     * `ADMIN_EXPORT` on a `GET` looks wrong until you remember what a `GET` does
     * here: it hands a complete, unfiltered-or-filtered copy of the platform's
     * revenue ledger to a file on somebody's disk, from which it can go to a
     * spreadsheet, an email, a shared drive and eventually a support ticket
     * attached to a public issue. The read endpoints are not audited because a
     * screen showing a row discloses no more than the screen did. A file does.
     * The row count is in the entry so the audit says *how much* left, which is
     * the difference between "exported the ledger" and "exported the ledger,
     * 12 March to 1 April, 48,000 rows" when somebody asks in six months.
     */
    await auditLog(req, {
      action: AUDIT_ACTIONS.ADMIN_EXPORT,
      entity: "PlatformLedger",
      entityId: null,
      meta: withImpersonation(req, {
        resource: "ledger",
        from: req.query?.from ?? null,
        to: req.query?.to ?? null,
        schoolId: req.query?.schoolId ?? null,
        rowCount: result.rowCount,
        truncated: result.truncated,
        cap: result.cap,
      }),
    });

    return undefined;
  } catch (error) {
    /*
     * `streamCsv` ends the response itself, so by the time an error is possible
     * the status line may already be on the wire. Sending a JSON error body at
     * that point would be appended to a CSV the client is already parsing, and
     * the file they get would be a financial report with a stack trace in the
     * middle of it. The `headersSent` check is the whole reason this catch block
     * is not a copy of every other one in the file.
     */
    if (!res.headersSent) {
      return res.status(error.status || 500).json({
        success: false,
        message: error.message,
      });
    }

    return res.end();
  }
};

// ─────────────────────────────────────────────
// GET /admin/finance/reconciliation
// ─────────────────────────────────────────────
export const reconcileDayController = async (req, res) => {
  try {
    const report = await reconcileDay(req.query?.date);

    return res.status(200).json({
      success: true,
      message: `Reconciliation report for ${report.date} generated`,
      data: report,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /admin/finance/invoices
// ─────────────────────────────────────────────
export const listInvoicesController = async (req, res) => {
  try {
    const result = await listInvoices(req.query);

    return res.status(200).json({
      success: true,
      message: `Invoices for ${result.month} retrieved successfully`,
      data: result.data,
      meta: { ...result.meta, totals: result.totals, month: result.month },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /admin/finance/invoices/:month
// ─────────────────────────────────────────────
export const getInvoicesForMonthController = async (req, res) => {
  try {
    const result = await getInvoicesForMonth(req.params.month);

    return res.status(200).json({
      success: true,
      message: `Invoices for ${result.month} retrieved successfully`,
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};
