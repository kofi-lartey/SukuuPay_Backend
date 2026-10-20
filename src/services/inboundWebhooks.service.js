import { SmsMessage } from '../models/smsMessageModel.js';
import { School } from '../models/schoolModel.js';
import { handleMtnResult } from './payment.service.js';
import { log as auditLog } from '../utils/auditService.js';
import { verifyArkeselAuth } from '../utils/signatures.js';
import { phoneSearchCandidates } from '../utils/phoneNumbers.js';
import ApiError from '../utils/ApiError.js';
import {
  ARKESEL_WEBHOOK_SECRET,
  ARKESEL_API_KEY,
  WEBHOOK_AUTH_ENFORCED,
  MTN_WEBHOOK_SECRET,
} from '../config/env.js';

// ─────────────────────────────────────────────
// Inbound third-party webhooks
// ─────────────────────────────────────────────
// Meta and Arkesel both call back over the public internet with no session.
// Each therefore authenticates with a keyed MAC over the exact bytes it
// sent, and the raw body is what must be verified — a parsed-and-restringified
// body does not reproduce the provider's bytes.
//
// Two rules hold across both:
//
//   1. A report that cannot be authenticated is rejected. These endpoints move
//      money and delivery state; a guessed payload must not be able to credit a
//      parent or mark an undelivered SMS as delivered.
//   2. An authenticated report for something we do not recognise is acknowledged,
//      not retried. A provider that retries forever on a message id this
//      deployment never issued is a support incident, and 4xx/5xx loops make it
//      worse. Those are logged and audited instead.

// How far back to look when a report carries only a phone number. Wide enough
// for a report that arrives after a slow queue, narrow enough that a
// same-number report cannot attach to yesterday's message.
const DLR_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// ──────────────────── Authentication ────────────────────

const isEnforced = () => WEBHOOK_AUTH_ENFORCED === 'true';

/**
 * Verifies an Arkesel callback. Arkesel either echoes the account key in
 * `api_key` or signs the body, and deployments differ, so both are accepted —
 * but one of them must actually match.
 */
export const authenticateArkesel = ({ signatureHeader, providedApiKey, rawBody } = {}) => {
  const secret = ARKESEL_WEBHOOK_SECRET || ARKESEL_API_KEY;

  const { valid, reason, method } = verifyArkeselAuth({
    signatureHeader,
    secret,
    providedApiKey,
    rawBody,
  });

  if (valid) return { valid: true, enforced: true, method };

  if (reason === 'no_shared_secret_configured' && !isEnforced()) {
    console.warn(
      '[WEBHOOK-ARKESEL] ARKESEL_WEBHOOK_SECRET / ARKESEL_API_KEY is not set; accepting an unsigned callback. Set it before going to production.'
    );
    return { valid: true, enforced: false, method: 'none' };
  }

  throw new ApiError(
    reason === 'no_shared_secret_configured'
      ? 'Arkesel webhook secret is not configured'
      : 'Invalid or missing Arkesel webhook credentials',
    401,
    'INVALID_WEBHOOK_SIGNATURE'
  );
};

// ──────────────────── MTN: transaction result ────────────────────

/**
 * Authenticates an MTN callback.
 *
 * MTN does not sign the body with a keyed MAC the way Meta does: the
 * Collections callback is a plain POST that carries no verifiable signature.
 * Authentication therefore rests on a shared secret the integration *configures*
 * on MTN's side, echoed back by us on the callback URL path — combined with the
 * settlement claim, which is the real protection against a forged success.
 *
 * Because there is no provider-signed proof, this endpoint MUST NOT be treated as
 * strongly authenticated. When no secret is configured and enforcement is off,
 * it warns and allows so the sandbox flow can be exercised; in production an
 * operator who leaves this unset is accepting unauthenticated settlement posts.
 */
export const authenticateMtn = ({ providedSecret } = {}) => {
  if (MTN_WEBHOOK_SECRET && providedSecret && providedSecret === MTN_WEBHOOK_SECRET) {
    return { valid: true, enforced: true, method: 'shared-secret' };
  }

  if (!MTN_WEBHOOK_SECRET && !isEnforced()) {
    console.warn(
      '[WEBHOOK-MTN] MTN_WEBHOOK_SECRET is not set; accepting an unauthenticated MTN callback. Set it before going to production.'
    );
    return { valid: true, enforced: false, method: 'none' };
  }

  throw new ApiError(
    MTN_WEBHOOK_SECRET ? 'Invalid MTN webhook secret' : 'MTN webhook secret is not configured',
    401,
    'INVALID_WEBHOOK_SIGNATURE'
  );
};

/**
 * Settles (or fails) a payment from an MTN transaction result.
 *
 * Delegates to the same handler the status poll uses, so a callback and a poll
 * cannot diverge. That handler claims the settlement before moving any balance,
 * so MTN delivering the same "SUCCESSFUL" result three times credits the parent
 * once.
 */
export const handleMtnPaymentWebhook = async (payload, context = {}) => {
  const result = await handleMtnResult(payload);

  if (!result.duplicate) {
    await auditLog({
      action: 'webhook.received',
      entity: 'Payment',
      entityId: result.payment?._id,
      schoolId: result.payment?.schoolId,
      meta: {
        provider: 'mtn',
        channel: 'payment',
        endpoint: 'webhooks/mtn/payment',
        status: payload?.status || payload?.data?.status || null,
        ...context,
      },
    });
  }

  return result;
};

// ──────────────────── SMS delivery reports ────────────────────

/**
 * Provider status vocabulary → our internal states.
 *
 * Both a textual status and a numeric response code are accepted, because
 * providers send either depending on the endpoint. Anything unmapped becomes
 * `unknown` with the raw code preserved, so a new provider code is visible in
 * the data rather than silently treated as delivered.
 */
const DELIVERED = new Set(['delivered', 'success', 'successful', 'deliveredtohandset', 'delivered_to_handset', 2000, '2000', '0']);
const FAILED = new Set(['failed', 'failure', 'rejected', 'undelivered', 'expired', 'blocked', 'error', 4000, '4000', '3000', '3001', '4001', '4002', '4003', '4004', '5000', '5001']);
const SENT = new Set(['sent', 'submitted', 'queued', 'accepted', 'pending', 'processing', 1000, '1000', '1001', '1002']);

const normaliseStatus = ({ status, code, statusCode }) => {
  const candidates = [status, code, statusCode]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => (typeof value === 'string' ? value.trim() : value));

  for (const candidate of candidates) {
    const key = typeof candidate === 'string' ? candidate.toLowerCase().replace(/[\s-]/g, '') : candidate;
    if (DELIVERED.has(key)) return 'delivered';
    if (FAILED.has(key)) return 'failed';
    if (SENT.has(key)) return 'sent';
  }

  return 'unknown';
};

/** Field names each provider uses for the pieces of a delivery report. */
const REPORT_FIELDS = {
  arkesel: {
    messageId: ['message_id', 'messageId', 'sms_id', 'id', 'MessageId'],
    status: ['status', 'Status', 'delivery_status', 'DeliveryStatus'],
    code: ['code', 'Code', 'response_code'],
    description: ['description', 'Description', 'status_description', 'StatusDescription', 'reason'],
    network: ['network', 'Network', 'network_name'],
    to: ['destination', 'Destination', 'to', 'phone', 'PhoneNumber', 'msisdn', 'recipient'],
    sentAt: ['timestamp', 'Timestamp', 'sent_at', 'date'],
  },
};

const pick = (payload, names) => {
  for (const name of names) {
    if (payload?.[name] !== undefined && payload?.[name] !== null && payload?.[name] !== '') {
      return payload[name];
    }
  }
  return null;
};

/** Folds one provider payload into the internal report shape. */
export const normaliseDeliveryReport = (provider, payload) => {
  const fields = REPORT_FIELDS[provider] || REPORT_FIELDS.arkesel;
  const status = pick(payload, fields.status);
  const code = pick(payload, fields.code);
  const description = pick(payload, fields.description);

  return {
    provider,
    providerMessageId: pick(payload, fields.messageId) ? String(pick(payload, fields.messageId)) : null,
    status: normaliseStatus({ status, code }),
    rawStatus: status === null ? null : String(status),
    rawCode: code === null ? null : String(code),
    description: description ? String(description).slice(0, 300) : '',
    network: pick(payload, fields.network),
    to: pick(payload, fields.to),
    // The untouched provider payload, retained so a code that is unmapped today
    // can be interpreted later without the original having been discarded.
    raw: payload ?? null,
    // A gateway that reports a timestamp in seconds or milliseconds is common;
    // a value that is clearly neither is treated as absent.
    reportedAt: (() => {
      const value = pick(payload, fields.sentAt);
      if (value === null) return null;
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) return null;
      const millis = numeric < 1e12 ? numeric * 1000 : numeric;
      const date = new Date(millis);
      return Number.isNaN(date.getTime()) ? null : date;
    })(),
  };
};

/** Providers send either one report or a batch; both are accepted. */
const extractReports = (payload) => {
  if (Array.isArray(payload)) return payload.filter((entry) => entry && typeof entry === 'object');
  if (!payload || typeof payload !== 'object') return [];

  // Batch wrappers providers use.
  for (const key of ['Data', 'data', 'reports', 'Reports', 'messages', 'Messages', 'results']) {
    if (Array.isArray(payload[key])) {
      return payload[key].filter((entry) => entry && typeof entry === 'object');
    }
  }

  return [payload];
};

/**
 * Finds the message a report is about.
 *
 * The provider message id is the only reliable key, so it is tried first. When a
 * gateway omits it the report can only be matched by recipient, and then only
 * against an unsettled message inside the lookback window — matching a bare
 * number against all history would attach a report to an unrelated send.
 */
const findMessage = async (report) => {
  if (report.providerMessageId) {
    const byId = await SmsMessage.findOne({
      provider: report.provider,
      providerMessageId: report.providerMessageId,
    });
    if (byId) return { message: byId, matchedBy: 'providerMessageId' };
  }

  if (report.to) {
    const candidates = phoneSearchCandidates(report.to);
    if (candidates.length) {
      const byNumber = await SmsMessage.findOne({
        provider: report.provider,
        to: { $in: candidates },
        createdAt: { $gte: new Date(Date.now() - DLR_LOOKBACK_MS) },
        // A report cannot settle a message that is already terminal.
        status: { $nin: ['delivered', 'failed', 'rejected'] },
      })
        .sort({ createdAt: -1 });

      if (byNumber) return { message: byNumber, matchedBy: 'recipient' };
    }
  }

  return { message: null, matchedBy: null };
};

/** Terminal states never move again, so a late report cannot rewrite history. */
const isTerminal = (status) => ['delivered', 'failed', 'rejected'].includes(status);

const applyReport = async (report) => {
  const { message, matchedBy } = await findMessage(report);

  if (!message) {
    console.warn(
      `[WEBHOOK-${report.provider.toUpperCase()}] No SMS message matches report ${report.providerMessageId || report.to || '(no id)'}`
    );
    return { matched: false, matchedBy: null, status: report.status };
  }

  if (isTerminal(message.status)) {
    // Still counted: a provider that reports twice is worth knowing about, but
    // the first terminal verdict stands.
    message.dlrCount = (message.dlrCount || 0) + 1;
    await message.save();
    return { matched: true, matchedBy, duplicate: true, status: message.status, messageId: message._id };
  }

  const previousStatus = message.status;
  message.status = report.status;
  message.dlrCount = (message.dlrCount || 0) + 1;
  message.dlr = {
    receivedAt: new Date(),
    code: report.rawCode,
    description: report.description,
    network: report.network ? String(report.network) : null,
    raw: report.raw ?? null,
  };

  // Promote the carrier's own report to the top level when the submit response
  // did not name one. Arkesel accepts a message without echoing the network, and
  // the DLR is often the only place it appears — so without this a school's
  // coverage report silently excludes most of its MTN traffic.
  if (!message.network && report.network) {
    const carrier = String(report.network).trim().toLowerCase();
    if (carrier.includes('mtn')) message.network = 'mtn';
    else if (carrier.includes('telecel') || carrier.includes('vod')) message.network = 'telecel';
    else if (carrier.includes('airtel') || carrier.includes('tigo')) message.network = 'airteltigo';
  }

  if (report.status === 'failed') {
    message.failureReason = (report.description || report.rawStatus || 'Reported failed').slice(0, 500);
  }
  // The provider's own timestamp, when it sent a usable one, is the moment the
  // event happened; fall back to arrival time rather than claiming precision.
  if (report.reportedAt) {
    if (report.status === 'delivered') message.deliveredAt = report.reportedAt;
    if (report.status === 'failed') message.failedAt = report.reportedAt;
  }

  // ── Credit refund ──
  // A message the carrier could not deliver was never delivered, so the school
  // should not be paying for it. This is the one place a balance can be
  // returned without a bursar asking, and it is the difference between a
  // metered product and a billing dispute.
  //
  // Two guards, both necessary:
  //   - `isTest`: a test send was never charged, so refunding it would be a gift.
  //   - `creditsRefunded === 0`: a report that arrives twice, or a late report
  //     for a message already refunded, must not credit the school twice. The
  //     model clamps the field on save, but the check has to happen before the
  //     school's balance is touched.
  const refundable =
    report.status === 'failed' &&
    !message.isTest &&
    (message.creditsCharged || 0) > 0 &&
    (message.creditsRefunded || 0) === 0
      ? message.creditsCharged
      : 0;

  if (refundable > 0) {
    message.creditsRefunded = refundable;
    await School.findOneAndUpdate(
      { _id: message.schoolId },
      { $inc: { 'sms.balance': refundable } }
    );
  }

  await message.save();

  await auditLog({
    action: 'sms.dlr_update',
    entity: 'SmsMessage',
    entityId: message._id,
    schoolId: message.schoolId,
    meta: {
      provider: report.provider,
      previousStatus,
      status: report.status,
      matchedBy,
      rawCode: report.rawCode,
      network: message.network,
      creditsRefunded: refundable,
    },
  });

  return {
    matched: true,
    matchedBy,
    status: report.status,
    previousStatus,
    creditsRefunded: refundable,
    messageId: message._id,
  };
};

/**
 * Entry point for the SMS delivery callbacks.
 *
 * Always returns 200-equivalent truth: a report this deployment cannot match is
 * acknowledged so the provider stops retrying, and the mismatch is surfaced in
 * the tally and the log instead.
 */
export const handleSmsDeliveryReport = async (provider, payload) => {
  const reports = extractReports(payload);
  const results = [];

  for (const entry of reports) {
    const report = normaliseDeliveryReport(provider, entry);
    try {
      results.push(await applyReport(report));
    } catch (error) {
      console.error(`[WEBHOOK-${provider.toUpperCase()}] Failed to apply report:`, error.message);
      results.push({ matched: false, error: error.message });
    }
  }

  if (!results.length) {
    // An empty or unrecognised body is still a valid, authenticated request.
    // Acknowledging it is correct: there is nothing to retry.
    console.warn(`[WEBHOOK-${provider.toUpperCase()}] Authenticated callback carried no delivery reports`);
  }

  const matched = results.filter((entry) => entry.matched).length;
  const duplicated = results.filter((entry) => entry.duplicate).length;

  await auditLog({
    action: 'webhook.received',
    entity: 'SmsMessage',
    meta: {
      provider,
      channel: 'sms_dlr',
      received: reports.length,
      matched,
      unmatched: reports.length - matched,
      duplicates: duplicated,
    },
  });

  return {
    provider,
    received: reports.length,
    matched,
    unmatched: reports.length - matched,
    duplicates: duplicated,
    results,
  };
};
