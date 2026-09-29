import mongoose from 'mongoose';
import { WhatsAppMessage } from '../models/whatsappMessageModel.js';
import { WhatsAppTemplate } from '../models/whatsappTemplateModel.js';
import { WhatsAppJob } from '../models/whatsappJobModel.js';
import { Student } from '../models/studentModel.js';
import { School } from '../models/schoolModel.js';
import { PaymentPlan } from '../models/paymentPlanModel.js';
import { acceptPaymentPlan } from './paymentPlan.service.js';
import { log as auditLog } from '../utils/auditService.js';
import { checkIdempotency, rememberIdempotency } from '../utils/idempotency.js';
import { consumeRateLimit } from '../utils/rateLimiter.js';
import { verifyMetaSignature, safeEqual } from '../utils/signatures.js';
import {
  sendWhatsAppMessage,
  markWhatsAppRead,
  createProviderTemplate,
  WhatsAppTransportError,
} from '../utils/whatsappApi.js';
import {
  toGhanaE164,
  normalisePhone,
  phoneSearchCandidates,
  formatPhone,
} from '../utils/phoneNumbers.js';
import { formatCedis, formatAccraDate } from '../utils/formatters.js';
import ApiError from '../utils/ApiError.js';
import { LIMITS, WHATSAPP_TEMPLATE_CATEGORIES } from '../config/constants.js';
import {
  WHATSAPP_ENABLED,
  WHATSAPP_COMING_SOON_MESSAGE,
  WHATSAPP_APP_SECRET,
  WHATSAPP_VERIFY_TOKEN,
  WHATSAPP_DAILY_QUOTA,
  WHATSAPP_JOB_CONCURRENCY,
  WHATSAPP_SERVICE_WINDOW_HOURS,
  MAX_BULK_WHATSAPP_RECIPIENTS,
  WEBHOOK_AUTH_ENFORCED,
} from '../config/env.js';

// ──────────────────── Channel availability (Version 2) ────────────────────
// WhatsApp is disabled until Meta business verification completes. Every
// user-initiated send is refused here rather than deep in the send path, so a
// blocked attempt cannot consume rate-limit budget, query quota, or leave a
// ghost row in the school's conversation history.
//
// The guard lives in the service, not the controller, because the service is the
// chokepoint every caller passes through — including future ones. A check in the
// controller would have to be remembered in six places and would be missed in
// the seventh.
export const WHATSAPP_COMING_SOON_CODE = 'WHATSAPP_COMING_SOON_V2';

/**
 * Refuses a WhatsApp operation while the channel is off.
 *
 * 501 Not Implemented, not 4xx: the request is well-formed and the caller is
 * authorised, the capability simply does not exist yet. A 200 with
 * `success: false` would misreport the HTTP semantics to any client that keys
 * off the status code.
 */
export const assertWhatsAppAvailable = () => {
  if (WHATSAPP_ENABLED) return;
  throw new ApiError(WHATSAPP_COMING_SOON_MESSAGE, 501, WHATSAPP_COMING_SOON_CODE);
};

const MAX_SET_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// ──────────────────── Helpers ────────────────────

const startOfDay = (date = new Date()) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
};

/**
 * The school a request acts on. A super_admin must name one explicitly; every
 * other role is pinned to their own school, so a missing `schoolId` narrows
 * rather than widens the scope.
 */
const resolveSchoolId = (user, explicitSchoolId) => {
  if (user?.role === 'super_admin') {
    return explicitSchoolId ? new mongoose.Types.ObjectId(explicitSchoolId) : null;
  }
  return user?.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

/**
 * Rejects a request that names a school the caller does not belong to.
 * Silently falling back to the caller's own school would send to the wrong
 * audience, so this is an error rather than a coercion.
 */
const assertSchoolAccess = (user, schoolIdParam) => {
  if (
    schoolIdParam &&
    user?.role !== 'super_admin' &&
    user?.schoolId &&
    String(user.schoolId) !== String(schoolIdParam)
  ) {
    throw new ApiError('You do not have access to this school', 403, 'SCHOOL_ACCESS_DENIED');
  }
};

const getPrimaryParent = (student) =>
  (student?.parents || []).find((p) => p.isPrimary) || student?.parents?.[0] || null;

/** The values a template may interpolate, per recipient. */
const buildVariables = (student, school, parent) => ({
  schoolName: school?.name || '',
  studentName: student?.studentName || '',
  studentId: student?.studentId || '',
  studentClass: student?.studentClass || '',
  parentName: parent?.parentName || '',
  balance: formatCedis(student?.balance ?? 0),
  totalOwed: formatCedis(student?.totalOwed ?? 0),
  totalPaid: formatCedis(student?.totalPaid ?? 0),
  deadline: student?.deadline ? formatAccraDate(student.deadline) : '',
  payLink: student?.payLink || '',
});

// ──────────────────── Quota ────────────────────

const getDailyUsage = async (schoolId) => {
  const filter = {
    createdAt: { $gte: startOfDay() },
    direction: 'outbound',
    // A message that never reached Meta does not consume conversation quota.
    status: { $nin: ['failed', 'ignored'] },
  };
  if (schoolId) filter.schoolId = new mongoose.Types.ObjectId(schoolId);
  return WhatsAppMessage.countDocuments(filter);
};

const assertQuota = async (schoolId, requested) => {
  const used = await getDailyUsage(schoolId);
  const quota = WHATSAPP_DAILY_QUOTA;
  if (used + requested <= quota) return { used, quota, remaining: quota - used };

  // Seconds until the next 00:00 Accra reset.
  const now = new Date();
  const reset = new Date(startOfDay(now).getTime() + 24 * 60 * 60 * 1000);
  const error = new ApiError(
    `Daily WhatsApp quota exhausted (${quota} per day, ${used} used). Quota resets at ${reset.toISOString()}.`,
    429,
    'WHATSAPP_QUOTA_EXCEEDED'
  );
  error.retryAfter = Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 1000));
  throw error;
};

// ──────────────────── Templates ────────────────────

/** Placeholder names in declaration order, e.g. `{{studentName}}` → studentName. */
export const extractTemplateVariables = (body = '') => {
  const found = [];
  const pattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let match = pattern.exec(body);
  while (match) {
    const name = match[1].toLowerCase();
    // A placeholder repeated in the body is one variable, not two.
    if (!found.includes(name)) found.push(name);
    match = pattern.exec(body);
  }
  return found;
};

/**
 * Indexes a variable map for case-insensitive lookup.
 *
 * Template variable names are stored lowercase (Meta's convention), while the
 * values this platform supplies are camelCase (`studentName`, `payLink`). The
 * two must meet at some point, and matching case-sensitively would reject every
 * template that used a readable placeholder. Lookup is therefore case-folded,
 * with the caller's own casing winning so an explicit override is never
 * shadowed by a built-in.
 */
const buildVariableLookup = (variables = {}) => {
  const lookup = new Map();
  for (const [key, value] of Object.entries(variables)) {
    lookup.set(key.toLowerCase(), value);
  }
  return {
    get: (name) => {
      const direct = variables[name];
      if (direct !== undefined) return direct;
      return lookup.get(String(name).toLowerCase());
    },
  };
};

/** Substitutes `{{name}}` placeholders. Throws on a missing required value. */
const renderTemplateBody = (body, variables = {}) => {
  const values = buildVariableLookup(variables);
  const missing = [];

  const rendered = String(body).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, rawName) => {
    const value = values.get(rawName);
    if (value === undefined || value === null || value === '') {
      missing.push(rawName);
      return '';
    }
    return String(value);
  });

  if (missing.length) {
    throw new ApiError(
      `Template is missing values for: ${[...new Set(missing)].join(', ')}`,
      400,
      'WHATSAPP_TEMPLATE_MISSING_VARIABLES'
    );
  }

  return rendered;
};

/**
 * Positional parameters Meta expects, in the template's declared variable
 * order. An explicit `parameters` array from the caller wins, because only the
 * caller knows the intended order when it skipped the variable declaration.
 */
const resolveTemplateParameters = (template, variables, explicitParameters) => {
  const declared = template?.variables || [];

  if (Array.isArray(explicitParameters) && explicitParameters.length) {
    // Meta takes exactly one positional value per declared variable. A
    // short list is rejected by the provider with an opaque error after the
    // message has already been recorded, so the mismatch is caught here where
    // the caller can still correct it.
    if (declared.length && explicitParameters.length !== declared.length) {
      throw new ApiError(
        `Template "${template.name}" declares ${declared.length} variable(s) but ${explicitParameters.length} parameter(s) were supplied`,
        400,
        'WHATSAPP_TEMPLATE_PARAMETER_MISMATCH'
      );
    }
    return explicitParameters.map((value) => String(value));
  }

  if (!declared.length) return [];

  const values = buildVariableLookup(variables);

  return declared.map((variable) => {
    const value = values.get(variable.name);
    if (value === undefined || value === null || value === '') {
      throw new ApiError(
        `Template "${template.name}" requires a value for "${variable.name}"`,
        400,
        'WHATSAPP_TEMPLATE_MISSING_VARIABLES'
      );
    }
    return String(value);
  });
};

/**
 * Loads a sendable template: platform-wide (schoolId null) or the school's own,
 * and approved. A template that is pending or rejected is not sendable, which is
 * what Meta enforces too.
 */
const loadSendableTemplate = async (name, language, schoolId) => {
  const normalizedName = String(name || '').toLowerCase();
  const normalizedLanguage = String(language || 'en').toLowerCase();

  const template = await WhatsAppTemplate.findOne({
    name: normalizedName,
    language: normalizedLanguage,
    status: 'approved',
    deletedAt: null,
    $or: [{ schoolId: null }, { schoolId: new mongoose.Types.ObjectId(schoolId) }],
  }).lean();

  if (!template) {
    const anyStatus = await WhatsAppTemplate.findOne({
      name: normalizedName,
      language: normalizedLanguage,
      deletedAt: null,
    })
      .select('status name language schoolId')
      .lean();

    if (anyStatus) {
      throw new ApiError(
        `Template "${anyStatus.name}" (${anyStatus.language}) is ${anyStatus.status} and cannot be sent. Only approved templates may be sent.`,
        400,
        'WHATSAPP_TEMPLATE_NOT_APPROVED'
      );
    }

    throw new ApiError(
      `Approved template "${normalizedName}" (${normalizedLanguage}) not found. Create it via POST /whatsapp/template/create.`,
      404,
      'WHATSAPP_TEMPLATE_NOT_FOUND'
    );
  }

  return template;
};

// ──────────────────── Customer service window ────────────────────

/**
 * Meta only permits free-form business-initiated text inside the customer
 * service window that an inbound parent message opens. A school messaging a
 * parent cold must use an approved template; this makes that a clear 400
 * instead of an opaque provider rejection.
 */
const isWithinServiceWindow = async (phone, schoolId) => {
  const lastInbound = await WhatsAppMessage.findOne({
    schoolId: new mongoose.Types.ObjectId(schoolId),
    phone,
    direction: 'inbound',
  })
    .sort({ createdAt: -1 })
    .select('createdAt')
    .lean();

  if (!lastInbound) return false;

  const cutoff = Date.now() - WHATSAPP_SERVICE_WINDOW_HOURS * 60 * 60 * 1000;
  return new Date(lastInbound.createdAt).getTime() >= cutoff;
};

// ──────────────────── Inbound: webhook authentication ────────────────────

/**
 * Verifies Meta's `X-Hub-Signature-256` over the raw body.
 *
 * A missing WHATSAPP_APP_SECRET is a deployment error, not a reason to accept
 * unsigned traffic: the endpoint writes into conversation history and can
 * trigger plan acceptance. In development it warns and allows so the flow can
 * be exercised with a hand-rolled payload; in production (or when
 * WEBHOOK_AUTH_ENFORCED is set) it refuses.
 */
export const verifyWhatsAppWebhookSignature = ({ header, rawBody } = {}) => {
  const { valid, reason } = verifyMetaSignature({
    header,
    secret: WHATSAPP_APP_SECRET,
    rawBody,
  });

  if (valid) return { valid: true, enforced: true };

  if (reason === 'no_shared_secret_configured' && WEBHOOK_AUTH_ENFORCED !== 'true') {
    console.warn(
      '[WHATSAPP-WEBHOOK] WHATSAPP_APP_SECRET is not set; accepting an unsigned webhook. Set it before going to production.'
    );
    return { valid: true, enforced: false };
  }

  return { valid: false, reason };
};

/**
 * Meta's subscription handshake (GET /whatsapp/webhook). Echoes the challenge
 * only when the verify token matches, and compares in constant time.
 */
export const resolveWebhookChallenge = (mode, token, challenge) => {
  if (mode !== 'subscribe') return { subscribed: false, reason: 'not_a_subscription_request' };
  if (!token || !safeEqual(token, WHATSAPP_VERIFY_TOKEN)) {
    return { subscribed: false, reason: 'verify_token_mismatch' };
  }
  return { subscribed: true, challenge: challenge || '' };
};

// ──────────────────── Inbound: sender resolution ────────────────────

/**
 * Maps an inbound sender to a school.
 *
 * Meta does not scope messages to a business tenant, so the only link back to
 * SukuuPay is the sender's own number appearing on a Student record. A sender we
 * cannot place is still recorded — as an orphan — because dropping it would
 * make the school think the parent never wrote.
 */
const resolveSender = async (from) => {
  const candidates = phoneSearchCandidates(from);
  if (!candidates.length) {
    return { phone: null, phoneRaw: from || '', schoolId: null, studentId: null, parentName: '' };
  }

  const student = await Student.findOne({
    'parents.phone': { $in: candidates },
    deletedAt: null,
  })
    .select('schoolId parents')
    .lean();

  const matchedParent = student
    ? (student.parents || []).find((parent) => candidates.includes(String(parent.phone).trim()))
    : null;

  // Meta reports the sender as bare digits (`233241234567`, no `+`), while
  // outbound sends are addressed in E.164. Storing the raw value would file an
  // inbound message in a different thread from the school's own replies to that
  // parent, and would leave the customer service window permanently closed.
  const normalised = normalisePhone(from);

  return {
    phone: normalised.valid ? normalised.e164 : from,
    phoneRaw: from || '',
    schoolId: student?.schoolId || null,
    studentId: student?._id || null,
    parentName: matchedParent?.parentName || '',
  };
};

// ──────────────────── Inbound: message intake ────────────────────

/** Reduces a Meta message object to { kind, body, payload }. */
const readInboundContent = (message) => {
  switch (message.type) {
    case 'text':
      return { kind: 'text', body: message.text?.body || '', payload: null };
    case 'image':
      return { kind: 'image', body: message.image?.caption || '', payload: message.image || null };
    case 'document':
      return { kind: 'document', body: message.document?.caption || '', payload: message.document || null };
    case 'button': {
      const reply = message.button || {};
      return { kind: 'interactive', body: reply.text || reply.payload || '', payload: reply };
    }
    case 'interactive': {
      const reply = message.interactive || {};
      // A list reply carries the chosen row under `list_reply`, a reply button
      // under `button_reply`; a template quick-reply carries neither.
      const selection = reply.list_reply || reply.button_reply || reply;
      return {
        kind: 'interactive',
        body: selection?.title || selection?.id || '',
        payload: reply,
      };
    }
    case 'location':
      return { kind: 'unsupported', body: '', payload: message.location || null };
    case 'contacts':
      return { kind: 'unsupported', body: '', payload: message.contacts || null };
    case 'reaction':
      return { kind: 'unsupported', body: message.reaction?.emoji || '', payload: message.reaction || null };
    case 'unsupported':
      return { kind: 'unsupported', body: '', payload: message };
    default:
      return { kind: 'unsupported', body: '', payload: message };
  }
};

/**
 * Acts on a parent reply.
 *
 * The only action the platform takes on inbound text today is payment-plan
 * acceptance, which the SMS flow already supports: the school tells a parent to
 * reply `ACCEPT <token>`. Honouring the same keyword on WhatsApp means a parent
 * who replies on the channel they happen to prefer is not silently ignored.
 *
 * Every failure is swallowed: the message is already stored, and an
 * unrecognised keyword is the common case, not an error.
 */
const handleInboundAction = async (message) => {
  if (message.kind !== 'text' && message.kind !== 'interactive') return { action: 'none' };
  const text = String(message.body || '').trim();
  if (!text) return { action: 'none' };

  const match = text.match(/^accept[\s:-]+([A-Za-z0-9]{4,12})$/i);
  if (!match) return { action: 'none' };

  const token = match[1].toUpperCase();

  try {
    // The token column is `select: false`, so it has to be opted into.
    const plan = await PaymentPlan.findOne({
      acceptanceToken: token,
      planStatus: 'pending_acceptance',
      deletedAt: null,
    })
      .select('+acceptanceToken')
      .lean();

    if (!plan) return { action: 'plan_accept', outcome: 'no_matching_plan' };

    const result = await acceptPaymentPlan(plan._id, { token, via: 'whatsapp' });
    return { action: 'plan_accept', outcome: 'accepted', planId: plan._id, result };
  } catch (error) {
    console.warn(`[WHATSAPP] Could not accept plan for token reply: ${error.message}`);
    return { action: 'plan_accept', outcome: 'failed', reason: error.message };
  }
};

/**
 * Persists one inbound message, ignoring a redelivery.
 *
 * Meta retries until it receives a 2xx and can re-send an event it already
 * delivered, so idempotency is a correctness requirement, not an optimisation.
 * The unique index on providerMessageId is the race-proof backstop; the
 * existence check just avoids raising a duplicate-key error in the common case.
 */
const recordInboundMessage = async (rawMessage, { profileName } = {}) => {
  const sender = await resolveSender(rawMessage.from);
  const content = readInboundContent(rawMessage);

  const existing = await WhatsAppMessage.findOne({ providerMessageId: rawMessage.id }).select('_id').lean();
  if (existing) return { message: null, duplicate: true };

  // Meta's timestamp is seconds since epoch. A parent with a skewed phone clock
  // can send a future value, so it is clamped rather than trusted.
  const sentAt = Number.isFinite(Number(rawMessage.timestamp))
    ? new Date(Math.min(Number(rawMessage.timestamp) * 1000, Date.now() + 5 * 60 * 1000))
    : new Date();

  try {
    const message = await WhatsAppMessage.create({
      schoolId: sender.schoolId,
      studentId: sender.studentId,
      parentName: sender.parentName || profileName || '',
      phone: sender.phone,
      phoneRaw: sender.phoneRaw,
      direction: 'inbound',
      type: 'general',
      kind: content.kind,
      body: content.body,
      payload: content.payload,
      providerMessageId: rawMessage.id,
      // Inbound is delivered by definition; there is no send to confirm.
      status: sender.schoolId ? 'delivered' : 'ignored',
      statusTimestamp: sentAt,
      sentAt,
      deliveredAt: sentAt,
      rawPayload: rawMessage,
    });

    if (sender.schoolId) {
      await handleInboundAction(message);
    }

    // Acknowledging read is a courtesy to the parent, never a failure path:
    // if the tick does not turn blue the message is still in the history.
    markWhatsAppRead(rawMessage.id).catch((error) => {
      console.warn(`[WHATSAPP] Could not mark ${rawMessage.id} as read: ${error.message}`);
    });

    return { message, duplicate: false, placed: Boolean(sender.schoolId) };
  } catch (error) {
    if (error?.code === 11000) {
      // Concurrent redelivery won the race; the unique index did its job.
      return { message: null, duplicate: true };
    }
    throw error;
  }
};

/** Applies Meta delivery-status events to already-stored outbound messages. */
const applyStatusEvents = async (statuses = []) => {
  const applied = [];
  const unknown = [];

  for (const event of statuses) {
    const message = await WhatsAppMessage.findOne({
      providerMessageId: event.id,
      direction: 'outbound',
    });

    if (!message) {
      // A status for a message this deployment never sent (a number shared
      // across WABAs, or a log restored from a backup). Not an error.
      unknown.push(event.id);
      continue;
    }

    // Status callbacks are not strictly ordered, and a late `sent` must never
    // undo a `read` the provider already confirmed.
    const RANK = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 3, ignored: 0 };
    if ((RANK[event.status] ?? 0) < (RANK[message.status] ?? 0)) {
      applied.push({ id: event.id, skipped: `would regress ${message.status} to ${event.status}` });
      continue;
    }

    message.status = event.status === 'failed' ? 'failed' : event.status;
    message.statusTimestamp = Number.isFinite(Number(event.timestamp))
      ? new Date(Number(event.timestamp) * 1000)
      : new Date();
    if (event.status === 'failed') {
      const detail = event.errors?.[0]?.error_data?.details || event.errors?.[0]?.title;
      message.failureReason = String(detail || 'Reported failed by WhatsApp').slice(0, 500);
    }
    await message.save();
    applied.push({ id: event.id, status: message.status });
  }

  return { applied, unknown };
};

/**
 * Entry point for POST /whatsapp/webhook.
 *
 * Returns a tally rather than throwing for per-message problems: one malformed
 * entry must not make Meta retry the whole batch forever, which is what would
 * happen if this responded non-2xx.
 */
export const handleIncomingWebhook = async (payload, context = {}) => {
  // Deliberately NOT guarded with assertWhatsAppAvailable.
  //
  // This path is provider-initiated. Meta retries any non-2xx indefinitely, so
  // returning 501 here — the correct answer to a user-initiated send — would
  // create a permanent retry storm against an endpoint that will never exist.
  // Acknowledging is the only correct response: there is nothing to process and
  // nothing to retry.
  if (!WHATSAPP_ENABLED) {
    console.warn(
      '[WHATSAPP-WEBHOOK] Channel is disabled; acknowledging inbound payload without processing. This usually means a Meta subscription is still active and should be removed.'
    );
    return {
      received: 0,
      stored: 0,
      duplicates: 0,
      unplaced: 0,
      statusesApplied: 0,
      statusesUnknown: 0,
      ok: true,
      reason: 'channel_disabled',
      comingSoonMessage: WHATSAPP_COMING_SOON_MESSAGE,
    };
  }

  const entries = payload?.entry || [];
  const tally = { received: 0, stored: 0, duplicates: 0, unplaced: 0, statusesApplied: 0, statusesUnknown: 0 };

  for (const entry of entries) {
    for (const change of entry?.changes || []) {
      if (change.field === 'statuses') {
        const { applied, unknown } = await applyStatusEvents(change.value?.statuses || []);
        tally.statusesApplied += applied.length;
        tally.statusesUnknown += unknown.length;
        continue;
      }

      if (change.field !== 'messages') continue;

      const value = change.value || {};
      // The contact profile is a sibling of the messages array, keyed by the
      // sender's wa_id, so it has to be matched rather than zipped.
      const profileByWaId = new Map(
        (value.contacts || []).map((contact) => [contact.wa_id, contact.profile?.name || ''])
      );

      for (const message of value.messages || []) {
        tally.received += 1;
        try {
          const result = await recordInboundMessage(message, {
            profileName: profileByWaId.get(message.from) || '',
          });
          if (result.duplicate) tally.duplicates += 1;
          else {
            tally.stored += 1;
            if (!result.placed) tally.unplaced += 1;
          }
        } catch (error) {
          console.error(`[WHATSAPP-WEBHOOK] Failed to store message ${message.id}:`, error.message);
        }
      }
    }
  }

  // A senders-unknown tally means somebody is messaging a number that is not on
  // any Student record. Worth surfacing: it is either a new parent or a wrong
  // number in a form this deployment cannot match.
  if (tally.unplaced > 0) {
    console.warn(
      `[WHATSAPP-WEBHOOK] ${tally.unplaced} inbound message(s) could not be matched to a school.`
    );
  }

  await auditLog({
    action: 'webhook.received',
    entity: 'WhatsAppMessage',
    meta: { provider: 'meta', ...tally, ...context },
  });

  return { ...tally, ok: true };
};

// ──────────────────── Outbound: delivery ────────────────────

/**
 * Hands one persisted message to Meta and records the outcome.
 *
 * The row already exists as `queued`, so a transport failure becomes a `failed`
 * record rather than a silent gap in the audit trail — the same contract
 * `emailMessaging.service.js` uses.
 */
const deliver = async (message) => {
  try {
    const result = await sendWhatsAppMessage({
      to: message.phone,
      kind: message.kind,
      body: message.body,
      template: message.template?.name
        ? {
            name: message.template.name,
            language: message.template.language,
            parameters: message.template.parameters || [],
          }
        : null,
    });

    message.providerMessageId = result.providerMessageId;
    message.status = 'sent';
    message.sentAt = new Date();
    await message.save();
    return { delivered: true, providerMessageId: result.providerMessageId };
  } catch (error) {
    message.status = 'failed';
    message.failureReason = String(error.message || error).slice(0, 500);
    await message.save();

    if (error instanceof WhatsAppTransportError) {
      throw new ApiError(error.message, error.status, error.code);
    }
    throw error;
  }
};

/** Persists a message as `queued` before any provider call. */
const createMessage = (fields) => WhatsAppMessage.create({
  provider: 'meta',
  direction: 'outbound',
  ...fields,
});

/**
 * Resolves the parents a send should reach.
 *
 * Parent sub-documents are declared with `_id: false`, so a parent is selected
 * by position, never by id. An explicit `to` overrides resolution entirely,
 * which is the escape hatch for a number that is not on the student record.
 */
const resolveRecipients = async (student, data) => {
  if (data.to) {
    const normalised = toGhanaE164(data.to);
    if (!normalised.valid) {
      throw new ApiError(
        `"${data.to}" is not a valid WhatsApp number: ${normalised.reason}`,
        400,
        'INVALID_WHATSAPP_NUMBER'
      );
    }
    return {
      resolved: [{ phone: normalised.e164, parentName: '', raw: String(data.to) }],
      skippedInvalid: 0,
    };
  }

  const parents = student.parents || [];
  let selected;

  if (data.recipient === 'primary_indexed') {
    const index = Number(data.recipientIndex);
    selected = [parents[index]];
    if (!selected[0]) {
      throw new ApiError(
        `recipientIndex ${data.recipientIndex} is out of range; this student has ${parents.length} parent(s)`,
        400,
        'RECIPIENT_INDEX_OUT_OF_RANGE'
      );
    }
  } else if (data.recipient === 'all') {
    selected = parents;
  } else {
    selected = [getPrimaryParent(student)];
  }

  const resolved = [];
  const seen = new Set();
  let skippedInvalid = 0;

  selected.filter(Boolean).forEach((parent) => {
    const normalised = toGhanaE164(parent.phone);
    if (!normalised.valid) {
      skippedInvalid += 1;
      return;
    }
    // The same parent can appear twice when one guardian funds two children;
    // two messages to one number is a defect, not a reminder.
    if (seen.has(normalised.e164)) return;
    seen.add(normalised.e164);
    resolved.push({ phone: normalised.e164, parentName: parent.parentName || '', raw: parent.phone });
  });

  if (!resolved.length) {
    const who = data.recipient === 'all' ? 'The selected parents' : 'The selected parent';
    const detail = skippedInvalid
      ? ` (${skippedInvalid} parent number(s) on record are not valid Ghanaian numbers)`
      : '';
    throw new ApiError(
      `${who}${detail} cannot be messaged on WhatsApp. Update the parent's number on the student record, or pass an explicit "to" number.`,
      400,
      'RECIPIENT_HAS_NO_WHATSAPP'
    );
  }

  return { resolved, skippedInvalid };
};

// ──────────────────── Outbound: single send ────────────────────

export const sendWhatsAppToStudent = async (studentIdParam, data, user, { idempotencyKey = null } = {}) => {
  // Before anything else: this must not consume rate-limit budget, query the
  // quota, or write a message row when the channel is off.
  assertWhatsAppAvailable();

  const schoolId = resolveSchoolId(user, data.schoolId);

  const student = await Student.findOne({
    _id: studentIdParam,
    deletedAt: null,
    ...(schoolId ? { schoolId } : {}),
  }).select('studentId studentName studentClass balance totalOwed totalPaid deadline payLink schoolId parents');

  if (!student) throw new ApiError('Student not found', 404, 'STUDENT_NOT_FOUND');

  const school = await School.findById(student.schoolId)
    .select('name notifications')
    .lean();

  if (!school) throw new ApiError('School not found', 404, 'SCHOOL_NOT_FOUND');

  // Consent gates outbound only. A parent who replies must still be able to, and
  // their reply is still recorded.
  if (school.notifications?.whatsapp === false) {
    throw new ApiError(
      'WhatsApp messaging is switched off for this school',
      403,
      'WHATSAPP_DISABLED_FOR_SCHOOL'
    );
  }

  const payload = {
    studentId: studentIdParam,
    to: data.to,
    recipient: data.recipient,
    recipientIndex: data.recipientIndex,
    template: data.template,
    message: data.message,
    type: data.type,
    ignoreServiceWindow: data.ignoreServiceWindow,
    schoolId: data.schoolId,
  };
  const replay = await checkIdempotency(idempotencyKey, 'whatsapp:send', payload);
  if (replay) return { ...replay, replayed: true };

  // Charged only for work that will actually be done. A client retrying after a
  // timeout is the reason idempotency exists; making that retry also cost a
  // rate-limit slot would mean a single flaky request can exhaust the window.
  consumeRateLimit(`whatsapp:send:${schoolId || user?.schoolId || 'global'}`, 60, 60_000);

  const { resolved, skippedInvalid } = await resolveRecipients(student, data);
  const quota = await assertQuota(student.schoolId, resolved.length);

  const isTemplate = Boolean(data.template?.name);
  const templateDoc = isTemplate
    ? await loadSendableTemplate(data.template.name, data.template.language, student.schoolId)
    : null;

  const variables = buildVariables(student, school, { parentName: resolved[0]?.parentName });

  // Free-form text is only permitted inside the customer service window that an
  // inbound message opens. Templates are unrestricted, which is the whole point
  // of having them.
  if (!isTemplate && !data.ignoreServiceWindow) {
    for (const recipient of resolved) {
      const open = await isWithinServiceWindow(recipient.phone, student.schoolId);
      if (open) continue;
      throw new ApiError(
        `WhatsApp does not allow free-form messages to ${formatPhone(recipient.phone)} until that parent has replied in the last ${WHATSAPP_SERVICE_WINDOW_HOURS} hours. Send an approved template instead, or pass ignoreServiceWindow: true if this is a reply you are answering on their behalf.`,
        400,
        'WHATSAPP_SERVICE_WINDOW_CLOSED'
      );
    }
  }

  const messages = [];
  // A send that fails at the provider must still leave an audit entry, so the
  // attempt is tallied here and written in a `finally` below rather than only
  // on the success path.
  const outcome = { failureCode: null };

  try {
    for (const recipient of resolved) {
      const recipientVariables = { ...variables, parentName: recipient.parentName };

      let content;
      if (templateDoc) {
        const parameters = resolveTemplateParameters(templateDoc, recipientVariables, data.template.parameters);
        content = {
          kind: 'template',
          // The rendered text is stored so the conversation view is readable even
          // though Meta performs the real rendering on the parent's device.
          body: renderTemplateBody(templateDoc.body, recipientVariables),
          template: { name: templateDoc.name, language: templateDoc.language, parameters },
        };
      } else {
        content = {
          kind: 'text',
          body: String(data.message || ''),
          template: { name: null, language: null, parameters: [] },
        };
      }

      const message = await createMessage({
        schoolId: student.schoolId,
        studentId: student._id,
        parentName: recipient.parentName,
        phone: recipient.phone,
        phoneRaw: recipient.raw,
        type: data.type || 'general',
        kind: content.kind,
        body: content.body,
        template: content.template,
        createdBy: user?._id || null,
      });

      messages.push(message);

      try {
        await deliver(message);
      } catch (error) {
        outcome.failureCode = error.code || 'SEND_FAILED';
        throw error;
      }
    }
  } finally {
    const delivered = messages.filter((message) => message.status !== 'failed').length;
    await auditLog({
      action: 'whatsapp.send',
      entity: 'WhatsAppMessage',
      entityId: messages[0]?._id,
      userId: user?._id,
      schoolId: student.schoolId,
      meta: {
        studentId: student.studentId,
        recipients: messages.length,
        delivered,
        failed: messages.length - delivered,
        ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
        template: templateDoc?.name || null,
        kind: messages[0]?.kind,
      },
    });
  }

  const response = {
    data: messages.length === 1 ? messages[0].toJSON() : messages.map((m) => m.toJSON()),
    meta: {
      recipients: messages.length,
      skippedInvalid,
      quotaRemaining: quota.remaining - resolved.length,
    },
  };

  await rememberIdempotency(idempotencyKey, 'whatsapp:send', payload, user?._id, response);
  return response;
};

// ──────────────────── Outbound: bulk send ────────────────────

// Balance bands in cedis, expressed in pesewas.
const BALANCE_BANDS = {
  no_balance: { $eq: 0 },
  '1_100': { $gte: 100, $lte: 10000 },
  '101_500': { $gt: 10000, $lte: 50000 },
  '501_1000': { $gt: 50000, $lte: 100000 },
  above_1000: { $gt: 100000 },
};

const buildStudentFilter = (schoolId, { target, class: className, status, balanceRanges, hasActivePlan, ids }) => {
  const filter = { schoolId: new mongoose.Types.ObjectId(schoolId), deletedAt: null };

  if (status?.length) filter.status = { $in: status };

  if (target === 'class') {
    if (!className) {
      throw new ApiError('recipients.target "class" requires a class filter', 400, 'CLASS_REQUIRED');
    }
    filter.studentClass = { $in: [].concat(className) };
  } else if (target === 'students') {
    if (!ids?.length) {
      throw new ApiError('recipients.target "students" requires recipients.ids', 400, 'STUDENT_IDS_REQUIRED');
    }
    filter._id = { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  if (balanceRanges?.length) {
    const ranges = balanceRanges.map((band) => {
      if (!BALANCE_BANDS[band]) {
        throw new ApiError(`Unknown balance range "${band}"`, 400, 'INVALID_BALANCE_RANGE');
      }
      return BALANCE_BANDS[band];
    });
    filter.$and = [{ $or: ranges }];
  }

  if (hasActivePlan === true) {
    filter.paymentPlans = { $exists: true, $ne: [] };
  } else if (hasActivePlan === false) {
    filter.$or = [{ paymentPlans: { $exists: false } }, { paymentPlans: { $size: 0 } }];
  }

  return filter;
};

/**
 * Resolves a broadcast to one entry per reachable parent.
 *
 * Deduplication is per phone number, not per student: a guardian who funds two
 * children must not receive the same broadcast twice. The skipped counts are
 * reported separately because "no number on record" and "number is malformed"
 * are different problems with different fixes.
 */
const resolveBulkRecipients = async (schoolId, filters) => {
  const students = await Student.find(buildStudentFilter(schoolId, filters))
    .select('studentId studentName studentClass balance totalOwed totalPaid deadline payLink parents')
    .lean();

  const recipients = [];
  const skippedReasons = {};
  const bump = (reason) => {
    skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
  };

  const seen = new Set();

  for (const student of students) {
    const parent = getPrimaryParent(student);
    if (!parent) {
      bump('no_parent');
      continue;
    }

    const normalised = toGhanaE164(parent.phone);
    if (!normalised.valid) {
      bump('invalid_number');
      continue;
    }

    if (seen.has(normalised.e164)) {
      bump('duplicate_number');
      continue;
    }
    seen.add(normalised.e164);

    recipients.push({
      phone: normalised.e164,
      name: parent.parentName || '',
      studentId: student._id,
      variables: buildVariables(student, null, parent),
    });
  }

  const skippedInvalid = skippedReasons.invalid_number || 0;
  delete skippedReasons.invalid_number;

  return { recipients, skippedReasons, skippedInvalid };
};

export const sendBulkWhatsApp = async (schoolIdParam, data, user, { idempotencyKey = null } = {}) => {
  assertWhatsAppAvailable();

  assertSchoolAccess(user, schoolIdParam);

  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  const school = await School.findById(schoolId).select('name notifications').lean();
  if (!school) throw new ApiError('School not found', 404, 'SCHOOL_NOT_FOUND');

  if (school.notifications?.whatsapp === false) {
    throw new ApiError(
      'WhatsApp messaging is switched off for this school',
      403,
      'WHATSAPP_DISABLED_FOR_SCHOOL'
    );
  }

  const payload = {
    schoolId: schoolIdParam,
    template: data.template,
    message: data.message,
    type: data.type,
    recipients: data.recipients,
    class: data.class,
    balanceRanges: data.balanceRanges,
    hasActivePlan: data.hasActivePlan,
    status: data.status,
    confirmBroadscope: data.confirmBroadscope,
    scheduleAt: data.scheduleAt,
  };
  const replay = await checkIdempotency(idempotencyKey, 'whatsapp:bulk', payload);
  if (replay) return { ...replay, replayed: true };

  // The bulk allowance is small (5/hour) and a broadcast is expensive, so a
  // replay must not spend it. Charged after the replay check, before any work.
  consumeRateLimit(`whatsapp:bulk:${schoolId}`, 5, 60 * 60 * 1000);

  const isTemplate = Boolean(data.template?.name);
  const templateDoc = isTemplate
    ? await loadSendableTemplate(data.template.name, data.template.language, schoolId)
    : null;

  // A bulk broadcast is by definition cold: no parent has just replied to it.
  // Free-form text would be rejected by Meta for every recipient, so the check
  // is reported once here rather than per message.
  if (!isTemplate && !data.ignoreServiceWindow) {
    throw new ApiError(
      `A broadcast cannot use free-form text: WhatsApp only permits it within ${WHATSAPP_SERVICE_WINDOW_HOURS} hours of a parent's reply, and a broadcast has none. Use an approved template, or pass ignoreServiceWindow: true if you have a reason to override.`,
      400,
      'WHATSAPP_SERVICE_WINDOW_CLOSED'
    );
  }

  const filters = {
    target: data.recipients?.target,
    ids: data.recipients?.ids,
    class: data.class,
    status: data.status,
    balanceRanges: data.balanceRanges,
    hasActivePlan: data.hasActivePlan,
  };

  if (filters.target === 'all' && !data.confirmBroadscope) {
    throw new ApiError(
      'A full-school broadcast must be confirmed with confirmBroadscope: true',
      400,
      'BROADSCOPE_NOT_CONFIRMED'
    );
  }

  const { recipients, skippedReasons, skippedInvalid } = await resolveBulkRecipients(schoolId, filters);
  const matchedParents =
    recipients.length + Object.values(skippedReasons).reduce((a, b) => a + b, 0) + skippedInvalid;

  if (!recipients.length) {
    throw new ApiError(
      matchedParents
        ? `Broadcast resolves to 0 parents with a usable WhatsApp number. ${matchedParents} parents matched the filters but none can be messaged.`
        : 'Broadcast resolves to 0 parents. Relax the filters and try again.',
      400,
      'NO_REACHABLE_RECIPIENTS'
    );
  }

  if (recipients.length > MAX_BULK_WHATSAPP_RECIPIENTS) {
    throw new ApiError(
      `Broadcast resolves to ${recipients.length} parents, above the ${MAX_BULK_WHATSAPP_RECIPIENTS} limit. Narrow the filters and try again.`,
      400,
      'BULK_RECIPIENT_LIMIT'
    );
  }

  const quota = await assertQuota(schoolId, recipients.length);

  // A free-form literal body is identical for every recipient, so it is stored
  // once on the job rather than copied into the snapshot.
  if (!isTemplate && !data.message) {
    throw new ApiError(
      'A free-form broadcast requires a "message" body',
      400,
      'MESSAGE_REQUIRED'
    );
  }

  const snapshot = recipients.map((recipient) => ({
    phone: recipient.phone,
    name: recipient.name,
    studentId: recipient.studentId,
    variables: { schoolName: school.name, ...recipient.variables },
  }));

  const job = await WhatsAppJob.create({
    schoolId,
    channel: 'whatsapp',
    message: isTemplate ? null : data.message,
    template: isTemplate
      ? {
          name: templateDoc.name,
          language: templateDoc.language,
          parameters: data.template.parameters || undefined,
        }
      : { name: null, language: null, parameters: [] },
    type: data.type || 'announcement',
    status: data.scheduleAt ? 'queued' : 'processing',
    filters: {
      target: filters.target,
      class: filters.class || null,
      balanceRanges: filters.balanceRanges || null,
      hasActivePlan: filters.hasActivePlan ?? null,
      status: filters.status || null,
    },
    recipientsResolved: snapshot.length,
    recipientsSkipped: Object.values(skippedReasons).reduce((a, b) => a + b, 0),
    skippedInvalidNumber: skippedInvalid,
    skippedReasons,
    quotaRemainingBefore: quota.remaining,
    scheduledAt: data.scheduleAt ? new Date(data.scheduleAt) : null,
    recipientsSnapshot: snapshot,
    createdBy: user._id,
  });

  await auditLog({
    action: 'whatsapp.bulk_send',
    entity: 'WhatsAppJob',
    entityId: job._id,
    userId: user._id,
    schoolId,
    meta: {
      template: templateDoc?.name || null,
      type: data.type,
      recipientsResolved: snapshot.length,
      skippedInvalidNumber: skippedInvalid,
    },
  });

  // Fire and forget: the HTTP response must not wait on delivery.
  dispatchWhatsAppJob(job, data.scheduleAt).catch((error) => {
    console.error('[WHATSAPP-JOB] Unhandled failure:', error.message);
  });

  const response = { data: { ...job.toJSON(), jobId: job._id.toString() } };
  await rememberIdempotency(idempotencyKey, 'whatsapp:bulk', payload, user._id, response);
  return response;
};

/**
 * Starts the run, now or at `scheduleAt`.
 *
 * Scheduling is an in-process timer, so a job is lost if the process restarts
 * before it fires. That is acceptable for a single-instance deployment and is
 * called out here rather than left to look like durable scheduling; a
 * multi-instance deployment needs a queue or a poll of `status: queued` jobs.
 */
const dispatchWhatsAppJob = async (job, scheduleAt) => {
  if (!scheduleAt) {
    await runWhatsAppJob(job._id);
    return;
  }

  const delay = new Date(scheduleAt).getTime() - Date.now();
  if (delay <= 0) {
    await runWhatsAppJob(job._id);
    return;
  }
  if (delay > MAX_SET_TIMEOUT_MS) {
    throw new ApiError(
      'scheduleAt must be within 24 hours of now for in-process scheduling',
      400,
      'SCHEDULE_TOO_FAR'
    );
  }

  setTimeout(() => {
    runWhatsAppJob(job._id).catch((error) => {
      console.error(`[WHATSAPP-JOB] Scheduled job ${job._id} failed:`, error.message);
    });
  }, delay);
};

/**
 * Runs an accepted broadcast. `WHATSAPP_JOB_CONCURRENCY` messages are in flight
 * at once, and cancellation is checked between batches.
 */
export const runWhatsAppJob = async (jobId) => {
  const job = await WhatsAppJob.findById(jobId).select('+recipientsSnapshot +message');
  if (!job) return null;
  if (!['queued', 'processing'].includes(job.status)) return job;

  const templateDoc = job.template?.name
    ? await WhatsAppTemplate.findOne({
        name: job.template.name,
        language: job.template.language,
        status: 'approved',
        deletedAt: null,
        $or: [{ schoolId: null }, { schoolId: job.schoolId }],
      }).lean()
    : null;

  job.status = 'processing';
  job.startedAt = job.startedAt || new Date();
  await job.save();

  const snapshot = job.recipientsSnapshot || [];
  const concurrency = Math.max(1, Number(WHATSAPP_JOB_CONCURRENCY) || 3);
  let cancelled = false;

  // A re-dispatched job (process restart, operator retry) must not message the
  // same parent twice, so any recipient already carrying a row for this job is
  // skipped. The tally then describes exactly what this run handled, instead of
  // accumulating every row the job has ever produced.
  const alreadyMessaged = new Set(
    await WhatsAppMessage.distinct('phone', { jobId: job._id })
  );

  const tally = { sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 };
  const countOutcome = (message) => {
    if (!message || message.status === 'failed') {
      tally.failed += 1;
      return;
    }
    tally[message.status] = (tally[message.status] || 0) + 1;
  };

  for (let index = 0; index < snapshot.length; index += concurrency) {
    // Cooperative cancellation: stop between batches, never mid-flight.
    const current = await WhatsAppJob.findById(jobId).select('status');
    if (current?.status === 'cancelling' || current?.status === 'cancelled') {
      cancelled = true;
      break;
    }

    const batch = snapshot
      .slice(index, index + concurrency)
      .filter((entry) => {
        if (alreadyMessaged.has(entry.phone)) {
          tally.skipped += 1;
          return false;
        }
        alreadyMessaged.add(entry.phone);
        return true;
      });

    if (!batch.length) continue;

    await Promise.all(
      batch.map(async (entry) => {
        let body;
        let template;

        try {
          if (templateDoc) {
            const parameters = resolveTemplateParameters(
              templateDoc,
              entry.variables,
              job.template.parameters
            );
            body = renderTemplateBody(templateDoc.body, entry.variables);
            template = { name: templateDoc.name, language: templateDoc.language, parameters };
          } else {
            body = job.message || '';
            template = { name: null, language: null, parameters: [] };
          }
        } catch (error) {
          // A per-recipient render failure must not abort the whole run, but it
          // must be visible, so it is recorded as a failed message.
          await createMessage({
            schoolId: job.schoolId,
            studentId: entry.studentId,
            parentName: entry.name,
            phone: entry.phone,
            type: job.type,
            kind: 'template',
            body: 'Message could not be rendered',
            status: 'failed',
            failureReason: String(error.message).slice(0, 500),
            jobId: job._id,
            createdBy: job.createdBy,
          });
          tally.failed += 1;
          return;
        }

        const message = await createMessage({
          schoolId: job.schoolId,
          studentId: entry.studentId,
          parentName: entry.name,
          phone: entry.phone,
          type: job.type,
          kind: template.name ? 'template' : 'text',
          body,
          template,
          jobId: job._id,
          createdBy: job.createdBy,
        });

        try {
          await deliver(message);
          countOutcome(message);
        } catch {
          // deliver() already recorded the failure on the message.
          countOutcome(message);
        }
      })
    );

    // Checkpoint progress rather than writing on every message.
    job.progressPercent = Math.round(((index + batch.length) / snapshot.length) * 100);
    await job.save();
  }

  const handled = tally.sent + tally.delivered + tally.read + tally.failed;
  const result = { ...tally, handled, total: snapshot.length };
  // A cancelled run has not reached its audience; saying otherwise would let a
  // dashboard report a broadcast as complete.
  if (cancelled) result.cancelledBefore = handled;

  job.result = result;
  job.progressPercent = 100;
  job.status = cancelled ? 'cancelled' : 'completed';
  job.completedAt = new Date();
  if (cancelled) job.cancelledAt = new Date();
  await job.save();

  return job;
};

export const getWhatsAppJob = async (jobId, user) => {
  const schoolId = resolveSchoolId(user);
  const filter = { _id: jobId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;

  const job = await WhatsAppJob.findOne(filter);
  if (!job) throw new ApiError('Bulk WhatsApp job not found', 404, 'JOB_NOT_FOUND');
  return job.toJSON();
};

export const cancelWhatsAppJob = async (jobId, data, user) => {
  const schoolId = resolveSchoolId(user);
  const filter = { _id: jobId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;

  const job = await WhatsAppJob.findOne(filter);
  if (!job) throw new ApiError('Bulk WhatsApp job not found', 404, 'JOB_NOT_FOUND');

  if (!['queued', 'processing'].includes(job.status)) {
    throw new ApiError(
      `This job is already ${job.status} and cannot be cancelled`,
      409,
      'JOB_NOT_CANCELLABLE'
    );
  }

  job.status = 'cancelling';
  job.cancellationReason = data.reason || '';
  job.cancelledAt = new Date();
  job.updatedBy = user._id;
  await job.save();

  return {
    jobId: job._id,
    status: job.status,
    cancellationReason: job.cancellationReason,
    cancelledAt: job.cancelledAt,
    result: job.result,
  };
};

// ──────────────────── Templates ────────────────────

/**
 * Registers a template and, on request, submits it to Meta for approval.
 *
 * The declared `variables` must match the `{{ }}` placeholders in the body
 * exactly. A mismatch is rejected here rather than at send time, where it would
 * surface as an opaque provider error and could not be fixed retroactively.
 */
export const createWhatsAppTemplate = async (data, user) => {
  assertWhatsAppAvailable();

  const name = String(data.name || '').toLowerCase();

  if (!/^[a-z0-9_]{1,512}$/.test(name)) {
    throw new ApiError(
      'Template name must be lowercase letters, digits and underscores only (no spaces), 1-512 characters',
      400,
      'INVALID_TEMPLATE_NAME'
    );
  }

  if (!WHATSAPP_TEMPLATE_CATEGORIES.includes(data.category || 'UTILITY')) {
    throw new ApiError(
      `category must be one of: ${WHATSAPP_TEMPLATE_CATEGORIES.join(', ')}`,
      400,
      'INVALID_TEMPLATE_CATEGORY'
    );
  }

  const body = String(data.body || '').trim();
  if (!body) throw new ApiError('A template body is required', 400, 'TEMPLATE_BODY_REQUIRED');

  if (body.length > 1024) {
    throw new ApiError(
      `Template body must be 1024 characters or fewer (got ${body.length})`,
      400,
      'TEMPLATE_BODY_TOO_LONG'
    );
  }

  // `variables` accepts either a bare name or {name, example}; both spellings
  // are common in an admin form, so both are folded to one shape here.
  const declaredVariables = (data.variables || [])
    .map((variable) =>
      typeof variable === 'string'
        ? { name: variable.trim().toLowerCase(), example: '' }
        : { name: String(variable.name || '').trim().toLowerCase(), example: String(variable.example || '') }
    )
    .filter((variable) => variable.name);

  const declared = declaredVariables.map((variable) => variable.name);
  const placeholders = extractTemplateVariables(body);
  const missingDeclarations = placeholders.filter((name_) => !declared.includes(name_));
  const unusedDeclarations = declared.filter((name_) => !placeholders.includes(name_));

  if (missingDeclarations.length || unusedDeclarations.length) {
    const problems = [
      missingDeclarations.length ? `used in the body but not declared: ${missingDeclarations.join(', ')}` : null,
      unusedDeclarations.length ? `declared but not used in the body: ${unusedDeclarations.join(', ')}` : null,
    ].filter(Boolean);
    throw new ApiError(`Template variables do not match the body (${problems.join('; ')})`, 400, 'TEMPLATE_VARIABLE_MISMATCH');
  }

  // A platform-wide template belongs to no school; a scoped one belongs to the
  // caller's. A super_admin must name a school to scope one.
  const schoolId = data.schoolId
    ? new mongoose.Types.ObjectId(data.schoolId)
    : user?.role === 'super_admin'
      ? null
      : user?.schoolId
        ? new mongoose.Types.ObjectId(user.schoolId)
        : null;

  const existing = await WhatsAppTemplate.findOne({ name, deletedAt: null }).select('_id schoolId status').lean();
  if (existing) {
    throw new ApiError(
      `A template named "${name}" already exists (${existing.status})`,
      409,
      'TEMPLATE_NAME_TAKEN'
    );
  }

  let status = data.submitToMeta ? 'pending' : data.status || 'approved';
  let providerTemplateId = null;
  let rejectionReason = '';

  if (data.submitToMeta) {
    try {
      const submitted = await createProviderTemplate({
        name,
        category: data.category || 'UTILITY',
        body,
        example: declaredVariables.find((variable) => variable.example)?.example || data.example,
      });
      providerTemplateId = submitted?.id ? String(submitted.id) : null;
      // Meta answers synchronously with PENDING and decides later; anything
      // other than APPROVED right now must not be recorded as approved.
      const providerStatus = String(submitted?.status || '').toUpperCase();
      if (providerStatus === 'APPROVED') status = 'approved';
      else if (providerStatus === 'REJECTED') {
        status = 'rejected';
        rejectionReason = submitted?.rejected_reason || 'Rejected by Meta';
      } else status = 'pending';
    } catch (error) {
      // Submission failed, but the local definition is still worth keeping so
      // the text can be fixed and resubmitted without retyping it.
      status = 'draft';
      rejectionReason = String(error.message).slice(0, 500);
    }
  }

  const template = await WhatsAppTemplate.create({
    name,
    displayName: data.displayName || '',
    description: data.description || '',
    category: data.category || 'UTILITY',
    language: String(data.language || 'en').toLowerCase(),
    body,
    variables: declaredVariables.map((variable) => ({
      name: variable.name,
      // An example given inline wins over a separate `examples` map, which is
      // only needed when the form posts the two independently.
      example: variable.example || data.examples?.[variable.name] || '',
    })),
    status,
    rejectionReason,
    providerTemplateId,
    providerStatus: providerTemplateId ? status : null,
    submittedAt: data.submitToMeta ? new Date() : null,
    approvedAt: status === 'approved' ? new Date() : null,
    schoolId,
    createdBy: user?._id || null,
  });

  await auditLog({
    action: 'whatsapp.template_create',
    entity: 'WhatsAppTemplate',
    entityId: template._id,
    userId: user?._id,
    schoolId,
    meta: { name, category: template.category, status: template.status, submitted: Boolean(data.submitToMeta) },
  });

  return template.toJSON();
};

export const listWhatsAppTemplates = async (query, user) => {
  const schoolId = resolveSchoolId(user, query.schoolId);
  const filter = { deletedAt: null };

  // A school sees the platform catalogue plus its own; a super_admin with no
  // explicit school sees everything.
  if (schoolId) filter.$or = [{ schoolId: null }, { schoolId }];
  if (query.status) filter.status = query.status;
  if (query.category) filter.category = query.category;

  const templates = await WhatsAppTemplate.find(filter).sort({ name: 1 }).lean();
  return templates;
};

// ──────────────────── Conversations ────────────────────

/**
 * Conversation history for a school.
 *
 * Two views in one response: a thread summary (one row per parent, most recent
 * first) and, when a single phone is named, that thread's messages. Returning
 * both means a school can go from "who has been quiet this term" to the exact
 * messages without a second round trip.
 */
export const getConversations = async (schoolIdParam, query, user) => {
  assertSchoolAccess(user, schoolIdParam);

  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  const filter = { schoolId, deletedAt: null };

  if (query.phone) {
    filter.phone = query.phone;
  } else if (query.studentId) {
    filter.studentId = new mongoose.Types.ObjectId(query.studentId);
  }

  if (query.direction && query.direction !== 'all') filter.direction = query.direction;
  if (query.status && query.status !== 'all') filter.status = query.status;
  if (query.kind && query.kind !== 'all') filter.kind = query.kind;
  if (query.type && query.type !== 'all') filter.type = query.type;

  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }

  if (query.search) {
    const pattern = new RegExp(String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ body: pattern }, { parentName: pattern }];
  }

  const page = Number(query.page) || 1;
  const perPage = Math.min(Number(query.perPage) || 20, LIMITS.MAX_CONVERSATION_PAGE);
  const skip = (page - 1) * perPage;

  const [messages, total] = await Promise.all([
    WhatsAppMessage.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .populate('studentId', 'studentId studentName studentClass')
      .lean(),
    WhatsAppMessage.countDocuments(filter),
  ]);

  // The thread list is only meaningful at school level. Asking for one
  // thread's messages should not be paid for with a full group-by.
  let threads = null;
  if (!query.phone && !query.studentId && page === 1) {
    threads = await WhatsAppMessage.aggregate([
      { $match: { schoolId: new mongoose.Types.ObjectId(schoolId), deletedAt: null } },
      {
        $group: {
          _id: '$phone',
          messageCount: { $sum: 1 },
          lastMessageAt: { $max: '$createdAt' },
          lastMessage: { $last: '$$ROOT' },
          inboundCount: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
          outboundCount: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
          lastInboundAt: { $max: { $cond: [{ $eq: ['$direction', 'inbound'] }, '$createdAt', null] } },
          parentName: { $last: '$parentName' },
          studentIds: { $addToSet: '$studentId' },
        },
      },
      { $sort: { lastMessageAt: -1 } },
      { $limit: 100 },
    ]);
  }

  return {
    messages,
    threads: threads
      ? threads.map((thread) => ({
          phone: thread._id,
          phoneDisplay: formatPhone(thread._id),
          parentName: thread.parentName || '',
          messageCount: thread.messageCount,
          inboundCount: thread.inboundCount,
          outboundCount: thread.outboundCount,
          lastMessageAt: thread.lastMessageAt,
          lastInboundAt: thread.lastInboundAt,
          lastMessage: {
            body: thread.lastMessage?.body || '',
            direction: thread.lastMessage?.direction,
            status: thread.lastMessage?.status,
            kind: thread.lastMessage?.kind,
          },
          studentIds: (thread.studentIds || []).filter(Boolean),
        }))
      : null,
    meta: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };
};
