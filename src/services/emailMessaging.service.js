import crypto from 'crypto';
import mongoose from 'mongoose';
import { EmailMessage } from '../models/emailMessageModel.js';
import { EmailJob } from '../models/emailJobModel.js';
import { EmailPreference } from '../models/emailPreferenceModel.js';
import { Student } from '../models/studentModel.js';
import { School } from '../models/schoolModel.js';
import { sendEmail, EmailTransportError } from './emailService.js';
import { renderEmailTemplate, listEmailTemplates, EMAIL_TEMPLATES } from '../templates/emails.js';
import { consumeRateLimit } from '../utils/rateLimiter.js';
import { formatCedis } from '../utils/formatters.js';
import { safeEqual } from '../utils/signatures.js';
import { checkIdempotency, rememberIdempotency } from '../utils/idempotency.js';
import {
  SECRET,
  BREVO_EVENT_SECRET,
  EMAIL_DAILY_QUOTA,
  EMAIL_JOB_CONCURRENCY,
  API_BASE_URL,
} from '../config/env.js';

const IDEMPOTENCY_HEADER = 'idempotency-key';
const MAX_SET_TIMEOUT_MS = 24 * 60 * 60 * 1000;

class ApiError extends Error {
  constructor(message, status = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Stub audit service — mirrors student.service.js / payment.service.js.
const auditService = {
  log: async ({ action, entity, entityId, userId, details }) => {
    console.log(`[AUDIT] ${action} | ${entity}:${entityId} | User:${userId} |`, details);
  },
};

// ──────────────────── Helpers ────────────────────

const startOfDay = (date = new Date()) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
};

const resolveSchoolId = (user, explicitSchoolId) => {
  if (user?.role === 'super_admin') {
    return explicitSchoolId ? new mongoose.Types.ObjectId(explicitSchoolId) : null;
  }
  return user?.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

const normaliseAddress = (address) =>
  typeof address === 'string' ? address.trim().toLowerCase() : address?.email?.trim().toLowerCase();

const isValidEmailShape = (address) =>
  typeof address === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address);

// Constant-time comparison for secrets and tokens now lives in
// utils/signatures.js, shared with the inbound webhook verifiers.

// ──────────────────── Quota ────────────────────

const getDailyUsage = async (schoolId) => {
  const filter = {
    createdAt: { $gte: startOfDay() },
    status: { $ne: 'failed' },
  };
  if (schoolId) filter.schoolId = new mongoose.Types.ObjectId(schoolId);
  return EmailMessage.countDocuments(filter);
};

const assertQuota = async (schoolId, requested) => {
  const used = await getDailyUsage(schoolId);
  const quota = EMAIL_DAILY_QUOTA;
  if (used + requested <= quota) return { used, quota, remaining: quota - used };

  // Seconds until the next 00:00 Accra reset.
  const now = new Date();
  const reset = new Date(startOfDay(now).getTime() + 24 * 60 * 60 * 1000);
  const error = new ApiError(
    `Daily sending quota exhausted (${quota} per day, ${used} used). Quota resets at ${reset.toISOString()}.`,
    429,
    'EMAIL_QUOTA_EXCEEDED'
  );
  error.retryAfter = Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 1000));
  throw error;
};

// ──────────────────── Suppression & consent ────────────────────

const loadPreferences = async (addresses) => {
  if (!addresses.length) return new Map();
  const docs = await EmailPreference.find({
    email: { $in: addresses },
  }).lean();
  return new Map(docs.map((doc) => [doc.email, doc]));
};

/**
 * A single reason per address: the strongest disqualification wins, so a job
 * reports "bounced" rather than the vaguer "unsubscribed" for the same parent.
 */
const suppressionReason = (preference) => {
  if (!preference) return null;
  if (preference.complained) return 'complained';
  if (preference.bounced) return 'bounced';
  if (preference.unsubscribed) return 'unsubscribed';
  return null;
};

const isOptedIn = (preference, type) => {
  if (!preference) return false;
  if (!preference.optInCategories?.length) return true;
  return preference.optInCategories.includes(type);
};

const bumpCounter = (reasons, key) => {
  reasons[key] = (reasons[key] || 0) + 1;
};

// ──────────────────── Unsubscribe ────────────────────

const signAddress = (email) =>
  crypto.createHmac('sha256', SECRET || 'sukuupay').update(email).digest('hex').slice(0, 32);

export const buildUnsubscribeUrl = (email) =>
  `${API_BASE_URL}/api/email/unsubscribe?email=${encodeURIComponent(email)}&token=${signAddress(email)}`;

/** Processes a List-Unsubscribe click. Idempotent — a repeat click is a no-op. */
export const processUnsubscribe = async (email, token) => {
  const address = normaliseAddress(email);
  if (!address || !isValidEmailShape(address)) {
    throw new ApiError('Invalid email address', 400, 'INVALID_EMAIL');
  }
  if (!safeEqual(token, signAddress(address))) {
    throw new ApiError('Invalid or expired unsubscribe token', 400, 'INVALID_TOKEN');
  }

  const preference = await EmailPreference.findOneAndUpdate(
    { email: address },
    { $set: { unsubscribed: true, unsubscribedAt: new Date(), lastEventAt: new Date() } },
    { new: true, upsert: true }
  );

  // Mark any in-flight message from this address as unsubscribed.
  await EmailMessage.updateMany(
    { to: address, status: { $nin: ['bounced', 'complained', 'unsubscribed', 'blocked', 'failed'] } },
    { $set: { status: 'unsubscribed' } }
  );

  return {
    email: address,
    unsubscribed: true,
    unsubscribedAt: preference.unsubscribedAt,
  };
};

// ──────────────────── Idempotency ────────────────────
// checkIdempotency / rememberIdempotency now live in utils/idempotency.js so
// the WhatsApp channel enforces the same replay rules.

// ──────────────────── Recipient resolution ────────────────────

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
    filter.studentClass = className;
  }

  if (target === 'individual') {
    if (!ids?.length) {
      throw new ApiError(
        'recipients.target "individual" requires recipients.ids',
        400,
        'RECIPIENT_IDS_REQUIRED'
      );
    }
    filter._id = { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  if (target === 'balance') {
    if (!balanceRanges?.length) {
      throw new ApiError(
        'recipients.target "balance" requires balanceRanges',
        400,
        'BALANCE_RANGES_REQUIRED'
      );
    }
    const now = new Date();
    filter.$or = balanceRanges.map((band) => {
      // "overdue" is defined by the deadline having passed, not by a balance.
      if (band === 'overdue') return { balance: { $gt: 0 }, deadline: { $lt: now } };
      const range = BALANCE_BANDS[band];
      if (!range) {
        throw new ApiError(`Unknown balance range "${band}"`, 400, 'INVALID_BALANCE_RANGE');
      }
      return { balance: range };
    });
  }

  if (hasActivePlan === true) {
    filter.paymentPlans = { $exists: true, $ne: [] };
  } else if (hasActivePlan === false) {
    filter.$or = [...(filter.$or || []), { paymentPlans: { $exists: false } }, { paymentPlans: { $size: 0 } }];
  }

  return filter;
};

/**
 * Turns a filter set into a deduplicated list of addressable parents.
 * One email per parent even when several of their children match; the first
 * matching child supplies the per-recipient variables.
 */
const resolveRecipients = async (schoolId, filters, { confirmation = 'none', type = 'general' } = {}) => {
  const studentFilter = buildStudentFilter(schoolId, filters);
  const students = await Student.find(studentFilter)
    .select('studentId studentName studentClass balance deadline payLink parents')
    .lean();

  const recipients = new Map();
  const skippedReasons = {};
  let skippedWithoutEmail = 0;

  students.forEach((student) => {
    (student.parents || []).forEach((parent) => {
      if (parent.isAlive === false) {
        bumpCounter(skippedReasons, 'inactiveGuardian');
        return;
      }

      const address = normaliseAddress(parent.email);
      if (!address || !isValidEmailShape(address)) {
        skippedWithoutEmail += 1;
        return;
      }
      if (recipients.has(address)) return;

      recipients.set(address, {
        email: address,
        name: parent.parentName || '',
        studentId: student._id,
        variables: {
          parentName: parent.parentName || '',
          studentName: student.studentName,
          studentClass: student.studentClass,
          studentId: student.studentId,
          balance: student.balance,
          deadline: student.deadline,
          payLink: student.payLink || null,
        },
      });
    });
  });

  let resolved = [...recipients.values()];

  // Suppression and consent, applied after deduplication so a parent with two
  // children is counted once.
  const preferences = await loadPreferences(resolved.map((r) => r.email));
  const kept = [];

  resolved.forEach((recipient) => {
    const preference = preferences.get(recipient.email);
    const reason = suppressionReason(preference);
    if (reason) {
      bumpCounter(skippedReasons, reason);
      return;
    }
    if (confirmation === 'opt_in' && !isOptedIn(preference, type)) {
      bumpCounter(skippedReasons, 'notOptedIn');
      return;
    }
    kept.push(recipient);
  });

  return { recipients: kept, skippedWithoutEmail, skippedReasons };
};

// ──────────────────── Rendering ────────────────────

/**
 * Produces the subject, HTML and text for one message. Either a named template
 * or a caller-supplied body; supplying both is rejected by the validation layer.
 */
const renderContent = (
  { template, variables, subject, html, text, overrideSubject },
  baseVariables = {}
) => {
  if (template) {
    const definition = EMAIL_TEMPLATES[template];
    if (!definition) {
      throw new ApiError(`Template "${template}" not found`, 404, 'EMAIL_TEMPLATE_NOT_FOUND');
    }
    if (definition.internalOnly) {
      throw new ApiError(
        `Template "${template}" is reserved for platform messages and cannot be sent from the API`,
        403,
        'EMAIL_TEMPLATE_INTERNAL'
      );
    }
    try {
      const rendered = renderEmailTemplate(template, { ...baseVariables, ...variables });
      // The template owns its subject line unless the caller explicitly opted in.
      return overrideSubject ? { ...rendered, subject } : rendered;
    } catch (error) {
      if (error.code === 'EMAIL_TEMPLATE_MISSING_VARIABLES') {
        throw new ApiError(error.message, 400, error.code);
      }
      if (error.code === 'EMAIL_TEMPLATE_MALFORMED') {
        throw new ApiError(error.message, 400, error.code);
      }
      throw error;
    }
  }

  if (!html || !text) {
    throw new ApiError(
      'A custom message requires both html and text parts',
      400,
      'EMAIL_BODY_PARTS_REQUIRED'
    );
  }

  return { subject, html, text };
};

// ──────────────────── Delivery ────────────────────

const listUnsubscribeHeaders = (to) => ({
  'List-Unsubscribe': `<${buildUnsubscribeUrl(to)}>`,
  // Lets compliant mail clients process the unsubscribe without a page load.
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
});

/**
 * Hands one persisted message to the provider and records the outcome.
 * The row already exists as `queued`, so a transport failure becomes a
 * `failed` record rather than a silent gap in the audit trail.
 */
const deliver = async (message, { subject, html, text, scheduleAt }) => {
  try {
    const result = await sendEmail({
      to: { email: message.to, name: message.parentName || undefined },
      subject,
      html,
      text,
      tags: message.type ? [message.type] : undefined,
      headers: listUnsubscribeHeaders(message.to),
      scheduledAt: scheduleAt || undefined,
    });

    message.providerMessageId = result.messageId;
    message.status = 'sent';
    message.sentAt = new Date();
    if (scheduleAt) message.scheduledAt = new Date(scheduleAt);
    await message.save();
    return { sent: true };
  } catch (error) {
    message.status = 'failed';
    message.failureReason = String(error.message || error).slice(0, 500);
    await message.save();

    if (error instanceof EmailTransportError) {
      throw new ApiError(error.message, error.status, error.code);
    }
    throw error;
  }
};

const createMessage = (fields) => {
  const { html, text, ...persisted } = fields;
  return {
    ...persisted,
    hasHtmlPart: Boolean(html),
    hasTextPart: Boolean(text),
  };
};

// ──────────────────── Single send ────────────────────

const getPrimaryParent = (student) =>
  (student?.parents || []).find((p) => p.isPrimary) || student?.parents?.[0] || null;

/**
 * Resolves the recipient list for a single send from either an explicit
 * address or a student plus a parent selector. Parent sub-documents are
 * declared with `_id: false`, so a parent is selected by position, never by id.
 */
const resolveSingleRecipients = async (data) => {
  if (data.to) {
    const address = normaliseAddress(data.to);
    if (!isValidEmailShape(address)) {
      throw new ApiError(`"${data.to}" is not a valid email address`, 400, 'INVALID_EMAIL');
    }
    return {
      resolved: [
        { email: address, name: data.toName || '', studentId: null, variables: {} },
      ],
      skippedWithoutEmail: 0,
      schoolId: null,
    };
  }

  const student = await Student.findById(data.studentId).select(
    'studentId studentName studentClass balance deadline payLink parents'
  );
  if (!student || student.deletedAt) {
    throw new ApiError('Student not found', 404, 'STUDENT_NOT_FOUND');
  }
  if (data.schoolId && student.schoolId?.toString() !== data.schoolId.toString()) {
    throw new ApiError('Student not found', 404, 'STUDENT_NOT_FOUND');
  }

  const baseVariables = {
    parentName: '',
    studentName: student.studentName,
    studentClass: student.studentClass,
    studentId: student.studentId,
    balance: student.balance,
    deadline: student.deadline,
    payLink: student.payLink || null,
  };

  const parents = student.parents || [];
  let selected;

  if (data.recipient === 'primary_indexed') {
    const index = Number(data.recipientIndex);
    selected = parents[index];
    if (!selected) {
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
  let skippedWithoutEmail = 0;

  selected.filter(Boolean).forEach((parent) => {
    const address = normaliseAddress(parent.email);
    if (!address || !isValidEmailShape(address)) {
      skippedWithoutEmail += 1;
      return;
    }
    if (resolved.some((r) => r.email === address)) return;
    resolved.push({
      email: address,
      name: parent.parentName || '',
      studentId: student._id,
      variables: { ...baseVariables, parentName: parent.parentName || '' },
    });
  });

  if (!resolved.length) {
    const who = data.recipient === 'all' ? 'The selected parents' : 'The selected parent';
    throw new ApiError(
      `${who} (${getPrimaryParent(student)?.parentName || 'unknown'}) has no email address on record. Add one via PUT /students/:id/parents/:parentId, or use POST /email/single with an explicit "to" address.`,
      400,
      'RECIPIENT_HAS_NO_EMAIL'
    );
  }

  return { resolved, skippedWithoutEmail, schoolId: student.schoolId };
};

export const sendSingleEmail = async (data, user, { idempotencyKey = null } = {}) => {
  consumeRateLimit(`email:single:${data.schoolId || user?.schoolId || 'global'}`, 60, 60_000);

  const schoolId = resolveSchoolId(user, data.schoolId);
  if (user?.role === 'super_admin' && !data.schoolId) {
    throw new ApiError('schoolId is required when sending as super_admin', 400, 'SCHOOL_ID_REQUIRED');
  }

  const payload = {
    to: data.to,
    toName: data.toName,
    studentId: data.studentId,
    recipient: data.recipient,
    recipientIndex: data.recipientIndex,
    template: data.template,
    variables: data.variables,
    subject: data.subject,
    overrideSubject: data.overrideSubject,
    html: data.html,
    text: data.text,
    scheduleAt: data.scheduleAt,
    cc: data.cc,
    bcc: data.bcc,
    type: data.type,
  };
  const replay = await checkIdempotency(idempotencyKey, 'email:single', payload);
  if (replay) return { ...replay, replayed: true };

  const { resolved, skippedWithoutEmail = 0, schoolId: studentSchoolId } =
    await resolveSingleRecipients(data);
  const effectiveSchoolId = schoolId || studentSchoolId || null;

  // Suppression applies to an explicit address too.
  const preferences = await loadPreferences(resolved.map((r) => r.email));
  const sendable = resolved.filter((recipient) => {
    const reason = suppressionReason(preferences.get(recipient.email));
    if (reason) {
      throw new ApiError(
        `This address is suppressed (${reason}) and cannot be emailed.`,
        400,
        'RECIPIENT_SUPPRESSED'
      );
    }
    return true;
  });

  const extraRecipients = [...(data.cc || []), ...(data.bcc || [])].map(normaliseAddress);
  const recipientCount = sendable.length + extraRecipients.length;
  const quota = await assertQuota(effectiveSchoolId, recipientCount);

  // Render per recipient: student-derived values differ per parent.
  const rendered = sendable.map((recipient) => ({
    recipient,
    content: renderContent(data, recipient.variables),
  }));

  const messages = [];

  for (const { recipient, content } of rendered) {
    // Persist before the provider call so a transport failure is recorded.
    const message = await EmailMessage.create(
      createMessage({
        schoolId: effectiveSchoolId,
        studentId: recipient.studentId,
        parentName: recipient.name,
        to: recipient.email,
        subject: content.subject,
        type: data.type,
        template: data.template || null,
        provider: 'brevo',
        status: 'queued',
        html: content.html,
        text: content.text,
        createdBy: user?._id || null,
      })
    );
    await deliver(message, content);
    messages.push(message);
  }

  // Cc and bcc are recorded as their own messages so the log is complete.
  for (const address of extraRecipients) {
    const first = rendered[0];
    if (!first) break;
    const isCc = (data.cc || []).some((a) => normaliseAddress(a) === address);
    const message = await EmailMessage.create(
      createMessage({
        schoolId: effectiveSchoolId,
        studentId: null,
        to: address,
        subject: first.content.subject,
        type: data.type,
        template: data.template || null,
        provider: 'brevo',
        status: 'queued',
        isCc,
        isBcc: !isCc,
        html: first.content.html,
        text: first.content.text,
        createdBy: user?._id || null,
      })
    );
    await deliver(message, first.content);
    messages.push(message);
  }

  await auditService.log({
    action: 'SEND_EMAIL',
    entity: 'EmailMessage',
    entityId: messages[0]?._id,
    userId: user?._id,
    details: {
      type: data.type,
      template: data.template,
      recipients: messages.length,
      to: messages.map((m) => m.to),
    },
  });

  const response = {
    data: messages.length === 1 ? messages[0].toJSON() : messages.map((m) => m.toJSON()),
    meta: {
      skippedWithoutEmail,
      quotaRemaining: quota.remaining - recipientCount,
    },
  };

  await rememberIdempotency(idempotencyKey, 'email:single', payload, user?._id, response);
  return response;
};

// ──────────────────── Bulk send ────────────────────

const MAX_BULK_RECIPIENTS = 5000;

export const sendBulkEmail = async (schoolIdParam, data, user, { idempotencyKey = null } = {}) => {
  // A non-super-admin may only target their own school. Silently falling back
  // to the caller's school would send to the wrong audience.
  if (
    schoolIdParam &&
    user?.role !== 'super_admin' &&
    user?.schoolId &&
    String(user.schoolId) !== String(schoolIdParam)
  ) {
    throw new ApiError('You do not have access to this school', 403, 'SCHOOL_ACCESS_DENIED');
  }

  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) {
    throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');
  }
  consumeRateLimit(`email:bulk:${schoolId}`, 5, 60 * 60 * 1000);

  const school = await School.findById(schoolId).select('name').lean();
  if (!school) throw new ApiError('School not found', 404, 'SCHOOL_NOT_FOUND');

  const payload = {
    schoolId: schoolIdParam,
    template: data.template,
    variables: data.variables,
    subject: data.subject,
    overrideSubject: data.overrideSubject,
    html: data.html,
    text: data.text,
    scheduleAt: data.scheduleAt,
    recipients: data.recipients,
    type: data.type,
    class: data.class,
    balanceRanges: data.balanceRanges,
    hasActivePlan: data.hasActivePlan,
    status: data.status,
    confirmation: data.confirmation,
  };
  const replay = await checkIdempotency(idempotencyKey, 'email:bulk', payload);
  if (replay) return { ...replay, replayed: true };

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

  const { recipients, skippedWithoutEmail, skippedReasons } = await resolveRecipients(
    schoolId,
    filters,
    { confirmation: data.confirmation, type: data.type }
  );

  const matchedParents = recipients.length + Object.values(skippedReasons).reduce((a, b) => a + b, 0);

  if (!recipients.length) {
    throw new ApiError(
      matchedParents
        ? `Broadcast resolves to 0 parents with a deliverable email address. ${matchedParents} parents matched the filters but none can be emailed.`
        : 'Broadcast resolves to 0 parents. Relax the filters and try again.',
      400,
      'NO_ADDRESSABLE_RECIPIENTS'
    );
  }

  if (recipients.length > MAX_BULK_RECIPIENTS) {
    throw new ApiError(
      `Broadcast resolves to ${recipients.length} parents, above the ${MAX_BULK_RECIPIENTS} limit. Narrow the filters and try again.`,
      400,
      'BULK_RECIPIENT_LIMIT'
    );
  }

  const quota = await assertQuota(schoolId, recipients.length);

  // Merge school-wide values into each recipient's variables.
  const snapshot = recipients.map((recipient) => ({
    email: recipient.email,
    name: recipient.name,
    studentId: recipient.studentId,
    variables: { schoolName: school.name, ...recipient.variables },
  }));

  const job = await EmailJob.create({
    schoolId,
    channel: 'email',
    template: data.template || null,
    type: data.type,
    // Shared broadcast values; the worker merges these with each recipient's
    // own variables at render time.
    variables: data.variables || {},
    subject: data.subject || null,
    overrideSubject: Boolean(data.overrideSubject),
    customHtml: data.html || null,
    customText: data.text || null,
    status: data.scheduleAt ? 'queued' : 'processing',
    filters: {
      target: filters.target,
      class: filters.class || null,
      balanceRanges: filters.balanceRanges || null,
      hasActivePlan: filters.hasActivePlan ?? null,
      status: filters.status || null,
      confirmation: data.confirmation,
    },
    recipientsResolved: snapshot.length,
    recipientsSkipped: Object.values(skippedReasons).reduce((a, b) => a + b, 0),
    skippedWithoutEmail,
    skippedReasons,
    quotaRemainingBefore: quota.remaining,
    scheduledAt: data.scheduleAt ? new Date(data.scheduleAt) : null,
    recipientsSnapshot: snapshot,
    createdBy: user._id,
  });

  await auditService.log({
    action: 'BULK_EMAIL',
    entity: 'EmailJob',
    entityId: job._id,
    userId: user._id,
    details: {
      template: data.template,
      type: data.type,
      recipientsResolved: snapshot.length,
      skippedWithoutEmail,
    },
  });

  // Fire and forget: the HTTP response must not wait on delivery.
  dispatchEmailJob(job, data.scheduleAt).catch((error) => {
    console.error('[EMAIL-JOB] Unhandled failure:', error.message);
  });

  // `jobId` is the documented field (§3) that clients pass to
  // GET /email/jobs/:jobId; the rest of the job summary rides along.
  const response = { data: { ...job.toJSON(), jobId: job._id.toString() } };
  await rememberIdempotency(idempotencyKey, 'email:bulk', payload, user._id, response);
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
const dispatchEmailJob = async (job, scheduleAt) => {
  if (!scheduleAt) {
    await runEmailJob(job._id);
    return;
  }

  const delay = new Date(scheduleAt).getTime() - Date.now();
  if (delay <= 0) {
    await runEmailJob(job._id);
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
    runEmailJob(job._id).catch((error) => {
      console.error(`[EMAIL-JOB] Scheduled job ${job._id} failed:`, error.message);
    });
  }, delay);
};

/**
 * Runs an accepted job. Invoked in-process; `EMAIL_JOB_CONCURRENCY` messages
 * are in flight at once, and cancellation is checked between batches.
 */
export const runEmailJob = async (jobId) => {
  const job = await EmailJob.findById(jobId).select(
    '+recipientsSnapshot +customHtml +customText'
  );
  if (!job) return null;
  if (!['queued', 'processing'].includes(job.status)) return job;

  job.status = 'processing';
  job.startedAt = job.startedAt || new Date();
  await job.save();

  const snapshot = job.recipientsSnapshot || [];
  const tally = { total: snapshot.length, sent: 0, failed: 0 };
  const concurrency = Math.max(1, Number(EMAIL_JOB_CONCURRENCY) || 3);
  let cancelled = false;

  for (let index = 0; index < snapshot.length; index += concurrency) {
    // Cooperative cancellation: stop between batches, never mid-flight.
    const current = await EmailJob.findById(jobId).select('status');
    if (current?.status === 'cancelling' || current?.status === 'cancelled') {
      cancelled = true;
      break;
    }

    const batch = snapshot.slice(index, index + concurrency);

    await Promise.all(
      batch.map(async (entry) => {
        let content;
        try {
          content = renderContent(
            {
              template: job.template,
              variables: job.variables || {},
              subject: job.subject,
              overrideSubject: job.overrideSubject,
              html: job.customHtml,
              text: job.customText,
            },
            entry.variables
          );
        } catch (error) {
          // A per-recipient render failure must not abort the whole run.
          await EmailMessage.create(
            createMessage({
              schoolId: job.schoolId,
              studentId: entry.studentId,
              parentName: entry.name,
              to: entry.email,
              subject: job.subject || 'Message could not be rendered',
              type: job.type,
              template: job.template,
              status: 'failed',
              failureReason: String(error.message).slice(0, 500),
              jobId: job._id,
              createdBy: job.createdBy,
            })
          );
          tally.failed += 1;
          return;
        }

        const message = await EmailMessage.create(
          createMessage({
            schoolId: job.schoolId,
            studentId: entry.studentId,
            parentName: entry.name,
            to: entry.email,
            subject: content.subject,
            type: job.type,
            template: job.template,
            status: 'queued',
            jobId: job._id,
            html: content.html,
            text: content.text,
            createdBy: job.createdBy,
          })
        );

        try {
          await deliver(message, content);
          tally.sent += 1;
        } catch {
          // deliver() already recorded the failure on the message.
          tally.failed += 1;
        }
      })
    );

    // Checkpoint progress rather than writing on every message.
    job.progressPercent = Math.round(((index + batch.length) / snapshot.length) * 100);
    await job.save();
  }

  // aggregate returns every status group; the first element alone is one row.
  const byStatus = await EmailMessage.aggregate([
    { $match: { jobId: job._id } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const result = Object.fromEntries((byStatus || []).map((row) => [row._id, row.count]));
  result.total = snapshot.length;

  job.result = result;
  job.progressPercent = 100;
  job.status = cancelled ? 'cancelled' : 'completed';
  job.completedAt = new Date();
  if (cancelled) job.cancelledAt = new Date();
  await job.save();

  return job;
};

// ──────────────────── Job read / cancel ────────────────────

export const getEmailJob = async (jobId, user) => {
  const schoolId = resolveSchoolId(user);
  const filter = { _id: jobId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;

  const job = await EmailJob.findOne(filter);
  if (!job) throw new ApiError('Bulk email job not found', 404, 'JOB_NOT_FOUND');
  return job.toJSON();
};

export const cancelEmailJob = async (jobId, data, user) => {
  const schoolId = resolveSchoolId(user);
  consumeRateLimit(`email:cancel:${schoolId || 'global'}`, 5, 60 * 60 * 1000);

  const filter = { _id: jobId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;

  const job = await EmailJob.findOne(filter);
  if (!job) throw new ApiError('Bulk email job not found', 404, 'JOB_NOT_FOUND');

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

  await auditService.log({
    action: 'CANCEL_EMAIL_JOB',
    entity: 'EmailJob',
    entityId: job._id,
    userId: user._id,
    details: { reason: data.reason || '' },
  });

  return {
    jobId: job._id,
    status: job.status,
    cancellationReason: job.cancellationReason,
    cancelledAt: job.cancelledAt,
    result: job.result,
  };
};

// ──────────────────── History ────────────────────

export const getEmailHistory = async (query, user) => {
  const schoolId = resolveSchoolId(user, query.schoolId);
  const filter = { deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;

  if (query.studentId) filter.studentId = new mongoose.Types.ObjectId(query.studentId);
  if (query.to) filter.to = normaliseAddress(query.to);
  if (query.status && query.status !== 'all') filter.status = query.status;
  if (query.type && query.type !== 'all') filter.type = query.type;
  if (query.template) filter.template = query.template;
  if (query.jobId) filter.jobId = new mongoose.Types.ObjectId(query.jobId);
  if (query.hasBounce) filter.status = { $in: ['bounced', 'soft_bounced'] };

  if (query.from || query.toDate) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.toDate) filter.createdAt.$lte = new Date(query.toDate);
  }

  if (query.search) {
    const pattern = new RegExp(escapeRegExp(query.search), 'i');
    filter.$or = [{ subject: pattern }, { to: pattern }];
  }

  const page = Number(query.page) || 1;
  const perPage = Number(query.perPage) || 20;
  const skip = (page - 1) * perPage;
  const sortBy = query.sortBy || 'createdAt';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

  const [messages, total, summaryRows] = await Promise.all([
    EmailMessage.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(perPage)
      .lean(),
    EmailMessage.countDocuments(filter),
    EmailMessage.aggregate([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  // Summary covers the whole filtered set, not just this page, so a bounce
  // dashboard can be drawn from one request.
  const summary = summaryRows.reduce(
    (acc, row) => ({ ...acc, [row._id]: row.count }),
    {}
  );

  return {
    data: messages,
    meta: { page, perPage, total, totalPages: Math.ceil(total / perPage), summary },
  };
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ──────────────────── Provider events ────────────────────

/**
 * Brevo event name -> our internal status. The keys are the provider's wire
 * names ("opened", "clicked"), not our status names; a mismatch here silently
 * discards every event rather than erroring.
 */
const EVENT_TO_STATUS = {
  delivered: 'delivered',
  deferred: 'deferred',
  opened: 'opened',
  clicked: 'clicked',
  spam: 'complained',
  unsubscribed: 'unsubscribed',
  blocked: 'blocked',
  hard_bounce: 'bounced',
  soft_bounce: 'soft_bounced',
};

// Once an address is permanently undeliverable, later engagement events must
// not move the status backwards.
const TERMINAL_STATUSES = ['bounced', 'complained', 'unsubscribed', 'blocked', 'failed'];

const applySuppression = async (address, field) => {
  try {
    await EmailPreference.updateOne(
      { email: address },
      { $set: { [field]: true, [`${field}At`]: new Date(), lastEventAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    // Suppression failing must not lose the delivery event itself.
    console.error('[EMAIL-WEBHOOK] Suppression write failed:', error.message);
  }
};

/**
 * Brevo posts one transactional event per request using snake_case keys, but
 * also emits `events: []` batches for some campaign callbacks. Both are
 * accepted and folded into the single internal shape the rest of this module
 * and the Joi schema speak. Anything without a usable type or id is dropped
 * here rather than reaching the status update.
 */
const normaliseProviderEvent = (raw) => {
  if (!raw || typeof raw !== 'object') return null;

  const type = typeof raw.event === 'string' ? raw.event.trim().toLowerCase() : '';
  const messageId = raw.messageId ?? raw.message_id;
  if (!type || messageId === undefined || messageId === null || messageId === '') return null;

  const reason = raw.reason ?? (raw.reasonCode ? String(raw.reasonCode) : undefined);
  const url = raw.url ?? raw.link;

  // Optional fields are omitted rather than set to undefined, so the normalised
  // event has exactly the keys the provider actually supplied.
  const event = { messageId: String(messageId), event: type };
  if (raw.date !== undefined && raw.date !== null) event.date = raw.date;
  if (reason !== undefined && reason !== null) event.reason = String(reason);
  if (url !== undefined && url !== null) event.url = String(url);
  if (raw.ip !== undefined && raw.ip !== null) event.ip = String(raw.ip);

  return event;
};

// Exported for unit tests: the wire-format handling is the easiest part of this
// module to regress silently, because a wrong shape simply stops updating
// statuses rather than raising an error.
export const normaliseProviderPayload = (payload) => {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.events) ? payload.events : [payload];
  return { events: list.map(normaliseProviderEvent).filter(Boolean) };
};

/**
 * Applies Brevo transactional events.
 *
 * Open and click can each fire many times, so only the first occurrence sets a
 * timestamp. Answers "processed" regardless of how many references were
 * recognised: the provider retries non-2xx responses, and retrying an event for
 * a message this platform does not have achieves nothing.
 */
export const handleProviderEvents = async (payload, providedSecret) => {
  if (!BREVO_EVENT_SECRET) {
    throw new ApiError(
      'Event processing is unavailable: BREVO_EVENT_SECRET is not configured',
      500,
      'EMAIL_WEBHOOK_DISABLED'
    );
  }
  if (!safeEqual(providedSecret, BREVO_EVENT_SECRET)) {
    throw new ApiError('Invalid webhook secret', 401, 'INVALID_WEBHOOK_SECRET');
  }

  const { events } = normaliseProviderPayload(payload);
  if (!events.length) {
    throw new ApiError(
      'A non-empty events array is required, with an event type and a message id',
      400,
      'INVALID_WEBHOOK_PAYLOAD'
    );
  }

  let processed = 0;
  let updated = 0;

  for (const event of events) {
    processed += 1; // every well-formed event is acknowledged, known or not
    const status = EVENT_TO_STATUS[event?.event];
    if (!status) continue; // an event type this platform does not map

    const message = await EmailMessage.findOne({
      provider: 'brevo',
      providerMessageId: event.messageId,
    });
    if (!message) {
      continue;
    }

    const when = event.date ? new Date(event.date) : new Date();
    const isTerminal = TERMINAL_STATUSES.includes(message.status);
    const set = {};

    if (status === 'opened' || status === 'clicked') {
      if (status === 'opened' && !message.openedAt) set.openedAt = when;
      if (status === 'clicked' && !message.firstClickedAt) {
        set.firstClickedAt = when;
        if (event.url) set.firstClickedUrl = event.url;
      }
      // Engagement never upgrades a permanently-failed message.
      if (!isTerminal) set.status = status;
    } else {
      set.status = status;
      if (status === 'delivered') set.deliveredAt = message.deliveredAt || when;
      if (status === 'bounced' || status === 'soft_bounced') {
        set.bounceType = status === 'bounced' ? 'hard' : 'soft';
        if (event.reason) set.failureReason = String(event.reason).slice(0, 500);
      }
      if (event.reason && !['bounced', 'soft_bounced'].includes(status)) {
        set.failureReason = String(event.reason).slice(0, 500);
      }
    }

    if (Object.keys(set).length) {
      message.set(set);
      await message.save();
      updated += 1;
    }

    // Hard bounces and spam complaints suppress the address platform-wide.
    if (status === 'bounced') await applySuppression(message.to, 'bounced');
    if (status === 'complained') await applySuppression(message.to, 'complained');
    if (status === 'unsubscribed') await applySuppression(message.to, 'unsubscribed');
  }

  return { received: true, processed, updated };
};

// ──────────────────── Templates ────────────────────

export const getEmailTemplates = ({ includeInternal = false } = {}) =>
  listEmailTemplates({ includeInternal });

// ──────────────────── Reminder integration (internal) ────────────────────

/**
 * Used by the payment-plan and payment modules to notify a parent by email
 * when a parent record has one. Never throws — email is a best-effort
 * secondary channel and must not roll back a business operation.
 */
export const sendTemplatedEmailBestEffort = async ({
  schoolId,
  studentId,
  to,
  toName,
  template,
  variables,
  type = 'general',
}) => {
  try {
    if (!to || !isValidEmailShape(normaliseAddress(to))) return { sent: false };
    const schoolIdResolved = schoolId ? new mongoose.Types.ObjectId(schoolId) : null;
    if (schoolIdResolved) {
      const preferences = await loadPreferences([normaliseAddress(to)]);
      if (suppressionReason(preferences.get(normaliseAddress(to)))) return { sent: false };
      const used = await getDailyUsage(schoolIdResolved);
      if (used >= EMAIL_DAILY_QUOTA) return { sent: false };
    }

    const content = renderEmailTemplate(template, variables);
    const message = await EmailMessage.create(
      createMessage({
        schoolId: schoolIdResolved,
        studentId: studentId || null,
        parentName: toName || '',
        to: normaliseAddress(to),
        subject: content.subject,
        type,
        template,
        status: 'queued',
        html: content.html,
        text: content.text,
      })
    );
    await deliver(message, content);
    return { sent: true, id: message._id };
  } catch (error) {
    console.error(`[EMAIL] Best-effort send to ${to} failed:`, error.message);
    return { sent: false, reason: error.message };
  }
};

export { ApiError, formatCedis };
