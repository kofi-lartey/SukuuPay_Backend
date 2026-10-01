import mongoose from 'mongoose';
import { SMS_DELIVERY_STATUSES, SMS_CATEGORIES, SMS_PROVIDERS } from '../config/constants.js';

// ──────────────────── SMS message ────────────────────
// One document per SMS the platform hands to a gateway. It exists so the
// delivery-report webhooks have something to attach to: a provider reports
// "message 12345 was delivered", and without a row keyed on that id the report
// is unusable and the school's delivery record stays permanently "sent".
//
// `providerMessageId` is deliberately NOT unique. A gateway that omits it
// leaves the field null on every row, and a unique index would make the second
// such send fail. Deduplication is by value on a non-sparse index instead.
const smsMessageSchema = new mongoose.Schema(
  {
    // ── Scope ──
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
      index: true,
    },
    // The specific parent sub-document this went to. A student record holds
    // several parents and they each have their own number and their own
    // household, so "which parent is this" cannot be answered from `to` alone:
    // one guardian can parent three children in the same school, and all three
    // sends share a number. Recording the parent keeps that from reading as
    // three unrelated messages to one person.
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    // Business category, so history can be filtered by *why* something was sent
    // without parsing the body text. See SMS_CATEGORIES.
    type: {
      type: String,
      enum: SMS_CATEGORIES,
      default: 'custom',
      index: true,
    },
    // Which reusable body rendered this. Null for a free-form send, which is
    // also what makes the two distinguishable in the history view.
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SmsTemplate',
      default: null,
    },
    // The bulk run this belongs to. Null for a direct single send. Set on the
    // one-to-many side rather than resolved by date range, so a job's progress
    // is a single indexed count instead of a scan of the whole school's
    // messages.
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SmsJob',
      default: null,
      index: true,
    },
    // The carrier the gateway handed this to. Only known after submission, so it
    // is null while queued — and it is what splits a school's coverage report
    // by operator.
    network: {
      type: String,
      enum: ['mtn', 'telecel', 'airteltigo', null],
      default: null,
    },
    // A test send goes to a number the school controls, to prove the copy and
    // the sender ID render correctly. It is billed at nothing and must be
    // excluded from delivery rates, or a school's "98% delivered" is partly a
    // measurement of its own phone.
    isTest: {
      type: Boolean,
      default: false,
    },
    scheduledAt: {
      type: Date,
      default: null,
    },
    // The moment the gateway accepted the message. Distinct from `submittedAt`
    // only in intent — this is the field the SMS Reminders UI reads, and the
    // send path writes both.
    sentAt: {
      type: Date,
      default: null,
    },
    // Credit accounting, per message rather than per job.
    //
    // Refunds are tracked separately from charges so a message can be charged
    // once and refunded once, and so the history of a failed send stays
    // readable afterwards. The school balance is the single source of truth;
    // these are the audit trail explaining how it got there.
    creditsCharged: {
      type: Number,
      default: 0,
      min: 0,
    },
    creditsRefunded: {
      type: Number,
      default: 0,
      min: 0,
    },
    // The Idempotency-Key in force when this was created, so a replay can be
    // traced back to the attempt it replayed.
    idempotencyKey: {
      type: String,
      default: null,
    },
    // The specific parent sub-document this went to. A student record holds
    // several parents and they each have their own number and their own
    // household, so "which parent is this" cannot be answered from `to` alone:
    // one guardian can parent three children in the same school, and all three
    // sends share a number. Recording the parent keeps that from reading as
    // three unrelated messages to one person.
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    // Business category, so history can be filtered by *why* something was sent
    // without parsing the body text. See SMS_CATEGORIES.
    type: {
      type: String,
      enum: SMS_CATEGORIES,
      default: "custom",
      index: true,
    },
    // Which reusable body rendered this. Null for a free-form send, which is
    // also what makes the two distinguishable in the history view.
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SmsTemplate",
      default: null,
    },
    // The bulk run this belongs to. Null for a direct single send. Set on the
    // one-to-many side rather than queried for, so a job's progress is a single
    // indexed count instead of a scan of the whole school's messages.
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SmsJob",
      default: null,
      index: true,
    },
    // The carrier the gateway handed this to. Only known after submission, so
    // it is null while queued — and it is what splits a school's coverage
    // report by operator.
    network: {
      type: String,
      enum: ["mtn", "telecel", "airteltigo", null],
      default: null,
    },
    // A test send goes to a number the school controls, to prove the copy and
    // the sender ID render correctly. It is billed at nothing and must be
    // excluded from delivery rates, or a school's "98% delivered" is partly a
    // measurement of its own phone.
    isTest: {
      type: Boolean,
      default: false,
    },
    scheduledAt: {
      type: Date,
      default: null,
    },
    // The moment the gateway accepted the message. Distinct from
    // `submittedAt` in intent only: this is the record the SMS Reminders UI
    // reads, and the two are written together by the send path.
    sentAt: {
      type: Date,
      default: null,
    },
    // Credit accounting, per message rather than per job.
    //
    // Refunds are tracked separately from charges so a message can be charged
    // once and refunded once, and so the history of a failed send is readable
    // after the fact. The school balance is the single source of truth; these
    // are the audit trail explaining how it got there.
    creditsCharged: {
      type: Number,
      default: 0,
      min: 0,
    },
    creditsRefunded: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Idempotency key in force when this was created, so a replay can be
    // traced back to the original attempt.
    idempotencyKey: {
      type: String,
      default: null,
    },
    paymentPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentPlan',
      default: null,
    },
    parentName: {
      type: String,
      trim: true,
      default: '',
    },

    // ── Recipient ──
    // Kept exactly as submitted, because that is the form the provider echoes
    // back in its delivery report and the form the lookup must match on.
    to: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    // Best-effort E.164 form, for display and for matching a report that
    // normalised the number. Null when the stored number cannot be normalised.
    toE164: {
      type: String,
      default: null,
      trim: true,
    },

    // ── Content ──
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1600, // a long message split into concatenated parts
    },
    segments: {
      type: Number,
      default: 1,
      min: 1,
    },
    // What the message was for, e.g. `payment_plan.installment_due`. Lets the
    // delivery report be reconciled against a business reason.
    purpose: {
      type: String,
      trim: true,
      maxlength: 60,
      default: 'general',
    },

    // ── Provider ──
    provider: {
      type: String,
      enum: SMS_PROVIDERS,
      // Matches `school.sms.provider`'s default. A row always records the
      // provider actually used, so a report can never be matched against a
      // gateway that did not send it.
      default: 'arke',
      index: true,
    },
    providerMessageId: {
      type: String,
      default: null,
      index: true,
    },
    // Some gateways batch several recipients under one submission id.
    providerClientReference: {
      type: String,
      default: null,
    },

    // ── Delivery state ──
    status: {
      type: String,
      enum: SMS_DELIVERY_STATUSES,
      default: 'queued',
      index: true,
    },
    failureReason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    // Terminal states. A late report for an already-terminal message is
    // recorded but does not move the message backwards.
    deliveredAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },

    // ── Delivery report ──
    dlrCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    dlr: {
      receivedAt: { type: Date, default: null },
      // Raw provider code, kept even when unmapped so the mapping can be
      // extended later without having lost the original.
      code: { type: String, default: null },
      description: { type: String, default: '' },
      network: { type: String, default: null },
      raw: { type: mongoose.Schema.Types.Mixed, default: null, select: false },
    },

    // ── Audit ──
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null, // null for cron-driven sends
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

// ── Indexes ──
smsMessageSchema.index({ schoolId: 1, createdAt: -1 });
smsMessageSchema.index({ schoolId: 1, status: 1 });
smsMessageSchema.index({ provider: 1, providerMessageId: 1 });
// Lets a report that only carries a phone number still find its message.
smsMessageSchema.index({ to: 1, createdAt: -1 });
// The history view's default query: one school's sends, newest first, filtered
// by business category. The two single-field indexes above can only intersect at
// high cost, and this is the query behind every page of the SMS Reminders
// history tab.
smsMessageSchema.index({ schoolId: 1, type: 1, createdAt: -1 });
// A bulk run's progress rollup. Covered on the one-to-many side so the job poll
// is a count on an equality match, not an aggregation over the school's history.
smsMessageSchema.index({ jobId: 1, status: 1 });
// Resolving "who still owes" from a message history screen by student.
smsMessageSchema.index({ studentId: 1, createdAt: -1 });

// ── Pre-save hooks ──
smsMessageSchema.pre('save', function () {
  if (this.status === 'submitted' && !this.submittedAt) this.submittedAt = new Date();
  if (this.status === 'delivered' && !this.deliveredAt) this.deliveredAt = new Date();
  if (['failed', 'rejected'].includes(this.status) && !this.failedAt) this.failedAt = new Date();

  // `sentAt` mirrors `submittedAt` rather than being set independently: the two
  // name the same event, and the delivery-report path only ever moves
  // `status`/`submittedAt`, so a sender that sets one and not the other would
  // produce a message the history list files under "queued" forever.
  if (this.submittedAt) {
    if (!this.sentAt) this.sentAt = this.submittedAt;
  } else if (this.sentAt) {
    this.submittedAt = this.sentAt;
  }

  // A message cannot claim a refund it was never charged for. Clamped on the
  // document rather than trusted from the caller, because the DLR webhook
  // computes this from fields it read a moment earlier and a double-settled
  // webhook could otherwise credit a school twice.
  if ((this.creditsRefunded || 0) > (this.creditsCharged || 0)) {
    this.creditsRefunded = this.creditsCharged || 0;
  }
});

smsMessageSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    delete ret.dlr?.raw;
    return ret;
  },
});

export const SmsMessage = mongoose.model('SmsMessage', smsMessageSchema);
