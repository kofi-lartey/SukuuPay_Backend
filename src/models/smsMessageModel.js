import mongoose from 'mongoose';
import { SMS_DELIVERY_STATUSES, SMS_PROVIDERS } from '../config/constants.js';

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
      default: null,
      index: true,
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

// ── Pre-save hooks ──
smsMessageSchema.pre('save', function () {
  if (this.status === 'submitted' && !this.submittedAt) this.submittedAt = new Date();
  if (this.status === 'delivered' && !this.deliveredAt) this.deliveredAt = new Date();
  if (['failed', 'rejected'].includes(this.status) && !this.failedAt) this.failedAt = new Date();
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
