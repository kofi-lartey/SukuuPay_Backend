import { Router } from 'express';
import {
  sendSingleEmailController,
  sendBulkEmailController,
  getEmailHistoryController,
  getEmailJobController,
  cancelEmailJobController,
  providerEventsController,
  unsubscribeController,
  getEmailTemplatesController,
} from '../controllers/emailMessaging.controller.js';
import { authenticate, authorize } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import {
  sendSingleEmailSchema,
  sendBulkEmailSchema,
  cancelEmailJobSchema,
  emailJobIdParamSchema,
  emailSchoolIdParamSchema,
  emailHistoryQuerySchema,
  unsubscribeQuerySchema,
  unsubscribeBodySchema,
} from '../validations/emailMessaging.validation.js';

export const emailMessagingRoute = Router();

// Who may originate parent communication.
const requireSender = authorize('super_admin', 'school_admin', 'accountant');
// Who may read the delivery log. A teacher needs visibility into what was sent
// without a need to originate it.
const requireReader = authorize('super_admin', 'school_admin', 'accountant', 'teacher');

// ──────────────────── Public endpoints ────────────────────

// POST /email/unsubscribe - target of the List-Unsubscribe header. A one-click
// unsubscribe is a POST, so both verbs are supported on the same handler.
emailMessagingRoute.get(
  '/email/unsubscribe',
  validate(unsubscribeQuerySchema, 'query'),
  unsubscribeController
);

emailMessagingRoute.post(
  '/email/unsubscribe',
  validate(unsubscribeBodySchema),
  unsubscribeController
);

// POST /email/webhooks/brevo - delivery events. No bearer token: the caller is
// the provider, and authentication is the X-Brevo-Event-Secret header (the
// legacy X-Bravo-Event-Secret spelling is accepted too).
// The payload is deliberately not schema-validated here: Brevo posts a
// single snake_case object (message_id, link) for transactional events and an
// `events` batch for some campaign callbacks. The service folds both into the
// internal shape and validates after normalising.
emailMessagingRoute.post('/email/webhooks/brevo', providerEventsController);

// ──────────────────── Template catalogue ────────────────────
// Registered before the parameterised routes for readability; express matches
// these literally regardless of order.
emailMessagingRoute.get('/email/templates', authenticate, getEmailTemplatesController);

// ──────────────────── Send ────────────────────

// POST /email/single
emailMessagingRoute.post(
  '/email/single',
  authenticate,
  requireSender,
  validate(sendSingleEmailSchema),
  sendSingleEmailController
);

// POST /email/bulk/:schoolId
emailMessagingRoute.post(
  '/email/bulk/:schoolId',
  authenticate,
  requireSender,
  validate(emailSchoolIdParamSchema, 'params'),
  validate(sendBulkEmailSchema),
  sendBulkEmailController
);

// ──────────────────── Job control ────────────────────

// POST /email/jobs/:jobId/cancel
emailMessagingRoute.post(
  '/email/jobs/:jobId/cancel',
  authenticate,
  requireSender,
  validate(emailJobIdParamSchema, 'params'),
  validate(cancelEmailJobSchema),
  cancelEmailJobController
);

// GET /email/jobs/:jobId
emailMessagingRoute.get(
  '/email/jobs/:jobId',
  authenticate,
  requireReader,
  validate(emailJobIdParamSchema, 'params'),
  getEmailJobController
);

// ──────────────────── History ────────────────────

// GET /email/history
emailMessagingRoute.get(
  '/email/history',
  authenticate,
  requireReader,
  validate(emailHistoryQuerySchema, 'query'),
  getEmailHistoryController
);
