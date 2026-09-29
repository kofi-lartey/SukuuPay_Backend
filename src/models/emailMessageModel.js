import mongoose from 'mongoose';

// ──────────────────── Email message ────────────────────
// One document per recipient per send. This is the audit trail of what a
// parent was told, and the record the provider's delivery events attach to.
// Never hard-deleted.
const emailMessageModel = new mongoose.Schema(
  {
    // ── Scope ──
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      default: null, // null for platform-transactional mail
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      default: null,
    },
    parentName: {
      type: String,
      trim: true,
      default: '',
    },
    to: {
      type: String, // recipient address, lowercased
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    // ── Content (rendered, never a template reference) ──
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    type: {
      type: String,
      enum: [
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
      ],
      default: 'general',
      index: true,
    },
    template: {
      type: String,
      default: null,
    },
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmailJob',
      default: null,
      index: true,
    },
    isCc: { type: Boolean, default: false },
    isBcc: { type: Boolean, default: false },
    hasHtmlPart: { type: Boolean, default: false },
    hasTextPart: { type: Boolean, default: false },

    // ── Provider ──
    provider: {
      type: String,
      enum: ['brevo'],
      default: 'brevo',
    },
    providerMessageId: {
      type: String,
      default: null,
      index: true,
    },

    // ── Delivery state ──
    status: {
      type: String,
      enum: [
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
      ],
      default: 'queued',
      index: true,
    },
    bounceType: {
      type: String,
      enum: ['hard', 'soft', null],
      default: null,
    },
    failureReason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },

    // ── Timestamps (first occurrence wins for open/click) ──
    scheduledAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    firstClickedAt: { type: Date, default: null },
    firstClickedUrl: { type: String, default: null },

    // ── Audit ──
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
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
emailMessageModel.index({ schoolId: 1, createdAt: -1 });
emailMessageModel.index({ schoolId: 1, status: 1 });
emailMessageModel.index({ schoolId: 1, to: 1 });
emailMessageModel.index({ schoolId: 1, studentId: 1, createdAt: -1 });
// A replayed Idempotency-Key must not produce a second message. Replay
// protection itself lives in IdempotencyRecord, which is TTL'd; nothing may
// be put on a TTL here, because this collection is the audit trail and must
// never be auto-deleted.
emailMessageModel.index({ schoolId: 1, providerMessageId: 1 });

// ── Pre-save hooks ──
// Declared with no parameters: mongoose does not pass a `next` callback to a
// pre-save hook, so a `function (next)` signature would make `next` a
// non-function and throw on every save.
emailMessageModel.pre('save', function () {
  // Keep the delivery timeline consistent no matter which layer wrote the row.
  if (this.status === 'sent' && !this.sentAt) this.sentAt = new Date();
  if (this.status === 'delivered' && !this.deliveredAt) this.deliveredAt = new Date();
  if (this.isModified('to') && this.to) this.to = this.to.toLowerCase().trim();
});

// ── toJSON: keep the payload small for list views ──
emailMessageModel.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const EmailMessage = mongoose.model('EmailMessage', emailMessageModel);
