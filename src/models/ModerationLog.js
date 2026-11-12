import mongoose from "mongoose";

const MODERATION_ACTIONS = ["report", "delete", "pin", "accept_answer"];

const moderationLogSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    targetType: {
      type: String,
      enum: ["post", "comment", "club", "event"],
      required: true,
    },
    action: {
      type: String,
      enum: MODERATION_ACTIONS,
      required: true,
    },
    reason: {
      type: String,
      default: null,
      trim: true,
      maxlength: 1000,
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

moderationLogSchema.index({ schoolId: 1, createdAt: -1 });
moderationLogSchema.index({ schoolId: 1, action: 1, createdAt: -1 });

moderationLogSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const MODERATION_ACTIONS_VALUES = MODERATION_ACTIONS;

export const ModerationLog = mongoose.model("ModerationLog", moderationLogSchema);
export default ModerationLog;
