import mongoose from "mongoose";

/**
 * One student's roll-call mark for one day.
 *
 * The unique key is `{ schoolId, studentId, date }`, not `_id`, because the
 * question every reader asks is "what was this student marked on this day" — and
 * because the admin side is an *upsert*: a teacher correcting Tuesday's register
 * must land on the same row rather than a second one, or the parent's calendar
 * would show two Tuesdays and the attendance percentage would silently double.
 *
 * `date` is stored at 00:00 UTC. Ghana sits on UTC+0 permanently, so the
 * Accra calendar day and the UTC calendar day are the same day — a roll-call
 * taken at 07:30 in Accra is `2026-10-06T00:00:00.000Z` and never rolls back
 * into the previous day the way a European morning would.
 */
const attendanceSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },
    className: { type: String, required: true, trim: true, index: true },
    date: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ["present", "late", "absent", "excused", "holiday"],
      required: true,
      index: true,
    },
    arrivalTime: { type: Date, default: null },
    note: { type: String, maxlength: 300, default: "" },
    markedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    markedAt: { type: Date, default: Date.now },
    // Set when the school uses location-based auto-marking.
    autoMarked: { type: Boolean, default: false },
    locationVerified: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

// One row per student per day. Deliberately not partial on `deletedAt`: the
// admin upsert filters on these three fields alone, so a soft-deleted row is
// *reused* by the next mark rather than colliding into a duplicate-key error
// that would surface to a teacher as an unexplained 500.
attendanceSchema.index({ schoolId: 1, studentId: 1, date: -1 }, { unique: true });
// The roll-call screen's read: one class, one day, most recent first.
attendanceSchema.index({ schoolId: 1, className: 1, date: -1 });
// The parent portal's read: one student across a term.
attendanceSchema.index({ studentId: 1, date: -1 });

export const Attendance = mongoose.model("Attendance", attendanceSchema);
