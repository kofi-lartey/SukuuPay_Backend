import mongoose from "mongoose";

/**
 * A reply inside a community post's discussion thread.
 *
 * `parentCommentId` enables nested replies; `isAcceptedAnswer` marks the
 * teacher's or helpful student's reply that resolves a question. It is read as
 * a pointer back into the same collection, which keeps a question's "solved"
 * state denormalised exactly where the feed list can see it.
 */
const communityCommentSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    postId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunityPost",
      required: true,
      index: true,
    },
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    authorRole: {
      type: String,
      enum: ["student", "teacher", "school_admin"],
      required: true,
      default: "student",
    },
    authorName: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 4000,
    },
    parentCommentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunityComment",
      default: null,
      index: true,
    },
    isAcceptedAnswer: {
      type: Boolean,
      default: false,
      index: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

communityCommentSchema.index({ postId: 1, createdAt: 1 });
communityCommentSchema.index({ schoolId: 1, createdAt: -1 });

communityCommentSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const CommunityComment = mongoose.model("CommunityComment", communityCommentSchema);
export default CommunityComment;
