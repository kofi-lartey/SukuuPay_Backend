// ─────────────────────────────────────────────
// SMS service
// ─────────────────────────────────────────────
// The single entry point every outbound SMS goes through: installment reminders,
// overdue notices, payment-plan lifecycle messages and pay-link delivery all
// call `sendSms`.
//
// One invariant governs this module: it NEVER throws. Email and WhatsApp are
// both best-effort secondary channels, and an SMS failure must not roll back a
// business operation that has already succeeded — a plan that was created stays
// created whether or not the parent was told. Failures are therefore reported in
// the return value and on the `SmsMessage` row, never as an exception.
//
// `sent` is therefore a factual claim: it is true only when a gateway accepted
// the message. The previous stub returned `sent: true` without transmitting
// anything, which meant `installmentReminder.job.js` stamped `reminderSentAt`
// and `paymentPlan.service.js` wrote `smsSent: true` into the audit trail for
// messages that were never sent. That lie is what this rewrite removes.
import { SmsMessage } from '../models/smsMessageModel.js';
import { normalisePhone } from './phoneNumbers.js';
import { SMS_DEFAULT_PROVIDER } from '../config/env.js';
import { sendArkeselSms, isArkeselSendConfigured } from './arkeselApi.js';
import { isPlaceholder } from './placeholder.js';

// Rough GSM-7 character count per segment. Not used to bill, only so the
// delivery log can show how many parts a message was split into.
const countSegments = (text) => {
  const length = String(text || '').length;
  if (length === 0) return 1;
  if (length <= 160) return 1;
  if (length <= 153) return 2;
  return Math.ceil(length / 153);
};

/**
 * Send implementations, keyed by the value of `school.sms.provider`.
 *
 * A `null` entry is deliberate: it means "this provider is selectable in the
 * School model and appears in the delivery-report webhook, but has no send
 * integration yet". Dispatching to it fails loudly and honestly rather than
 * silently logging and reporting success.
 */
const SEND_CLIENTS = {
  arke: { configured: isArkeselSendConfigured, send: sendArkeselSms },
  hubtel: { configured: () => false, send: null },
  mnotify: { configured: () => false, send: null },
};

/** Resolves the provider for a school, falling back to the platform default. */
const resolveProvider = (school) => school?.sms?.provider || SMS_DEFAULT_PROVIDER;

/** Persists a terminal outcome on the row without ever throwing. */
const mark = async (row, status, reason) => {
  if (!row) return;
  try {
    row.status = status;
    if (reason) row.failureReason = String(reason).slice(0, 500);
    await row.save();
  } catch (error) {
    console.error('[SMS] Failed to persist message status:', error.message);
  }
};

/**
 * Sends one SMS.
 *
 * @returns {Promise<{sent: boolean, provider: string, reason?: string,
 *   providerMessageId?: string|null, messageId: ObjectId|null}>}
 *   `sent` is true only when a gateway accepted the message.
 */
export const sendSms = async ({
  to,
  message,
  school,
  purpose = 'general',
  studentId = null,
  paymentPlanId = null,
  parentName = '',
  createdBy = null,
}) => {
  const provider = resolveProvider(school);

  // The row is written before the gateway call, and written even when there is no
  // recipient: the row is how a school discovers that a parent has no number on
  // file, and it is what the delivery-report webhook later attaches to.
  let saved = null;
  try {
    saved = await SmsMessage.create({
      schoolId: school?._id || school || null,
      studentId,
      paymentPlanId,
      parentName,
      to: to || '',
      toE164: to ? normalisePhone(to).e164 : null,
      message: String(message || ''),
      segments: countSegments(message),
      purpose,
      provider,
      status: 'queued',
      createdBy,
    });
  } catch (error) {
    console.error('[SMS] Failed to record message:', error.message);
  }

  try {
    if (!to) {
      await mark(saved, 'rejected', 'No recipient phone number');
      return { sent: false, provider, reason: 'No recipient phone number', messageId: saved?._id || null };
    }

    const client = SEND_CLIENTS[provider];
    if (!client) {
      const reason = `Unknown SMS provider "${provider}"`;
      await mark(saved, 'failed', reason);
      return { sent: false, provider, reason, messageId: saved?._id || null };
    }

    if (!client.send) {
      const reason = `SMS provider "${provider}" has no send integration wired yet`;
      console.warn(`[SMS] ${reason}`);
      await mark(saved, 'failed', reason);
      return { sent: false, provider, reason, messageId: saved?._id || null };
    }

    if (!client.configured()) {
      const reason = `SMS provider "${provider}" is not configured`;
      console.warn(`[SMS] ${reason}`);
      await mark(saved, 'failed', reason);
      return { sent: false, provider, reason, messageId: saved?._id || null };
    }

    // ── Transmit ──
    // `saved.paymentId`-style correlation is not available here, so the
    // reference handed to the gateway is derived from the row's own id, which is
    // stable and lets a gateway-side duplicate be recognised.
    const result = await client.send({
      to,
      message,
      senderId: school?.sms?.senderId || undefined,
      reference: saved?._id ? String(saved._id) : undefined,
    });

    if (saved) {
      // providerMessageId is what the delivery-report webhook looks the message
      // up by. Without it the report degrades to phone-number matching inside a
      // 24h window, which can attach a report to an unrelated send.
      saved.provider = provider;
      saved.providerMessageId = result?.providerMessageId ?? null;
      saved.status = 'submitted';
      saved.submittedAt = new Date();
      await saved.save();
    }

    return {
      sent: true,
      provider,
      providerMessageId: result?.providerMessageId ?? null,
      messageId: saved?._id || null,
    };
  } catch (error) {
    // A gateway that accepted the message and then timed out on the response
    // lands here. Marking it failed is the safe default: a duplicate send risks
    // billing the parent twice, whereas a lost send is retried by the next cron.
    console.error('[SMS] Send failed:', error.message);
    await mark(saved, 'failed', error.message);
    return {
      sent: false,
      provider,
      reason: error.message,
      messageId: saved?._id || null,
    };
  }
};

/** Provider ids with a working send integration, for GET /version. */
export const availableSmsProviders = () =>
  Object.entries(SEND_CLIENTS)
    .filter(([, client]) => typeof client.send === 'function' && client.configured())
    .map(([id]) => id);

export default sendSms;
