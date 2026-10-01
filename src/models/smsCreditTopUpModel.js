import mongoose from 'mongoose';

/**
 * A school's record of buying SMS credit.
 *
 * The balance itself is `school.sms.balance` — a number on the school, kept
 * there so it cannot drift from the school it belongs to. This collection is the
 * *reason* for that number: without it, "you have 1,420 SMS left" is a figure
 * with no provenance, a bursar cannot reconcile what they bought against what
 * they sent, and a support question about a wrong balance is unanswerable.
 *
 * So this is an append-only ledger. The balance is derived by summing it, and a
 * repair is a new correcting entry rather than an edit — an edited row cannot
 * explain itself.
 */
const smsCreditTopUpSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },

    // Credits purchased. Always positive: a refund is a separate row, so the
    // direction of every entry is unambiguous.
    units: {
      type: Number,
      required: true,
      min: 1,
    },

    // What the school paid, in pesewas, and which provider took it. Nullable
    // because credit can also be granted by support or by a migration, and
    // recording a GH₵0.00 for those would put a price on a decision that had
    // none.
    amountPes: {
      type: Number,
      default: null,
      min: 0,
    },
    provider: {
      type: String,
      default: null,
    },
    reference: {
      type: String,
      default: null,
      trim: true,
      maxlength: 200,
    },

    // How the credit was granted. Distinguishes money from a grant, because only
    // one of those is a balance-sheet item.
    source: {
      type: String,
      enum: ['purchase', 'grant', 'reversal', 'migration', 'adjustment'],
      default: 'purchase',
    },

    // Set on a `reversal`, naming the row being reversed. A reversal that points
    // at nothing is not a reversal.
    reverses: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SmsCreditTopUp',
      default: null,
    },

    note: {
      type: String,
      default: '',
      trim: true,
      maxlength: 300,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

// The purchase history screen: newest first, one school only.
smsCreditTopUpSchema.index({ schoolId: 1, createdAt: -1 });
// A reversal may only be applied once. Without this, double-submitting a
// reversal silently double-refunds the school.
smsCreditTopUpSchema.index({ reverses: 1 }, { unique: true, sparse: true });

smsCreditTopUpSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const SmsCreditTopUp = mongoose.model('SmsCreditTopUp', smsCreditTopUpSchema);

export default SmsCreditTopUp;
