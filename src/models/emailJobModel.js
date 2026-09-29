import mongoose from 'mongoose';

// ──────────────────── Bulk email job ────────────────────
// One document per accepted broadcast. Tracks resolution, skips and the final
// per-status tally so a run is auditable without walking every message.
const emailJobModel = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    // Distinguishes an email job from an SMS job that shares the lifecycle.
    channel: {
      type: String,
      enum: ['email'],
      default: 'email',
    },
    template: {
      type: String,
      default: null,
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
      default: 'announcement',
    },
    subject: {
      type: String,
      default: null,
      trim: true,
      maxlength: 300,
    },
    // Mirrors the request flag: when false, `subject` is stored for reference
    // only and the template's own subject line is used at render time.
    overrideSubject: {
      type: Boolean,
      default: false,
    },
    // A caller-authored body is authored once at the request site; per
    // recipient values are substituted at render time during the run.
    customHtml: {
      type: String,
      default: null,
      select: false,
    },
    customText: {
      type: String,
      default: null,
      select: false,
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
    // Values shared by every recipient in this broadcast. Persisted so the
    // worker can render the same message long after the request has returned.
    variables: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    filters: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    recipientsResolved: {
      type: Number, // parents with a deliverable address
      default: 0,
      min: 0,
    },
    recipientsSkipped: {
      type: Number, // excluded by consent or data state
      default: 0,
      min: 0,
    },
    skippedWithoutEmail: {
      type: Number, // eligible but no address on record
      default: 0,
      min: 0,
    },
    skippedReasons: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    result: {
      type: mongoose.Schema.Types.Mixed,
      default: null, // per-status tally, filled on completion
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
          email: { type: String, required: true, lowercase: true, trim: true },
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
emailJobModel.index({ schoolId: 1, createdAt: -1 });
emailJobModel.index({ schoolId: 1, status: 1 });

emailJobModel.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    // Never echo the resolved address list in a job read.
    delete ret.recipientsSnapshot;
    delete ret.customHtml;
    delete ret.customText;
    return ret;
  },
});

export const EmailJob = mongoose.model('EmailJob', emailJobModel);
