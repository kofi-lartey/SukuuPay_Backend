// ─────────────────────────────────────────────
// Webhook signature verification
// ─────────────────────────────────────────────
// Every inbound webhook in this platform (Meta, Hubtel, Arkesel) authenticates
// itself with a keyed MAC over the exact bytes it sent. That means two things
// this module exists to enforce:
//
//   1. Verification must run against the RAW request body. Any JSON parse and
//      re-serialise changes byte-for-byte — key order, whitespace, unicode
//      escaping — and the digest will not match. The raw body is captured by
//      the `verify` hook in `src/index.js` as `req.rawBody`.
//   2. Comparison must be constant-time. A byte-at-a-time `===` leaks the
//      correct digest one character at a time.
//
// A webhook is an unauthenticated public POST surface that mutates money and
// delivery state, so a missing or unverifiable signature is rejected, never
// warned past.
import crypto from 'node:crypto';

/** Constant-time string comparison. Returns false for length mismatches. */
export const safeEqual = (a = '', b = '') => {
  const left = String(a);
  const right = String(b);
  if (!left.length || left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
};

export const hmacHex = (secret, payload, algorithm = 'sha256') =>
  crypto.createHmac(algorithm, String(secret)).update(payload ?? '').digest('hex');

export const sha256Hex = (payload) =>
  crypto.createHash('sha256').update(payload ?? '').digest('hex');

/**
 * Verifies a `sha256=<hex>` (or bare hex) signature header against the raw body.
 *
 * @param {{ header?: string, secret?: string, rawBody?: Buffer|string,
 *   algorithm?: string, prefix?: string }} params
 * @returns {{ valid: boolean, reason: string|null }}
 */
export const verifyHmacSignature = ({
  header,
  secret,
  rawBody,
  algorithm = 'sha256',
  prefix = 'sha256=',
} = {}) => {
  if (!secret) return { valid: false, reason: 'no_shared_secret_configured' };
  if (!header) return { valid: false, reason: 'signature_header_missing' };
  if (rawBody === null || rawBody === undefined) {
    return { valid: false, reason: 'raw_body_unavailable' };
  }

  const provided = String(header).trim();
  const expected = `${prefix}${hmacHex(secret, rawBody, algorithm)}`;

  // A provider that omits the algorithm prefix is common enough to accept;
  // a prefix of a *different* algorithm is not silently reinterpreted.
  const providedWithPrefix = provided.includes('=') ? provided : `${prefix}${provided}`;

  if (!safeEqual(providedWithPrefix, expected)) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  return { valid: true, reason: null };
};

/**
 * Meta's outbound-webhook check: `X-Hub-Signature-256: sha256=<hmac>` over the
 * raw body using the app secret. Separated from the generic helper because the
 * header name and algorithm are fixed by Meta and callers should not be able to
 * pass something else.
 */
export const verifyMetaSignature = ({ header, secret, rawBody } = {}) =>
  verifyHmacSignature({ header, secret, rawBody, algorithm: 'sha256', prefix: 'sha256=' });

/**
 * Hubtel signs the raw body with HMAC-SHA512 using the account API key and
 * sends the bare hex digest in `X-Hubtel-Signature`. Some gateway
 * configurations prefix it with the algorithm name, so both forms are accepted.
 */
export const verifyHubtelSignature = ({ header, secret, rawBody } = {}) => {
  const provided = String(header ?? '').trim();
  const stripped = provided.replace(/^sha512=/i, '');
  return verifyHmacSignature({ header: stripped, secret, rawBody, algorithm: 'sha512', prefix: '' });
};

/**
 * Arkesel authenticates the delivery callback either by echoing the account
 * key in the `api_key` form field, or by signing the body with HMAC-SHA256 in
 * `X-Arkesel-Signature`. Either proof is accepted; at least one must hold.
 */
export const verifyArkeselAuth = ({ signatureHeader, secret, providedApiKey, rawBody } = {}) => {
  if (secret && providedApiKey && safeEqual(providedApiKey, secret)) {
    return { valid: true, reason: null, method: 'api_key' };
  }

  const signature = verifyHmacSignature({
    header: signatureHeader,
    secret,
    rawBody,
    algorithm: 'sha256',
    prefix: 'sha256=',
  });

  if (signature.valid) return { valid: true, reason: null, method: 'signature' };

  return {
    valid: false,
    reason: signature.reason === 'no_shared_secret_configured' ? signature.reason : 'signature_mismatch',
  };
};
