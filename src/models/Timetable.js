import mongoose from "mongoose";

/**
 * One class's weekly timetable for one term.
 *
 * Keyed by class rather than by student: every student in JHS 2A reads the same
 * grid, which is why the parent portal resolves a timetable through
 * `student.studentClass` and never through the student. Uniqueness is
 * `{ schoolId, className, term, academicYear }` — a timetable is edited in place
 * across a term, not versioned per week.
 *
 * `days` is a fixed five-key object rather than an array of day documents, so
 * the parent portal can read `days.Monday` without mapping anything and a day
 * with no lessons is an empty array rather than an absent key. The child
 * `_id: false` on a period follows: a period has no identity outside its
 * position in its day, and the parent side re-derives `period` from the array
 * order on render.
 *
 * Period times are wall-clock strings ("8:00 am"), not Dates: a lesson happens
 * at 08:00 in Accra every week of the term, and storing that as an instant on
 * one particular Monday would be wrong for the other twenty-nine.
 */
const periodSchema = new mongoose.Schema(
  {
    period: { type: Number, required: true, min: 1 },
    startTime: { type: String, required: true }, // "8:00 am"
    endTime: { type: String, required: true },   // "8:45 am"
    subject: { type: String, required: true, trim: true },
    teacher: { type: String, default: "" },
    room: { type: String, default: "" },
  },
  { _id: false }
);

const timetableSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    className: { type: String, required: true, trim: true, index: true },
    term: {
      type: String,
      enum: ["Term 1", "Term 2", "Term 3"],
      required: true,
      index: true,
    },
    academicYear: { type: String, required: true, index: true },

    days: {
      Monday: { type: [periodSchema], default: [] },
      Tuesday: { type: [periodSchema], default: [] },
      Wednesday: { type: [periodSchema], default: [] },
      Thursday: { type: [periodSchema], default: [] },
      Friday: { type: [periodSchema], default: [] },
    },

    status: {
      type: String,
      enum: ["draft", "published"],
      default: "draft",
      index: true,
    },
    /**
     * The teacher-facing approval lifecycle, separate from `status`.
     *
     * `status` gates what parents see (only `published`). `submissionStatus`
     * gates what a teacher may edit and what an administrator may review:
     *
     *   draft      teacher is editing, nothing sent for review
     *   submitted  teacher has sent it to the administrator; locked for edits
     *   approved   administrator signed off; administrator may publish
     *   rejected   administrator sent it back with a reason; editable again
     */
    submissionStatus: {
      type: String,
      enum: ["draft", "submitted", "approved", "rejected"],
      default: "draft",
      index: true,
    },
    submittedAt: { type: Date, default: null },
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    teacherName: { type: String, default: "", trim: true },
    approvedAt: { type: Date, default: null },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvalComment: { type: String, default: "", trim: true },
    rejectedAt: { type: Date, default: null },
    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    rejectionReason: { type: String, default: "", trim: true },
    publishedAt: { type: Date, default: null },
    publishedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    /**
     * Deactivation fields. A teacher or admin deactivates a published timetable to
     * remove it from parent/teacher views without hard-deleting it. The timetable
     * stays on disk with `status: "draft"` but `deactivatedAt` set, and schedule
     * queries filter it out.
     */
    deactivatedAt: { type: Date, default: null },
    deactivatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deactivationReason: { type: String, default: "", trim: true },
    /**
     * Removal-request fields. A teacher requests removal of a timetable they own;
     * the admin then confirms or rejects the request. `removalStatus` is `null`
     * until requested, `"requested"` while pending, and back to `null` on withdraw
     * or reject. `deletionStatus` records the admin's final decision: `null` while
     * pending, `"removed"` when confirmed.
     */
    removalStatus: {
      type: String,
      enum: ["requested", "rejected"],
      default: null,
      index: true,
    },
    removalRequestedAt: { type: Date, default: null },
    removalRequestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    removalReason: { type: String, default: "", trim: true },
    removalDecidedAt: { type: Date, default: null },
    removalDecidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deletionStatus: {
      type: String,
      enum: ["pending", "removed"],
      default: null,
    },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

timetableSchema.index(
  { schoolId: 1, className: 1, term: 1, academicYear: 1 },
  { unique: true }
);

export const Timetable = mongoose.model("Timetable", timetableSchema);
