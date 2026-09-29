import Joi from 'joi';
import {
  LIMITS,
  WHATSAPP_MESSAGE_KINDS,
  WHATSAPP_MESSAGE_STATUSES,
  WHATSAPP_MESSAGE_TYPES,
  WHATSAPP_TEMPLATE_CATEGORIES,
  WHATSAPP_TEMPLATE_STATUSES,
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

// Meta accepts a phone in any national or E.164 form; normalisation and the
// real validity check happen in the service, which can explain *why* a number
// is unusable. Here only obviously wrong input is rejected.
const phoneNumber = Joi.string()
  .trim()
  .min(3)
  .max(24)
  .pattern(/^[+\d][\d\s()-]*$/)
  .messages({
    'string.pattern.base': 'Phone number may only contain digits, spaces and + - ( )',
  });

const isoDate = Joi.date().iso().messages({
  'date.format': 'Use an ISO 8601 date',
});

// ──────────────────── Send to a student's parent ────────────────────

export const whatsappSendParamSchema = Joi.object({
  studentId: studentIdParam,
});

const sendBody = {
  // Which parents on the record to reach. `primary_indexed` selects by
  // position because parent sub-documents carry no id of their own.
  recipient: Joi.string().valid('primary', 'all', 'primary_indexed').default('primary'),
  recipientIndex: Joi.number().integer().min(0).max(20).optional(),
  type: Joi.string().valid(...WHATSAPP_MESSAGE_TYPES).default('general'),
  // An explicit number overrides resolution from the student record. Useful for
  // a parent whose number is on file under an unusable format.
  to: phoneNumber.optional(),
  message: Joi.string().trim().min(1).max(LIMITS.MAX_WHATSAPP_MESSAGE_BODY).optional(),
  template: Joi.object({
    name: Joi.string().trim().lowercase().max(512).required(),
    language: Joi.string().trim().lowercase().max(16).default('en'),
    // Positional values. When omitted, they are taken from the template's
    // declared variables in declaration order.
    parameters: Joi.array().items(Joi.alternatives().try(Joi.string(), Joi.number())).max(20).optional(),
  }).optional(),
  schoolId: objectId.optional(),
  // Overrides the customer service window for free-form text. Recorded in the
  // audit trail; a school should only set it deliberately.
  ignoreServiceWindow: Joi.boolean().default(false),
};

export const sendWhatsAppSchema = Joi.object(sendBody).custom((value, helpers) => {
  const hasTemplate = Boolean(value.template?.name);
  const hasMessage = Boolean(value.message);

  if (!hasTemplate && !hasMessage) {
    return helpers.message({ custom: 'Provide either a template or a message body' });
  }
  if (hasTemplate && hasMessage) {
    return helpers.message({ custom: 'Provide a template or a message body, not both' });
  }
  if (value.recipient === 'primary_indexed' && value.recipientIndex === undefined) {
    return helpers.message({ custom: 'recipient "primary_indexed" requires recipientIndex' });
  }
  return value;
});

// ──────────────────── Bulk send ────────────────────

export const whatsappSchoolParamSchema = Joi.object({
  schoolId: schoolIdParam,
});

export const sendBulkWhatsAppSchema = Joi.object({
  recipients: Joi.object({
    target: Joi.string().valid('all', 'class', 'students').required(),
    ids: Joi.array().items(objectId).max(5000).optional(),
  })
    .required()
    .messages({ 'any.required': 'recipients.target is required' }),
  class: Joi.alternatives().try(Joi.string().trim().max(60), Joi.array().items(Joi.string().trim().max(60)).max(50)).optional(),
  status: Joi.array()
    .items(Joi.string().valid('active', 'suspended', 'removed', 'graduated', 'transferred_out'))
    .min(1)
    .max(5)
    .optional(),
  balanceRanges: Joi.array()
    .items(Joi.string().valid('no_balance', '1_100', '101_500', '501_1000', 'above_1000'))
    .min(1)
    .max(5)
    .optional(),
  hasActivePlan: Joi.boolean().optional(),
  template: Joi.object({
    name: Joi.string().trim().lowercase().max(512).required(),
    language: Joi.string().trim().lowercase().max(16).default('en'),
    parameters: Joi.array().items(Joi.alternatives().try(Joi.string(), Joi.number())).max(20).optional(),
  }).optional(),
  message: Joi.string().trim().min(1).max(LIMITS.MAX_WHATSAPP_MESSAGE_BODY).optional(),
  type: Joi.string().valid(...WHATSAPP_MESSAGE_TYPES).default('announcement'),
  // Required before a whole-school broadcast goes out.
  confirmBroadscope: Joi.boolean().default(false),
  ignoreServiceWindow: Joi.boolean().default(false),
  scheduleAt: Joi.date().min('now').max('now', { offset: { days: 1 } }).optional().messages({
    'date.min': 'scheduleAt must be in the future',
    'date.max': 'scheduleAt cannot be more than 24 hours away',
  }),
  schoolId: objectId.optional(),
}).custom((value, helpers) => {
  if (Boolean(value.template?.name) === Boolean(value.message)) {
    return helpers.message({ custom: 'Provide either a template or a message body, not both' });
  }
  if (value.recipients.target === 'class' && !value.class) {
    return helpers.message({ custom: 'recipients.target "class" requires a class filter' });
  }
  if (value.recipients.target === 'students' && !value.recipients.ids?.length) {
    return helpers.message({ custom: 'recipients.target "students" requires recipients.ids' });
  }
  return value;
});

// ──────────────────── Job control ────────────────────

export const whatsappJobParamSchema = Joi.object({
  jobId: jobIdParam,
});

export const cancelWhatsAppJobSchema = Joi.object({
  reason: Joi.string().trim().max(300).optional().default(''),
});

// ──────────────────── Templates ────────────────────

export const createWhatsAppTemplateSchema = Joi.object({
  // Meta's rule, enforced here so a bad name is a 422 rather than a provider
  // rejection at submission time.
  name: Joi.string()
    .trim()
    .lowercase()
    .pattern(/^[a-z0-9_]+$/)
    .min(1)
    .max(512)
    .required()
    .messages({ 'string.pattern.base': 'Template name may only contain lowercase letters, digits and underscores' }),
  displayName: Joi.string().trim().max(120).optional(),
  description: Joi.string().trim().max(300).optional(),
  category: Joi.string().valid(...WHATSAPP_TEMPLATE_CATEGORIES).default('UTILITY'),
  language: Joi.string().trim().lowercase().max(16).default('en'),
  body: Joi.string().trim().min(1).max(1024).required(),
  // Placeholder names; the service checks these against the {{ }} in `body`.
  variables: Joi.array()
    .items(
      Joi.alternatives().try(
        Joi.string().trim().lowercase().max(40),
        Joi.object({
          name: Joi.string().trim().lowercase().max(40).required(),
          example: Joi.string().trim().max(120).optional().allow(''),
        })
      )
    )
    .max(20)
    .optional()
    .default([]),
  examples: Joi.object().pattern(Joi.string(), Joi.string().max(120)).optional(),
  // Submit to Meta for approval. Without it the template is registered locally
  // in the requested status so it can be used immediately.
  submitToMeta: Joi.boolean().default(false),
  status: Joi.string().valid(...WHATSAPP_TEMPLATE_STATUSES).optional(),
  schoolId: objectId.optional(),
});

export const listTemplatesQuerySchema = Joi.object({
  schoolId: objectId.optional(),
  status: Joi.string().valid(...WHATSAPP_TEMPLATE_STATUSES).optional(),
  category: Joi.string().valid(...WHATSAPP_TEMPLATE_CATEGORIES).optional(),
});

// ──────────────────── Conversations ────────────────────

export const conversationsParamSchema = Joi.object({
  schoolId: schoolIdParam,
});

export const conversationsQuerySchema = Joi.object({
  // One thread. Named in E.164 or any local form the platform accepts.
  phone: phoneNumber.optional(),
  studentId: objectId.optional(),
  direction: Joi.string().valid('inbound', 'outbound', 'all').default('all'),
  status: Joi.string()
    .valid(...WHATSAPP_MESSAGE_STATUSES, 'all')
    .default('all'),
  kind: Joi.string().valid(...WHATSAPP_MESSAGE_KINDS, 'all').default('all'),
  type: Joi.string().valid(...WHATSAPP_MESSAGE_TYPES, 'all').default('all'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  search: Joi.string().trim().max(120).optional(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(LIMITS.MAX_CONVERSATION_PAGE).default(20),
}).custom((value, helpers) => {
  if (value.from && value.to && new Date(value.from) > new Date(value.to)) {
    return helpers.message({ custom: 'from cannot be later than to' });
  }
  return value;
});

// ──────────────────── Webhook subscription ────────────────────

// Meta's own names, read from the query string by the handshake.
export const webhookVerifyQuerySchema = Joi.object({
  'hub.mode': Joi.string().required(),
  'hub.verify_token': Joi.string().required(),
  'hub.challenge': Joi.string().allow('').optional(),
}).unknown(true);
