import express from 'express';

import { authenticate, authorize } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { handleImpersonation } from '../middleware/impersonation.js';

import {
  getDashboardKpis,
  listAllSchools,
  getSchoolUsage,
  suspendSchoolPlatform,
  unsuspendSchoolPlatform,
  getPlatformRevenue,
  getRevenueSeries,
  getPlatformSmsBalance,
  getPlatformSettings,
  updatePlatformSettings,
  updateCommission,
  updateDisbursementSettings,
} from '../services/admin.service.js';
import {
  getDashboardKpisController,
  listAllSchoolsController,
  getSchoolUsageController,
  suspendSchoolPlatformController,
  unsuspendSchoolPlatformController,
  getPlatformRevenueController,
  getRevenueSeriesController,
  getPlatformSmsBalanceController,
  getPlatformSettingsController,
  updatePlatformSettingsController,
  updateCommissionController,
  updateDisbursementSettingsController,
} from '../controllers/admin.controller.js';

/**
 * The school-ad moderation handlers live in `controllers/schoolAd.controller.js`
 * rather than in `admin.controller.js`, next to their public-facing siblings in the
 * same file — and they are imported here from there.
 *
 * Worth noting because it was a live boot failure: `admin.routes.js` previously
 * imported `listSchoolAds`/`createSchoolAd`/`updateSchoolAd`/`reviewSchoolAd`/
 * `deleteSchoolAd` from `services/admin.service.js`, which exports none of them.
 * ESM named imports are resolved at load time, so the whole `/admin` router — and
 * with it `routes/index.js` and therefore the entire application — threw
 * `SyntaxError: does not provide an export named 'listSchoolAds'` on start. Nothing
 * in the test suite caught it because every test that touched this file read it as a
 * source string rather than importing it, which is a gap in the tests rather than in
 * the router.
 */
import {
  listSchoolAds,
  createSchoolAd,
  updateSchoolAd,
  reviewSchoolAd,
  deleteSchoolAd,
} from '../controllers/schoolAd.controller.js';
import { uploadSchoolAd } from '../middleware/upload.js';
import {
  listSchoolAdsQuerySchema,
  createSchoolAdSchema,
  updateSchoolAdSchema,
  approveSchoolAdSchema,
  schoolAdIdParamSchema,
} from '../validations/schoolAd.validation.js';
import {
  listAllRequests,
  approveSmsRequest,
  rejectSmsRequest,
  markSmsRequestRefunded,
  getPlatformSmsPool,
  recordPoolTopUp,
} from '../services/smsPurchaseRequest.service.js';
import {
  poolTopUpSchema,
  rejectSmsRequestSchema,
  markRefundedSchema,
  smsRequestIdParamSchema,
} from '../validations/smsRequest.validation.js';

// ── Platform console: schools and users ────────────────────────────────────
import {
  getAdminSchoolDetailController,
  createSchoolAsPlatformController,
  updateSchoolAsPlatformController,
  updateSchoolMarkupController,
  updateSchoolPlatformFeeController,
  updateSchoolGatewayModeController,
  updateSchoolSubscriptionController,
  updateSchoolFeatureFlagsController,
  updateSchoolTagsController,
  updateSchoolInternalNotesController,
  archiveSchoolAsPlatformController,
} from '../controllers/admin/schools.controller.js';
import {
  listAllUsersController,
  getAdminUserDetailController,
  updateUserRoleAsPlatformController,
  updateUserStatusAsPlatformController,
  resetUserPasswordAsPlatformController,
  resendUserVerificationAsPlatformController,
} from '../controllers/admin/users.controller.js';

// ── Platform console: impersonation ────────────────────────────────────────
import {
  startImpersonationController,
  endImpersonationController,
  listImpersonationSessionsController,
  getImpersonationSessionController,
} from '../controllers/admin/impersonation.controller.js';

// ── Platform console: money ────────────────────────────────────────────────
import {
  getFinanceOverviewController,
  listLedgerEntriesController,
  exportLedgerCsvController,
  listDisbursementsController,
  getDisbursementBatchController,
  buildDisbursementBatchController,
  approveDisbursementBatchController,
  retryDisbursementBatchController,
  reconcileDayController,
  listInvoicesController,
  getInvoicesForMonthController,
} from '../controllers/admin/finance.controller.js';
import {
  listAllPaymentsController,
  getAdminPaymentDetailController,
  refundPaymentAsPlatformController,
  getPaymentStatsController,
  exportPaymentsCsvController,
} from '../controllers/admin/payments.controller.js';

// ── Platform console: messaging ────────────────────────────────────────────
import {
  getSmsOverviewController,
  getSmsCreditsController,
  recordSmsCreditTopUpController,
  listSmsLogsController,
  broadcastToSchoolAdminsController,
} from '../controllers/admin/sms.controller.js';
import {
  listAnnouncementsController,
  getAnnouncementController,
  createAnnouncementController,
  updateAnnouncementController,
  deactivateAnnouncementController,
} from '../controllers/admin/announcements.controller.js';

// ── Platform console: oversight ────────────────────────────────────────────
import {
  listPlatformAuditLogsController,
  exportPlatformAuditLogsCsvController,
  getUserAuditTrailController,
  getImpersonationSessionAuditController,
  getAuditLogByIdController,
} from '../controllers/admin/auditLogs.controller.js';
import {
  getSystemHealthController,
  getJobRunsController,
  getRecentErrorsController,
  setMaintenanceModeController,
} from '../controllers/admin/health.controller.js';

// ── Platform console: analytics and reports ────────────────────────────────
import {
  getPlatformOverviewController,
  getRevenueAnalyticsController,
  getSchoolsAnalyticsController,
  getUsageAnalyticsController,
  getCollectionRateAnalyticsController,
  getGatewayMixAnalyticsController,
  getTopSchoolsAnalyticsController,
  getAtRiskSchoolsController,
} from '../controllers/admin/analytics.controller.js';
import {
  getPlatformRevenueReportController,
  getSchoolPerformanceReportController,
  getGrowthReportController,
  getChurnReportController,
  exportReportController,
} from '../controllers/admin/reports.controller.js';

import {
  listAllSchoolsQuerySchema,
  revenueQuerySchema,
  suspendSchema,
  revenueSeriesQuerySchema,
  updatePlatformSettingsSchema,
  updateCommissionSchema,
  updateDisbursementSettingsSchema,
  schoolIdParamSchema,
} from '../validations/admin.validation.js';
import {
  schoolIdParamSchema as schoolSchoolIdParamSchema,
  createSchoolAsPlatformSchema,
  updateSchoolAsPlatformSchema,
  updateMarkupSchema,
  updatePlatformFeeSchema,
  updateGatewayModeSchema,
  updateSubscriptionSchema,
  updateFeatureFlagsSchema,
  updateTagsSchema,
  updateInternalNotesSchema,
} from '../validations/admin.schools.validation.js';
import {
  userIdParamSchema,
  listAdminUsersQuerySchema,
  updateUserRoleAsPlatformSchema,
  updateUserStatusAsPlatformSchema,
} from '../validations/admin.users.validation.js';
import {
  startImpersonationSchema,
  listImpersonationSessionsQuerySchema,
  impersonationSessionIdParamSchema,
} from '../validations/admin.impersonation.validation.js';
import {
  createDisbursementBatchSchema,
  batchIdParamSchema,
  listDisbursementsQuerySchema,
  listLedgerQuerySchema,
  exportLedgerQuerySchema,
  reconciliationQuerySchema,
  listInvoicesQuerySchema,
  invoiceMonthParamSchema,
} from '../validations/admin.finance.validation.js';
import {
  listPaymentsQuerySchema,
  paymentIdParamSchema,
  refundSchema,
  paymentStatsQuerySchema,
  exportPaymentsQuerySchema,
} from '../validations/admin.payments.validation.js';
import {
  listSmsLogsQuerySchema,
  recordSmsCreditTopUpSchema,
  broadcastToSchoolAdminsSchema,
} from '../validations/admin.sms.validation.js';
import {
  announcementIdParamSchema,
  listAnnouncementsQuerySchema,
  createAnnouncementSchema,
  updateAnnouncementSchema,
} from '../validations/admin.announcements.validation.js';
import {
  listPlatformAuditLogsQuerySchema,
  exportPlatformAuditLogsQuerySchema,
  userAuditTrailQuerySchema,
  impersonationAuditQuerySchema,
  auditUserIdParamSchema,
  auditSessionIdParamSchema,
  auditLogIdParamSchema,
} from '../validations/admin.auditLogs.validation.js';
import { setMaintenanceModeSchema, recentErrorsQuerySchema } from '../validations/admin.health.validation.js';
import {
  revenueAnalyticsQuerySchema,
  schoolsAnalyticsQuerySchema,
  usageAnalyticsQuerySchema,
  collectionRateQuerySchema,
  gatewayMixQuerySchema,
  topSchoolsQuerySchema,
  atRiskSchoolsQuerySchema,
  reportQuerySchema,
  reportExportQuerySchema,
} from '../validations/admin.analytics.validation.js';

const adminRoute = express.Router();

/**
 * The platform console. Mounted at `/api/admin` from `routes/index.js` and again
 * from `index.js`, so **nothing in here may hard-code its own mount prefix** —
 * see the comment on `isWriteAllowed` in `middleware/impersonation.js` for the
 * bug that came from doing exactly that.
 *
 * `authenticate` then `authorize('super_admin')` are applied to the router itself
 * rather than per route. There is no un-guarded route in this file, and the
 * cheapest way to guarantee that is for the gate to sit above the routes rather
 * than beside them: a new handler is guarded by being *added*, not by remembering
 * to add a middleware.
 */
adminRoute.use(authenticate, authorize('super_admin'));

/**
 * The impersonation boundary, and **before every route below it.**
 *
 * Mounted here rather than per route for the same reason the gate above is: a rule
 * that has to be repeated on each registration is a rule the next person forgets.
 * It re-reads the open session on every request, so ending an impersonation takes
 * effect for every token already in circulation rather than only for the client
 * that asked to exit.
 *
 * Order is load-bearing in both directions. Before the routes, so nothing below can
 * be reached without passing it; and the two `/impersonate` paths below are ordered
 * so that `/impersonate/end` is matched before `/impersonate/:schoolId` — both are
 * two segments, so the wildcard would otherwise capture the exit.
 */
adminRoute.use(handleImpersonation);

/**
 * Rate limits, named once.
 *
 * All keyed by `user`, never by IP: every route here is behind `super_admin`, there
 * is exactly one such account, and an IP key would mean a shared office or a mobile
 * network could exhaust the platform owner's own budget by coincidence.
 *
 * The ceilings are chosen against the largest real operation, not against "what is
 * too many requests":
 *
 *   - **30/hour on a disbursement approval** still permits a weekly run of forty
 *     schools by a human, with room for a second attempt.
 *   - **10/hour on impersonation** is about credentials. An impersonation token is
 *     a live key into a tenant's data, and ten is more than any support call needs
 *     while being far too few to sweep through the customer list.
 *   - **20/hour on suspend** because suspending cascades to every account in a
 *     school. An operator who hit that ceiling was automating it, and should be
 *     caught rather than served.
 */
const limits = {
  impersonate: rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyBy: 'user',
    message: 'Too many impersonation sessions. Try again in an hour.',
  }),
  approve: rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    keyBy: 'user',
    message: 'Too many disbursement approvals. Try again in an hour.',
  }),
  suspend: rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    keyBy: 'user',
    message: 'Too many school suspensions. Try again in an hour.',
  }),
  broadcast: rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    keyBy: 'user',
    message: 'Too many broadcasts. A broadcast cannot be recalled, so this is deliberately strict.',
  }),
  export: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyBy: 'user',
    message: 'Too many exports. Try again shortly.',
  }),
  write: rateLimit({ windowMs: 15 * 60 * 1000, max: 60, keyBy: 'user' }),
};

// ═══════════════════════════════════════════════════════════════════════════
// Platform overview
// ═══════════════════════════════════════════════════════════════════════════

adminRoute.get('/dashboard', getDashboardKpisController);
adminRoute.get('/revenue', validate(revenueQuerySchema, 'query'), getPlatformRevenueController);
adminRoute.get('/revenue/series', validate(revenueSeriesQuerySchema, 'query'), getRevenueSeriesController);
adminRoute.get('/sms-balance', getPlatformSmsBalanceController);

/**
 * `GET /admin/overview` — the console's headline payload.
 *
 * Distinct from `/dashboard`, which predates it and aggregates payments only. This
 * one adds MRR, ARR, churn and growth, all of which are properties of the
 * *subscription* base rather than of any single payment, which is why they could not
 * be derived from the older endpoint. Both exist because the Overview screen shows
 * both: transaction figures on top, subscription economics beneath them.
 */
adminRoute.get('/overview', getPlatformOverviewController);

// ═══════════════════════════════════════════════════════════════════════════
// Schools
// ═══════════════════════════════════════════════════════════════════════════

adminRoute.get('/schools', validate(listAllSchoolsQuerySchema, 'query'), listAllSchoolsController);

/**
 * **Registered before `/schools/:id` and its sub-resources below.** Express matches
 * in order, so a `/schools/:id` registered first would swallow every `/schools/x/y`
 * as an id of `x` and a trailing segment of `y`. A route added below this comment
 * must go above the wildcard.
 */
adminRoute.post(
  '/schools',
  limits.write,
  validate(createSchoolAsPlatformSchema),
  createSchoolAsPlatformController
);

adminRoute.get('/schools/:id', validate(schoolSchoolIdParamSchema, 'params'), getAdminSchoolDetailController);
adminRoute.put(
  '/schools/:id',
  limits.write,
  validate(schoolSchoolIdParamSchema, 'params'),
  validate(updateSchoolAsPlatformSchema),
  updateSchoolAsPlatformController
);

adminRoute.put(
  '/schools/:id/markup',
  limits.write,
  validate(schoolSchoolIdParamSchema, 'params'),
  validate(updateMarkupSchema),
  updateSchoolMarkupController
);
adminRoute.put(
  '/schools/:id/platform-fee',
  limits.write,
  validate(schoolSchoolIdParamSchema, 'params'),
  validate(updatePlatformFeeSchema),
  updateSchoolPlatformFeeController
);
adminRoute.put(
  '/schools/:id/gateway-mode',
  limits.write,
  validate(schoolSchoolIdParamSchema, 'params'),
  validate(updateGatewayModeSchema),
  updateSchoolGatewayModeController
);
adminRoute.put(
  '/schools/:id/subscription',
  limits.write,
  validate(schoolSchoolIdParamSchema, 'params'),
  validate(updateSubscriptionSchema),
  updateSchoolSubscriptionController
);
adminRoute.put(
  '/schools/:id/feature-flags',
  limits.write,
  validate(schoolSchoolIdParamSchema, 'params'),
  validate(updateFeatureFlagsSchema),
  updateSchoolFeatureFlagsController
);
adminRoute.put(
  '/schools/:id/tags',
  limits.write,
  validate(schoolSchoolIdParamSchema, 'params'),
  validate(updateTagsSchema),
  updateSchoolTagsController
);
adminRoute.put(
  '/schools/:id/notes',
  limits.write,
  validate(schoolSchoolIdParamSchema, 'params'),
  validate(updateInternalNotesSchema),
  updateSchoolInternalNotesController
);

/**
 * `DELETE /schools/:id` — archive, not destroy.
 *
 * The `schoolIdParamSchema` used here is the one from `admin.validation.js` rather
 * than the schools module's, only because both validate the same shape and this
 * route predates the split. Either works; what matters is that both are applied.
 */
adminRoute.delete(
  '/schools/:id',
  limits.suspend,
  validate(schoolIdParamSchema, 'params'),
  archiveSchoolAsPlatformController
);

adminRoute.get('/schools/:id/usage', getSchoolUsageController);

/**
 * School advertisement moderation.
 *
 * ## These five paths were wrong, and nothing caught it
 *
 * They were registered as `/schools/:id/settings…`, which is three segments. The
 * client in `frontend/src/services/admin.js` calls `/admin/school-ads`,
 * `/admin/school-ads/:adId`, `/admin/school-ads/:adId/approve` and
 * `/admin/school-ads/:adId` — two segments, and a different action name (`approve`,
 * not `review`). `GET /api/admin/school-ads` therefore matched no registered route and
 * the moderation queue answered **`404 Route not found`** against the real API while
 * working perfectly under `VITE_USE_MOCKS`, because the mock router had the client's
 * paths all along. The three mocked routes were the evidence that the mismatch was
 * real and not a stale client.
 *
 * The old paths are **removed rather than kept as aliases.** Two working paths for one
 * resource is how they drifted in the first place; the next client would have had a
 * 50/50 chance of picking the wrong one and no test to tell it.
 *
 * ## Validation was missing entirely
 *
 * All five handlers were mounted with no `validate(...)` at all, so the schemas in
 * `validations/schoolAd.validation.js` were written and never used. That file is the
 * only place `linkUrl` is restricted to `https` — without it, a `javascript:` URL
 * submitted here renders on the login and signup pages of every visitor. The schemas
 * are wired below, which is what makes that guarantee real.
 *
 * `uploadSchoolAd` runs before `validate` because multer must parse the multipart
 * body before Joi can read the text fields. It is `.single("image")`, so a JSON
 * submission with an `imageUrl` still passes through untouched.
 */
adminRoute.get(
  '/school-ads',
  validate(listSchoolAdsQuerySchema, 'query'),
  listSchoolAds
);
adminRoute.post(
  '/school-ads',
  uploadSchoolAd,
  validate(createSchoolAdSchema),
  createSchoolAd
);
adminRoute.put(
  '/school-ads/:adId',
  uploadSchoolAd,
  validate(schoolAdIdParamSchema, 'params'),
  validate(updateSchoolAdSchema),
  updateSchoolAd
);
/*
 * Declared before the two-segment siblings above would matter if they were reordered —
 * `/school-ads/:adId/approve` and `/school-ads/:adId` are both two-segment paths
 * under the same prefix, and Express matches them independently, so this is safe in
 * either order. It is written out in path order anyway.
 */
adminRoute.put(
  '/school-ads/:adId/approve',
  validate(schoolAdIdParamSchema, 'params'),
  validate(approveSchoolAdSchema),
  reviewSchoolAd
);
adminRoute.delete(
  '/school-ads/:adId',
  validate(schoolAdIdParamSchema, 'params'),
  deleteSchoolAd
);

/**
 * Suspension, on the *existing* handler rather than the platform-console one.
 *
 * `suspendSchema` requires a 10-character minimum reason, and that is the whole
 * design: the reason is what every signed-out member of that school is told, and
 * "testing" is not a reason. The platform console reaches the same code path here
 * deliberately — a second implementation would be a second set of rules for the
 * most consequential action in the console.
 */
adminRoute.put(
  '/schools/:id/suspend',
  limits.suspend,
  validate(suspendSchema),
  suspendSchoolPlatformController
);
adminRoute.put('/schools/:id/unsuspend', limits.suspend, unsuspendSchoolPlatformController);

// ═══════════════════════════════════════════════════════════════════════════
// Users across every school
// ═══════════════════════════════════════════════════════════════════════════

adminRoute.get('/users', validate(listAdminUsersQuerySchema, 'query'), listAllUsersController);
adminRoute.get('/users/:id', validate(userIdParamSchema, 'params'), getAdminUserDetailController);
adminRoute.put(
  '/users/:id/role',
  limits.write,
  validate(userIdParamSchema, 'params'),
  validate(updateUserRoleAsPlatformSchema),
  updateUserRoleAsPlatformController
);
adminRoute.put(
  '/users/:id/status',
  limits.write,
  validate(userIdParamSchema, 'params'),
  validate(updateUserStatusAsPlatformSchema),
  updateUserStatusAsPlatformController
);

/**
 * **Deliberately not rate-limited by the shared `write` budget.** These mint a
 * credential path: a reset link is a bearer token for somebody's account, and
 * re-sending one is the first move in an account-takeover attempt. Ten per hour is
 * far more than any support call needs and far too few for a sweep.
 */
adminRoute.post(
  '/users/:id/reset-password',
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyBy: 'user',
    message: 'Too many password resets. Try again in an hour.',
  }),
  validate(userIdParamSchema, 'params'),
  resetUserPasswordAsPlatformController
);
adminRoute.post(
  '/users/:id/resend-verification',
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyBy: 'user',
    message: 'Too many verification emails. Try again in an hour.',
  }),
  validate(userIdParamSchema, 'params'),
  resendUserVerificationAsPlatformController
);

// ═══════════════════════════════════════════════════════════════════════════
// Impersonation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `/impersonate/end` **before** `/impersonate/:schoolId`.
 *
 * Both are two segments, so registering the wildcard first would capture `end` as
 * a school id and 422 on it — and the operator would be unable to leave a session
 * by the one route that exists to let them. This is the same ordering rule as the
 * `/schools` block above, and it is worth stating because the failure is silent in
 * the worst way: the console keeps working and the exit button does nothing.
 */
adminRoute.post('/impersonate/end', limits.impersonate, endImpersonationController);

adminRoute.get(
  '/impersonate/sessions',
  validate(listImpersonationSessionsQuerySchema, 'query'),
  listImpersonationSessionsController
);
adminRoute.get(
  '/impersonate/sessions/:id',
  validate(impersonationSessionIdParamSchema, 'params'),
  getImpersonationSessionController
);
adminRoute.post(
  '/impersonate/:schoolId',
  limits.impersonate,
  validate(startImpersonationSchema),
  startImpersonationController
);

// ═══════════════════════════════════════════════════════════════════════════
// Finance
// ═══════════════════════════════════════════════════════════════════════════

adminRoute.get('/finance/overview', getFinanceOverviewController);
adminRoute.get('/finance/ledger', validate(listLedgerQuerySchema, 'query'), listLedgerEntriesController);

/**
 * `GET /finance/ledger/export` — a `GET`, not a `POST`.
 *
 * The brief assumed `POST` "because it takes a body". A CSV export takes query
 * parameters and produces nothing, and `GET` is what makes it cacheable-by-header,
 * linkable and safe to retry. It also means the impersonation middleware — which
 * only ever blocks write methods — permits it without an allowlist entry, which is
 * exactly the situation an allowlist entry was wrongly added for once already.
 */
adminRoute.get(
  '/finance/ledger/export',
  limits.export,
  validate(exportLedgerQuerySchema, 'query'),
  exportLedgerCsvController
);

adminRoute.get(
  '/finance/disbursements',
  validate(listDisbursementsQuerySchema, 'query'),
  listDisbursementsController
);

/** Creation is a `POST` to the collection, not to `/create`. */
adminRoute.post(
  '/finance/disbursements',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyBy: 'user',
    message: 'Too many batches built. Please try again later.',
  }),
  validate(createDisbursementBatchSchema),
  buildDisbursementBatchController
);

/** Registered after the collection `POST` for the same reason as `/impersonate`. */
adminRoute.post(
  '/finance/disbursements/:batchId/approve',
  limits.approve,
  validate(batchIdParamSchema, 'params'),
  approveDisbursementBatchController
);
adminRoute.post(
  '/finance/disbursements/:batchId/retry',
  rateLimit({ windowMs: 60 * 60 * 1000, max: 30, keyBy: 'user' }),
  validate(batchIdParamSchema, 'params'),
  retryDisbursementBatchController
);
adminRoute.get(
  '/finance/disbursements/:batchId',
  validate(batchIdParamSchema, 'params'),
  getDisbursementBatchController
);

adminRoute.get('/finance/reconciliation', validate(reconciliationQuerySchema, 'query'), reconcileDayController);
adminRoute.get('/finance/invoices', validate(listInvoicesQuerySchema, 'query'), listInvoicesController);
adminRoute.get(
  '/finance/invoices/:month',
  validate(invoiceMonthParamSchema, 'params'),
  getInvoicesForMonthController
);

// ═══════════════════════════════════════════════════════════════════════════
// Payments
// ═══════════════════════════════════════════════════════════════════════════

adminRoute.get('/payments', validate(listPaymentsQuerySchema, 'query'), listAllPaymentsController);
adminRoute.get('/payments/stats', validate(paymentStatsQuerySchema, 'query'), getPaymentStatsController);
adminRoute.get('/payments/export', limits.export, validate(exportPaymentsQuerySchema, 'query'), exportPaymentsCsvController);

/**
 * A refund is the one write here that takes money back out of a parent's pocket,
 * and the rate limit is tight for that reason rather than for the database: twenty
 * an hour is well past what support needs and well short of what a compromised
 * session would use to drain accounts.
 */
adminRoute.post(
  '/payments/:paymentId/refund',
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    keyBy: 'user',
    message: 'Too many refunds. Try again in an hour.',
  }),
  validate(paymentIdParamSchema, 'params'),
  validate(refundSchema),
  refundPaymentAsPlatformController
);
adminRoute.get('/payments/:paymentId', validate(paymentIdParamSchema, 'params'), getAdminPaymentDetailController);

// ═══════════════════════════════════════════════════════════════════════════
// SMS
// ═══════════════════════════════════════════════════════════════════════════

adminRoute.get('/sms/overview', getSmsOverviewController);
adminRoute.get('/sms/credits', getSmsCreditsController);

// ── Regulated SMS credit purchase ──
//
// The console side of `smsRequest.routes.js`: the pool the platform allocates from, and
// the queue of schools waiting for an approval. Inherits `authorize('super_admin')`
// from the router above, which is the point of the feature — the whole design is that
// money arriving does not release units on its own.
//
// Order is deliberate. `/sms/pool/topup` and `/sms/requests/:requestId/approve` are
// both longer than `/sms/overview`, and Express matches in declaration order, so the
// literals are declared before the parameterised sibling they would otherwise shadow.

adminRoute.get('/sms/pool', async (req, res) => {
  try {
    return res.status(200).json({ success: true, data: await getPlatformSmsPool() });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

adminRoute.post(
  '/sms/pool/topup',
  limits.write,
  validate(poolTopUpSchema),
  async (req, res) => {
    try {
      const result = await recordPoolTopUp(req.body, req.user);
      return res.status(201).json({
        success: true,
        message: `${result.entry.units.toLocaleString('en-GB')} units added to the pool`,
        data: { entry: result.entry, availableUnits: result.availableUnits },
      });
    } catch (error) {
      return res
        .status(error.status || 500)
        .json({ success: false, message: error.message });
    }
  }
);

adminRoute.get('/sms/requests', async (req, res) => {
  try {
    const { page, perPage, status } = req.query;
    const result = await listAllRequests({
      status,
      page: Number(page) || 1,
      perPage: Math.min(Number(perPage) || 20, 100),
    });

    return res.status(200).json({
      success: true,
      data: result.rows,
      meta: {
        page: result.page,
        perPage: result.perPage,
        total: result.total,
        totalPages: Math.ceil(result.total / result.perPage),
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

adminRoute.post(
  '/sms/requests/:requestId/approve',
  limits.write,
  validate(smsRequestIdParamSchema, 'params'),
  async (req, res) => {
    try {
      const result = await approveSmsRequest(req.params.requestId, req.user);

      // 200 rather than 201 on the second call: nothing was created, and a double-click
      // is a UI event, not a second approval.
      return res.status(200).json({
        success: true,
        message: result.alreadyApproved
          ? 'This request was already approved'
          : `${result.request.units.toLocaleString('en-GB')} units released to ${
              result.schoolBalance.toLocaleString('en-GB')
            } total balance`,
        data: {
          requestId: result.request.requestId,
          schoolBalance: result.schoolBalance,
          alreadyApproved: result.alreadyApproved,
        },
      });
    } catch (error) {
      return res
        .status(error.status || 500)
        .json({ success: false, message: error.message });
    }
  }
);

adminRoute.post(
  '/sms/requests/:requestId/reject',
  limits.write,
  validate(smsRequestIdParamSchema, 'params'),
  validate(rejectSmsRequestSchema),
  async (req, res) => {
    try {
      const result = await rejectSmsRequest(req.params.requestId, req.body, req.user);

      return res.status(200).json({
        success: true,
        message:
          'Request declined. The school has been told why, and the payment can now be refunded.',
        data: {
          requestId: result.request.requestId,
          alreadyRejected: result.alreadyRejected,
        },
      });
    } catch (error) {
      return res
        .status(error.status || 500)
        .json({ success: false, message: error.message });
    }
  }
);

/**
 * Recording that a refund was issued — deliberately *not* performing one.
 *
 * Reversing a school administrator's MoMo payment is a support operation with its own
 * confirmation at the gateway, and it is not something that should happen as a side
 * effect of a state transition. So an operator performs it and records it here, which
 * is what the school and the next support conversation both need to see.
 */
adminRoute.post(
  '/sms/requests/:requestId/refund',
  limits.write,
  validate(smsRequestIdParamSchema, 'params'),
  validate(markRefundedSchema),
  async (req, res) => {
    try {
      const result = await markSmsRequestRefunded(
        req.params.requestId,
        req.body.refundReference,
        req.user
      );

      return res.status(200).json({
        success: true,
        message: result.alreadyRefunded
          ? 'A refund was already recorded for this request'
          : 'Refund recorded',
        data: { requestId: result.request.requestId },
      });
    } catch (error) {
      return res
        .status(error.status || 500)
        .json({ success: false, message: error.message });
    }
  }
);
adminRoute.post(
  '/sms/credits/topup',
  limits.write,
  validate(recordSmsCreditTopUpSchema),
  recordSmsCreditTopUpController
);
adminRoute.get('/sms/logs', validate(listSmsLogsQuerySchema, 'query'), listSmsLogsController);

/**
 * Metered SMS to real phones, from a real provider, which cannot be recalled once
 * the provider accepts it. Five an hour is generous for announcements and far too
 * few for a sweep.
 */
adminRoute.post(
  '/sms/broadcast',
  limits.broadcast,
  validate(broadcastToSchoolAdminsSchema),
  broadcastToSchoolAdminsController
);

// ═══════════════════════════════════════════════════════════════════════════
// Announcements
// ═══════════════════════════════════════════════════════════════════════════

adminRoute.get('/announcements', validate(listAnnouncementsQuerySchema, 'query'), listAnnouncementsController);
adminRoute.post('/announcements', limits.write, validate(createAnnouncementSchema), createAnnouncementController);
adminRoute.get('/announcements/:id', validate(announcementIdParamSchema, 'params'), getAnnouncementController);
adminRoute.put(
  '/announcements/:id',
  limits.write,
  validate(announcementIdParamSchema, 'params'),
  validate(updateAnnouncementSchema),
  updateAnnouncementController
);

/**
 * Withdraw, not destroy — the handler sets `isActive: false`. A notice schools have
 * already been shown cannot be un-read, and removing the row would destroy the
 * record that it was ever published.
 */
adminRoute.delete(
  '/announcements/:id',
  limits.write,
  validate(announcementIdParamSchema, 'params'),
  deactivateAnnouncementController
);

// ═══════════════════════════════════════════════════════════════════════════
// Audit log
// ═══════════════════════════════════════════════════════════════════════════

adminRoute.get('/audit-logs', validate(listPlatformAuditLogsQuerySchema, 'query'), listPlatformAuditLogsController);

/**
 * The platform-wide trail, and the only read in the product that crosses schools.
 * A ledger export and an audit export both leave the platform with a copy of the
 * data, so both are audited — which is why `limits.export` is also the limit here.
 */
adminRoute.get(
  '/audit-logs/export',
  limits.export,
  validate(exportPlatformAuditLogsQuerySchema, 'query'),
  exportPlatformAuditLogsCsvController
);

/**
 * **Registered after `/audit-logs/user/:userId` and
 * `/audit-logs/impersonation/:sessionId`, and before nothing else.**
 *
 * `/audit-logs/:id` is the only wildcard in this group, so the two fixed-segment
 * paths above it must come first. They do not currently collide — `user` and
 * `impersonation` are two segments each, while `:id` is one — but the rule that
 * fixed paths precede wildcards is the one worth applying consistently, because the
 * day somebody adds `/audit-logs/export/:format` the ordering starts to matter and
 * the failure is a 404 on a working link.
 */
adminRoute.get(
  '/audit-logs/user/:userId',
  validate(auditUserIdParamSchema, 'params'),
  validate(userAuditTrailQuerySchema, 'query'),
  getUserAuditTrailController
);
adminRoute.get(
  '/audit-logs/impersonation/:sessionId',
  validate(auditSessionIdParamSchema, 'params'),
  validate(impersonationAuditQuerySchema, 'query'),
  getImpersonationSessionAuditController
);
adminRoute.get(
  '/audit-logs/:id',
  validate(auditLogIdParamSchema, 'params'),
  getAuditLogByIdController
);

// ═══════════════════════════════════════════════════════════════════════════
// Health
// ═══════════════════════════════════════════════════════════════════════════

adminRoute.get('/health', getSystemHealthController);
adminRoute.get('/health/jobs', getJobRunsController);
adminRoute.get('/health/errors', validate(recentErrorsQuerySchema, 'query'), getRecentErrorsController);

/**
 * `PUT /health/maintenance` — **not** `POST`, and **not** in
 * `IMPERSONATION_WRITE_ALLOWLIST`.
 *
 * The body describes the whole maintenance state (mode and message together)
 * rather than adding something to it, which is what a `PUT` means. And it is
 * absent from the allowlist on purpose: that list exists so an operator can always
 * *leave* an impersonated session, and an entry for `/health` was once added here
 * on the reasoning that health checks are read-only. They are — as `GET`s. Because
 * the allowlist matches by prefix, that entry also permitted this route, the one
 * call that takes the entire platform quiet, from inside a session that is supposed
 * to be read-only. `tests/platformConsole.test.js` now pins the list to exactly
 * `['/impersonate/end']`.
 */
adminRoute.put(
  '/health/maintenance',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 6,
    keyBy: 'user',
    message: 'Too many maintenance-mode changes. Confirm before trying again.',
  }),
  validate(setMaintenanceModeSchema),
  setMaintenanceModeController
);

// ═══════════════════════════════════════════════════════════════════════════
// Platform settings
// ═══════════════════════════════════════════════════════════════════════════

adminRoute.get('/settings', getPlatformSettingsController);
adminRoute.put('/settings', validate(updatePlatformSettingsSchema), updatePlatformSettingsController);

/**
 * Commission and disbursement are separate endpoints so the console can put a
 * confirmation in front of exactly those fields. "Save settings" and "change what
 * we earn" are different decisions and deserve different buttons; folding them into
 * the general `PUT` would mean the operator confirms them together, or not at all.
 */
adminRoute.put('/settings/commission', validate(updateCommissionSchema), updateCommissionController);
adminRoute.put(
  '/settings/disbursement',
  validate(updateDisbursementSettingsSchema),
  updateDisbursementSettingsController
);

// ═══════════════════════════════════════════════════════════════════════════
// Analytics
// ═══════════════════════════════════════════════════════════════════════════

adminRoute.get(
  '/analytics/revenue',
  validate(revenueAnalyticsQuerySchema, 'query'),
  getRevenueAnalyticsController
);
adminRoute.get('/analytics/schools', validate(schoolsAnalyticsQuerySchema, 'query'), getSchoolsAnalyticsController);
adminRoute.get('/analytics/usage', validate(usageAnalyticsQuerySchema, 'query'), getUsageAnalyticsController);
adminRoute.get(
  '/analytics/collection-rate',
  validate(collectionRateQuerySchema, 'query'),
  getCollectionRateAnalyticsController
);
adminRoute.get('/analytics/gateway-mix', validate(gatewayMixQuerySchema, 'query'), getGatewayMixAnalyticsController);
adminRoute.get('/analytics/top-schools', validate(topSchoolsQuerySchema, 'query'), getTopSchoolsAnalyticsController);
adminRoute.get('/analytics/at-risk-schools', validate(atRiskSchoolsQuerySchema, 'query'), getAtRiskSchoolsController);

// ═══════════════════════════════════════════════════════════════════════════
// Reports
// ═══════════════════════════════════════════════════════════════════════════

adminRoute.get('/reports/platform-revenue', validate(reportQuerySchema, 'query'), getPlatformRevenueReportController);
adminRoute.get('/reports/school-performance', validate(reportQuerySchema, 'query'), getSchoolPerformanceReportController);
adminRoute.get('/reports/growth', validate(reportQuerySchema, 'query'), getGrowthReportController);
adminRoute.get('/reports/churn', validate(reportQuerySchema, 'query'), getChurnReportController);

/**
 * `GET` for the same reason as the ledger export: a download produces nothing, so
 * it is a read. That also keeps it out of the impersonation write block without an
 * allowlist entry, which is the correct way for it to be reachable there.
 *
 * **`type` is a query parameter, not a path segment.** `exportReportController`
 * destructures `{ type, from, to, format }` out of `req.query`, and
 * `reportExportQuerySchema` declares `type` as an optional query key — so a path
 * parameter here would leave `type` `undefined` while the URL *looked* right, which
 * is the worst kind of 422 to debug. The frontend's `downloadReport` sends it as a
 * query parameter for the same reason.
 */
adminRoute.get(
  '/reports/export',
  limits.export,
  validate(reportExportQuerySchema, 'query'),
  exportReportController
);

/**
 * Exported **both ways**, and not for style.
 *
 * `routes/index.js` imports it as a named export (`import { adminRoute } from
 * './admin.routes.js'`), which is this repo's convention across every router file;
 * the default export exists because a router is also a value in its own right and
 * `import adminRoute from ...` is the shape Vite/most tooling reaches for first.
 *
 * Same `ExpressRouter` instance either way, so mounting it twice cannot produce two
 * sets of middleware — which matters here, because this router is in fact mounted
 * from two places (`routes/index.js:60` and directly in `index.js`) and the
 * impersonation boundary below runs on both.
 */
export { adminRoute };
export default adminRoute;