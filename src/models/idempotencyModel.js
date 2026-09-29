import mongoose from 'mongoose';

// ──────────────────── Idempotency record ────────────────────
// Replay protection for unsafe POSTs. Kept in its own collection, separate
// from the resources it guards, for two reasons:
//
//   1. A TTL index here expires the KEY after 24 hours. Putting it on
//      EmailMessage instead would delete the delivery audit trail, which must
//      never be auto-removed.
//   2. `responseSnapshot` lets a replay return the original response byte for
//      byte, which a re-derived resource could not guarantee.
const idempotencyModel = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    // Namespace, so the same key can be used on different routes.
    scope: {
      type: String,
      required: true,
      trim: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Hash of the normalised request payload. Same key + same hash replays;
    // same key + different hash is a 409.
    requestHash: {
      type: String,
      required: true,
    },
    responseSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

// Mongo removes the record once expiresAt passes, making the key reusable.
idempotencyModel.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IDEMPOTENCY_TTL_HOURS = 24;

export const IdempotencyRecord = mongoose.model(
  'IdempotencyRecord',
  idempotencyModel
);
