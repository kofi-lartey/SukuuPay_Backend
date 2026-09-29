import mongoose from 'mongoose';

// ──────────────────── Email preference / suppression ────────────────────
// Consent and suppression are PLATFORM-WIDE, not per school. Every school on
// SukuuPay shares one sender identity and one sending reputation, so a hard
// bounce or spam complaint at one school must stop that address being mailed
// by all of them. Scoping this per school would let the same dead address be
// mailed repeatedly and degrade delivery for everyone.
const emailPreferenceModel = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // Opt-in bookkeeping. An empty optInCategories means opted in to all.
    optInCategories: {
      type: [String],
      default: () => [],
    },
    optedOutAt: {
      type: Date,
      default: null,
    },
    // Set when a one-click or link unsubscribe is processed.
    unsubscribed: {
      type: Boolean,
      default: false,
      index: true,
    },
    unsubscribedAt: {
      type: Date,
      default: null,
    },
    // Hard bounce — the address does not exist.
    bounced: {
      type: Boolean,
      default: false,
    },
    bouncedAt: {
      type: Date,
      default: null,
    },
    // Spam complaint.
    complained: {
      type: Boolean,
      default: false,
    },
    complainedAt: {
      type: Date,
      default: null,
    },
    lastEventAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

emailPreferenceModel.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const EmailPreference = mongoose.model('EmailPreference', emailPreferenceModel);
