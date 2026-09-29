import {
  handleIncomingWebhook,
  verifyWhatsAppWebhookSignature,
  resolveWebhookChallenge,
  sendWhatsAppToStudent,
  sendBulkWhatsApp,
  getWhatsAppJob,
  cancelWhatsAppJob,
  createWhatsAppTemplate,
  listWhatsAppTemplates,
  getConversations,
  WHATSAPP_COMING_SOON_CODE,
} from '../services/whatsapp.service.js';
import { WHATSAPP_ENABLED, WHATSAPP_COMING_SOON_MESSAGE } from '../config/env.js';
import { idempotencyKeyFrom } from '../utils/idempotency.js';

// ── GET /whatsapp/webhook — Meta subscription handshake ──
// Meta verifies a webhook by GETting it with a challenge. The response is
// plain text, not JSON, because Meta compares the body verbatim.
export const whatsappVerifyController = (req, res) => {
  // Refuse the handshake while the channel is off. Confirming it would leave
  // Meta delivering inbound events to an endpoint that discards them — and
  // would make the V2 switch-over a silent black hole rather than a visible
  // one. Removing a stale subscription is a Meta-console action; this endpoint
  // only has to decline to start one.
  if (!WHATSAPP_ENABLED) {
    return res.status(403).json({
      success: false,
      message: WHATSAPP_COMING_SOON_MESSAGE,
      code: WHATSAPP_COMING_SOON_CODE,
    });
  }

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const result = resolveWebhookChallenge(mode, token, challenge);

  if (!result.subscribed) {
    // 403 rather than echoing the challenge: a wrong verify token must not
    // confirm this endpoint to whoever sent the request.
    return res.status(403).json({ success: false, message: 'Verification failed' });
  }

  return res.status(200).send(String(challenge));
};

// ── POST /whatsapp/webhook — inbound messages from Meta ──
export const whatsappWebhookController = async (req, res) => {
  try {
    const auth = verifyWhatsAppWebhookSignature({
      header: req.get('x-hub-signature-256') || req.get('x-hub-signature'),
      rawBody: req.rawBody,
    });

    if (!auth.valid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or missing WhatsApp signature',
        code: 'INVALID_WEBHOOK_SIGNATURE',
      });
    }

    const result = await handleIncomingWebhook(req.body, { verified: auth.enforced });

    // Always 2xx once the request is authenticated: Meta retries until it gets
    // one, and a retry would re-deliver messages already stored.
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process WhatsApp webhook',
    });
  }
};

// ── POST /whatsapp/send/:studentId — message a student's parent(s) ──
export const sendWhatsAppController = async (req, res) => {
  try {
    const result = await sendWhatsAppToStudent(req.params.studentId, req.body, req.user, {
      idempotencyKey: idempotencyKeyFrom(req),
    });

    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      message: result.replayed ? 'WhatsApp message already sent for this Idempotency-Key' : 'WhatsApp message sent',
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── POST /whatsapp/send-bulk/:schoolId — broadcast to a school's parents ──
export const sendBulkWhatsAppController = async (req, res) => {
  try {
    const result = await sendBulkWhatsApp(req.params.schoolId, req.body, req.user, {
      idempotencyKey: idempotencyKeyFrom(req),
    });

    return res.status(result.replayed ? 200 : 202).json({
      success: true,
      message: result.replayed
        ? 'Bulk WhatsApp job already created for this Idempotency-Key'
        : 'Bulk WhatsApp job accepted',
      data: result.data,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── GET /whatsapp/jobs/:jobId — read a bulk job ──
export const getWhatsAppJobController = async (req, res) => {
  try {
    const job = await getWhatsAppJob(req.params.jobId, req.user);

    return res.status(200).json({
      success: true,
      message: 'Bulk WhatsApp job retrieved successfully',
      data: job,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── POST /whatsapp/jobs/:jobId/cancel — stop a running job ──
export const cancelWhatsAppJobController = async (req, res) => {
  try {
    const result = await cancelWhatsAppJob(req.params.jobId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: 'Bulk WhatsApp job cancelled',
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── POST /whatsapp/template/create — register an approved template ──
export const createWhatsAppTemplateController = async (req, res) => {
  try {
    const template = await createWhatsAppTemplate(req.body, req.user);

    return res.status(201).json({
      success: true,
      message: 'WhatsApp template created',
      data: template,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── GET /whatsapp/templates — the sendable catalogue ──
export const listWhatsAppTemplatesController = async (req, res) => {
  try {
    const templates = await listWhatsAppTemplates(req.query, req.user);

    return res.status(200).json({
      success: true,
      message: 'WhatsApp templates retrieved successfully',
      data: templates,
      meta: { total: templates.length },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── GET /whatsapp/conversations/:schoolId — conversation history ──
export const getConversationsController = async (req, res) => {
  try {
    const result = await getConversations(req.params.schoolId, req.query, req.user);

    return res.status(200).json({
      success: true,
      message: 'Conversations retrieved successfully',
      data: {
        messages: result.messages,
        threads: result.threads,
      },
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};
