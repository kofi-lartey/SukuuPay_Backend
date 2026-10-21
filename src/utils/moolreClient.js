// ─────────────────────────────────────────────
// Moolre API client
// ─────────────────────────────────────────────
// The one integration that reaches MTN MoMo, Telecel Cash and AT Money.
//
// Moolre is a Ghanaian EPSP licensed by the Bank of Ghana, which matters for a
// school-fee product: the merchant agreement, the settlement bank and the
// dispute path are all local.
//
// ## Credentials
//
// Moolre uses four credentials, not one:
//   MOOLRE_API_USER        — the account username, sent as `X-API-USER`
//   MOOLRE_API_KEY         — the private key, for account / transfer / payment ops
//   MOOLRE_PUBLIC_KEY      — the public key, for payment-initiation ops
//   MOOLRE_ACCOUNT_NUMBER  — the merchant wallet, sent on almost every call
//
// A missing credential fails fast on the first request rather than silently on
// the tenth.
//
// ## USSD push vs hosted checkout
//
//   1. **USSD push** (`/open/transact/status` with `type: 1`) — sends a prompt
//      to the payer's phone. The default for SukuuPay: parents already have
//      MoMo, and the prompt is a single tap.
//
//   2. **Hosted checkout** — opens a web page where the parent picks their
//      network. The fallback for a parent whose phone cannot receive the push.
//
// ## Channel codes
//
// Moolre identifies the network by number, not name:
//   13 = MTN,  6 = Telecel,  7 = AT
//
// `normaliseChannel` maps the SukuuPay-side names to those codes so no caller
// has to know them.
import {
  MOOLRE_API_KEY,
  MOOLRE_API_USER,
  MOOLRE_ACCOUNT_NUMBER,
  MOOLRE_BASE_URL,
  MOOLRE_CHECKOUT_EMAIL,
  MOOLRE_PUBLIC_KEY,
  MOOLRE_REQUEST_TIMEOUT_MS,
} from '../config/env.js';

// ──────────────────── Transport error ────────────────────

/**
 * A failure that came from Moolre rather than from our own code.
 *
 * The distinction matters at the call site: a transport error is a gateway
 * problem, and the payment router treats it as a reason to fall back to the
 * secondary gateway, while a validation error on our side is not worth
 * retrying anywhere.
 */
export class MoolreTransportError extends Error {
  constructor(
    message,
    { status = 502, code = 'MOOLRE_PROVIDER_ERROR', providerStatus = null, providerBody = null } = {}
  ) {
    super(message);
    this.name = 'MoolreTransportError';
    this.status = status;
    this.code = code;
    this.providerStatus = providerStatus;
    this.providerBody = providerBody;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ──────────────────── Configuration ────────────────────

/** True when every credential Moolre needs is present. */
export const isMoolreConfigured = () =>
  Boolean(MOOLRE_API_USER && MOOLRE_API_KEY && MOOLRE_PUBLIC_KEY && MOOLRE_ACCOUNT_NUMBER);

// ──────────────────── Channels ────────────────────

const CHANNEL_CODES = {
  MTN: '13',
  Telecel: '6',
  AirtelTigo: '7',
};

/**
 * The `momoNetwork` values this platform stores on a Student or Payment.
 *
 * The Student model carries `VODAFONE` and `AIRTELTELIGO` — the names Ghana
 * used before Telecel and AT re-branded — so a payment has to be able to name
 * a network in the vocabulary of the caller *and* in the vocabulary of the
 * document it is written to. Both are accepted here.
 */
const CHANNEL_ALIASES = {
  MTN: '13',
  'MTN MOMO': '13',
  13: '13',
  TELECEL: '6',
  VODAFONE: '6',
  'VODAFONE CASH': '6',
  6: '6',
  AT: '7',
  AIRTELTIGO: '7',
  // The spelling stored on `Student.momoNetwork` and `Payment.momoNetwork`.
  // Distinct from the parent-facing `AirtelTigo`, and missing it here meant a
  // payment initiated from a stored network was refused as unsupported.
  AIRTELTELIGO: '7',
  'AT MONEY': '7',
  7: '7',
};

/**
 * Maps a network name to Moolre's channel code.
 *
 * @throws when the network is not one Moolre can route to. Throwing is
 * deliberate: a payment sent with an unknown channel would be accepted by the
 * API and then fail silently at the carrier, leaving a parent whose money was
 * debited and whose balance was never credited.
 */
export const normaliseChannel = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) {
    throw new MoolreTransportError('A mobile money network is required', {
      status: 400,
      code: 'MOOLRE_CHANNEL_MISSING',
    });
  }
  if (CHANNEL_CODES[raw]) return CHANNEL_CODES[raw];
  const key = raw.toUpperCase();
  if (CHANNEL_ALIASES[key]) return CHANNEL_ALIASES[key];
  throw new MoolreTransportError(`Unsupported mobile money network: ${value}`, {
    status: 400,
    code: 'MOOLRE_UNSUPPORTED_CHANNEL',
  });
};

/**
 * The `momoNetwork` value to store on the Payment document.
 *
 * The reverse of `normaliseChannel`: Moolre's numeric channel code becomes the
 * vocabulary the Student and Payment models use.
 *
 * **Unlike `normaliseChannel`, this does not throw.** It is used on the audit
 * line *after* a payment has settled, and an unmappable channel there must not
 * turn a settled payment into a failed webhook — the money has moved either
 * way. An unrecognised channel is reported as `null`, which reads as "we do
 * not know", rather than aborting the write.
 */
export const channelLabel = (value) => {
  let code;
  try {
    code = normaliseChannel(value);
  } catch {
    return null;
  }
  if (code === '13') return 'MTN';
  if (code === '6') return 'VODAFONE';
  return 'AIRTELTELIGO';
};

// ──────────────────── Request plumbing ────────────────────

/**
 * One Moolre call.
 *
 * `path` is appended to the configured base URL. The response is unwrapped to
 * `payload.data`, which is where Moolre puts the useful part; a response that
 * carries neither `data` nor a success marker is returned whole, so a
 * shape change upstream does not silently produce `undefined` downstream.
 *
 * ## Which credential goes in which header
 *
 * Moolre does not use one key. The endpoint decides:
 *
 *   - `X-API-PUBKEY` — the **public** key. Payment initiation, payment status
 *     and the hosted payment link.
 *   - `X-API-KEY` — the **private** key. Account and transfer operations.
 *   - `X-API-VASKEY` — a separate VAS credential. SMS and WhatsApp.
 *
 * The payment endpoints are on the *public* key. Sending the private key
 * there is answered with `AIN01 Authentication Error`, and — this is the part
 * that bites — a 200 response carrying an application-level failure, so a
 * caller that only checks the HTTP status sees a success.
 */
const request = async (
  path,
  { method = 'POST', body, headers = {}, credential = 'public', envelope = false } = {}
) => {
  if (!isMoolreConfigured()) {
    throw new MoolreTransportError(
      'Moolre is not configured. Set MOOLRE_API_USER, MOOLRE_API_KEY, MOOLRE_PUBLIC_KEY and MOOLRE_ACCOUNT_NUMBER.',
      { status: 503, code: 'MOOLRE_NOT_CONFIGURED' }
    );
  }

  const credentialHeaders =
    credential === 'private'
      ? { 'X-API-KEY': MOOLRE_API_KEY }
      : { 'X-API-PUBKEY': MOOLRE_PUBLIC_KEY };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOOLRE_REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${MOOLRE_BASE_URL}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-USER': MOOLRE_API_USER,
        ...credentialHeaders,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      throw new MoolreTransportError(
        `Moolre request to ${path} timed out after ${MOOLRE_REQUEST_TIMEOUT_MS}ms`,
        { status: 504, code: 'MOOLRE_TIMEOUT' }
      );
    }
    throw new MoolreTransportError(`Moolre request to ${path} failed: ${error.message}`, {
      status: 502,
      code: 'MOOLRE_PROVIDER_UNREACHABLE',
    });
  }
  clearTimeout(timer);

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  // Moolre answers with `status: 1` for success alongside a 200. A non-1
  // `status` on a 200 response is a business failure, so both are checked.
  const businessStatus = payload?.status;
  const ok = response.ok && (businessStatus === undefined || Number(businessStatus) === 1);

  if (!ok) {
    const message =
      payload?.message || payload?.data?.message || `Moolre request failed (HTTP ${response.status})`;
    throw new MoolreTransportError(message, {
      status: response.status >= 400 ? response.status : 502,
      code: payload?.code || 'MOOLRE_PROVIDER_ERROR',
      providerStatus: response.status,
      providerBody: payload,
    });
  }

  // `envelope` returns the whole response — `{ status, code, message, data, go }`
  // — instead of just `data`.
  //
  // It matters because **Moolre uses `status: 1` for a flow state, not only
  // for success.** An OTP-required answer (`TP14`) is a 200 with `status: 1`,
  // and the only thing that distinguishes it from "the prompt is on its way"
  // is the `code`. Unwrapping to `data` throws that away: `data` is the
  // literal string `"all"`, so the caller would see a successful initiation,
  // no transaction id, and a payment that sits pending forever because no
  // prompt was ever sent.
  if (envelope) return payload;

  return payload?.data ?? payload;
};

// ──────────────────── Payments ────────────────────

/**
 * Starts a USSD push payment.
 *
 * `POST /open/transact/payment` — this is the endpoint that triggers the
 * prompt on the payer's handset. (The status lookup on `/open/transact/status`
 * is a *different* endpoint with a different body, and posting a payment
 * request to it returns an account listing rather than anything about the
 * transaction.)
 *
 * `amount` is in cedis (GHS), not pesewas — this client converts to the
 * two-decimal string Moolre expects. Callers that hold pesewas divide by 100
 * before calling.
 *
 * ## The callback is not sent here
 *
 * Moolre takes the callback URL from the **wallet's** registered callback, not
 * from the request. `POST /embed/link` (the hosted checkout) is the one
 * payment endpoint that accepts a per-request `callback`. The wallet's
 * callback is set once, when the wallet is created or the API service is
 * activated — so `MOOLRE_CALLBACK_URL` is a deployment setting rather than
 * something this call carries.
 *
 * ## The OTP round-trip
 *
 * Most Ghanaian MoMo collections go through a phone-number verification step
 * before the prompt is sent:
 *
 *   1. `POST /open/transact/payment` → **`TP14`** — Moolre sends an OTP by
 *      SMS to the payer's number. The prompt has *not* been sent.
 *   2. `POST /open/transact/payment` with `otpcode` → **`TP17`** — the number
 *      is verified. The prompt still has not been sent.
 *   3. `POST /open/transact/payment` again → **`TR099`** — the USSD prompt is
 *      on its way to the phone.
 *
 * Step 3 is the one that catches people out: `TP17` is not the prompt, it is
 * the *permission* to send one. A caller that stops at `TP17` leaves the
 * parent staring at their phone for a prompt that will never arrive, and the
 * payment pending forever.
 *
 * This function drives all three steps itself. It returns `otp_required` when
 * it needs the parent to type the code Moolre sent them, and `requested` once
 * the prompt is actually out.
 */
export const initiatePayment = async ({
  amount,
  phone,
  network,
  reference,
  description,
  otpCode,
  sessionId,
  skipOtp = false,
}) => {
  const channel = normaliseChannel(network);

  const buildBody = (extra = {}) => ({
    type: 1,
    accountnumber: MOOLRE_ACCOUNT_NUMBER,
    payer: String(phone).replace(/\D/g, ''),
    amount: Number(amount).toFixed(2),
    channel,
    currency: 'GHS',
    externalref: reference,
    ...(description ? { reference: description } : {}),
    ...(extra),
  });

  // `skipotp` is **sandbox only** — Moolre ignores it in live, and production
  // must always do the phone verification. So it is not merely "not set in
  // production": the client decides, from the configured base URL, and a
  // caller cannot turn it on against a live gateway. Without it there is no
  // way to exercise the prompt path in the sandbox at all, because the
  // sandbox OTP is a simulation with no code to submit.
  const isSandbox = MOOLRE_BASE_URL.includes('sandbox');

  const body = buildBody({
    ...(otpCode ? { otpcode: otpCode } : {}),
    ...(sessionId ? { sessionid: sessionId } : {}),
    ...(isSandbox && skipOtp ? { skipotp: true } : {}),
  });

  let payload = await request('/open/transact/payment', { body, envelope: true });
  let code = payload?.code;

  // `TP14` — an OTP was sent to the payer. The prompt has not been sent, and
  // it cannot be until the parent types the code in.
  if (code === 'TP14') {
    return {
      status: 'otp_required',
      transactionId: null,
      message: payload?.message || null,
      raw: payload,
    };
  }

  // `TP17` — the number is verified. The prompt goes out on the next call.
  //
  // The follow-up call must NOT carry `otpcode`: Moolre treats a request that
  // still carries the code as a fresh verification attempt and re-issues an OTP
  // (`TP14`) instead of sending the USSD prompt (`TR099`). That is what made
  // every submitted code read as "not accepted" — the parent kept getting new
  // codes and the prompt never arrived.
  if (code === 'TP17') {
    const tp17Data = payload?.data && typeof payload.data === 'object' ? payload.data : null;
    const sessionId =
      tp17Data?.sessionid || tp17Data?.sessionId || tp17Data?.session_id || null;
    const promptBody = buildBody({
      ...(sessionId ? { sessionid: sessionId } : {}),
      ...(isSandbox && skipOtp ? { skipotp: true } : {}),
    });
    payload = await request('/open/transact/payment', { body: promptBody, envelope: true });
    code = payload?.code;

    // Moolre answered the follow-up with "a code was sent to you" again: the
    // code was not accepted, and the number is still unverified. That is a
    // retryable answer, not a broken integration, so it is reported as one —
    // the parent is told their code was wrong rather than shown an error
    // about the gateway.
    if (code === 'TP14') {
      return {
        status: 'otp_required',
        transactionId: null,
        message: payload?.message || null,
        raw: payload,
      };
    }
  }

  // `TR099` — the prompt is on its way. `data` is the session id.
  if (code === 'TR099') {
    const data = payload?.data;
    return {
      status: 'requested',
      transactionId: typeof data === 'string' ? data : data?.transactionid || data?.id || null,
      message: payload?.message || null,
      raw: payload,
    };
  }

  // A code we do not recognise, with `status: 1`. Moolre has answered
  // successfully at the transport level but not in a way this client
  // understands — so it is surfaced rather than treated as a sent prompt.
  throw new MoolreTransportError(
    payload?.message || `Moolre returned an unexpected response (${code || 'no code'})`,
    {
      status: 502,
      code: code || 'MOOLRE_UNEXPECTED_RESPONSE',
      providerBody: payload,
    }
  );
};

/**
 * Asks Moolre what happened to a transaction.
 *
 * `POST /open/transact/status` with `idtype: 1` — "the id is the externalref
 * we supplied". (`idtype: 2` looks the transaction up by the Moolre-generated
 * id instead.)
 *
 * ## The status lives in `data.txstatus`, not in the envelope
 *
 * | `txstatus` | Meaning   |
 * |------------|-----------|
 * | 1          | Successful |
 * | 0          | Pending    |
 * | 2          | Failed     |
 * | 3          | Not found  |
 *
 * The envelope's own `status` is `1` even for a "transaction not found"
 * lookup, so reading the envelope is how a lookup that found nothing gets
 * mistaken for a success. `txstatus` is the only thing that means anything.
 *
 * A **not found** is reported as `pending`, not as `failed`: the transaction
 * may simply not be recorded yet, and failing a payment because the provider
 * had not caught up would take money that did arrive.
 */
export const verifyTransaction = async ({ reference }) => {
  const data = await request('/open/transact/status', {
    body: {
      type: 1,
      idtype: 1,
      id: reference,
      accountnumber: MOOLRE_ACCOUNT_NUMBER,
    },
  });

  const txStatus = Number(data?.txstatus);
  const raw = String(data?.status ?? '').trim().toLowerCase();

  let status = 'pending';
  if (txStatus === 1 || raw === '1' || raw === 'success' || raw === 'successful') {
    status = 'success';
  } else if (txStatus === 2 || raw === '2' || raw === 'failed' || raw === 'failure') {
    status = 'failed';
  }

  return {
    status,
    amount: data?.amount,
    channel: data?.channel,
    reference: data?.externalref || reference,
    transactionId: data?.transactionid || null,
    txStatus,
    raw: data,
  };
};

/**
 * Moolre onboarding is a platform-level account rather than a per-merchant
 * handshake, so there is nothing to verify per school. The function exists so
 * the shape matches the other gateway clients.
 */
export const verifyMerchant = async () => ({
  verified: true,
  note: 'Moolre onboarding is platform-level',
});

/**
 * The hosted-checkout URL for a payment.
 *
 * `POST /embed/link` creates a Moolre Web POS page and returns its
 * `authorization_url`. This is the fallback for a parent whose phone cannot
 * receive the USSD push — and, unlike the push, it lets the parent pick their
 * network rather than being told which one they have.
 *
 * Unlike the USSD push, this endpoint **does** accept a per-request `callback`,
 * so the hosted checkout settles the same payment the push would have.
 *
 * `email` is required by Moolre and is the **business's** address, not the
 * payer's — it is where a receipt or a payment notification goes.
 */
export const createCheckoutSession = async ({
  amount,
  reference,
  redirectUrl,
  email,
  callbackUrl,
  expiryMinutes,
  reusable = false,
}) => {
  if (!MOOLRE_PUBLIC_KEY || !MOOLRE_ACCOUNT_NUMBER) {
    throw new MoolreTransportError('Moolre public key and account number are required', {
      status: 503,
      code: 'MOOLRE_NOT_CONFIGURED',
    });
  }

  const data = await request('/embed/link', {
    body: {
      type: 1,
      amount: Number(amount).toFixed(2),
      currency: 'GHS',
      externalref: reference,
      reusable: reusable ? '1' : '0',
      accountnumber: MOOLRE_ACCOUNT_NUMBER,
      // Moolre requires it. A school without an address on file still needs
      // something, so the platform address is the fallback.
      email: email || MOOLRE_CHECKOUT_EMAIL,
      ...(redirectUrl ? { redirect: redirectUrl } : {}),
      ...(callbackUrl ? { callback: callbackUrl } : {}),
      ...(expiryMinutes ? { expiration_time: Number(expiryMinutes) } : {}),
    },
  });

  const url = data?.authorization_url || data?.authorizationUrl || null;
  if (!url) {
    throw new MoolreTransportError('Moolre did not return a checkout URL', {
      status: 502,
      code: 'MOOLRE_CHECKOUT_URL_MISSING',
    });
  }

  return { checkoutUrl: url, reference: data?.reference || reference };
};

export default {
  isMoolreConfigured,
  normaliseChannel,
  channelLabel,
  initiatePayment,
  verifyTransaction,
  verifyMerchant,
  createCheckoutSession,
};
