// ─────────────────────────────────────────────
// Arkesel SMS V2 — send client
// ─────────────────────────────────────────────
// The receive half of Arkesel was already built: `handleSmsDeliveryReport('arkesel', …)`
// in services/inboundWebhooks.service.js normalises their status vocabulary and
// attaches reports to SmsMessage rows. This module is the transmit half.
//
// ─────────────────────────────────────────────────────────────────────────────
// Wire format — Arkesel SMS API V2
// ─────────────────────────────────────────────────────────────────────────────
// Confirmed against Arkesel's developer documentation and five independent
// client implementations (Node, Python, PHP, Go, Java) plus a third-party
// technical evaluation. V1 is deliberately NOT used: it passes the API key as a
// query parameter, which puts a live credential in every access log.
//
//   POST https://sms.arkesel.com/api/v2/sms/send
//   Header: api-key: <ARKESEL_API_KEY>
//   Header: Content-Type: application/json
//   Body:   { "sender": "...", "message": "...", "recipients": ["+233..."] }
//
// Success (200):
//   { "status": "success", "data": [ { "recipient": "+233...", "id": "msg_..." } ] }
//   The single-recipient form is also documented as
//   { "status": "success", "data": { "id": "msg_...", "credits_used": 1 } }
//   — `data` is not consistently an array, so readMessageId handles both.
//
// Validation failure (422): { "code": "422", "message": "Validation Errors ..." }
//
// Four provider behaviours this client has to defend against:
//
//   1. Recipients are E.164 and want a leading `+`. Arkesel accepts
//      "233244123456", but the documented examples all use "+233...", and a bare
//      local number like "0244123456" is rejected. Normalised here so a Ghanaian
//      local number never reaches the provider and fails with an opaque 422.
//   2. A 200 does not mean the message was accepted for delivery. The status
//      lives in the body's `status` field, and a provider can answer 200 with
//      `status: "error"`. Every 200 is therefore inspected, not just logged —
//      otherwise a refused message is recorded as submitted, which is the exact
//      phantom-success bug this module was originally written to prevent.
//   3. Sender ID must be 1–11 characters, alphanumeric, containing at least one
//      letter. MTN Ghana additionally requires a registered sender ID or it
//      silently drops the message. Validated before sending so a misconfigured
//      ID fails here with an actionable message rather than at the handset.
//   4. There is no client-supplied idempotency field on this endpoint, so a retry
//      after a timeout bills the parent twice. The `reference` passed by
//      smsService is therefore used for local correlation only, and callers must
//      not blindly retry a timed-out send.
//   5. Delivery reports arrive by callback, not polling. Without a public
//      ARKESEL_CALLBACK_URL the send is still accepted and billed, but the
//      outcome is never reported — the message stays `submitted` forever, and a
//      carrier-dropped message is indistinguishable from a delivered one. Same
//      failure class as (3): the API says success, the handset gets nothing.
import {
  ARKESEL_API_KEY,
  ARKESEL_API_URL,
  ARKESEL_SENDER_ID,
  ARKESEL_TIMEOUT_MS,
  ARKESEL_CALLBACK_URL,
} from '../config/env.js';
import { isPlaceholder } from './placeholder.js';
import { toGhanaE164 } from './phoneNumbers.js';

/** Default V2 send endpoint. Overridable for sandbox or regional routing. */
const DEFAULT_API_URL = 'https://sms.arkesel.com/api/v2/sms/send';

/** Typed transport failure, mirroring MtnTransportError's shape. */
export class ArkeselTransportError extends Error {
  constructor(
    message,
    { status = 502, code = 'ARKESEL_PROVIDER_ERROR', providerStatus = null, providerBody = null } = {}
  ) {
    super(message);
    this.name = 'ArkeselTransportError';
    this.status = status;
    this.code = code;
    this.providerStatus = providerStatus;
    this.providerBody = providerBody;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** The resolved endpoint, falling back to the documented V2 path. */
export const getArkeselApiUrl = () =>
  isPlaceholder(ARKESEL_API_URL) ? DEFAULT_API_URL : ARKESEL_API_URL;

/** True when there is enough configuration to reach Arkesel. */
export const isArkeselSendConfigured = () =>
  !isPlaceholder(ARKESEL_API_KEY) && Boolean(getArkeselApiUrl());

/** Configuration report for GET /version. Never returns a credential value. */
export const getArkeselConfigStatus = () => ({
  configured: isArkeselSendConfigured(),
  hasApiKey: !isPlaceholder(ARKESEL_API_KEY),
  hasSenderId: !isPlaceholder(ARKESEL_SENDER_ID),
  apiUrl: getArkeselApiUrl(),
  timeoutMs: ARKESEL_TIMEOUT_MS,
  // The sender ID is the thing most likely to be wrong, and a bad one is
  // invisible: MTN drops the message rather than reporting an error. Surfacing it
  // keeps a silent delivery failure from looking like a code problem.
  senderIdValid: validateSenderId(ARKESEL_SENDER_ID).valid,
  senderIdIssue: validateSenderId(ARKESEL_SENDER_ID).reason,
  // Without a DLR URL every message stays `submitted` forever, so a delivered
  // message and a carrier-dropped one are indistinguishable. Reported explicitly
  // because it is the second way this integration can fail silently.
  dlrCallbackConfigured: isDlrCallbackReachable(),
  dlrCallbackUrl: ARKESEL_CALLBACK_URL || null,
});

/**
 * True when Arkesel has a public URL to report delivery status to.
 *
 * A localhost or 127.0.0.1 callback is treated as NOT reachable: it is a real
 * value that would pass a naive presence check, and configuring it would give
 * the false impression that delivery tracking is working.
 */
export const isDlrCallbackReachable = () => {
  const url = String(ARKESEL_CALLBACK_URL || '').trim();
  if (!url || isPlaceholder(url)) return false;
  if (!/^https:\/\//i.test(url)) return false;
  if (/^https:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(url)) return false;
  return true;
};

/**
 * Validates a sender ID against Arkesel's carrier-enforced rules.
 *
 * @param {string} sender
 * @returns {{valid: boolean, reason: string|null, sender: string}}
 */
export const validateSenderId = (sender) => {
  const value = String(sender ?? '').trim();
  if (!value) {
    return { valid: false, reason: 'Sender ID is not configured', sender: value };
  }
  if (value.length > 11) {
    return {
      valid: false,
      reason: `Sender ID must be 1-11 characters (got ${value.length})`,
      sender: value,
    };
  }
  if (!/^[A-Za-z0-9]+$/.test(value)) {
    return {
      valid: false,
      reason: 'Sender ID must be alphanumeric — no spaces, punctuation or symbols',
      sender: value,
    };
  }
  if (!/[A-Za-z]/.test(value)) {
    // All-numeric sender IDs render as a phone number on the handset and bypass
    // the branded display, so they are almost never what is intended.
    return {
      valid: false,
      reason: 'Sender ID must contain at least one letter, or it displays as a number',
      sender: value,
    };
  }
  return { valid: true, reason: null, sender: value };
};

/**
 * Builds the V2 submit body.
 *
 * `recipients` is an array even for one number: the V2 endpoint takes a list,
 * and single-recipient sends share the same shape as bulk.
 *
 * `callbackUrl` is included only when it is genuinely reachable (see
 * isDlrCallbackReachable). Sending a localhost URL would be accepted and would
 * produce nothing, which is worse than not asking: it looks configured.
 */
const buildSubmitBody = ({ to, message, senderId, callbackUrl }) => {
  const body = {
    sender: senderId,
    message: String(message ?? ''),
    recipients: [to],
  };
  if (callbackUrl) body.callbackUrl = callbackUrl;
  return body;
};

/**
 * Extracts the gateway's message id from a submit response.
 *
 * This id is what the delivery-report webhook looks the SmsMessage row up by
 * (`SmsMessage.providerMessageId`), so returning null here is survivable — the
 * report falls back to phone-number matching within a 24-hour window — but it is
 * lossy, and it is worth getting right.
 *
 * Handles both documented success shapes: `data` as an array of
 * `{ recipient, id }`, and `data` as a single `{ id, credits_used }`.
 */
export const readMessageId = (payload) => {
  const { data } = payload || {};
  if (Array.isArray(data)) {
    const first = data.find((entry) => entry && entry.id);
    return first?.id ?? null;
  }
  if (data && typeof data === 'object') return data.id ?? null;
  return null;
};

/** True when a 200 body actually reports acceptance. */
export const isAccepted = (payload) => {
  const status = payload?.status;
  if (typeof status !== 'string') return false;
  return status.toLowerCase() === 'success';
};

/** Credits consumed, when Arkesel reports it. Used for cost tracking. */
export const readCreditsUsed = (payload) => {
  const { data } = payload || {};
  if (Array.isArray(data)) {
    const total = data.reduce((sum, entry) => sum + (Number(entry?.credits_used) || 0), 0);
    return total || null;
  }
  const single = Number(data?.credits_used);
  return Number.isFinite(single) ? single : null;
};

/**
 * Submits one SMS to Arkesel.
 *
 * @param {{to: string, message: string, senderId?: string, reference?: string}} params
 *   `reference` is carried for local correlation only — the V2 endpoint has no
 *   client-reference field, so it is not transmitted.
 * @returns {Promise<{providerMessageId: string|null, creditsUsed: number|null, raw: object}>}
 * @throws {ArkeselTransportError} on any transport, provider or validation failure
 */
export const sendArkeselSms = async ({ to, message, senderId, reference, apiKey }) => {
  // `apiKey` is the school's own Arkesel credential. A school with its own
  // Arkesel account has its own balance and its own approved sender IDs, and
  // the platform's key would spend the platform's credit under the platform's
  // sender ID.
  const key = String(apiKey || ARKESEL_API_KEY || '').trim();
  if (!isArkeselSendConfigured() && !apiKey) {
    throw new ArkeselTransportError('Arkesel is not configured', {
      status: 503,
      code: 'ARKESEL_NOT_CONFIGURED',
    });
  }

  const effectiveSender = senderId || ARKESEL_SENDER_ID;
  const senderCheck = validateSenderId(effectiveSender);
  if (!senderCheck.valid) {
    throw new ArkeselTransportError(
      `Arkesel sender ID is invalid: ${senderCheck.reason}`,
      { status: 400, code: 'ARKESEL_INVALID_SENDER_ID' }
    );
  }

  // E.164 with a leading plus. Validated here so a malformed or non-Ghanaian
  // number produces a clear 400 instead of Arkesel's generic 422.
  const normalised = toGhanaE164(to);
  if (!normalised.valid) {
    throw new ArkeselTransportError(
      `"${to}" is not a valid Ghanaian MSISDN for SMS: ${normalised.reason}`,
      { status: 400, code: 'ARKESEL_INVALID_MSISDN' }
    );
  }

  const url = getArkeselApiUrl();
  const body = buildSubmitBody({
    to: normalised.e164,
    message,
    senderId: senderCheck.sender,
    callbackUrl: isDlrCallbackReachable() ? ARKESEL_CALLBACK_URL : undefined,
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
        // V2 moves the key from a query parameter to a header. A key in the query
        // string ends up in every access log along the way.
        'api-key': key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ARKESEL_TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout here is ambiguous: Arkesel may have accepted the message and the
    // response was lost. Retrying would bill the parent twice, so this is
    // surfaced as a failure the caller must reconcile rather than auto-retried.
    throw new ArkeselTransportError(
      `Arkesel request failed: ${error.message}. The message may or may not have been accepted — reconcile via the delivery report before retrying.`,
      { status: 502, code: 'ARKESEL_PROVIDER_UNREACHABLE' }
    );
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Arkesel can return an HTML error page from its edge. Keep the raw text.
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.message || payload?.error || text || response.statusText;
    throw new ArkeselTransportError(
      `Arkesel rejected the message (${response.status}): ${detail}`,
      {
        status: 502,
        // 401/403 are a credential problem, not a transient provider fault, and
        // the caller should not retry those blindly.
        code: [401, 403].includes(response.status)
          ? 'ARKESEL_AUTH_FAILED'
          : 'ARKESEL_PROVIDER_REJECTED',
        providerStatus: response.status,
        providerBody: payload ?? text,
      }
    );
  }

  // The critical check. Arkesel answers 200 with `status: "error"` for some
  // failures, so an accepted-looking HTTP status is not sufficient evidence that
  // the message was queued. Recording one of these as `submitted` would produce a
  // delivery record for a message that was never sent.
  if (!isAccepted(payload)) {
    const detail = payload?.message || payload?.error || 'no status field in response';
    throw new ArkeselTransportError(
      `Arkesel returned HTTP 200 but did not accept the message: ${detail}`,
      {
        status: 502,
        code: 'ARKESEL_NOT_ACCEPTED',
        providerStatus: response.status,
        providerBody: payload,
      }
    );
  }

  return {
    providerMessageId: readMessageId(payload),
    creditsUsed: readCreditsUsed(payload),
    raw: payload,
  };
};

export default sendArkeselSms;
