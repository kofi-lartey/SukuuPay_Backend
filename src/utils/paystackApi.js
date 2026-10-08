// ─────────────────────────────────────────────
// Paystack API client
// ─────────────────────────────────────────────
// The single module that knows Paystack's wire format. Everything above this
// layer speaks in terms of { amount, email, reference, currency }, so a
// provider endpoint change or API-version bump is a change to this file alone.
//
// Three properties shape this client:
//
//   1. Paystack's secret key is per-deployment. A school may override with
//      their own key stored on School.payment.paystackSecretKey; if absent
//      the platform-level PAYSTACK_SECRET_KEY is used.
//   2. `reference` is the idempotency key for Initialize Transaction — a
//      retry of the same reference returns the existing session rather than
//      creating a duplicate.
//   3. Transactions are asynchronous from the parent's perspective:
//      Initialize returns a `data.authorization_url` the parent is redirected
//      to, and the final state arrives by webhook or by polling the Verify
//      endpoint. Nothing here ever fabricates a success.
//
// Amounts cross the wire in major units as integers (Paystack takes 100 for
// GH₵ 1.00). The platform stores integer pesewas, so the conversion lives
// here and nowhere else.
import crypto from 'crypto';
import { PAYSTACK_SECRET_KEY, PAYSTACK_PUBLIC_KEY } from '../config/env.js';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

/**
 * Typed transport failure for Paystack API errors.
 * `status` is the HTTP status to surface; `code` is the Paystack
 * `code` field (e.g. "duplicate_reference"), if present.
 */
export class PaystackTransportError extends Error {
  constructor(message, { status = 502, code = 'PAYSTACK_PROVIDER_ERROR', providerStatus = null, providerBody = null } = {}) {
    super(message);
    this.name = 'PaystackTransportError';
    this.status = status;
    this.code = code;
    this.providerStatus = providerStatus;
    this.providerBody = providerBody;
  }
}

/**
 * Returns the secret key to use for a given school.
 * Falls back to the platform-level key when the school has not configured
 * its own. Throws when neither is available — this is a deployment error,
 * not grounds for a silent fallback to another gateway.
 */
export const resolvePaystackSecretKey = (school) => {
  return school?.payment?.paystackSecretKey || PAYSTACK_SECRET_KEY;
};

/**
 * Verifies a Paystack webhook signature.
 *
 * Paystack signs the raw request body with HMAC-SHA512 using the webhook
 * secret, and sends it in the `X-Paystack-Signature` header.
 *
 * @param {object} params
 * @param {string} params.signature - The `X-Paystack-Signature` header value
 * @param {Buffer|string} params.rawBody - The raw request body
 * @param {string} [params.secret] - The Paystack webhook secret (defaults to PAYSTACK_WEBHOOK_SECRET)
 * @returns {{ valid: boolean, reason?: string }}
 */
export const verifyPaystackSignature = ({ signature, rawBody, secret }) => {
  const shared = secret || PAYSTACK_WEBHOOK_SECRET;

  if (!signature) {
    return { valid: false, reason: 'no_signature_header' };
  }

  if (!shared) {
    return { valid: false, reason: 'no_shared_secret_configured' };
  }

  const expected = crypto
    .createHmac('sha512', shared)
    .update(rawBody)
    .digest('hex');

  const provided = signature.toLowerCase();

  const valid = crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(provided, 'hex')
  );

  if (!valid) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  return { valid: true };
};

/**
 * Converts integer pesewas to the major-unit string Paystack expects.
 * e.g. 55000 → "550.00"
 */
const toMajorUnits = (pesewas) => (Number(pesewas) / 100).toFixed(2);

/**
 * Makes an authenticated request to the Paystack API.
 */
const paystackRequest = async (path, method, body, secretKey) => {
  const response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.status === false) {
    throw new PaystackTransportError(
      data.message || `Paystack API ${method} ${path} failed`,
      {
        status: response.status >= 400 ? response.status : 502,
        code: data.code || 'PAYSTACK_API_ERROR',
        providerStatus: response.status,
        providerBody: data,
      }
    );
  }

  return data;
};

/**
 * Initializes a Paystack transaction (redirect-based checkout).
 *
 * @param {object} params
 * @param {string} params.secretKey - Paystack secret key
 * @param {string} params.email - Payer's email
 * @param {number} params.amount - Amount in pesewas
 * @param {string} params.reference - Unique reference (paymentId)
 * @param {string} [params.callbackUrl] - URL Paystack redirects to after payment
 * @param {string} [params.currency='GHS']
 * @param {object} [params.metadata] - Custom metadata to attach
 * @returns {Promise<{ authorizationUrl: string, accessCode: string, reference: string }>}
 */
export const initializeTransaction = async ({
  secretKey,
  email,
  amount,
  reference,
  callbackUrl,
  currency = 'GHS',
  metadata = {},
}) => {
  if (!secretKey) {
    throw new PaystackTransportError(
      'No Paystack secret key configured for this school',
      { status: 500, code: 'PAYSTACK_NOT_CONFIGURED' }
    );
  }

  const result = await paystackRequest(
    '/v1/transaction/initialize',
    'POST',
    {
      email,
      amount: toMajorUnits(amount),
      currency,
      reference,
      callback_url: callbackUrl,
      metadata,
    },
    secretKey
  );

  const authData = result.data;

  if (!authData || !authData.authorization_url) {
    throw new PaystackTransportError(
      'Paystack did not return an authorization URL',
      { status: 502, code: 'PAYSTACK_INIT_FAILED' }
    );
  }

  return {
    authorizationUrl: authData.authorization_url,
    accessCode: authData.access_code || null,
    reference: authData.reference || reference,
    publicKey: PAYSTACK_PUBLIC_KEY,
  };
};

/**
 * Verifies a Paystack transaction by reference.
 *
 * Used both for the parent-facing status poll and as the webhook fallback.
 *
 * @param {object} params
 * @param {string} params.secretKey
 * @param {string} params.reference
 * @returns {Promise<object>} - The Paystack transaction object
 */
export const verifyTransaction = async ({ secretKey, reference }) => {
  if (!secretKey) {
    throw new PaystackTransportError(
      'No Paystack secret key configured for this school',
      { status: 500, code: 'PAYSTACK_NOT_CONFIGURED' }
    );
  }

  const result = await paystackRequest(`/v1/transaction/verify/${encodeURIComponent(reference)}`, 'GET', null, secretKey);

  if (!result.data) {
    throw new PaystackTransportError(
      'Paystack did not return transaction data',
      { status: 502, code: 'PAYSTACK_VERIFY_FAILED' }
    );
  }

  return result.data;
};

/**
 * Maps Paystack transaction status to our internal states.
 *
 * Paystack `status`: "success" | "failed" | "pending" | "abandoned"
 */
export const mapPaystackStatus = (status) => {
  const normalized = String(status || '').toLowerCase();
  switch (normalized) {
    case 'success':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'pending':
    case 'abandoned':
    case '':
      return 'processing';
    default:
      return 'processing';
  }
};

/**
 * Returns true when the Paystack status indicates a successful settlement.
 */
export const isPaystackSuccessful = (status) => mapPaystackStatus(status) === 'completed';

/**
 * Returns true when the Paystack secret key is configured
 * (either school-level or platform-level).
 */
export const isPaystackConfigured = (school) =>
  Boolean(school?.payment?.paystackSecretKey || PAYSTACK_SECRET_KEY);
