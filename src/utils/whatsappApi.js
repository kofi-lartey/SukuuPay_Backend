// ─────────────────────────────────────────────
// WhatsApp Cloud API client (Meta / Graph API)
// ─────────────────────────────────────────────
// The only place that knows Meta's wire format. Everything above this layer
// speaks in terms of {phone, kind, body, template}, so a Graph API version bump
// or a renamed field is a change to this file alone.
//
// No provider is wired yet, so — like `smsService.js` — the client reports
// whether it is configured instead of pretending to deliver. It throws
// `WhatsAppTransportError` on every failure path, and never returns a
// fabricated success.
import {
  WHATSAPP_ENABLED,
  WHATSAPP_COMING_SOON_MESSAGE,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_BUSINESS_ACCOUNT_ID,
  WHATSAPP_GRAPH_BASE_URL,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_APP_SECRET,
  WHATSAPP_REQUEST_TIMEOUT_MS,
} from '../config/env.js';
import { isPlaceholder, allConfigured } from './placeholder.js';

/**
 * Typed transport failure. `status` is the HTTP status the API layer should
 * surface; `code` lets callers branch without matching on message text.
 */
export class WhatsAppTransportError extends Error {
  constructor(
    message,
    { status = 502, code = 'WHATSAPP_PROVIDER_ERROR', providerStatus = null, providerBody = null } = {}
  ) {
    super(message);
    this.name = 'WhatsAppTransportError';
    this.status = status;
    this.code = code;
    this.providerStatus = providerStatus;
    this.providerBody = providerBody;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * True when the channel is switched on.
 *
 * Distinct from `isWhatsAppConfigured`: a channel can be fully credentialed and
 * still deliberately off until Meta business verification completes. Version 2
 * ships disabled, and conflating the two would report a channel as live when
 * the intent is that it is not.
 */
export const isWhatsAppEnabled = () => WHATSAPP_ENABLED;

/**
 * True when there is enough configuration to actually reach Meta.
 *
 * Placeholder-aware. This used to be a plain truthiness check, which meant the
 * five `your-whatsapp-*` values shipped in .env were read as a working channel:
 * GET /version reported `configured: true` while every real call would 401.
 */
export const isWhatsAppConfigured = () =>
  allConfigured(WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID);

export const getWhatsAppConfigStatus = () => ({
  // The single field a client should branch on. A disabled channel is not an
  // error condition — it is a planned state.
  enabled: WHATSAPP_ENABLED,
  status: WHATSAPP_ENABLED ? 'active' : 'coming_soon_v2',
  comingSoonMessage: WHATSAPP_ENABLED ? null : WHATSAPP_COMING_SOON_MESSAGE,
  configured: isWhatsAppConfigured(),
  hasAccessToken: !isPlaceholder(WHATSAPP_ACCESS_TOKEN),
  hasPhoneNumberId: !isPlaceholder(WHATSAPP_PHONE_NUMBER_ID),
  hasBusinessAccountId: !isPlaceholder(WHATSAPP_BUSINESS_ACCOUNT_ID),
  hasAppSecret: !isPlaceholder(WHATSAPP_APP_SECRET),
  // Separated from `configured` on purpose: a channel whose credentials are all
  // still `your-...` is configured in name only, and that is exactly the state
  // that previously read as ready.
  hasPlaceholderCredentials:
    isPlaceholder(WHATSAPP_ACCESS_TOKEN) ||
    isPlaceholder(WHATSAPP_PHONE_NUMBER_ID) ||
    isPlaceholder(WHATSAPP_BUSINESS_ACCOUNT_ID) ||
    isPlaceholder(WHATSAPP_APP_SECRET),
  graphVersion: WHATSAPP_GRAPH_BASE_URL.split('/').pop() || null,
  // The sender number the business is registered on, used to ignore webhook
  // events Meta echoes back for our own outbound messages.
  displayPhoneNumber: null,
});

const assertConfigured = () => {
  if (!WHATSAPP_ACCESS_TOKEN) {
    throw new WhatsAppTransportError('WHATSAPP_ACCESS_TOKEN is not configured', {
      status: 503,
      code: 'WHATSAPP_NOT_CONFIGURED',
    });
  }
  if (!WHATSAPP_PHONE_NUMBER_ID) {
    throw new WhatsAppTransportError('WHATSAPP_PHONE_NUMBER_ID is not configured', {
      status: 503,
      code: 'WHATSAPP_NOT_CONFIGURED',
    });
  }
};

const request = async (path, { method = 'GET', body = null } = {}) => {
  assertConfigured();

  const url = `${WHATSAPP_GRAPH_BASE_URL}${path}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(WHATSAPP_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Network error, DNS failure, or our own timeout.
    throw new WhatsAppTransportError(`WhatsApp request to Meta failed: ${error.message}`, {
      status: 502,
      code: 'WHATSAPP_PROVIDER_UNREACHABLE',
    });
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Meta returns HTML for some edge cases; keep the raw text for the audit.
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.error?.message || text || response.statusText;
    throw new WhatsAppTransportError(`WhatsApp request failed (${response.status}): ${detail}`, {
      status: 502,
      code: 'WHATSAPP_PROVIDER_REJECTED',
      providerStatus: response.status,
      providerBody: payload ?? text,
    });
  }

  return payload;
};

// ──────────────────── Sending ────────────────────

/**
 * Builds the `messaging_product` request body Meta expects.
 *
 * Exported because the bulk worker builds one per recipient and because the
 * single-send path needs the same shape; keeping it here means the two cannot
 * drift.
 *
 * @param {{ to: string, kind?: string, body?: string,
 *   template?: { name: string, language?: string, parameters?: Array<any> },
 *   image?: object, document?: object, interactive?: object }} message
 */
export const buildSendPayload = ({ to, kind = 'text', body, template, image, document, interactive }) => {
  const base = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
  };

  if (kind === 'template') {
    if (!template?.name) {
      throw new WhatsAppTransportError('A template send requires template.name', {
        status: 400,
        code: 'WHATSAPP_TEMPLATE_REQUIRED',
      });
    }
    const parameters = (template.parameters || []).map((value) => ({
      type: 'text',
      text: String(value),
    }));

    return {
      ...base,
      type: 'template',
      template: {
        name: template.name,
        // Meta rejects a template send with no language; `en` is the fallback
        // every school in the current market reads.
        language: { code: template.language || 'en' },
        ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}),
      },
    };
  }

  if (kind === 'image') return { ...base, type: 'image', image };
  if (kind === 'document') return { ...base, type: 'document', document };
  if (kind === 'interactive') return { ...base, type: 'interactive', interactive };

  return {
    ...base,
    type: 'text',
    text: { body: body ?? '', preview_url: false },
  };
};

/**
 * Sends one message.
 * @returns {Promise<{ providerMessageId: string|null, raw: object }>}
 */
export const sendWhatsAppMessage = async (message) => {
  const payload = buildSendPayload(message);
  const response = await request(`/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    body: payload,
  });

  return {
    providerMessageId: response?.messages?.[0]?.id ?? null,
    // Meta rewrites the number to the customer's WhatsApp id (`wa_id`), which
    // is what future inbound messages will be addressed from.
    resolvedPhone: response?.contacts?.[0]?.wa_id ?? null,
    raw: response,
  };
};

/** Marks an inbound message as read, so the parent's tick turns blue. */
export const markWhatsAppRead = async (providerMessageId) => {
  return request(`/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: providerMessageId,
    },
  });
};

// ──────────────────── Templates ────────────────────

/**
 * Submits a template for Meta approval. This is asynchronous on Meta's side:
 * the response carries a numeric template id and a `PENDING` status, and the
 * real verdict arrives later (or only when the business is queried for it).
 */
export const createProviderTemplate = async ({ name, category, body, example }) => {
  if (!WHATSAPP_BUSINESS_ACCOUNT_ID) {
    throw new WhatsAppTransportError('WHATSAPP_BUSINESS_ACCOUNT_ID is not configured', {
      status: 503,
      code: 'WHATSAPP_NOT_CONFIGURED',
    });
  }

  const component = {
    type: 'BODY',
    text: body,
    ...(example ? { example: { body_text: [example] } } : {}),
  };

  return request(`/${WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`, {
    method: 'POST',
    body: {
      name,
      category,
      components: [component],
    },
  });
};

/** Reads the current approval status Meta holds for a template. */
export const getProviderTemplateStatus = async (providerTemplateId) => {
  const response = await request(`/${providerTemplateId}?fields=id,name,status,category`);
  return {
    providerTemplateId: response?.id ?? providerTemplateId,
    name: response?.name ?? null,
    status: (response?.status || '').toLowerCase() || null,
    category: response?.category ?? null,
  };
};

/** Lists the template ids Meta holds for this business account. */
export const listProviderTemplates = async () => {
  if (!WHATSAPP_BUSINESS_ACCOUNT_ID) {
    throw new WhatsAppTransportError('WHATSAPP_BUSINESS_ACCOUNT_ID is not configured', {
      status: 503,
      code: 'WHATSAPP_NOT_CONFIGURED',
    });
  }
  const response = await request(`/${WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates?fields=id,name,status,category`);
  return response?.data ?? [];
};
