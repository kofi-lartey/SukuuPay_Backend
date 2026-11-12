import mongoose from "mongoose";

/**
 * A contextual reaction on a community post or comment.
 *
 * `targetType` says which collection the target document lives in and is kept
 * separate from `targetId` because the two are different ids by nature: a post
 * has a post id, a comment has a comment id, and neither can substitute for the
 * other.
 */
const COMMUNITY_REACTION_TYPES = ["like", "helpful", "fire", "support"];

const communityReactionSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    targetType: {
      type: String,
      enum: ["post", "comment"],
      required: true,
      default: "post",
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: COMMUNITY_REACTION_TYPES,
      required: true,
      default: "like",
    },
  },
  { timestamps: true }
);

communityReactionSchema.index({ targetId: 1, targetType: 1, userId: 1 }, { unique: true });

communityReactionSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const COMMUNITY_REACTION_TYPES_VALUES = COMMUNITY_REACTION_TYPES;

export const CommunityReaction = mongoose.model("CommunityReaction", communityReactionSchema);
export default CommunityReaction;
