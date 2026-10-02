import mongoose from "mongoose";

/**
 * Every cedi SukuuPay takes, in one append-only collection.
 *
 * This is the money the platform *keeps*, and it is deliberately separate from
 * `Payment`. A `Payment` is what a parent paid: gross, school-bound, and the
 * school's business. A ledger entry is the slice of that payment which is the
 * platform's — markup, platform fee, subscription, SMS resale, or a refund that
 * has to claw money back. Nothing in `Payment` can answer "how much did we earn
 * last month, and from whom", because a single payment is not that answer and
 * `Payment` has no notion of a split.
 *
 * **Append-only.** There is no update path and no delete. An entry that turns out
 * to be wrong is corrected by writing a compensating `adjustment` that points at
 * it, not by editing history — the same rule as a real book of account, and for
 * the same reason: an audit that can be edited is not an audit. `disbursementBatchId`
 * is where the reversal of a bad entry lives.
 *
 * **Signed rather than directional.** `amount` carries its own sign: positive is
 * money *to* the platform, negative is money *back out* (a refund, a chargeback, a
 * correction). `direction` is therefore redundant and not stored — a second source
 * of truth for one fact is a second thing to get wrong, and a `credit` row with a
 * negative amount is a contradiction rather than a record.
 *
 * **Nullable `schoolId`, and that is not an oversight.** Markup and subscription
 * revenue belong to a tenant; a platform-wide maintenance SMS charge or a gateway
 * fee does not. Filtering is `schoolId: null` to mean "platform-level", which is
 * the same convention `AuditLog.schoolId` already uses.
 *
 * **`createdBy` is nullable because most entries have no author.** A cron job
 * writing the day's markup at 06:00 is not a user. `createdBy: null` with
 * `entryType` set is the honest record; inventing a system user id would put a
 * fabricated identity in the one table that must never fabricate anything.
 */
const platformLedgerSchema = new mongoose.Schema(
  {
    /**
     * What kind of revenue this is.
     *
     * The single field the platform's income statement is grouped by, and the only
     * reason `GET /admin/analytics/revenue` can split "markup vs fee vs
     * subscription vs sms" instead of reporting one indistinguishable total.
     *
     * `adjustment` is the escape hatch for the corrections described above; it
     * carries no meaning of its own beyond "the numbers moved and this says why".
     */
    type: {
      type: String,
      enum: [
        "markup",
        "platform_fee",
        "subscription",
        "sms",
        "gateway_fee",
        "refund",
        "payout",
        "adjustment",
      ],
      required: true,
      index: true,
    },

    /**
     * Signed pesewas. Positive credits the platform, negative debits it.
     *
     * Integer pesewas like every other amount in the system — 1 GHS = 100 pesewas.
     * A ledger that mixes cedi and pesewas in one column cannot be summed without
     * the caller knowing which column it is looking at.
     */
    amount: {
      type: Number,
      required: true,
      validate: {
        validator: (value) => Number.isInteger(value) && value !== 0,
        message:
          "A ledger amount must be a non-zero integer number of pesewas — use the sign for direction",
      },
    },

    currency: {
      type: String,
      enum: ["GHS"],
      default: "GHS",
    },

    /** Whose money this is. `null` for platform-level entries. */
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      default: null,
      index: true,
    },

    /** The parent payment this was taken from. Null for subscriptions and SMS. */
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
      default: null,
      index: true,
    },

    /** The payout that settled or reversed this entry. */
    disbursementBatchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DisbursementBatch",
      default: null,
      index: true,
    },

    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      default: null,
    },

    /** Human-readable line, shown verbatim in the ledger screen and the CSV export. */
    description: {
      type: String,
      trim: true,
      maxlength: 300,
      default: "",
    },

    /**
     * Whether the money has actually moved out of the gateway's float.
     *
     * Unsettled is *accrued* revenue: taken from parents, visible on the
     * dashboard, not yet in an account. This is the distinction that keeps the
     * platform's cash figure and its earned figure from being the same number,
     * which is exactly the mistake a "total collected" headline invites.
     */
    settled: {
      type: Boolean,
      default: false,
      index: true,
    },
    settledAt: {
      type: Date,
      default: null,
    },

    /** The gateway's or payout provider's identifier, when one exists. */
    reference: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },

    /** The who and why. Never interpreted; a reconciler reads it. */
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    /**
     * Who wrote this entry.
     *
     * Null for anything written by a scheduled job. A reference rather than a copy
     * so a suspended user's entries stay attributable.
     */
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

/*
 * The ledger's three real reads.
 *
 * `{ schoolId: 1, createdAt: -1 }` is the per-school statement — "show this tenant's
 * earnings", which is also the export. `{ type: 1, createdAt: -1 }` is the
 * platform-wide revenue split, and it is the one that is only fast because of this
 * index: grouping revenue by kind is a full-collection question otherwise.
 * `{ settled: 1, createdAt: -1 }` is the finance queue — what is still sitting in
 * the gateway, which is read on every payout run.
 */
platformLedgerSchema.index({ schoolId: 1, createdAt: -1 });
platformLedgerSchema.index({ type: 1, createdAt: -1 });
platformLedgerSchema.index({ settled: 1, createdAt: -1 });

/*
 * Per-school net position. Partial on `settled: false` because the running "owed to
 * schools" total is summed on every finance screen over the unsettled subset, and
 * that subset stays small while the settled history grows without bound.
 */
platformLedgerSchema.index(
  { schoolId: 1, amount: -1 },
  { partialFilterExpression: { settled: false } }
);

platformLedgerSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const PlatformLedger = mongoose.model(
  "PlatformLedger",
  platformLedgerSchema
);

/**
 * The types that count as platform *income* for a period.
 *
 * Exported rather than repeated, because the answer is genuinely disputed between
 * two pages that must agree: a revenue headline that counts `payout` as earnings
 * would report every cedi forwarded to a school as money SukuuPay made. `refund` is
 * excluded because it is signed negative already and is a reversal, not a sale —
 * including it would net it against revenue and quietly restate a prior month.
 *
 * `adjustment` is excluded too, deliberately: a correction belongs next to the
 * thing it corrects, not inside the headline number, and mixing the two makes the
 * headline impossible to explain to anyone auditing it.
 */
export const PLATFORM_REVENUE_TYPES = [
  "markup",
  "platform_fee",
  "subscription",
  "sms",
  "gateway_fee",
];

export default PlatformLedger;