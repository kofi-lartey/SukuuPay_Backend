import mongoose from 'mongoose';
import { SMS_AUDIENCE_TYPES, SMS_CATEGORIES, SMS_JOB_STATUSES } from '../config/constants.js';

/**
 * One broadcast — the fee-reminder run a school clicks "Send" on.
 *
 * Modelled on `WhatsAppJob` so the two channels report progress, skips and
 * outcomes identically, and so a school reading its history sees one vocabulary
 * rather than two that mean the same thing.
 *
 * The recipient list is snapshotted at acceptance, not re-resolved at send time.
 * That is the important decision here: a school chooses "overdue only" at
 * 09:00, the run starts at 14:00, and in those five hours a parent paid. A
 * run that re-resolved would skip a parent who has just settled up — after
 * showing them the reminder count in the confirmation dialog. The snapshot also
 * makes a scheduled run deterministic: it sends the message the school
 * previewed, with the numbers they saw, on the day they chose.
 */
const smsJobSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },

    // ── What was sent ──
    // The rendered body, stored per job. Every message in a run is identical
    // except for the substituted numbers, and storing the body on the job rather
    // than on each message is what makes a 10,000-recipient broadcast one
    // document instead of ten thousand.
    body: {
      type: String,
      required: true,
      maxlength: 4800,
      select: false, // returned by the job-read service via .select('+body')
    },

    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SmsTemplate',
      default: null,
    },

    category: {
      type: String,
      enum: SMS_CATEGORIES,
      default: 'custom',
      index: true,
    },

    // ── Who it went to ──
    // The rule, kept alongside the snapshot of its result. A job that stored
    // only the snapshot could not be re-run or audited: "why did these 87 people
    // get this?" is unanswerable without the filter.
    audienceType: {
      type: String,
      enum: SMS_AUDIENCE_TYPES,
      required: true,
    },

    // The resolved filter as the service applied it, not as the client sent it.
    // Retained verbatim so the job is auditable and re-runnable; the free-form
    // bag because a school's audience is a query, not a fixed set of fields.
    filters: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    // ── Status ──
    status: {
      type: String,
      enum: SMS_JOB_STATUSES,
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
    // Parents with a deliverable number.
    recipientsResolved: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Excluded by a choice: a class filter, an explicit id list, an
    // `excludeRecentPayers` window.
    recipientsSkipped: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Eligible, but the number on record cannot be normalised to a Ghanaian
    // mobile. Counted apart from `recipientsSkipped` because this is a data-
    // quality signal the school can act on, not a decision anyone made.
    skippedInvalidNumber: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Per-reason tally, e.g. { no_parent: 3, no_balance: 120, opted_out: 2 }.
    skippedReasons: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    // ── Outcome ──
    result: {
      queued: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },

    // ── Money ──
    // The school's balance when the run was accepted, so a "you have 1,420 SMS
    // left" claim in the confirmation dialog can be reconciled against what
    // actually happened.
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

    // ── Timing ──
    scheduledAt: {
      type: Date,
      default: null,
      // A job with a future schedule is stored as `scheduled`, not `queued`, so
      // the history can separate "waiting its turn" from "waiting for the clock"
      // — two very different things to a bursar who is wondering why their 7pm
      // send has not gone out.
      index: true,
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // ── Cancellation ──
    // A cancel takes effect between batches, never mid-batch: a message already
    // handed to the gateway cannot be recalled, and pretending otherwise is how
    // a cancelled run ends up with a "cancelled" label on 40 delivered SMS.
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: '', trim: true, maxlength: 300 },

    // ── Failure ──
    failureReason: { type: String, default: '', trim: true, maxlength: 500 },

    // ── Resolved recipients ──
    // The snapshot. One entry per parent, carrying the numbers the message will
    // be rendered with, so the run is deterministic and each message reads as of
    // when the broadcast was accepted.
    recipientsSnapshot: {
      type: [
        {
          parentId: { type: mongoose.Schema.Types.ObjectId, required: true },
          studentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Student',
            required: true,
          },
          phone: { type: String, required: true, trim: true },
          parentName: { type: String, default: '' },
          studentName: { type: String, default: '' },
          studentClass: { type: String, default: '' },
          balance: { type: Number, default: 0 },
          amountPaid: { type: Number, default: 0 },
          dueDate: { type: Date, default: null },
          payLink: { type: String, default: null },
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
// The worker polls for work to do: everything not yet finished, soonest
// schedule first. Partial on the terminal states so the poll does not read the
// whole completed history on every tick.
smsJobSchema.index({ status: 1, scheduledAt: 1 });
smsJobSchema.index({ schoolId: 1, createdAt: -1 });
smsJobSchema.index({ schoolId: 1, status: 1 });

smsJobSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    // Never echo the resolved recipient list or the body in a job list read. The
    // recipient snapshot is every parent's number for the whole school, and a
    // history list that returns it is a data-protection incident, not a payload.
    delete ret.recipientsSnapshot;
    delete ret.body;
    return ret;
  },
});

export const SmsJob = mongoose.model('SmsJob', smsJobSchema);

export { SMS_AUDIENCE_TYPES, SMS_JOB_STATUSES };

export default SmsJob;
