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
      // See `CommunityPost`: the author is a `User` or a `Student`, so the
      // model is named per-row by `authorModel` instead of being fixed.
      refPath: "authorModel",
      required: true,
      index: true,
    },
    authorModel: {
      type: String,
      enum: ["User", "Student"],
      required: true,
      default: "User",
    },
    authorRole: {
      type: String,
      enum: ["student", "teacher", "school_admin", "super_admin", "accountant"],
      required: true,
      default: "student",
    },
    authorName: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
    },
    // A comment is a chat message, so it can be body-only, media-only, or both.
    // `required: true` on the body is what made "send a picture with no caption"
    // impossible: a media-only message failed Mongoose validation and the request
    // came back as a 500 rather than a message.
    body: {
      type: String,
      default: null,
      trim: true,
      maxlength: 4000,
    },
    // Attachments, same shape as `CommunityPost.media` so the feed and the thread
    // can share one renderer.
    media: [
      {
        url: { type: String, default: null },
        publicId: { type: String, default: null, select: false },
        mimeType: { type: String, default: null },
        bytes: { type: Number, default: null, min: 0 },
        originalName: { type: String, default: null, trim: true, maxlength: 255 },
        // Probed by Cloudinary for audio; null when the format cannot be read. The
        // player seeds its duration label from this and refines it from the file.
        durationSeconds: { type: Number, default: null, min: 0 },
      },
    ],
    parentCommentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunityComment",
      default: null,
      index: true,
    },
    // Forwarding copies the message into another thread, pointing back at the
    // original so "who said this first" stays answerable. `forwardedFromAuthor`
    // is a snapshot rather than a populate: the original may be deleted, and a
    // forwarded quote that loses its attribution is worse than none.
    forwardedFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunityComment",
      default: null,
      index: true,
    },
    forwardedFromAuthor: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
    },
    // Who this message names with `@`. Stored as a snapshot of the display name
    // rather than resolved on read: the mention is a statement about what the text
    // said when it was written, and the picker already had the name in hand.
    mentions: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        name: { type: String, default: null, trim: true, maxlength: 100 },
      },
    ],
    // An edit is allowed for a short window after posting, then it stops: a
    // message that can be rewritten an hour later is a message nobody can quote.
    // `editedAt` is what the window is measured against and what the UI labels;
    // the original text is not kept, because "edited" is enough â€” the author said
    // they changed it, and a school chat is not a legal record.
    editedAt: {
      type: Date,
      default: null,
    },
    // The link card for the first URL in `body`, resolved server-side at post time
    // so no reader has to fetch it. Null when the message has no link, or when the
    // fetch failed â€” a preview is a nicety, never a reason to reject a message.
    linkPreview: {
      url: { type: String, default: null },
      title: { type: String, default: null },
      description: { type: String, default: null },
      imageUrl: { type: String, default: null },
      siteName: { type: String, default: null },
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

// The thread order, with `_id` as the tiebreaker: two messages sharing a
// millisecond could otherwise swap places between pages, duplicating one and
// dropping another. This is the index the default page query uses.
communityCommentSchema.index({ postId: 1, createdAt: -1, _id: -1 });

// The derived filters. Each is a prefix of `{ postId: 1, ... }` so a filtered
// page is still a single indexed read.
communityCommentSchema.index({ postId: 1, "media.0": 1 });
communityCommentSchema.index({ postId: 1, "mentions.userId": 1 });
communityCommentSchema.index({ postId: 1, "linkPreview.url": 1 });
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
