import mongoose from "mongoose";

/**
 * Durable read-state for the parent portal's two surfaces that the backend does
 * not already track per-parent: the messages inbox and the notifications bell.
 *
 * The parent portal speaks in pay tokens, not user accounts, so a parent has no
 * row in the `Notification`/`User` tables to carry a `read` flag. Rather than
 * invent a fourth notification schema, each portal surface is *derived* from
 * the student's existing rows here and the "have I seen this" answer is stored
 * once, keyed by token identity, on this document.
 *
 * Two fields:
 *
 *  - `readMessageIds`: ids of the student's ParentMessage rows the parent has
 *    opened, so the messages badge does not re-animate after a refresh.
 *
 *  - `readNotificationIds`: ids of *derived* notification entries the parent has
 *    dismissed, so a dismissed payment-alert does not reappear on reload.
 *
 * A `version` field guards against a parent with two tabs open clobbering each
 * other's marks: writes use a `$inc` on `version` so the lost update is the
 * older one, not a silent overwrite.
 */
const ParentPortalReadStateSchema = new mongoose.Schema(
  {
    /** The student this state belongs to, resolved from the pay token. */
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },

    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },

    /** ParentMessage `_id`s the parent has opened, as a Set under the hood. */
    readMessageIds: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
    },

    /** Derived notification entry ids the parent has dismissed. */
    readNotificationIds: {
      type: [String],
      default: [],
    },

    version: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

ParentPortalReadStateSchema.index(
  { studentId: 1, schoolId: 1 },
  { unique: true }
);

export const ParentPortalReadState = mongoose.model(
  "ParentPortalReadState",
  ParentPortalReadStateSchema
);

export default ParentPortalReadState;
