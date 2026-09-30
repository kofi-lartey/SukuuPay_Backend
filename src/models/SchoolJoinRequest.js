import mongoose from "mongoose";

/**
 * A request from an unlinked account to join a school that already exists.
 *
 * Why this exists: the provisioning endpoint (`POST /schools/me`) refuses an
 * email address that already belongs to a School, because `School.email` is
 * unique. A second bursar of an existing school hits exactly that, and the
 * obvious "fix" — let them join on the school code alone — is unsafe. Codes are
 * three initials plus a three-digit counter (`generateSchoolCode`), so roughly
 * 17,000 values per prefix: guessable by anyone who knows the school's name.
 * A leaked code in a parents' WhatsApp group would hand out bursary access.
 *
 * So possession of the code is necessary but not sufficient. It identifies the
 * school; the school's existing admins decide. That trade-off costs the second
 * bursar one round trip and keeps a guessable secret from being an
 * authentication factor.
 */
const schoolJoinRequestSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    // What the applicant said they are. Shown to the deciding admin so they can
    // tell a colleague from an stranger with a guessed code.
    applicantName: { type: String, trim: true, maxlength: 100, default: "" },
    applicantPosition: { type: String, trim: true, maxlength: 80, default: "" },

    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    decidedAt: { type: Date, default: null },
    decidedNote: { type: String, trim: true, maxlength: 300, default: "" },
  },
  { timestamps: true }
);

// One live request per (user, school). A rejected applicant re-applying creates a
// fresh document rather than reviving the old one, so the decision history is
// not overwritten in place.
schoolJoinRequestSchema.index({ userId: 1, schoolId: 1, status: 1 });

schoolJoinRequestSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const SchoolJoinRequest = mongoose.model("SchoolJoinRequest", schoolJoinRequestSchema);
export default SchoolJoinRequest;
