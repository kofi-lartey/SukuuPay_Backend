import { Router } from 'express';
import {
  sendSmsController,
  previewSmsController,
  previewAudienceController,
  bulkSendSmsController,
  listSmsJobsController,
  getSmsJobController,
  cancelSmsJobController,
  processSmsJobController,
  drainSmsQueueController,
  listSmsMessagesController,
  listTemplatesController,
  createTemplateController,
  updateTemplateController,
  deleteTemplateController,
  previewTemplateController,
  getSmsCreditsController,
  topUpSmsCreditsController,
  getSmsRailStatusController,
} from '../controllers/sms.controller.js';
import { authenticate, authorize } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import {
  smsSendParamSchema,
  previewSmsQuerySchema,
  previewAudienceSchema,
  sendSmsSchema,
  bulkSendSchema,
  smsJobParamSchema,
  cancelSmsJobSchema,
  listJobsQuerySchema,
  listMessagesQuerySchema,
  templateParamSchema,
  createTemplateSchema,
  updateTemplateSchema,
  listTemplatesQuerySchema,
  previewTemplateSchema,
  creditsParamSchema,
  topUpCreditsSchema,
} from '../validations/sms.validation.js';

export const smsRoute = Router();

/**
 * Who may originate parent communication. Mirrors the WhatsApp channel exactly:
 * a bursar, a school admin or a platform admin can send; a teacher can read the
 * history but not spend a school's credit talking to its parents.
 *
 * The distinction is not a technicality. A broadcast is irreversible, costs real
 * money, and reaches a child's guardian — the one surface in this product where
 * "it was technically possible" is not a defence.
 */
const requireSender = authorize('super_admin', 'school_admin', 'accountant');
const requireReader = authorize('super_admin', 'school_admin', 'accountant', 'teacher');

// ──────────────────── Credits ────────────────────

// GET /sms/rail-status — can this deployment send an SMS right now?
//
// A **live** probe of the gateway, not a report of what is configured. Every
// reason a receipt can fail to reach a parent is invisible from the
// configuration: no credit, no approved sender ID, no messaging account on
// this service. This asks the gateway, so an operator finds out here rather
// than from a parent who never got a receipt.
//
// Platform-wide rather than per school, so it is a **super admin** read: it
// reports the platform's own messaging accounts, and the credentials involved
// are not a school's to see.
smsRoute.get('/sms/rail-status', authenticate, authorize('super_admin'), getSmsRailStatusController);

// GET /sms/credits/:schoolId — balance, usage and gateway readiness.
smsRoute.get(
  '/sms/credits/:schoolId',
  authenticate,
  requireReader,
  validate(creditsParamSchema, 'params'),
  getSmsCreditsController
);

// POST /sms/credits/top-up — add credit to a school.
//
// **`authorize('super_admin')` only.** This used to be `requireSender`, which
// includes `school_admin` and `accountant`, so any bursar could mint unlimited SMS
// credit for their own school by typing a number into a dialog: no payment, no
// approval, no record of who bought what. It wrote a real `SmsCreditTopUp` row and
// incremented `School.sms.balance`, so it looked like a purchase in every audit and
// report while being free. The only thing standing between that and a school's whole
// Arkesel bill was the honesty of the person operating it.
//
// The platform console has its own equivalent at
// `POST /admin/sms/credits/topup`, which allocates across several schools at once and
// books a `PlatformLedger` entry. Neither is a *sale*: both are a super admin recording
// credit that has already been paid for out of band. Charging a school for SMS is a
// separate flow with its own request, payment and approval states, and this route is
// deliberately not it.
//
// Ahead of the `GET /sms/credits/:schoolId` pattern above. Not a shadowing risk
// (different method and a two-segment path), but it is declared first so the
// literal routes stay together and the parameterised ones read last.
smsRoute.post(
  '/sms/credits/top-up',
  authenticate,
  authorize('super_admin'),
  validate(topUpCreditsSchema),
  topUpSmsCreditsController
);

// ──────────────────── Preview ────────────────────

// GET /sms/preview/:studentId — rendered copy and cost for one student.
//
// Costs nothing and sends nothing, so it is on the reader side. The composer
// calls it on every keystroke, and a bursar drafting a message is not a bursar
// sending one.
smsRoute.get(
  '/sms/preview/:studentId',
  authenticate,
  requireReader,
  validate(smsSendParamSchema, 'params'),
  validate(previewSmsQuerySchema, 'query'),
  previewSmsController
);

// POST /sms/audience/preview — how many parents a rule reaches, and for how much.
//
// A POST, not a GET, because the audience is a structured object rather than a
// flat filter: `{"type":"overdue","overdueDays":45,"gracePeriodDays":14}` in a
// query string is unreadable and has no natural encoding. It is a read, but it
// is not addressable as a URL, and that is the lesser problem.
smsRoute.post(
  '/sms/audience/preview',
  authenticate,
  requireReader,
  validate(previewAudienceSchema),
  previewAudienceController
);

// ──────────────────── Send ────────────────────

// POST /sms/send/:studentId — message a student's parent.
smsRoute.post(
  '/sms/send/:studentId',
  authenticate,
  requireSender,
  validate(smsSendParamSchema, 'params'),
  validate(sendSmsSchema),
  sendSmsController
);

// POST /sms/bulk — broadcast to a resolved audience.
//
// `body` here, not `templateId` alone: a bursar editing a preset in the composer
// and then hitting Send means the edited text goes out, not the stored original.
// A template reference is a starting point, not a contract.
smsRoute.post('/sms/bulk', authenticate, requireSender, validate(bulkSendSchema), bulkSendSmsController);

// ──────────────────── Jobs ────────────────────

// GET /sms/jobs — broadcast history.
smsRoute.get(
  '/sms/jobs',
  authenticate,
  requireReader,
  validate(listJobsQuerySchema, 'query'),
  listSmsJobsController
);

// POST /sms/jobs/drain — run everything currently due.
//
// Declared before `/jobs/:jobId` for the same reason as the credits routes: a
// literal path declared after a parameterised sibling is unreachable, and
// "drain" would be read as a job id.
smsRoute.post('/sms/jobs/drain', authenticate, authorize('super_admin'), drainSmsQueueController);

// GET /sms/jobs/:jobId — read one broadcast.
smsRoute.get(
  '/sms/jobs/:jobId',
  authenticate,
  requireReader,
  validate(smsJobParamSchema, 'params'),
  getSmsJobController
);

// POST /sms/jobs/:jobId/cancel — stop a queued broadcast, refunding the credit.
smsRoute.post(
  '/sms/jobs/:jobId/cancel',
  authenticate,
  requireSender,
  validate(smsJobParamSchema, 'params'),
  validate(cancelSmsJobSchema),
  cancelSmsJobController
);

// POST /sms/jobs/:jobId/process — run one queued broadcast now.
//
// The scheduler's manual trigger, for a deployment with no cron configured. The
// `queued` claim inside `processSmsJob` is what keeps a manual trigger and the
// drain from running the same broadcast twice, which would be 200 parents
// messaged twice for the school's own money.
smsRoute.post(
  '/sms/jobs/:jobId/process',
  authenticate,
  authorize('super_admin'),
  validate(smsJobParamSchema, 'params'),
  processSmsJobController
);

// ──────────────────── History ────────────────────

// GET /sms/messages — per-message delivery log.
smsRoute.get(
  '/sms/messages',
  authenticate,
  requireReader,
  validate(listMessagesQuerySchema, 'query'),
  listSmsMessagesController
);

// ──────────────────── Templates ────────────────────

// GET /sms/templates — presets plus the school's own.
smsRoute.get(
  '/sms/templates',
  authenticate,
  requireReader,
  validate(listTemplatesQuerySchema, 'query'),
  listTemplatesController
);

// POST /sms/templates/preview — render a draft against sample values.
//
// Before `/templates/:templateId` for the same reason as the drain route: a
// literal segment declared after a parameterised sibling is unreachable, and
// "preview" would be read as a template id.
smsRoute.post('/sms/templates/preview', authenticate, requireReader, validate(previewTemplateSchema), previewTemplateController);

// POST /sms/templates — save a new template.
smsRoute.post('/sms/templates', authenticate, requireSender, validate(createTemplateSchema), createTemplateController);

// PATCH /sms/templates/:templateId — edit one.
smsRoute.patch(
  '/sms/templates/:templateId',
  authenticate,
  requireSender,
  validate(templateParamSchema, 'params'),
  validate(updateTemplateSchema),
  updateTemplateController
);

// DELETE /sms/templates/:templateId — soft-delete one.
//
// A soft delete, so past sends keep rendering the copy they were sent with.
smsRoute.delete(
  '/sms/templates/:templateId',
  authenticate,
  requireSender,
  validate(templateParamSchema, 'params'),
  deleteTemplateController
);

export default smsRoute;
