import mongoose from "mongoose";

/**
 * One payout: a school's collected money, net of what SukuuPay keeps, on its way
 * out of the gateway.
 *
 * The unit that makes "pay the schools" one auditable operation instead of N
 * individual transfers. Parents pay all week; a school gets one transfer a week.
 * Without this collection there is no record of *the decision to pay a school* —
 * only N payment records and N provider references, and no way to answer "did we
 * send Kumasi Basic School their money on the 9th?" as a single question.
 *
 * **Two-phase, and the split is the safety property.** `pending_approval` → `paid`
 * with a human (or, if the owner has enabled it, a rule) in between. A batch is
 * built from settled-parent payments, reviewed as a list, and only then does money
 * leave. `PlatformSettings.disbursementAutoApprove` can skip the human, which is a
 * deliberate power rather than a convenience: it is off by default, it is a platform
 * setting the owner can see, and `GET /admin/finance/disbursements` records who or
 * what approved each batch either way.
 *
 * **`approvedBy` is null when auto-approved**, and `meta.approvedByRule` carries why.
 * Leaving `approvedBy` set to the cron owner would attribute a machine decision to a
 * person, which is the one thing an approval column exists to prevent.
 *
 * **Amounts are stored, not derived on read.** `grossAmount`, `platformAmount` and
 * `netAmount` are frozen at approval, alongside the exact `paymentIds` that
 * produced them. Re-deriving them later from the payments would be wrong the moment
 * a payment is refunded: the payout did not change, the ledger was corrected. The
 * stored figures describe the transfer that happened; `metadata.markupPercentAtApproval`
 * keeps the rate that produced it legible for as long as the batch exists.
 */
const disbursementBatchSchema = new mongoose.Schema(
  {
    /**
     * Human-facing identifier, e.g. `DISB-2026-000123`.
     *
     * Unique and indexed, because it is what appears in SMS to schools ("GHS 25,000
     * credited, batch DISB-2026-000123") and what support is quoted. A sequential
     * counter via `counterModel.js` rather than randomness: a school that cannot
     * find its own batch number cannot ask about its own money.
     */
    batchNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },

    /**
     * The window of parent payments this batch settles.
     *
     * Both required, and `periodEnd` is validated to be at or after `periodStart`
     * in the service layer — an inverted window selects payments "created after the
     * period ends", which is an empty set that looks exactly like a school with no
     * money to collect. Every other cause of an empty batch is visible; that one is
     * invisible.
     */
    periodStart: {
      type: Date,
      required: true,
    },
    periodEnd: {
      type: Date,
      required: true,
    },

    /**
     * `draft` → `pending_approval` → `approved` → `processing` → `paid`.
     *
     * `failed` and `cancelled` are terminal-ish but retryable: a `failed` batch is
     * what `POST /admin/finance/disbursements/:batchId/retry` operates on, and the
     * retry re-uses the same row rather than creating a second one for the same
     * payments. Two batches covering one window would pay a school twice, so
     * "retry" must mean "try again", never "make another".
     */
    status: {
      type: String,
      enum: [
        "draft",
        "pending_approval",
        "approved",
        "processing",
        "paid",
        "failed",
        "cancelled",
      ],
      default: "pending_approval",
      index: true,
    },

    /** What parents paid in this window, before any split. Integer pesewas. */
    grossAmount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    /** What SukuuPay keeps from this batch. Integer pesewas. */
    platformAmount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    /** What the school receives: `grossAmount - platformAmount`. Integer pesewas. */
    netAmount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    paymentCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    /**
     * The payments included, frozen at approval.
     *
     * Stored rather than re-queried, and this is the field that makes the batch
     * auditable: it is the difference between "the ledger says we paid" and "these
     * 143 payments were in it". Also the idempotency anchor — a second batch is
     * refused while any of these payments is unsettled.
     */
    paymentIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Payment",
        },
      ],
      default: [],
    },

    /** The full split at approval, so the breakdown can be shown without re-deriving. */
    breakdown: {
      markupAmount: { type: Number, default: 0, min: 0 },
      platformFeeAmount: { type: Number, default: 0, min: 0 },
      markupPercent: { type: Number, default: 0, min: 0, max: 100 },
      platformFeePercent: { type: Number, default: 0, min: 0, max: 100 },
    },

    /** The payout provider's own reference for the settled transfer. */
    payoutReference: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },

    provider: {
      type: String,
      enum: ["hubtel", "manual"],
      default: "hubtel",
    },

    /**
     * Approval trail.
     *
     * `approvedBy` null + `meta.approvedByRule` set is the auto-approve case. Both
     * null is rejected: an approved batch with no approver and no rule has no
     * explanation, and that is the state worth being able to assert is impossible.
     */
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    approvedAt: {
      type: Date,
      default: null,
    },

    processedAt: {
      type: Date,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },

    /** The provider's words, kept verbatim. A support ticket quotes this. */
    failureReason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },

    /** How many times the payout has been attempted. */
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },

    /** When the "GHS X credited to your account" SMS went out. */
    notificationsSentAt: {
      type: Date,
      default: null,
    },

    /**
     * The untyped remainder: rates at approval, the auto-approve rule name, the
     * provider payload retained for reconciliation.
     */
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

/*
 * The payout queue: which schools have money waiting, biggest first.
 *
 * Unsettled payments are the input, so this is the query a run is built from, and it
 * is also the finance screen's "awaiting approval" table. Both want the same order,
 * so both get the index.
 */
disbursementBatchSchema.index({ status: 1, createdAt: -1 });
disbursementBatchSchema.index({ schoolId: 1, periodEnd: -1 });

/*
 * The "don't pay twice" guard, as an index rather than only as application code.
 *
 * A school has at most one batch per payment window, so `{ schoolId, periodStart,
 * periodEnd }` is unique. This is the last line of defence for the one error that
 * costs a school money: two batches covering the same window both pass "no pending
 * disbursements", both get approved, and both pay out. The application check is
 * still there and runs first — it returns a readable 409 — but a check that only
 * exists in code is a check that only exists on the code path that has it.
 */
disbursementBatchSchema.index(
  { schoolId: 1, periodStart: 1, periodEnd: 1 },
  { unique: true }
);

disbursementBatchSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

/**
 * Batches that a payout run may pick up: built, not yet paid, and not dead.
 *
 * `failed` is included on purpose. A failed batch is money that has not reached the
 * school, and excluding it would mean a school whose payout broke on Monday is
 * quietly omitted from every subsequent run — the failure would never retry itself
 * and nothing on any screen would say so. Cancellation is the only terminal state
 * left out.
 */
export const OPEN_DISBURSEMENT_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "processing",
  "failed",
];

/** States in which money has left the gateway. Terminal for the batch. */
export const SETTLED_DISBURSEMENT_STATUSES = ["paid"];

export const DisbursementBatch = mongoose.model(
  "DisbursementBatch",
  disbursementBatchSchema
);

export default DisbursementBatch;