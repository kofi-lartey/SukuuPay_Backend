import mongoose from "mongoose";

/**
 * The shape of a community post in the school feed.
 *
 * `postType` decides how much of the rest of the schema the post is expected to
 * honour — a `poll` carries its own tally, a `question` carries an
 * accepted-answer pointer, an `resource` carries pinned media — and Mongoose here
 * enforces that by shape, not by convention:
 *
 *   discussion → plain body + media + tags
 *   question    → body + acceptedCommentId + tags
 *   poll        → poll.question + poll.options with embedded voterIds
 *   resource    → media[] of attachments the Resource Vault can surface
 *
 * Soft delete lives on the row itself (`isDeleted`) rather than the field
 * convention Mongoose gives `deletedAt`, because the feed list must filter on it
 * directly and the distinction has to survive to the moderation UI.
 */

const COMMUNITY_POST_TYPES = ["discussion", "question", "poll", "resource"];
const COMMUNITY_POST_STATUSES = ["active", "archived"];

const communityPostSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      // `refPath` rather than a fixed `ref`: an author is a `User` (staff) or a
      // `Student`, and those are separate collections. A fixed `ref: "User"`
      // made every student-authored row unpopulatable — the query ran against
      // `users` with a `students` `_id` and matched nothing.
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
      enum: ["student", "teacher", "school_admin", "super_admin"],
      required: true,
      default: "student",
    },
    authorName: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
    },
    authorStudentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      default: null,
      index: true,
    },
    clubId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Club",
      default: null,
      index: true,
    },
    postType: {
      type: String,
      enum: COMMUNITY_POST_TYPES,
      required: true,
      default: "discussion",
    },
    title: {
      type: String,
      default: null,
      trim: true,
      maxlength: 300,
    },
    body: {
      type: String,
      default: null,
      trim: true,
      maxlength: 8000,
    },
    media: [
      {
        url: { type: String, default: null },
        publicId: { type: String, default: null, select: false },
        mimeType: { type: String, default: null },
        bytes: { type: Number, default: null, min: 0 },
        originalName: { type: String, default: null, trim: true, maxlength: 255 },
      },
    ],
    tags: [
      { type: String, trim: true, lowercase: true, maxlength: 40 },
    ],
    poll: {
      type: new mongoose.Schema(
        {
          question: { type: String, default: null, trim: true, maxlength: 300 },
          options: [
            {
              text: { type: String, trim: true, maxlength: 200 },
              voterIds: { type: [mongoose.Schema.Types.ObjectId], default: [], ref: "User" },
            },
          ],
          expiresAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    acceptedCommentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunityComment",
      default: null,
      index: true,
    },
    bookmarkedBy: [
      { type: mongoose.Schema.Types.ObjectId, ref: "User", default: [] },
    ],
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    status: {
      type: String,
      enum: COMMUNITY_POST_STATUSES,
      default: "active",
      index: true,
    },
  },
  { timestamps: true }
);

communityPostSchema.index({ schoolId: 1, createdAt: -1 });
communityPostSchema.index({ clubId: 1, createdAt: -1 });
communityPostSchema.index({ schoolId: 1, postType: 1, createdAt: -1 });
communityPostSchema.index({ schoolId: 1, tags: 1, createdAt: -1 });

/**
 * One Club Chat thread per club, enforced by the database rather than by
 * convention.
 *
 * The client's get-or-create is a read followed by a write, and two of them in
 * the same second — React's double-invoked effect in development, or a second
 * tab — both read "no thread" and both write one. That produced two Club Chat
 * posts for a club, and because the client reads whichever it finds first, the
 * thread holding every message could render as empty.
 *
 * A partial index is the right shape: it applies only to Club Chat discussions,
 * so ordinary posts titled "Club Chat" are unaffected, and it makes the second
 * insert fail with E11000 rather than silently succeeding. The service catches
 * that and returns the winner (`ensureClubChat`), so the loser still gets a
 * thread instead of an error.
 *
 * `isDeleted: false` is in the filter so a club can have a fresh thread after a
 * moderator removes the old one without colliding with it.
 */
communityPostSchema.index(
  { clubId: 1 },
  {
    name: "clubChat_unique_per_club",
    unique: true,
    partialFilterExpression: {
      postType: "discussion",
      title: "Club Chat",
      isDeleted: false,
      // `clubId` defaults to null, and a unique index over a nullable field is the
      // "one null row per collection" bug: without this, a Club Chat post that
      // somehow carried no club would be the only one allowed anywhere. `$type`
      // rather than `$ne: null`, because MongoDB refuses to build the `$ne` form.
      clubId: { $type: "objectId" },
    },
  }
);

communityPostSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    if (Array.isArray(ret.media)) {
      ret.media = ret.media.map((m) => {
        if (m && m.publicId) delete m.publicId;
        return m;
      });
    }
    if (ret.poll) {
      ret.poll = {
        ...ret.poll,
        options: Array.isArray(ret.poll.options)
          ? ret.poll.options.map((o) => ({ ...o, voterIds: o?.voterIds || [] }))
          : [],
      };
    }
    return ret;
  },
});

export const COMMUNITY_POST_TYPES_VALUES = COMMUNITY_POST_TYPES;
export const COMMUNITY_POST_STATUSES_VALUES = COMMUNITY_POST_STATUSES;

export const CommunityPost = mongoose.model("CommunityPost", communityPostSchema);
export default CommunityPost;