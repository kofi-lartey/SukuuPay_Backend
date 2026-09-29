import Joi from 'joi';

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

// Same rule as every other validator in the codebase (auth, users, school,
// student): plain Joi email validation with the default TLD allowlist. Setting
// `tlds: false` here would let addresses through that login rejects.
const emailAddress = Joi.string()
  .trim()
  .lowercase()
  .email({ minDomainSegments: 2 })
  .max(254)
  .messages({ 'string.email': 'Invalid email address format' });

const MESSAGE_TYPE_ENUM = [
  'general',
  'balance',
  'payment',
  'payment_plan',
  'academic',
  'attendance',
  'announcement',
  'emergency',
  'result',
  'receipt',
];

const STATUS_ENUM = [
  'queued',
  'sent',
  'delivered',
  'opened',
  'clicked',
  'deferred',
  'soft_bounced',
  'bounced',
  'complained',
  'blocked',
  'unsubscribed',
  'failed',
];

const RECIPIENT_TARGET_ENUM = ['all', 'class', 'balance', 'payment_plan', 'individual'];

const BALANCE_RANGE_ENUM = [
  'no_balance',
  'overdue',
  '1_100',
  '101_500',
  '501_1000',
  'above_1000',
];

const STUDENT_STATUS_ENUM = [
  'active',
  'suspended',
  'removed',
  'graduated',
  'transferred_out',
];

const notInPastDate = Joi.date()
  .custom((value, helpers) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (new Date(value) < today) {
      return helpers.error('any.custom');
    }
    return value;
  })
  .messages({ 'any.custom': 'Date cannot be in the past' });

// Within 30 days, matching the rest of the platform's scheduling rules.
const scheduleDate = Joi.date()
  .min('now')
  .max('now', { offset: { days: 30 } })
  .messages({
    'date.min': 'scheduleAt must be in the future',
    'date.max': 'scheduleAt cannot be more than 30 days in the future',
  });

const addressList = Joi.array().items(emailAddress).max(10).default([]);

// A message is authored either from a named template or from a custom body.
// `template` is validated for existence in the service layer.
const bodyFields = {
  template: Joi.string().trim().max(60).optional(),
  variables: Joi.object().unknown(true).default({}),
  subject: Joi.string().trim().min(1).max(150).optional(),
  // Only meaningful with a template: the template's own subject line is used
  // unless this is set, so an accidental `subject` cannot silently rewrite it.
  overrideSubject: Joi.boolean().default(false),
  html: Joi.string().trim().min(1).max(200000).optional(),
  text: Joi.string().trim().min(1).max(100000).optional(),
};

const requireTemplateOrBody = (schema) =>
  schema.custom((value, helpers) => {
    if (!value.template && !(value.html && value.text)) {
      return helpers.message({
        custom: 'Provide either a template, or both html and text parts',
      });
    }
    if (value.template && (value.html || value.text)) {
      return helpers.message({
        custom: 'Provide a template or a custom html/text body, not both',
      });
    }
    if (!value.template && value.overrideSubject) {
      return helpers.message({
        custom: 'overrideSubject only applies when sending from a template',
      });
    }
    if (value.overrideSubject && !value.subject) {
      return helpers.message({
        custom: 'overrideSubject requires a subject to replace the template subject',
      });
    }
    return value;
  });

export const sendSingleEmailSchema = requireTemplateOrBody(
  Joi.object({
    ...bodyFields,
    to: emailAddress.optional(),
    toName: Joi.string().trim().max(100).optional().allow('', null),
    studentId: objectId.optional(),
    recipient: Joi.string().valid('primary', 'all', 'primary_indexed').default('primary'),
    recipientIndex: Joi.number().integer().min(0).max(20).optional(),
    type: Joi.string().valid(...MESSAGE_TYPE_ENUM).default('general'),
    cc: addressList,
    bcc: addressList,
    schoolId: objectId.optional(),
    scheduleAt: scheduleDate.optional(),
  })
    // Addressing is one of: an explicit mailbox, or a student plus a selector.
    .or('to', 'studentId')
    .custom((value, helpers) => {
      if (value.to && value.studentId) {
        return helpers.message({ custom: 'Provide either to or studentId, not both' });
      }
      if (value.recipient === 'primary_indexed' && value.recipientIndex === undefined) {
        return helpers.message({
          custom: 'recipientIndex is required when recipient is primary_indexed',
        });
      }
      if (value.recipient !== 'primary_indexed') {
        delete value.recipientIndex;
      }
      return value;
    })
);

export const sendBulkEmailSchema = requireTemplateOrBody(
  Joi.object({
    ...bodyFields,
    recipients: Joi.object({
      target: Joi.string().valid(...RECIPIENT_TARGET_ENUM).required(),
      ids: Joi.array().items(objectId).max(1000).optional(),
    })
      .required()
      .custom((value, helpers) => {
        if (value.target === 'individual' && !value.ids?.length) {
          return helpers.message({ custom: 'recipients.ids is required for target "individual"' });
        }
        return value;
      }),
    type: Joi.string().valid(...MESSAGE_TYPE_ENUM).default('announcement'),
    class: Joi.string().trim().max(50).optional().allow('', null),
    balanceRanges: Joi.array().items(Joi.string().valid(...BALANCE_RANGE_ENUM)).max(6).optional(),
    hasActivePlan: Joi.boolean().optional(),
    status: Joi.array()
      .items(Joi.string().valid(...STUDENT_STATUS_ENUM))
      .min(1)
      .max(5)
      .default(['active']),
    confirmation: Joi.string().valid('none', 'opt_in', 'opt_out').default('none'),
    scheduleAt: scheduleDate.optional(),
    confirmBroadscope: Joi.boolean().default(false),
  })
    .custom((value, helpers) => {
      // target implies its filter, so a mismatch is caught before resolution.
      if (value.recipients?.target === 'class' && !value.class) {
        return helpers.message({ custom: 'class is required when target is "class"' });
      }
      if (value.recipients?.target === 'balance' && !value.balanceRanges?.length) {
        return helpers.message({ custom: 'balanceRanges is required when target is "balance"' });
      }
      return value;
    })
);

export const cancelEmailJobSchema = Joi.object({
  reason: Joi.string().trim().max(300).optional().allow('', null),
});

export const emailJobIdParamSchema = Joi.object({
  jobId: objectId.required().messages({ 'string.pattern.base': 'Invalid job ID format' }),
});

export const emailSchoolIdParamSchema = Joi.object({
  schoolId: objectId.required().messages({ 'string.pattern.base': 'Invalid school ID format' }),
});

export const emailHistoryQuerySchema = Joi.object({
  schoolId: objectId.optional(),
  studentId: objectId.optional(),
  to: emailAddress.optional(),
  status: Joi.string().valid(...STATUS_ENUM, 'all').optional(),
  type: Joi.string().valid(...MESSAGE_TYPE_ENUM, 'all').optional(),
  template: Joi.string().trim().max(60).optional(),
  jobId: objectId.optional(),
  search: Joi.string().trim().max(100).allow('').optional(),
  from: Joi.date().optional(),
  toDate: Joi.date().optional(),
  hasBounce: Joi.boolean().optional(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string()
    .valid('createdAt', 'sentAt', 'deliveredAt', 'openedAt', 'status')
    .default('createdAt'),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
})
  .custom((value, helpers) => {
    if (value.hasBounce && value.status && value.status !== 'all') {
      return helpers.message({
        custom: 'Use either hasBounce or status, not both',
      });
    }
    if (value.from && value.toDate && new Date(value.from) > new Date(value.toDate)) {
      return helpers.message({ custom: 'from cannot be later than toDate' });
    }
    return value;
  });

export const providerEventSchema = Joi.object({
  events: Joi.array()
    .items(
      Joi.object({
        messageId: Joi.string().trim().max(300).required(),
        event: Joi.string()
          .valid(
            'delivered',
            'opened',
            'clicked',
            'spam',
            'unsubscribed',
            'blocked',
            'hard_bounce',
            'soft_bounce',
            'deferred'
          )
          .required(),
        date: Joi.date().optional(),
        reason: Joi.string().trim().max(500).optional(),
        url: Joi.string().uri().max(2000).optional(),
        ip: Joi.string().trim().max(64).optional(),
      })
    )
    .min(1)
    .required(),
});

const unsubscribeFields = {
  email: emailAddress.required(),
  token: Joi.string().trim().length(32).hex().required(),
};

// GET carries the pair in the query string; the one-click POST carries it
// form-encoded, so the same fields are declared for both.
export const unsubscribeQuerySchema = Joi.object(unsubscribeFields);
export const unsubscribeBodySchema = Joi.object(unsubscribeFields);

export { MESSAGE_TYPE_ENUM, STATUS_ENUM, RECIPIENT_TARGET_ENUM };
