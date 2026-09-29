import { Router } from 'express';
import {
  whatsappVerifyController,
  whatsappWebhookController,
  sendWhatsAppController,
  sendBulkWhatsAppController,
  getWhatsAppJobController,
  cancelWhatsAppJobController,
  createWhatsAppTemplateController,
  listWhatsAppTemplatesController,
  getConversationsController,
} from '../controllers/whatsapp.controller.js';
import { authenticate, authorize } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import {
  whatsappSendParamSchema,
  sendWhatsAppSchema,
  whatsappSchoolParamSchema,
  sendBulkWhatsAppSchema,
  whatsappJobParamSchema,
  cancelWhatsAppJobSchema,
  createWhatsAppTemplateSchema,
  listTemplatesQuerySchema,
  conversationsParamSchema,
  conversationsQuerySchema,
} from '../validations/whatsapp.validation.js';

export const whatsappRoute = Router();

// Who may originate parent communication. Mirrors the email channel: a teacher
// can read the conversation but not start a broadcast.
const requireSender = authorize('super_admin', 'school_admin', 'accountant');
const requireReader = authorize('super_admin', 'school_admin', 'accountant', 'teacher');

// ──────────────────── Webhook (no bearer token) ────────────────────

// GET /whatsapp/webhook — Meta's subscription handshake. Authenticated by the
// shared verify token, not by a session.
whatsappRoute.get('/whatsapp/webhook', whatsappVerifyController);

// POST /whatsapp/webhook — inbound messages. Authenticated by the
// X-Hub-Signature-256 HMAC over the raw body, verified in the service against
// req.rawBody. The payload is not schema-validated: Meta's envelope shape is
// theirs to change, and a rejected message is a message that never reaches the
// conversation history.
whatsappRoute.post('/whatsapp/webhook', whatsappWebhookController);

// ──────────────────── Send ────────────────────

// POST /whatsapp/send/:studentId — message a student's parent(s)
whatsappRoute.post(
  '/whatsapp/send/:studentId',
  authenticate,
  requireSender,
  validate(whatsappSendParamSchema, 'params'),
  validate(sendWhatsAppSchema),
  sendWhatsAppController
);

// POST /whatsapp/send-bulk/:schoolId — broadcast to a school's parents
whatsappRoute.post(
  '/whatsapp/send-bulk/:schoolId',
  authenticate,
  requireSender,
  validate(whatsappSchoolParamSchema, 'params'),
  validate(sendBulkWhatsAppSchema),
  sendBulkWhatsAppController
);

// ──────────────────── Job control ────────────────────

whatsappRoute.get(
  '/whatsapp/jobs/:jobId',
  authenticate,
  requireReader,
  validate(whatsappJobParamSchema, 'params'),
  getWhatsAppJobController
);

whatsappRoute.post(
  '/whatsapp/jobs/:jobId/cancel',
  authenticate,
  requireSender,
  validate(whatsappJobParamSchema, 'params'),
  validate(cancelWhatsAppJobSchema),
  cancelWhatsAppJobController
);

// ──────────────────── Templates ────────────────────

// POST /whatsapp/template/create — register (and optionally submit) a template
whatsappRoute.post(
  '/whatsapp/template/create',
  authenticate,
  requireSender,
  validate(createWhatsAppTemplateSchema),
  createWhatsAppTemplateController
);

// GET /whatsapp/templates — the sendable catalogue
whatsappRoute.get(
  '/whatsapp/templates',
  authenticate,
  requireReader,
  validate(listTemplatesQuerySchema, 'query'),
  listWhatsAppTemplatesController
);

// ──────────────────── History ────────────────────

// GET /whatsapp/conversations/:schoolId — conversation history
whatsappRoute.get(
  '/whatsapp/conversations/:schoolId',
  authenticate,
  requireReader,
  validate(conversationsParamSchema, 'params'),
  validate(conversationsQuerySchema, 'query'),
  getConversationsController
);
