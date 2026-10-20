// ─────────────────────────────────────────────
// Moolre WhatsApp transport
// ─────────────────────────────────────────────
// WhatsApp delivery over the same Moolre account that collects the payments.
//
// For a school this is the same argument as SMS: one vendor, one wallet, one
// balance to top up. The difference is that WhatsApp is not a free-form
// channel — every message is an **approved template**, the way it is on Meta's
// own API, because Moolre resells Meta WhatsApp Business.
//
// ## Credentials
//
// **The WhatsApp VAS key is not the SMS VAS key.** Moolre issues one
// service-specific `X-API-VASKEY` per service, and the WhatsApp endpoints
// reject the SMS one. A deployment needs both:
//
//   MOOLRE_SMS_VASKEY       — for /open/sms/*
//   MOOLRE_WHATSAPP_VASKEY  — for /open/whatsapp/*
//
// Sending the SMS key to a WhatsApp endpoint is answered `AIN11`; sending
// nothing is answered `403 WAS403`.
//
// ## What this API can and cannot do
//
// It is an **outbound** channel. There are three endpoints — list templates,
// send a message, check message status — and none of them accepts an inbound
// message. Anything in the platform that depends on *receiving* a reply (a
// parent's "ACCEPT <token>" on a payment plan, a conversation thread) still
// needs Meta's inbound webhook; Moolre covers the sending side only.
//
// ## The `ref` is the handle
//
// Moolre's send response carries no message id — `data` is an empty array on
// success. The `ref` we supply is the only thing the status endpoint can match
// on, so it is generated here and is never optional. A message sent without
// one is a message whose delivery can never be confirmed.
import {
  MOOLRE_BASE_URL,
  MOOLRE_REQUEST_TIMEOUT_MS,
  MOOLRE_WHATSAPP_VASKEY,
} from '../config/env.js';
import { toGhanaE164, toDigits } from './phoneNumbers.js';

const TEMPLATES_ENDPOINT = '/open/whatsapp/template';
const SEND_ENDPOINT = '/open/whatsapp/send';
const STATUS_ENDPOINT = '/open/whatsapp/status';

/**
 * A failure that came from Moolre rather than from our own code.
 *
 * The same shape as `MoolreSmsTransportError` and `WhatsAppTransportError`,
 * so the delivery-log layer treats every provider the same way.
 */
export class MoolreWhatsAppTransportError extends Error {
  constructor(
    message,
    { status = 502, code = 'MOOLRE_WHATSAPP_PROVIDER_ERROR', providerStatus = null, providerBody = null } = {}
  ) {
    super(message);
    this.name = 'MoolreWhatsAppTransportError';
    this.status = status;
    this.code = code;
    this.providerStatus = providerStatus;
    this.providerBody = providerBody;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** True when the WhatsApp service has a credential to use. */
export const isMoolreWhatsAppConfigured = () => Boolean(MOOLRE_WHATSAPP_VASKEY);

/**
 * One Moolre WhatsApp call.
 *
 * The `X-API-VASKEY` header is always the **WhatsApp** key. There is no
 * fallback to the SMS key: the two are different credentials, and sending the
 * wrong one produces an authentication error that looks like a service outage.
 */
const request = async (path, { method = 'POST', body, query } = {}) => {
  if (!isMoolreWhatsAppConfigured()) {
    throw new MoolreWhatsAppTransportError(
      'Moolre WhatsApp is not configured. Set MOOLRE_WHATSAPP_VASKEY — the WhatsApp service has its own VAS key, separate from the SMS one.',
      { status: 503, code: 'MOOLRE_WHATSAPP_NOT_CONFIGURED' }
    );
  }

  const url = new URL(`${MOOLRE_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOOLRE_REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-VASKEY': MOOLRE_WHATSAPP_VASKEY,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      throw new MoolreWhatsAppTransportError(
        `Moolre WhatsApp request to ${path} timed out after ${MOOLRE_REQUEST_TIMEOUT_MS}ms. The message may or may not have been accepted — reconcile before retrying.`,
        { status: 504, code: 'MOOLRE_WHATSAPP_TIMEOUT' }
      );
    }
    throw new MoolreWhatsAppTransportError(
      `Moolre WhatsApp request to ${path} failed: ${error.message}. The message may or may not have been accepted — reconcile before retrying.`,
      { status: 502, code: 'MOOLRE_WHATSAPP_PROVIDER_UNREACHABLE' }
    );
  }
  clearTimeout(timer);

  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }

  const businessStatus = payload?.status;
  const ok = response.ok && (businessStatus === undefined || Number(businessStatus) === 1);

  if (!ok) {
    const message =
      payload?.message || `Moolre WhatsApp request failed (HTTP ${response.status})`;
    throw new MoolreWhatsAppTransportError(message, {
      status: response.status >= 400 ? response.status : 502,
      code: payload?.code || 'MOOLRE_WHATSAPP_PROVIDER_ERROR',
      providerStatus: response.status,
      providerBody: payload,
    });
  }

  return payload;
};

/**
 * The recipient form Moolre expects: international digits, no `+` and no
 * spaces — `233244000000`.
 *
 * The platform stores numbers in E.164 with a leading `+`, which Meta's API
 * rejects and Moolre expects without. Normalising here keeps the difference
 * in one place instead of at every call site.
 */
const toMoolreRecipient = (to) => {
  const e164 = toGhanaE164(to);
  if (!e164?.valid) {
    throw new MoolreWhatsAppTransportError(
      `"${to}" is not a valid Ghanaian MSISDN for WhatsApp: ${e164?.reason || 'unrecognised format'}`,
      { status: 400, code: 'MOOLRE_WHATSAPP_INVALID_MSISDN' }
    );
  }
  return toDigits(e164.e164);
};

/**
 * Lists the approved WhatsApp templates on the account.
 *
 * The templates are Meta's, approved in Moolre's dashboard. Each carries
 * positional placeholders — `{{1}}`, `{{2}}` — listed in `placeholders`, and
 * a template is sent by its `name`.
 *
 * @param {string} [next] the cursor from a previous page
 */
export const getMoolreWhatsAppTemplates = async ({ next } = {}) => {
  const payload = await request(TEMPLATES_ENDPOINT, { method: 'GET', query: { next } });

  const data = Array.isArray(payload?.data) ? payload.data : [];

  return {
    templates: data.map((template) => ({
      id: template?.id ?? null,
      name: template?.name ?? null,
      language: template?.language ?? 'en',
      // APPROVED | PENDING | REJECTED
      status: template?.status ?? null,
      body: template?.message ?? '',
      // The placeholder positions, in order: ["1", "2"].
      placeholders: Array.isArray(template?.placeholders) ? template.placeholders : [],
    })),
    // The cursor for the next page, or null at the end.
    next: payload?.next ?? null,
    raw: payload,
  };
};

/**
 * Sends a templated WhatsApp message.
 *
 * `templateName` must be an **approved** template. `placeholders` is the
 * values for the template's `{{1}}`, `{{2}}` … in order — positional, so the
 * order matters and a short array leaves later placeholders empty.
 *
 * Every message carries a `ref` we generate. It is the only handle on the
 * message — Moolre's send response carries no id — so the status endpoint can
 * only report on a message that has one.
 *
 * @param {object} params
 * @param {string} params.templateName the approved template's name
 * @param {string} [params.language='en'] the template language (English only)
 * @param {Array<{to: string, placeholders?: string[], ref?: string}>} params.messages
 */
export const sendMoolreWhatsAppMessage = async ({ templateName, language = 'en', messages }) => {
  if (!templateName) {
    throw new MoolreWhatsAppTransportError(
      'A WhatsApp template name is required — WhatsApp messages must use an approved template',
      { status: 400, code: 'MOOLRE_WHATSAPP_TEMPLATE_REQUIRED' }
    );
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new MoolreWhatsAppTransportError('At least one WhatsApp message is required', {
      status: 400,
      code: 'MOOLRE_WHATSAPP_NO_MESSAGES',
    });
  }

  const built = messages.map((message, index) => {
    const recipient = toMoolreRecipient(message.to);
    const ref =
      message.ref ||
      `wa-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 10)}`;
    return {
      recipient,
      ref,
      ...(Array.isArray(message.placeholders) && message.placeholders.length
        ? { placeholders: message.placeholders.map((value) => String(value)) }
        : {}),
    };
  });

  const payload = await request(SEND_ENDPOINT, {
    body: {
      template_name: templateName,
      language,
      messages: built,
    },
  });

  // **A partial failure looks like a success.**
  //
  // Moolre answers `status: 1` for a batch where some references were already
  // used. The rejections come back in `data`, and `error` carries the reason.
  // Treating that as a clean send would tell a school "sent" for messages
  // that were never delivered — so the rejections are separated out and the
  // caller is told.
  const rejected = Array.isArray(payload?.data) ? payload.data : [];
  const accepted = built.filter(
    (message) => !rejected.some((r) => r?.ref === message.ref)
  );

  return {
    sent: accepted.map((message) => ({
      ref: message.ref,
      to: message.recipient,
    })),
    rejected: rejected.map((message) => ({
      ref: message?.ref ?? null,
      to: message?.recipient ?? null,
      reason: String(payload?.error || 'Reference already used').slice(0, 300),
    })),
    raw: payload,
  };
};

/**
 * The delivery status of one or more messages, by their refs.
 *
 * The status values are Moolre's own words — `accepted`, `sent`, `delivered`,
 * `read`, `failed` — rather than the numbers the SMS endpoint uses.
 */
export const getMoolreWhatsAppMessageStatus = async ({ refs } = {}) => {
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new MoolreWhatsAppTransportError('At least one message ref is required', {
      status: 400,
      code: 'MOOLRE_WHATSAPP_NO_REFS',
    });
  }

  const payload = await request(STATUS_ENDPOINT, { body: { ref: refs } });

  const data = Array.isArray(payload?.data) ? payload.data : [];

  return {
    statuses: data.map((entry) => ({
      ref: entry?.ref ?? null,
      status: entry?.status ?? null,
    })),
    raw: payload,
  };
};

export default {
  isMoolreWhatsAppConfigured,
  getMoolreWhatsAppTemplates,
  sendMoolreWhatsAppMessage,
  getMoolreWhatsAppMessageStatus,
};
