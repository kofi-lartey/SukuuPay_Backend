// ─────────────────────────────────────────────
// MTN MoMo API client (Collections product)
// ─────────────────────────────────────────────
// The only module that knows MTN's wire format. Everything above this layer
// speaks in terms of { phone, amount, externalId }, so an endpoint path change
// or a Graph-version-style bump is a change to this file alone.
//
// Three properties of the provider shape this client:
//
//   1. Access tokens are per-product and short-lived (MTN_TOKEN_EXPIRY seconds,
//      3600 by default). They are cached in-process per product so a burst of
//      payments does not mint a token per request — MTN rate-limits the token
//      endpoint far below the payment endpoints.
//   2. Every mutating call must carry a unique `X-Reference-Id` (UUID). MTN uses
//      it as an idempotency key: a retry of the same reference replays the
//      original response instead of debiting the subscriber twice. This is
//      mandatory, not advisory — a client that times out and retries without one
//      double-charges a parent.
//   3. RequestToPay is asynchronous. It returns 202 with a reference; the money
//      only moves when the payer authorises the prompt, and the final state
//      arrives by callback or by polling. Nothing here ever fabricates a
//      success — failures throw WhatsAppTransportError's MTN equivalent.
//
// Amounts cross the wire in major units as strings (MTN takes "100.00", not
// 10000). The platform stores integer pesewas, so the conversion lives here and
// nowhere else.
import {
  MTN_BASE_URL,
  MTN_ENVIRONMENT,
  MTN_COLLECTION_SUBSCRIPTION_KEY,
  MTN_DISBURSEMENT_SUBSCRIPTION_KEY,
  MTN_API_USER,
  MTN_API_KEY,
  MTN_TARGET_ENVIRONMENT,
  MTN_TOKEN_PATH,
  MTN_TOKEN_EXPIRY,
  MTN_REQUEST_TIMEOUT_MS,
  MTN_CURRENCY,
  MTN_CALLBACK_HOST,
} from '../config/env.js';
import { normalisePhone, toGhanaE164 } from './phoneNumbers.js';
// Placeholder detection is shared with the WhatsApp status helper: both channels
// have shipped with `your-*-credentials` in .env, and both used to report
// themselves as configured because those strings are truthy.
import { isPlaceholder, allConfigured } from './placeholder.js';

/**
 * Typed transport failure. `status` is the HTTP status the API layer should
 * surface; `code` lets callers branch without matching on message text.
 */
export class MtnTransportError extends Error {
  constructor(
    message,
    { status = 502, code = 'MTN_PROVIDER_ERROR', providerStatus = null, providerBody = null } = {}
  ) {
    super(message);
    this.name = 'MtnTransportError';
    this.status = status;
    this.code = code;
    this.providerStatus = providerStatus;
    this.providerBody = providerBody;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ──────────────────── Configuration ────────────────────

/** Product names map to their own subscription key and endpoint prefix. */
const PRODUCTS = {
  collection: {
    path: '/collection',
    subscriptionKey: MTN_COLLECTION_SUBSCRIPTION_KEY,
  },
  disbursement: {
    path: '/disbursement',
    subscriptionKey: MTN_DISBURSEMENT_SUBSCRIPTION_KEY,
  },
};

/** True when there is enough configuration to actually reach MTN Collections. */
export const isMtnConfigured = () =>
  allConfigured(MTN_API_USER, MTN_API_KEY, MTN_COLLECTION_SUBSCRIPTION_KEY);

/**
 * Configuration status for GET /version. Reports only whether a credential is
 * present, never its value.
 */
export const getMtnConfigStatus = () => ({
  configured: isMtnConfigured(),
  environment: MTN_ENVIRONMENT,
  targetEnvironment: MTN_TARGET_ENVIRONMENT,
  baseUrl: MTN_BASE_URL,
  hasApiUser: !isPlaceholder(MTN_API_USER),
  hasApiKey: !isPlaceholder(MTN_API_KEY),
  hasCollectionKey: !isPlaceholder(MTN_COLLECTION_SUBSCRIPTION_KEY),
  hasDisbursementKey: !isPlaceholder(MTN_DISBURSEMENT_SUBSCRIPTION_KEY),
  // Worth surfacing on its own: credentials that are present but still say
  // "your-..." read as configured everywhere except here, and the symptom is a
  // 401 on every payment rather than a visible misconfiguration.
  hasPlaceholderCredentials:
    isPlaceholder(MTN_API_USER) ||
    isPlaceholder(MTN_API_KEY) ||
    isPlaceholder(MTN_COLLECTION_SUBSCRIPTION_KEY),
  currency: MTN_CURRENCY,
  callbackHost: MTN_CALLBACK_HOST || null,
});

const assertConfigured = (product = 'collection') => {
  const config = PRODUCTS[product];
  if (!config) {
    throw new MtnTransportError(`Unknown MTN product "${product}"`, {
      status: 400,
      code: 'MTN_UNKNOWN_PRODUCT',
    });
  }
  if (isPlaceholder(MTN_API_USER) || isPlaceholder(MTN_API_KEY)) {
    throw new MtnTransportError('MTN_API_USER / MTN_API_KEY is not configured', {
      status: 503,
      code: 'MTN_NOT_CONFIGURED',
    });
  }
  if (isPlaceholder(config.subscriptionKey)) {
    throw new MtnTransportError(`MTN ${product} subscription key is not configured`, {
      status: 503,
      code: 'MTN_NOT_CONFIGURED',
    });
  }
};

// ──────────────────── Token cache ────────────────────
// Keyed by product because MTN issues a distinct token per product, and holding
// one product's token against another's endpoint is rejected with a 401.

const tokenCache = new Map();

// A 60s safety margin so a token cannot expire between the cache check and the
// request that uses it.
const tokenExpiryMarginMs = 60_000;

const getCachedToken = (product) => {
  const cached = tokenCache.get(product);
  if (!cached) return null;
  if (cached.expiresAtMs - tokenExpiryMarginMs <= Date.now()) {
    tokenCache.delete(product);
    return null;
  }
  return cached.token;
};

const cacheToken = (product, token, expiresInSeconds) => {
  const expiresIn = Number(expiresInSeconds) || MTN_TOKEN_EXPIRY;
  tokenCache.set(product, {
    token,
    // MTN reports expires_in in seconds; fall back to the configured value.
    expiresAtMs: Date.now() + expiresIn * 1000,
  });
};

/** Test seam: drops cached tokens so the next call re-mints one. */
export const clearMtnTokenCache = () => tokenCache.clear();

// ──────────────────── HTTP ────────────────────

const basicAuth = () =>
  Buffer.from(`${MTN_API_USER}:${MTN_API_KEY}`).toString('base64');

/**
 * Requests an OAuth access token for one product and caches it.
 *
 * Concurrent callers share one in-flight request per product: a burst of
 * payments on a cold cache would otherwise mint N tokens and trip MTN's token
 * rate limit.
 */
const requestToken = async (product) => {
  const config = PRODUCTS[product];
  const url = `${MTN_BASE_URL}${config.path}${MTN_TOKEN_PATH}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(MTN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new MtnTransportError(`MTN token request failed: ${error.message}`, {
      status: 502,
      code: 'MTN_PROVIDER_UNREACHABLE',
    });
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.message || text || response.statusText;
    throw new MtnTransportError(`MTN token request failed (${response.status}): ${detail}`, {
      status: 502,
      code: 'MTN_AUTH_FAILED',
      providerStatus: response.status,
      providerBody: payload ?? text,
    });
  }

  const token = payload?.access_token;
  if (!token) {
    throw new MtnTransportError('MTN token response carried no access_token', {
      status: 502,
      code: 'MTN_AUTH_FAILED',
      providerStatus: response.status,
      providerBody: payload,
    });
  }

  cacheToken(product, token, payload?.expires_in);
  return token;
};

/** Returns a valid token for the product, minting or replaying as needed. */
export const getMtnToken = async (product = 'collection') => {
  assertConfigured(product);

  const cached = getCachedToken(product);
  if (cached) return cached;

  const inFlight = tokenCache.get(`${product}:pending`);
  if (inFlight) return inFlight;

  const pending = requestToken(product).finally(() => {
    tokenCache.delete(`${product}:pending`);
  });
  tokenCache.set(`${product}:pending`, pending);

  return pending;
};

/** Headers every MTN business call carries. */
const buildHeaders = async ({ product, referenceId, callbackUrl }) => {
  const token = await getMtnToken(product);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    accept: 'application/json',
    'Ocp-Apim-Subscription-Key': PRODUCTS[product].subscriptionKey,
    'X-Target-Environment': MTN_TARGET_ENVIRONMENT,
  };
  // Idempotency key. Absent on a read, mandatory on a write.
  if (referenceId) headers['X-Reference-Id'] = referenceId;
  if (callbackUrl) headers['X-Callback-Url'] = callbackUrl;
  return headers;
};

/**
 * One MTN business call, with a single transparent retry on an expired token.
 *
 * MTN returns 401 for a token that expired mid-flight. Refreshing once and
 * replaying is correct and safe precisely because writes carry X-Reference-Id:
 * the retry is idempotent, so it cannot double-charge.
 */
const request = async (product, path, { method = 'GET', body = null, referenceId, callbackUrl } = {}) => {
  assertConfigured(product);

  const url = `${MTN_BASE_URL}${PRODUCTS[product].path}${path}`;

  const send = async () => {
    const headers = await buildHeaders({ product, referenceId, callbackUrl });
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(MTN_REQUEST_TIMEOUT_MS),
    });
    return response;
  };

  let response;
  try {
    response = await send();
  } catch (error) {
    throw new MtnTransportError(`MTN request failed: ${error.message}`, {
      status: 502,
      code: 'MTN_PROVIDER_UNREACHABLE',
    });
  }

  if (response.status === 401) {
    clearMtnTokenCache();
    try {
      response = await send();
    } catch (error) {
      throw new MtnTransportError(`MTN request failed: ${error.message}`, {
        status: 502,
        code: 'MTN_PROVIDER_UNREACHABLE',
      });
    }
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // MTN returns an HTML error page for a WAF rejection; keep the raw text.
    payload = null;
  }

  if (!response.ok) {
    const detail =
      payload?.message || payload?.statusDescription || text || response.statusText;
    throw new MtnTransportError(
      `MTN request failed (${response.status}): ${detail}`,
      {
        status: 502,
        code: 'MTN_PROVIDER_REJECTED',
        providerStatus: response.status,
        providerBody: payload ?? text,
      }
    );
  }

  return payload;
};

// ──────────────────── Amount conversion ────────────────────

/**
 * pesewas → MTN's major-unit string.
 *
 * The platform's whole money model is integer pesewas, so a payment of 10000
 * is GHS 100.00. Rounding to 2dp is exact for pesewas and is what MTN expects;
 * returning a string rather than a number is deliberate — MTN takes amounts as
 * strings and a float here would reintroduce the error the pesewa model exists
 * to prevent.
 */
export const pesewasToMtnAmount = (pesewas) => {
  const value = Math.round(Number(pesewas) || 0) / 100;
  return value.toFixed(2);
};

// ──────────────────── Collections ────────────────────

/**
 * Requests a payment from a payer (Request To Pay).
 *
 * The payer receives a MoMo prompt and authorises it; only then does the money
 * move. Returns MTN's reference, which is what the status endpoint and the
 * callback both key off.
 *
 * @param {{ amount: number, phone: string, externalId: string,
 *   payerMessage?: string, payeeNote?: string, referenceId?: string }} params
 *   `amount` is in pesewas.
 */
export const requestToPay = async ({
  amount,
  phone,
  externalId,
  payerMessage = '',
  payeeNote = '',
  referenceId,
}) => {
  assertConfigured('collection');

  // MTN accepts MSISDN in E.123. A Ghanaian local number is normalised here
  // rather than pushed onto the caller, because a bare "024..." is rejected by
  // the provider with an opaque error.
  const normalised = toGhanaE164(phone);
  if (!normalised.valid) {
    throw new MtnTransportError(
      `"${phone}" is not a valid MSISDN for MTN Mobile Money: ${normalised.reason}`,
      { status: 400, code: 'MTN_INVALID_MSISDN' }
    );
  }

  // The reference is our idempotency key. Deriving it from externalId means a
  // client retry of the same logical payment replays rather than re-debits,
  // even if the retry is a fresh process that lost its in-memory state.
  const xReference = referenceId || externalId;

  return request(
    'collection',
    '/v1_0/requesttopay',
    {
      method: 'POST',
      referenceId: xReference,
      body: {
        amount: pesewasToMtnAmount(amount),
        currency: MTN_CURRENCY,
        externalId: String(externalId),
        payer: {
          partyIdType: 'MSISDN',
          partyId: normalised.e164,
        },
        payerMessage: String(payerMessage).slice(0, 160),
        payeeNote: String(payeeNote).slice(0, 160),
      },
    }
  );
};

/**
 * Reads the final state of a Request To Pay.
 *
 * Poll this rather than trusting the callback alone: the callback is a
 * notification and is never the system of record.
 *
 * @param {string} referenceId MTN's reference from requestToPay.
 */
export const getTransactionStatus = async (referenceId) =>
  request('collection', `/v1_0/requesttopay/${encodeURIComponent(referenceId)}`);

/** The merchant's available MoMo wallet balance. */
export const getBalance = async () => request('collection', '/v1_0/account/balance');

/**
 * Whether an account holder is registered and active.
 *
 * Worth calling before initiating a charge: an inactive MSISDN fails the debit
 * at the provider, and telling the parent up front beats a payment that sits
 * pending until it times out.
 */
export const isAccountActive = async (phone) => {
  const normalised = toGhanaE164(phone);
  if (!normalised.valid) {
    throw new MtnTransportError(
      `"${phone}" is not a valid MSISDN: ${normalised.reason}`,
      { status: 400, code: 'MTN_INVALID_MSISDN' }
    );
  }
  return request(
    'collection',
    `/v1_0/accountholder/msisdn/${encodeURIComponent(normalised.e164)}/active`
  );
};

// ──────────────────── Status mapping ────────────────────

/**
 * MTN transaction status → our Payment.status vocabulary.
 *
 * MTN's own states are SUCCESSFUL / FAILED / PENDING, plus REVERSED for a
 * provider-side reversal. Reversal is terminal: the money went back to the
 * payer, so it must never be treated as a settlement.
 */
export const mapMtnStatus = (status) => {
  switch (String(status || '').trim().toUpperCase()) {
    case 'SUCCESSFUL':
      return 'completed';
    case 'FAILED':
      return 'failed';
    case 'REVERSED':
      return 'refunded';
    case 'PENDING':
      return 'processing';
    default:
      return null;
  }
};

/** Normalises the many shapes an MTN transaction object arrives in. */
export const normaliseTransaction = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  return {
    referenceId: raw.referenceId || raw.ReferenceId || null,
    financialTransactionId: raw.financialTransactionId || raw.FinancialTransactionId || null,
    status: raw.status || raw.Status || null,
    statusReason: raw.statusReason || raw.StatusReason || raw.reason || null,
    amount: raw.amount ?? null,
    currency: raw.currency || null,
    externalId: raw.externalId || raw.ExternalId || null,
    payer: raw.payer?.partyId || null,
    payee: raw.payee?.partyId || null,
    raw,
  };
};
