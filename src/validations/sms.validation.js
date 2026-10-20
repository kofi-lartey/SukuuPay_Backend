import Joi from 'joi';
import {
  LIMITS,
  SMS_AUDIENCE_TYPES,
  SMS_CATEGORIES,
  SMS_DELIVERY_STATUSES,
  SMS_JOB_STATUSES,
  SMS_TOKENS,
} from '../config/constants.js';

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

const studentIdParam = objectId.required().messages({
  'string.pattern.base': 'Invalid student ID format',
});

const schoolIdParam = objectId.required().messages({
  'string.pattern.base': 'Invalid school ID format',
});

const jobIdParam = objectId.required().messages({
  'string.pattern.base': 'Invalid job ID format',
});

const templateIdParam = objectId.required().messages({
  'string.pattern.base': 'Invalid template ID format',
});

/**
 * A body with `{token}` placeholders, not `{{token}}`.
 *
 * The single braces are deliberate and are what the seeded presets use. GSM-7
 * charging counts braces like any other character, and every send is billed per
 * part, so a two-character token delimiter is two characters of the school's
 * money on every message. Double braces also collide with the WhatsApp
 * `{{variable}}` convention used elsewhere in the platform, and a bursar copying
 * a body between the two modules should not silently change its meaning.
 */
const messageBody = Joi.string().trim().min(1).max(LIMITS.MAX_SMS_PARTS * 160).messages({
  'string.empty': 'A message body is required',
  'string.max': `Message body may not exceed ${LIMITS.MAX_SMS_PARTS * 160} characters`,
});

const isoDate = Joi.date().iso().messages({
  'date.format': 'Use an ISO 8601 date',
});

/**
 * A future timestamp, at most `MAX_SMS_SCHEDULE_DAYS` out.
 *
 * Written as a custom rule rather than `.min('now').max('now', { offset })`
 * because of two things Joi does that look correct and are not. The `offset`
 * option belongs to `number` and `string`; on `date` it is ignored, and `max`
 * then compares against *now* — so every schedule in the future is rejected and
 * the feature is dead rather than visibly broken. And this Joi version accepts
 * neither `Joi.date('now').plus({ days: 14 })` nor a function reference for a
 * date bound.
 *
 * A custom rule also runs per request, so the window is measured from the moment
 * of validation rather than from when this module was imported — a long-lived
 * process must not keep a ceiling it computed at boot.
 */
const scheduledWithinWindow = (value, helpers) => {
  if (value === undefined) return value;

  const at = new Date(value).getTime();
  const now = Date.now();

  if (Number.isNaN(at)) return helpers.message({ custom: 'Use an ISO 8601 date' });
  if (at <= now) return helpers.message({ custom: 'scheduledAt must be in the future' });

  const ceiling = now + LIMITS.MAX_SMS_SCHEDULE_DAYS * 24 * 60 * 60 * 1000;
  if (at > ceiling) {
    return helpers.message({
      custom: `scheduledAt cannot be more than ${LIMITS.MAX_SMS_SCHEDULE_DAYS} days away`,
    });
  }

  return value;
};

// ──────────────────── Audience ────────────────────

/**
 * The audience, as one shape regardless of which rule was chosen.
 *
 * All the fields are optional at the Joi level and required *conditionally* by
 * `assertAudience`, because the rule is which one matters. Validating "class
 * requires class" with plain Joi means an `.when()` on a field that may not
 * exist, which produces the wrong error message — "class is required" said to
 * someone who sent `audience: { type: "class" }` with the class present, but
 * under the wrong casing of the rule.
 *
 * It is a plain object schema and not one with `.custom()` attached, because Joi
 * will not nest a customised schema as an object key — `Joi.object({ audience:
 * customSchema })` throws "Object schema cannot be a joi schema". The
 * cross-field check therefore lives in the parent schemas, below.
 */
const audience = Joi.object({
  type: Joi.string().valid(...SMS_AUDIENCE_TYPES).required(),

  // `class`, `classes` — a grade, or several. Accepts one or many because a
  // broadcast to "JHS 2A and 3B" is one send, and a client that had to split it
  // would be building several jobs where the school asked for one.
  class: Joi.alternatives()
    .try(Joi.string().trim().max(60), Joi.array().items(Joi.string().trim().max(60)).max(50))
    .optional(),

  // Explicit recipients. Bounded by MAX_SMS_SEND_BATCH because this is the only
  // audience rule that scales with the request body; "all owing" is resolved
  // server-side from a query and can be a school of 10,000.
  studentIds: Joi.array().items(objectId).max(LIMITS.MAX_SMS_SEND_BATCH).optional(),

  // Minimum balance, in pesewas. Default 1 rather than "any", because the whole
  // point of the module is reminding people who owe — a message to a parent
  // whose account is square is a support ticket.
  minBalance: Joi.number().integer().min(0).default(1),

  // `overdue`: days past `student.deadline`. `installment_due_soon`: days ahead
  // of the next tranche's due date. `at_risk`: the horizon for the tranche
  // branch, same field. All counted in whole days so a parent is not labelled
  // overdue at 09:00 on the due date.
  overdueDays: Joi.number().integer().min(0).max(365).default(30),
  dueSoonDays: Joi.number().integer().min(1).max(90).default(5),

  // The statutory grace period, in days, that `overdue` respects. Ghana's is 30
  // under the 1998 Act, but a school may have been more lenient in practice, and
  // the audience picker must be able to reproduce what the bursar remembers
  // being told rather than what the law says.
  gracePeriodDays: Joi.number().integer().min(0).max(180).default(30),

  // Suppress parents who paid anything — a part payment — in the last N hours.
  // The reason this exists: sending a "you owe GHC 550" to a parent who paid
  // GHC 500 an hour ago is how a school loses the trust the reminder was meant
  // to spend.
  excludeRecentPayers: Joi.boolean().default(false),
  recentPaymentWindowHours: Joi.number().integer().min(1).max(720).default(48),

  // `all`: include students with nothing outstanding. Off for the other rules,
  // where a zero balance contradicts the rule itself.
  includeZeroBalance: Joi.boolean().default(false),
});

/** `audience` is the audience's own name in an error, never `any`. */
const AUDIENCE = 'audience';

/**
 * Cross-field rules for the audience, shared by the preview and the send.
 *
 * Returns an error string or null, rather than a Joi helper, so the same check
 * serves both schemas without a second copy drifting from the first.
 */
const assertAudience = (value) => {
  const audience_ = value?.audience;
  if (!audience_) return null;

  if (audience_.type === 'class' && !(audience_.class || audience_.classes)) {
    return `${AUDIENCE}.type "class" requires a class name`;
  }
  if (audience_.type === 'students' && !audience_.studentIds?.length) {
    return `${AUDIENCE}.type "students" requires studentIds`;
  }

  // A zero-balance run wastes a school's credit and every recipient's patience.
  // The rules that *mean* "people who owe" must therefore be paired with a
  // positive floor — checked as a positive floor rather than as "not zero",
  // because a negative `minBalance` is also a broadcast to everyone.
  const owesMoney = ['all_owing', 'overdue', 'installment_due_soon', 'at_risk'].includes(
    audience_.type
  );
  const hasPositiveFloor = audience_.minBalance >= 1 && !audience_.includeZeroBalance;

  if (owesMoney && !hasPositiveFloor) {
    return `${AUDIENCE}.type "${audience_.type}" requires a positive minBalance — use ${AUDIENCE}.type "all" with includeZeroBalance to message settled students`;
  }
  if (audience_.type === 'all' && hasPositiveFloor) {
    return `${AUDIENCE}.type "all" requires includeZeroBalance or minBalance 0`;
  }

  return null;
};

export const previewAudienceSchema = Joi.object({
  schoolId: objectId.optional(),
  audience: audience.required().messages({ 'any.required': `${AUDIENCE} is required` }),
}).custom((value, helpers) => {
  const problem = assertAudience(value);
  return problem ? helpers.message({ custom: problem }) : value;
});

// `studentId` in the path, for send and preview alike. Named for the send route's
// historic query and reused by the preview route, which takes the same path.
export const smsSendParamSchema = Joi.object({
  studentId: studentIdParam,
});

// The preview's own query: an optional body or template, since the point is to
// cost a draft before it becomes a send.
export const previewSmsQuerySchema = Joi.object({
  body: messageBody.optional(),
  templateId: objectId.optional(),
}).or('body', 'templateId');

// ──────────────────── Send ────────────────────

export const sendSmsSchema = Joi.object({
  // Which parents on the record to reach. `primary_indexed` selects by position
  // because parent sub-documents carry no stable ordinal in practice; prefer
  // `parentId` where the caller has it.
  recipient: Joi.string().valid('primary', 'all', 'parentId', 'primary_indexed').default('primary'),
  parentId: objectId.optional(),
  recipientIndex: Joi.number().integer().min(0).max(20).optional(),

  // Overrides the number resolved from the student record. Needed for a parent
  // whose number is on file in a format that will not normalise, and for the
  // send-to-self test, which is not a student at all.
  to: Joi.string().trim().min(3).max(24).pattern(/^[+\d][\d\s()-]*$/).optional(),

  body: messageBody.optional(),
  templateId: objectId.optional(),

  // The business category. Defaults to the template's own, so a school sending
  // "Final Warning" does not also have to say it is a final warning.
  category: Joi.string().valid(...SMS_CATEGORIES).optional(),

  schoolId: objectId.optional(),

  // A test goes to a number the school controls, is not billed, and is excluded
  // from delivery statistics. It cannot be batched, and it cannot be scheduled.
  isTest: Joi.boolean().default(false),

  // Accepted by the shape, refused by the custom rule below. A single send is
  // always immediate; the schema says so with the endpoint that *can* schedule,
  // rather than reporting a type error and leaving the caller to guess.
  scheduledAt: Joi.date().iso().optional(),
}).custom((value, helpers) => {
  if (!value.body && !value.templateId) {
    return helpers.message({ custom: 'Provide either a body or a templateId' });
  }
  if (value.body && value.templateId) {
    return helpers.message({ custom: 'Provide either a body or a templateId, not both' });
  }
  if (value.recipient === 'parentId' && !value.parentId) {
    return helpers.message({ custom: 'recipient "parentId" requires parentId' });
  }
  if (value.recipient === 'primary_indexed' && value.recipientIndex === undefined) {
    return helpers.message({ custom: 'recipient "primary_indexed" requires recipientIndex' });
  }
  if (value.recipient === 'all' && value.scheduledAt) {
    return helpers.message({ custom: 'A scheduled send to multiple parents is not supported; use the bulk endpoint' });
  }
  // A single send is always immediate. Caught here rather than in the service so
  // the message names the endpoint that can schedule, and it is caught *before*
  // any credit is reserved — the service keeps the same check as a backstop, but
  // a schema rejection costs nothing and a service rejection has already done
  // work.
  if (value.scheduledAt) {
    return helpers.message({
      custom: 'A single send cannot be scheduled. Use POST /sms/bulk, which reserves credit at acceptance and releases it if the run fails.',
    });
  }
  return value;
});

// ──────────────────── Bulk send ────────────────────

export const bulkSendSchema = Joi.object({
  schoolId: objectId.optional(),
  audience: audience.required().messages({ 'any.required': `${AUDIENCE} is required` }),
  body: messageBody.optional(),
  templateId: objectId.optional(),
  category: Joi.string().valid(...SMS_CATEGORIES).optional(),

  // The cap the confirmation dialog states. The service refuses a broadcast
  // larger than it, so a school that somehow ends up selecting every student in
  // the country cannot queue 10,000 sends from one click.
  maxRecipients: Joi.number().integer().min(1).max(LIMITS.MAX_SMS_JOB_BATCH).optional(),

  // Up to LIMITS.MAX_SMS_SCHEDULE_DAYS ahead. Past that the "send later"
  // affordance becomes a calendar entry in a costume, and the balance quoted at
  // scheduling will be stale by the time the run fires.
  scheduledAt: Joi.date().iso().optional().custom(scheduledWithinWindow),

  // Required before a whole-school broadcast goes out. This is the confirmation
  // that the bursar read the recipient count, not a per-student consent.
  confirmBroadcast: Joi.boolean().default(false),
}).custom((value, helpers) => {
  if (!value.body && !value.templateId) {
    return helpers.message({ custom: 'Provide either a body or a templateId' });
  }
  if (value.body && value.templateId) {
    return helpers.message({ custom: 'Provide either a body or a templateId, not both' });
  }
  const audienceProblem = assertAudience(value);
  if (audienceProblem) return helpers.message({ custom: audienceProblem });
  // Only a whole-roster broadcast needs the explicit acknowledgement. "Overdue
  // only" to 87 people is the ordinary case and a confirmation dialog for every
  // one of them would train a bursar to click through it.
  if (value.audience?.type === 'all' && !value.confirmBroadcast) {
    return helpers.message({ custom: 'A whole-school broadcast requires confirmBroadcast' });
  }
  return value;
});

// ──────────────────── Job control ────────────────────

export const smsJobParamSchema = Joi.object({
  jobId: jobIdParam,
});

export const cancelSmsJobSchema = Joi.object({
  reason: Joi.string().trim().max(300).optional().default(''),
});

export const listJobsQuerySchema = Joi.object({
  schoolId: objectId.optional(),
  status: Joi.string()
    .valid(...SMS_JOB_STATUSES, 'all')
    .default('all'),
  category: Joi.string().valid(...SMS_CATEGORIES, 'all').default('all'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(LIMITS.MAX_NOTIFICATIONS_PAGE).default(20),
}).custom((value, helpers) => {
  if (value.from && value.to && new Date(value.from) > new Date(value.to)) {
    return helpers.message({ custom: 'from cannot be later than to' });
  }
  return value;
});

// ──────────────────── History ────────────────────

export const listMessagesQuerySchema = Joi.object({
  schoolId: objectId.optional(),
  status: Joi.string()
    .valid(...SMS_DELIVERY_STATUSES, 'all')
    .default('all'),
  category: Joi.string().valid(...SMS_CATEGORIES, 'all').default('all'),
  jobId: objectId.optional(),
  studentId: objectId.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  search: Joi.string().trim().max(120).optional(),
  // Test sends are excluded by default: they are the school's own number, and a
  // history that counts them makes a school's delivery rate meaningless.
  includeTest: Joi.boolean().default(false),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(LIMITS.MAX_NOTIFICATIONS_PAGE).default(20),
}).custom((value, helpers) => {
  if (value.from && value.to && new Date(value.from) > new Date(value.to)) {
    return helpers.message({ custom: 'from cannot be later than to' });
  }
  return value;
});

// ──────────────────── Templates ────────────────────

export const templateParamSchema = Joi.object({
  templateId: templateIdParam,
});

const templateBody = Joi.object({
  // What the composer shows. Derived into `key` when one is not given.
  name: Joi.string().trim().min(1).max(120).required(),

  // The machine form. Optional because it is almost always derived from `name`;
  // accepted so an integration can pin a key the frontend cannot change later.
  key: Joi.string().trim().lowercase().pattern(/^[a-z0-9_]+$/).max(80).optional(),

  description: Joi.string().trim().max(300).optional(),
  category: Joi.string().valid(...SMS_CATEGORIES).default('custom'),
  body: messageBody.required(),

  schoolId: objectId.optional(),

  // Only meaningful on the four seeded presets, where it tells the UI which
  // token rows to mark. Accepted on any template and stored, because a school
  // writing its own copy may still want the same emphasis in its composer.
  requiredTokens: Joi.array()
    .items(Joi.string().valid(...SMS_TOKENS))
    .max(SMS_TOKENS.length)
    .optional()
    .default([]),
});

// No `.custom()` here, and no re-wrapping in `Joi.object(...)`: `templateBody`
// is already the object schema, and passing a schema where Joi expects a map of
// key → schema is what makes it throw "Object schema cannot be a joi schema".
//
// The one rule this schema really has — that the body's `{tokens}` are all real
// — is checked in the service, where the token vocabulary and the "which token
// is wrong" message already live together. Joi is given the shape; the semantics
// are the service's.
export const createTemplateSchema = templateBody;

export const updateTemplateSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).optional(),
  description: Joi.string().trim().max(300).optional(),
  category: Joi.string().valid(...SMS_CATEGORIES).optional(),
  body: messageBody.optional(),
  requiredTokens: Joi.array()
    .items(Joi.string().valid(...SMS_TOKENS))
    .max(SMS_TOKENS.length)
    .optional(),
}).min(1).messages({ 'object.min': 'Provide at least one field to update' });

export const listTemplatesQuerySchema = Joi.object({
  schoolId: objectId.optional(),
  category: Joi.string().valid(...SMS_CATEGORIES, 'all').default('all'),
  // A school's own templates only, excluding the four platform presets. This is
  // what the composer's "Saved" section asks for.
  own: Joi.boolean().default(false),
  includeDeleted: Joi.boolean().default(false),
});

export const previewTemplateSchema = Joi.object({
  schoolId: objectId.optional(),
  body: messageBody.optional(),
  templateId: objectId.optional(),
  // Supplies the values a preview needs without needing a real student, so the
  // composer can render a new template before saving it.
  sample: Joi.object().unknown(true).optional(),
}).custom((value, helpers) => {
  if (!value.body && !value.templateId) {
    return helpers.message({ custom: 'Provide either a body or a templateId' });
  }
  return value;
});

// ──────────────────── Credits ────────────────────

export const creditsParamSchema = Joi.object({
  schoolId: schoolIdParam,
});

export const topUpCreditsSchema = Joi.object({
  schoolId: objectId.optional(),
  units: Joi.number().integer().min(1).max(LIMITS.MAX_SMS_CREDIT_TOP_UP_UNITS).required(),
  amountPes: Joi.number().integer().min(0).optional(),
  provider: Joi.string().trim().max(40).optional(),
  reference: Joi.string().trim().max(200).optional(),
  note: Joi.string().trim().max(300).optional(),
});

// ──────────────────── Delivery reports ────────────────────
// The provider's own field names, read from the body by the callback. `unknown`
// keys are stripped, which is what the schema is for: a provider that adds a
// field must not start failing validation on it.

export const smsDlrSchema = Joi.object({
  // Arkesel repeats a batch either as a bare array or under one of these keys.
  Data: Joi.array().items(Joi.object().unknown(true)).optional(),
  data: Joi.array().items(Joi.object().unknown(true)).optional(),
  reports: Joi.array().items(Joi.object().unknown(true)).optional(),
  Reports: Joi.array().items(Joi.object().unknown(true)).optional(),
  messages: Joi.array().items(Joi.object().unknown(true)).optional(),
  Messages: Joi.array().items(Joi.object().unknown(true)).optional(),
  results: Joi.array().items(Joi.object().unknown(true)).optional(),
  // A single report, under any of the names providers use.
  message_id: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
  id: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
  status: Joi.string().optional(),
  code: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
  description: Joi.string().optional(),
  network: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
  destination: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
  msisdn: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
  to: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
  timestamp: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
}).unknown(true);
