import mongoose from "mongoose";

/**
 * A monotonic counter per logical key, e.g. `studentId:65f…:2026`.
 *
 * Exists because generating an id by reading the current maximum and adding one
 * is a read-then-write race: two concurrent imports against the same school and
 * academic year both read `0007`, both compute `0008`, and one gets a
 * duplicate-key error on insert. The original `generateStudentId` did exactly
 * that, and its three-attempt retry loop could not fix it — the retry
 * recomputed the same maximum and collided again.
 *
 * `findOneAndUpdate` with `$inc` is a single atomic document operation, so two
 * concurrent callers are guaranteed distinct values. `upsert` creates the
 * counter on first use, and the unique index on `key` is what makes a
 * simultaneous upsert a retryable duplicate-key rather than two counters.
 *
 * A gap can appear between the increment and the insert (if the caller fails
 * afterwards), so ids are monotonic and not gapless. That is deliberate: gapless
 * would require a transaction spanning both collections, which is not worth it
 * for a human-readable identifier.
 */
const counterSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  seq: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
  },
});

export const Counter = mongoose.model("Counter", counterSchema);

export default Counter;
