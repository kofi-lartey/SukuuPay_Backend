import mongoose from 'mongoose';
import { WHATSAPP_MESSAGE_TYPES, WHATSAPP_TEMPLATE_CATEGORIES } from '../config/constants.js';

// ──────────────────── Bulk WhatsApp job ────────────────────
// One document per accepted broadcast. Mirrors EmailJob so the two channels
// report progress, skips and outcomes the same way.
const whatsappJobSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    // Distinguishes a WhatsApp job from an email/SMS job that shares the
    // lifecycle.
    channel: {
      type: String,
      enum: ['whatsapp'],
      default: 'whatsapp',
    },

    // ── Content ──
    // Either a template reference or a literal body, never both. The literal
    // body is stored per job (not per recipient) so every message in the run
    // is byte-identical unless the template substitutes variables.
    message: {
      type: String,
      default: null,
      maxlength: 4096,
      select: false, // returned by the job-read service via .select('+message')
    },
    template: {
      name: { type: String, default: null },
      language: { type: String, default: null },
      // Values shared by every recipient. Merged with each recipient's own
      // variables at render time.
      parameters: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    },
    type: {
      type: String,
      enum: WHATSAPP_MESSAGE_TYPES,
      default: 'announcement',
      index: true,
    },

    // ── Status ──
    status: {
      type: String,
      enum: ['queued', 'processing', 'cancelling', 'cancelled', 'completed', 'failed'],
      default: 'queued',
      index: true,
    },
    progressPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    // ── Resolution ──
    filters: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    recipientsResolved: {
      type: Number, // parents with a deliverable number
      default: 0,
      min: 0,
    },
    recipientsSkipped: {
      type: Number, // excluded by consent or data state
      default: 0,
      min: 0,
    },
    // Eligible but the number on record is unusable. Reported separately from
    // `recipientsSkipped` because this is a data-quality signal, not a choice.
    skippedInvalidNumber: {
      type: Number,
      default: 0,
      min: 0,
    },
    skippedReasons: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    // Per-status tally, filled on completion.
    result: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // ── Quota ──
    quotaRemainingBefore: {
      type: Number,
      default: null,
    },

    // ── Timing ──
    scheduledAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // ── Cancellation ──
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: '', trim: true, maxlength: 300 },

    // ── Failure ──
    failureReason: { type: String, default: '', trim: true, maxlength: 500 },

    // ── Resolved recipients ──
    // Snapshotted at acceptance so a run is deterministic and each message
    // renders the values as of when the broadcast was accepted.
    recipientsSnapshot: {
      type: [
        {
          phone: { type: String, required: true, trim: true },
          name: { type: String, default: '' },
          studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
          variables: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
        },
      ],
      default: [],
      select: false, // returned by the job-read service via .select('+recipientsSnapshot')
    },

    // ── Audit ──
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
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
whatsappJobSchema.index({ schoolId: 1, createdAt: -1 });
whatsappJobSchema.index({ schoolId: 1, status: 1 });

whatsappJobSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    // Never echo the resolved recipient list or the literal body in a job read.
    delete ret.recipientsSnapshot;
    delete ret.message;
    return ret;
  },
});

export const WhatsAppJob = mongoose.model('WhatsAppJob', whatsappJobSchema);
export { WHATSAPP_TEMPLATE_CATEGORIES };
