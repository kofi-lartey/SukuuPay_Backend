import mongoose from "mongoose";

/**
 * The platform's SMS pool — the units bought from Arkesel and available to allocate.
 *
 * ## Why this is a ledger and not a number
 *
 * The console needs to show a bursar how much credit is left, and that figure has to
 * be *defensible*. A single mutable `platformSmsBalance` number cannot be: nothing
 * records where it came from, so "we had 12,000 units in April" is unanswerable and a
 * wrong balance cannot be reconciled.
 *
 * So this is append-only. Entries are never edited — a correction is a new reversing
 * entry, which is the same rule `smsCreditTopUpModel.js` follows and the same reason.
 * The balance is a sum, and the sum's inputs are all still there.
 *
 * ## Sign convention
 *
 * `units` is **always positive** and `direction` carries the sign. An entry that could
 * be "−500 top-up" is an entry nobody can sum; this way `direction: 'allocation'` is
 * unambiguous at a glance and in an export.
 *
 * ## The claim
 *
 * `requestId` is set on an `allocation` and is **sparse-unique**. That index is the
 * approval idempotency guarantee: `approveSmsPurchaseRequest` inserts this row, and a
 * second attempt to approve the same request throws a duplicate-key error instead of
 * handing out the units twice. Stated here as well as on the requesting model because
 * the guarantee lives on *this* index, and a future edit to it would be invisible.
 */
const POOL_DIRECTIONS = ["topup", "allocation", "reversal"];
const POOL_DIRECTION_VALUES = POOL_DIRECTIONS;

const platformSmsPoolEntrySchema = new mongoose.Schema(
  {
    /** `POOL-YYYYMMDD-XXXXXX`. */
    entryId: { type: String, unique: true, default: null },

    direction: {
      type: String,
      enum: POOL_DIRECTION_VALUES,
      required: true,
      index: true,
    },

    /** Always positive. See the sign convention in the class comment. */
    units: { type: Number, required: true, min: 1 },

    /**
     * What this entry cost or charged, in pesewas.
     *
     * Nullable, and deliberately so. A `topup` records what the platform paid Arkesel
     * — a real cost. An `allocation` records what the school was charged, which is
     * money *earned*, not spent. Recording both in one column without that note is how
     * a platform-margin report ends up netting revenue against cost of sales and
     * calling the difference profit.
     */
    amountPes: { type: Number, default: null, min: 0 },

    provider: {
      type: String,
      enum: ["arke", "hubtel"],
      default: "arke",
    },

    /** The Arkesel receipt or gateway reference. The audit trail back to the provider. */
    reference: { type: String, default: null, trim: true, maxlength: 200 },

    /** Set on an `allocation`. Null for a top-up and for a reversal. */
    requestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SmsPurchaseRequest",
      default: null,
    },

    /** Which school received the units. Null on a top-up. */
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", default: null },

    /**
     * A snapshot of the pool balance after this entry.
     *
     * Denormalised, and the reason a disputed figure can be traced to the exact entry
     * that moved it without replaying the whole ledger. Advisory: the authoritative
     * figure is always the aggregation, because a snapshot can disagree with it after
     * a bad write — this is for answering "what did it say at the time", not for
     * computing the current balance.
     */
    balanceAfter: { type: Number, default: null },

    note: { type: String, default: "", trim: true, maxlength: 300 },

    /** Null when the entry was written by an approval rather than by a person. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

/** The console's pool history, newest first. */
platformSmsPoolEntrySchema.index({ createdAt: -1 });

/**
 * One allocation per request. Sparse-unique, and load-bearing — see the class comment.
 *
 * A `reversal` points at the request it reverses and therefore also collides, which is
 * correct: a request cannot be both allocated and reversed, because an allocation that
 * was reversed is represented by *two* rows with `requestId` null and a
 * `reversalOfEntryId` instead. See `reversePoolAllocation`.
 */
platformSmsPoolEntrySchema.index({ requestId: 1 }, { unique: true, sparse: true });

/** Which school a pool entry moved units to, when listing per-school consumption. */
platformSmsPoolEntrySchema.index({ schoolId: 1, createdAt: -1 });

/** Mints `entryId` before first write. */
platformSmsPoolEntrySchema.pre("save", function mintEntryId(next) {
  if (!this.entryId) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    this.entryId = `POOL-${dateStr}-${Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()}`;
  }
  next();
});

platformSmsPoolEntrySchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export { POOL_DIRECTIONS, POOL_DIRECTION_VALUES };
export const PlatformSmsPoolEntry = mongoose.model(
  "PlatformSmsPoolEntry",
  platformSmsPoolEntrySchema
);
export default PlatformSmsPoolEntry;