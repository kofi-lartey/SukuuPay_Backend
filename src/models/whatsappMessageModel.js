import mongoose from 'mongoose';
import {
  LIMITS,
  WHATSAPP_MESSAGE_KINDS,
  WHATSAPP_MESSAGE_STATUSES,
  WHATSAPP_MESSAGE_TYPES,
} from '../config/constants.js';

// ──────────────────── WhatsApp message ────────────────────
// One document per message, in either direction. This is the conversation
// history a school reads, the audit trail of what a parent was told, and the
// record Meta's status callbacks attach to. Never hard-deleted.
const whatsappMessageSchema = new mongoose.Schema(
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
    parentName: {
      type: String,
      trim: true,
      default: '',
    },

    // ── Thread identity ──
    // Stored in E.164 (+233...). Both directions use the parent's number, so
    // one thread per parent is a plain query rather than a computed key.
    phone: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    // The parent number as it was written on the student record. Kept so a
    // data-quality problem on the student is visible in the conversation view
    // instead of being hidden behind the normalised value.
    phoneRaw: {
      type: String,
      default: '',
      trim: true,
    },

    // ── Content ──
    direction: {
      type: String,
      enum: ['inbound', 'outbound'],
      required: true,
      index: true,
    },
    // Business category, aligned with the email `type` vocabulary so the two
    // channels can be filtered together.
    type: {
      type: String,
      enum: WHATSAPP_MESSAGE_TYPES,
      default: 'general',
      index: true,
    },
    // What the payload actually is. Separate from `type`: a template is both
    // an approved `template` and, say, a `payment_plan` message.
    kind: {
      type: String,
      enum: WHATSAPP_MESSAGE_KINDS,
      default: 'text',
    },
    body: {
      type: String,
      default: '',
      maxlength: LIMITS.MAX_WHATSAPP_MESSAGE_BODY,
    },
    // Set for interactive replies and inbound attachments. Opaque on purpose:
    // the renderer for each kind lives in the service layer, not the model.
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    template: {
      name: { type: String, default: null },
      language: { type: String, default: null },
      // Rendered values, so the exact text a parent saw is recoverable even
      // if the template body is later edited.
      parameters: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    },

    // ── Provider ──
    //
    // `meta` is Meta's own Cloud API. `moolre` is the same WhatsApp Business
    // product resold through Moolre, which is the same account that collects
    // the school's payments — one vendor, one balance.
    provider: {
      type: String,
      enum: ['meta', 'moolre'],
      default: 'meta',
    },
    providerMessageId: {
      type: String,
      default: null,
    },

    // ── Delivery state ──
    status: {
      type: String,
      enum: WHATSAPP_MESSAGE_STATUSES,
      default: 'queued',
      index: true,
    },
    failureReason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    // Timestamp Meta attached to the status event, which is when the message
    // actually changed state. Never `Date.now()` — the callback can arrive
    // minutes or hours after the event.
    statusTimestamp: {
      type: Date,
      default: null,
    },

    // ── Timestamps ──
    scheduledAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },

    // ── Provenance ──
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WhatsAppJob',
      default: null,
      index: true,
    },
    // The untouched provider event. `select: false` so a conversation read
    // never ships the raw payload, but still reachable by `.select('+rawPayload')`.
    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      select: false,
    },

    // ── Audit ──
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null, // null for inbound messages
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
whatsappMessageSchema.index({ schoolId: 1, createdAt: -1 });
whatsappMessageSchema.index({ schoolId: 1, phone: 1, createdAt: -1 });
whatsappMessageSchema.index({ schoolId: 1, studentId: 1, createdAt: -1 });
whatsappMessageSchema.index({ schoolId: 1, status: 1 });
whatsappMessageSchema.index({ direction: 1, createdAt: -1 });

// Meta retries a webhook until it gets a 2xx, so the same message id arrives
// more than once. The unique index makes the second insert fail rather than
// duplicating a parent's message in the history. Partial, because a send that
// never reached Meta has no id and `null` would collide.
whatsappMessageSchema.index(
  { providerMessageId: 1 },
  { unique: true, partialFilterExpression: { providerMessageId: { $type: 'string' } } }
);

// ── Pre-save hooks ──
// Declared with no parameters: mongoose does not pass a `next` callback to a
// pre-save hook, so a `function (next)` signature would make `next` a
// non-function and throw on every save.
whatsappMessageSchema.pre('save', function () {
  if (this.isModified('phone') && this.phone) this.phone = this.phone.trim();
  if (this.status === 'sent' && !this.sentAt) this.sentAt = new Date();
  if (this.status === 'delivered' && !this.deliveredAt) this.deliveredAt = new Date();
  if (this.status === 'read' && !this.readAt) this.readAt = new Date();
});

// ── toJSON ──
whatsappMessageSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    delete ret.rawPayload;
    return ret;
  },
});

export const WhatsAppMessage = mongoose.model('WhatsAppMessage', whatsappMessageSchema);
