// ─────────────────────────────────────────────
// Moolre SMS transport
// ─────────────────────────────────────────────
// SMS delivery over the same Moolre account that collects the payments.
//
// This matters for a school: one vendor, one wallet, one balance to top up,
// and one relationship to reconcile against. The school tops up the Moolre
// balance once and both the payment rail and the reminder rail are covered.
//
// Registered into `utils/smsService.js`'s `SEND_CLIENTS` table rather than
// replacing it, so the existing per-school provider override and the
// `SmsMessage` delivery log keep working unchanged.
import {
  MOOLRE_ACCOUNT_NUMBER,
  MOOLRE_API_USER,
  MOOLRE_REQUEST_TIMEOUT_MS,
  MOOLRE_SMS_BASE_URL,
  MOOLRE_SMS_SENDER_ID,
  MOOLRE_SMS_VASKEY,
} from '../config/env.js';
import { toGhanaE164 } from './phoneNumbers.js';

const SMS_ENDPOINT = '/open/sms/send';
const SMS_STATUS_ENDPOINT = '/open/sms/status';
const SENDER_ID_ENDPOINT = '/open/sms/query';

/**
 * The two Moolre messaging failures that are not bugs in this code, spelled
 * out.
 *
 * Both arrive as a generic provider rejection, and both are the kind of thing
 * that gets "fixed" by retrying — which changes nothing, because the account
 * needs a human on Moolre's side. Saying so in the error turns a silent
 * no-receipt into a two-line fix.
 */
const explainProviderRejection = (code, message) => {
  if (code === 'ASMS07') {
    return (
      `${message} — the sender ID "${MOOLRE_SMS_SENDER_ID || ''}" is not approved on this ` +
      'Moolre account. It has to be registered and approved in the Moolre portal ' +
      '(app.moolre.com); an account without "approve sender ID" permission cannot ' +
      'approve it through the API.'
    );
  }
  if (code === 'SMS02') {
    return (
      `${message} — this Moolre account has no messaging (VAS) account. The sandbox ` +
      'does not have one either, so the messaging API must be reached at the live ' +
      'base URL; set MOOLRE_SMS_BASE_URL if it is pointing somewhere else.'
    );
  }
  return message;
};

/** A failure that came from Moolre rather than from our own code. */
export class MoolreSmsTransportError extends Error {
  constructor(
    message,
    { status = 502, code = 'MOOLRE_SMS_PROVIDER_ERROR', providerStatus = null, providerBody = null } = {}
  ) {
    super(message);
    this.name = 'MoolreSmsTransportError';
    this.status = status;
    this.code = code;
    this.providerStatus = providerStatus;
    this.providerBody = providerBody;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** True when there is enough configuration to reach Moolre's SMS API. */
export const isMoolreSmsConfigured = () =>
  Boolean(MOOLRE_API_USER && MOOLRE_SMS_VASKEY && MOOLRE_SMS_SENDER_ID);

/**
 * One Moolre SMS call.
 *
 * `X-API-VASKEY` is the VAS credential. It is the *messaging* credential and
 * is not interchangeable with the payment keys — Moolre answers `AIN11` if a
 * payment key is used here.
 *
 * `vasKey` overrides the platform's own VAS key for one call. A school that
 * has its own Moolre SMS service has its own sender IDs on it, and those are
 * the sender IDs Moolre has approved — the platform's service is a different
 * account with a different registry, and a sender ID approved on one is not
 * approved on the other.
 */
const request = async (path, { method = 'POST', body, vasKey } = {}) => {
  const key = String(vasKey || MOOLRE_SMS_VASKEY || '').trim();
  if (!MOOLRE_API_USER || !key || !MOOLRE_SMS_SENDER_ID) {
    throw new MoolreSmsTransportError(
      'Moolre SMS is not configured. Set MOOLRE_API_USER and MOOLRE_VASKEY (or MOOLRE_SMS_VASKEY), and MOOLRE_SMS_SENDER_ID.',
      { status: 503, code: 'MOOLRE_SMS_NOT_CONFIGURED' }
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOOLRE_REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${MOOLRE_SMS_BASE_URL}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-VASKEY': key,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      throw new MoolreSmsTransportError(
        `Moolre SMS request to ${path} timed out after ${MOOLRE_REQUEST_TIMEOUT_MS}ms`,
        { status: 504, code: 'MOOLRE_SMS_TIMEOUT' }
      );
    }
    throw new MoolreSmsTransportError(
      `Moolre SMS request to ${path} failed: ${error.message}`,
      { status: 502, code: 'MOOLRE_SMS_PROVIDER_UNREACHABLE' }
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
    const message = explainProviderRejection(
      payload?.code,
      payload?.message || `Moolre SMS failed (HTTP ${response.status})`
    );
    throw new MoolreSmsTransportError(message, {
      status: response.status >= 400 ? response.status : 502,
      code: payload?.code || 'MOOLRE_SMS_PROVIDER_ERROR',
      providerStatus: response.status,
      providerBody: payload,
    });
  }

  return payload?.data ?? payload;
};

/**
 * Sends one SMS through Moolre.
 *
 * The sender ID must be one Moolre has approved for the account. An
 * unapproved ID is not an error from the API — the carrier simply drops the
 * message — so the check happens here, before the send, where it can still be
 * reported.
 *
 * @returns {Promise<{providerMessageId: string|null}>}
 */
export const sendMoolreSms = async ({ to, message, senderId, ref, apiKey }) => {
  if (!to || !message) {
    throw new MoolreSmsTransportError('sendSms requires `to` and `message`', {
      status: 400,
      code: 'MOOLRE_SMS_INVALID_ARGUMENT',
    });
  }

  // The credentials and the sender ID are checked separately, and the sender ID
  // second, so a missing sender ID reports *itself* rather than being reported
  // as a generic misconfiguration. They are different problems with different
  // fixes: one is a credential, the other is an ID Moolre has to have approved
  // for the account.
  //
  // `apiKey` is a school's own VAS key, for a school whose Moolre account is
  // not the platform's.
  const vasKey = String(apiKey || MOOLRE_SMS_VASKEY || '').trim();
  if (!MOOLRE_API_USER || !vasKey) {
    throw new MoolreSmsTransportError(
      'Moolre SMS is not configured. Set MOOLRE_API_USER and MOOLRE_SMS_VASKEY.',
      { status: 503, code: 'MOOLRE_SMS_NOT_CONFIGURED' }
    );
  }

  // The sender ID must be one Moolre has approved for the account. An
  // unapproved ID is not an error from the API — the carrier simply drops the
  // message — so the check happens here, before the send, where it can still
  // be reported.
  const effectiveSender = String(senderId || MOOLRE_SMS_SENDER_ID || '').trim();
  if (!effectiveSender) {
    throw new MoolreSmsTransportError(
      'Moolre SMS sender ID is missing. Set MOOLRE_SMS_SENDER_ID to an ID Moolre has approved for this account.',
      { status: 400, code: 'MOOLRE_SMS_MISSING_SENDER_ID' }
    );
  }

  // E.164 with a leading plus, so a malformed or non-Ghanaian number produces
  // a clear error here instead of a generic rejection from the provider.
  const normalised = toGhanaE164(to);
  if (!normalised?.valid) {
    throw new MoolreSmsTransportError(
      `"${to}" is not a valid Ghanaian MSISDN for SMS: ${normalised?.reason || 'unrecognised format'}`,
      { status: 400, code: 'MOOLRE_SMS_INVALID_MSISDN' }
    );
  }

  // 480 characters is the longest single-part SMS Moolre accepts; anything
  // longer is truncated rather than rejected, because a truncated reminder is
  // still a reminder and a rejected one is not sent at all.
  const text = String(message).slice(0, 480);

  // The body is a `messages` array, not a flat recipient/message pair. Moolre
  // sends one or many in a single call, and the array is how it knows which
  // is which.
  //
  // The `ref` is ours, and it is the only handle on the message: Moolre's
  // send response carries no message id (`data` is null), so the ref is what
  // the status lookup — `POST /open/sms/status` with `type: 5` — matches on.
  // Without it, the delivery report cannot be tied back to this send.
  const reference = ref || `sms-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOOLRE_REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${MOOLRE_SMS_BASE_URL}${SMS_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-VASKEY': vasKey,
      },
      body: JSON.stringify({
        type: 1,
        senderid: effectiveSender,
        messages: [{ recipient: normalised.e164, message: text, ref: reference }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      throw new MoolreSmsTransportError(
        `Moolre SMS timed out after ${MOOLRE_REQUEST_TIMEOUT_MS}ms. The message may or may not have been accepted — reconcile before retrying.`,
        { status: 504, code: 'MOOLRE_SMS_TIMEOUT' }
      );
    }
    throw new MoolreSmsTransportError(
      `Moolre SMS request failed: ${error.message}. The message may or may not have been accepted — reconcile before retrying.`,
      { status: 502, code: 'MOOLRE_SMS_PROVIDER_UNREACHABLE' }
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
    const message = explainProviderRejection(
      payload?.code,
      payload?.message || `Moolre SMS failed (HTTP ${response.status})`
    );
    throw new MoolreSmsTransportError(message, {
      status: response.status >= 400 ? response.status : 502,
      code: payload?.code || 'MOOLRE_SMS_PROVIDER_ERROR',
      providerStatus: response.status,
      providerBody: payload,
    });
  }

  return {
    // The ref we supplied. Moolre's send response carries no message id, so
    // this is what the delivery-report lookup matches on.
    providerMessageId: reference,
    raw: payload,
  };
};

/**
 * Sends to many recipients, one at a time.
 *
 * Sequential rather than parallel: Moolre bills and rate-limits per message,
 * and a burst of parallel sends is how an account gets throttled mid-reminder
 * run. One failure does not stop the rest — each recipient gets its own
 * outcome, because a school needs to know *which* parents were reached.
 */
export const sendBulkSms = async ({ recipients, message, senderId }) => {
  const results = [];
  for (const to of recipients || []) {
    try {
      await sendMoolreSms({ to, message, senderId });
      results.push({ to, ok: true });
    } catch (error) {
      results.push({ to, ok: false, error: error.message });
    }
  }
  return results;
};

/**
 * The sender IDs registered on this Moolre SMS service.
 *
 * `type: 7` on the query endpoint is Moolre's "List of Your Sender IDs". It is
 * the only way to see what the account actually has, and it is the answer to
 * the question that wastes the most time when a send fails: **is the sender ID
 * I am sending under approved on the account I am sending to?**
 *
 * The registry is per *service*, not per merchant. A merchant with two SMS
 * services has two registries, and a sender ID approved on one is not approved
 * on the other — which looks exactly like "Moolre says my approved sender ID
 * is not approved".
 *
 * @returns {Promise<Array<{id: number, senderid: string, approval: string, whitelisted: boolean}>>}
 */
export const listMoolreSenderIds = async ({ apiKey } = {}) => {
  const data = await request(SENDER_ID_ENDPOINT, { body: { type: 7 }, vasKey: apiKey });
  return Array.isArray(data) ? data : [];
};

/**
 * The state of the sender ID this deployment sends under.
 *
 * @returns {Promise<{senderId: string, approval: string|null, approved: boolean, registered: boolean, reason: string|null}>}
 */
export const getMoolreSenderIdStatus = async ({ senderId, apiKey } = {}) => {
  const id = String(senderId || MOOLRE_SMS_SENDER_ID || '').trim();
  if (!id) {
    return { senderId: id, approval: null, approved: false, registered: false, reason: 'No sender ID is configured' };
  }

  try {
    const rows = await listMoolreSenderIds({ apiKey });
    const match = rows.find((row) => String(row?.senderid) === id) || null;
    // A row with no approval recorded is not an approved row. Moolre omits the
    // field on some responses, and reading it as "approved" would report a
    // sender ID as usable when it has not been through approval at all.
    const approval = match?.approval ? String(match.approval) : null;
    const approved = Boolean(approval && approval.toLowerCase() === 'approved');

    return {
      senderId: id,
      approval,
      approved,
      registered: Boolean(match),
      reason: approved
        ? null
        : match
          ? `The sender ID "${id}" is ${approval || 'not approved'} on this Moolre SMS service.`
          : `The sender ID "${id}" is not registered on this Moolre SMS service.`,
    };
  } catch (error) {
    return {
      senderId: id,
      approval: null,
      approved: false,
      registered: false,
      reason: error.message,
    };
  }
};

/**
 * Whether this deployment can actually send an SMS right now.
 *
 * The answer to the question a school actually asks — "is the receipt going
 * to reach the parent?" — and the only honest way to answer it is to ask
 * Moolre, because every one of the three failure modes (no credit, no
 * approved sender ID, no messaging account) is invisible from the outside:
 * a receipt that cannot be sent is a receipt nobody is told about.
 */
export const getMoolreSmsReadiness = async ({ senderId, apiKey } = {}) => {
  const sender = await getMoolreSenderIdStatus({ senderId, apiKey });

  let balance = null;
  let balanceError = null;
  try {
    const data = await request(SMS_STATUS_ENDPOINT, { body: { type: 2 }, vasKey: apiKey });
    balance = data?.balance ?? data?.credits ?? null;
  } catch (error) {
    balanceError = error.message;
  }

  const reasons = [];
  if (balanceError) reasons.push(balanceError);
  else if (balance !== null && Number(balance) <= 0) {
    reasons.push('The Moolre SMS service has no credit left. Top it up before sending.');
  }
  if (!sender.approved && sender.reason) reasons.push(sender.reason);

  return {
    ready: reasons.length === 0,
    reasons,
    balance,
    senderId: sender.senderId,
    senderApproval: sender.approval,
    senderApproved: sender.approved,
  };
};

/**
 * Registers a Sender ID with Moolre.
 *
 * The sender ID has to be registered and **approved** before any SMS will
 * deliver: an unapproved ID is not an API error, the carrier simply drops the
 * message, so a platform can appear to send successfully for weeks and reach
 * nobody.
 *
 * `approve: true` asks Moolre to approve the ID in the same call. Moolre
 * answers `ASMQ09` if the account is not permitted to approve its own IDs —
 * that is the common case, and it means a human has to do it in the portal.
 *
 * The registry is checked first, because **creating a sender ID that already
 * exists leaves two rows with the same name**, and Moolre resolves a send
 * against one of them. A duplicate pending row left behind by an earlier
 * attempt will shadow the approved one, and the send will fail with
 * "sender ID is not approved" while the portal shows it approved. The same
 * name, two registries, one very confusing afternoon.
 */
export const createMoolreSenderId = async ({ senderId, approve = false, apiKey } = {}) => {
  if (!senderId) {
    throw new MoolreSmsTransportError('A sender ID is required', {
      status: 400,
      code: 'MOOLRE_SMS_INVALID_ARGUMENT',
    });
  }

  const id = String(senderId).slice(0, 11);

  // Already there? Do not create a second row for the same name.
  try {
    const rows = await listMoolreSenderIds({ apiKey });
    const existing = rows.find((row) => String(row?.senderid) === id);
    if (existing) {
      return {
        status: 1,
        code: 'ASMQ01',
        message: 'Sender ID Status',
        data: existing,
        existing: true,
      };
    }
  } catch (error) {
    // The list is an optimisation, not a gate: if it cannot be read, fall
    // through and let the create answer.
  }

  const result = await request(SENDER_ID_ENDPOINT, {
    body: {
      type: 3,
      senderids: [{ senderid: id, approve: Boolean(approve) }],
    },
    vasKey: apiKey,
  });

  return { ...result, existing: false };
};

/**
 * The delivery status of messages we sent, by the `ref` we gave them.
 *
 * Moolre's send response carries no message id, so the `ref` generated at send
 * time is the only handle. Without this, the delivery report cannot be tied
 * back to a specific message, and a report can be attached to the wrong send.
 *
 * The statuses come back as numbers: 1 sent, 2 delivered, 3 failed.
 */
export const getMoolreSmsDeliveryStatus = async ({ refs } = {}) => {
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new MoolreSmsTransportError('At least one message ref is required', {
      status: 400,
      code: 'MOOLRE_SMS_INVALID_ARGUMENT',
    });
  }

  const data = await request(SMS_STATUS_ENDPOINT, { body: { type: 5, ref: refs } });
  const rows = Array.isArray(data) ? data : [];

  return rows.map((row) => ({
    ref: row?.ref ?? null,
    // 1 sent, 2 delivered, 3 failed. Named, because the platform stores words.
    status: { 1: 'sent', 2: 'delivered', 3: 'failed' }[Number(row?.status)] || 'unknown',
    rawStatus: row?.status ?? null,
  }));
};

/**
 * The remaining message credit on the Moolre VAS service.
 *
 * `POST /open/sms/status` with `type: 2` — the documented "SMS Account
 * Status" endpoint. It is the only balance Moolre exposes for messaging; the
 * WhatsApp bundle has no endpoint at all, and can only be confirmed by
 * attempting a send and reading WAS401.
 */
export const getMoolreSmsBalance = async () => {
  const data = await request(SMS_STATUS_ENDPOINT, { body: { type: 2 } });
  return { balance: data?.balance ?? data?.credits ?? 0 };
};

export default {
  isMoolreSmsConfigured,
  sendMoolreSms,
  sendBulkSms,
  getMoolreSmsBalance,
  createMoolreSenderId,
  getMoolreSmsDeliveryStatus,
  listMoolreSenderIds,
  getMoolreSenderIdStatus,
  getMoolreSmsReadiness,
};
