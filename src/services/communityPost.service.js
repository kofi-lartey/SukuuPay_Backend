import { CommunityPost } from "../models/CommunityPost.js";
import { consumeRateLimit } from "../utils/rateLimiter.js";
import ApiError from "../utils/ApiError.js";
import { emitPostCreated, emitPostDeleted } from "./communityEventEmitter.js";
import { resolveRole } from "../middleware/communityAuth.js";
import {
  authorDisplayName,
  authorModelForRole,
  withResolvedAuthorName,
} from "../utils/communityAuthor.js";

const CREATE_RATE_LIMIT_KEY = "community:post:create";

export const createPost = async (payload, user) => {
  const {
    clubId,
    postType = "discussion",
    title,
    body,
    tags,
    media,
  } = payload;

  const authorRole = resolveRole(user);
  const authorId = user?._id;
  const schoolId = user?.schoolId;
  const authorName = authorDisplayName(user);
  const authorModel = authorModelForRole(authorRole);
  const authorStudentId = authorRole === "student" ? (user.studentId || user._id) : null;

  /*
   * Identity is read from the authenticated principal, never from the request
   * body. `validate(createPostSchema)` runs with `stripUnknown: true`, and the
   * schema deliberately does not declare `authorId`/`authorRole`/`schoolId`,
   * so those keys were silently deleted from `req.body` before this service
   * ran. Trusting the body therefore produced `authorRole === undefined` and
   * the "Role 'undefined' is not allowed to create posts" 403; deriving it
   * here removes both the failure and the spoofing surface.
   */
  if (!authorId || !schoolId) {
    throw new ApiError("Your account is not linked to a school", 403, "SCHOOL_ACCESS_DENIED");
  }

  if (!["student", "teacher", "school_admin", "super_admin"].includes(authorRole)) {
    throw new ApiError("Role '" + authorRole + "' is not allowed to create posts", 403);
  }

  // Rate limit post creation per user per window
  consumeRateLimit(`${CREATE_RATE_LIMIT_KEY}:${authorId}`, 5, 15 * 60 * 1000);

  const post = new CommunityPost({
    schoolId,
    authorId,
    authorModel,
    authorRole,
    authorName,
    authorStudentId,
    clubId: postType === "resource" ? null : clubId,
    postType,
    title,
    body,
    tags: postType === "resource" ? [] : (tags || []),
    media: postType === "resource" ? (media || []) : (media || []),
  });

  await post.save();
  emitPostCreated(schoolId, post);
  return post;
};

export const fetchPosts = async ({ schoolId, clubId, postType, skip = 0, limit = 20 }, user) => {
  const filter = { schoolId, isDeleted: false };

  if (clubId) {
    filter.clubId = clubId;
  } else {
    filter.clubId = null;
  }

  if (postType) {
    filter.postType = postType;
  }

  // Every field either collection can supply. `authorId` resolves through
  // `refPath`, so the same projection has to cover a `User` (`name`, `avatar`)
  // and a `Student` (`studentName`, `firstName`, `studentImage`).
  const posts = await CommunityPost.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("authorId", "name firstName studentName studentId avatar studentImage")
    .lean();

  const total = await CommunityPost.countDocuments(filter);

  return { posts: posts.map(withResolvedAuthorName), total };
};

export const fetchPostById = async (postId, user) => {
  const post = await CommunityPost.findById(postId)
    .populate("authorId", "name firstName studentName studentId avatar studentImage")
    .lean();

  if (!post || post.isDeleted) {
    throw new ApiError("Post not found", 404);
  }

  return withResolvedAuthorName(post);
};

export const softDeletePost = async (postId, user) => {
  const post = await CommunityPost.findById(postId);

  if (!post) throw new ApiError("Post not found", 404);

  if (user.role !== "super_admin" && post.authorId.toString() !== user._id.toString()) {
    throw new ApiError("You do not have permission to delete this post", 403);
  }

  post.isDeleted = true;
  await post.save();
  emitPostDeleted(post.schoolId, postId);
  return post;
};

export const togglePostStatus = async (postId, user, status) => {
  const post = await CommunityPost.findById(postId);

  if (!post) throw new ApiError("Post not found", 404);

  if (user.role !== "super_admin" && post.authorId.toString() !== user._id.toString()) {
    throw new ApiError("You do not have permission to change this post's status", 403);
  }

  post.status = status;
  await post.save();
  return post;
};

export const bookmarkPost = async (postId, user) => {
  const post = await CommunityPost.findById(postId);

  if (!post) throw new ApiError("Post not found", 404);

  if (post.bookmarkedBy.includes(user._id)) {
    post.bookmarkedBy.pull(user._id);
  } else {
    post.bookmarkedBy.push(user._id);
  }

  await post.save();
  return post;
};

export const createPoll = async (payload, user) => {
  const { question, options } = payload;
  const authorRole = resolveRole(user);
  const authorId = user?._id;
  const schoolId = user?.schoolId;
  const authorName = authorDisplayName(user);
  const authorModel = authorModelForRole(authorRole);

  if (!authorId || !schoolId) {
    throw new ApiError("Your account is not linked to a school", 403, "SCHOOL_ACCESS_DENIED");
  }

  if (!["student", "teacher", "school_admin", "super_admin"].includes(authorRole)) {
    throw new ApiError("Role '" + authorRole + "' is not allowed to create posts", 403);
  }

  if (!options || options.length < 2 || options.length > 10) {
    throw new ApiError("A poll must have between 2 and 10 options", 400);
  }

  const post = new CommunityPost({
    schoolId,
    authorId,
    authorModel,
    authorRole,
    authorName,
    postType: "poll",
    title: question,
    body: null,
    tags: [],
    poll: {
      question,
      options: options.map((opt) => ({
        text: opt.text || opt,
        voterIds: [],
      })),
    },
  });

  await post.save();
  emitPostCreated(schoolId, post);
  return post;
};
/** The one thread title the platform reserves for a club's chat. */
export const CLUB_CHAT_TITLE = "Club Chat";

/**
 * Returns the club's chat thread, creating it only if none exists.
 *
 * This is the atomic version of what the client used to do inline. The read-then-
 * write it replaces is not safe: two mounts in the same second both see no thread
 * and both create one. Here the partial unique index on `clubId` for Club Chat
 * discussions is the actual guarantee — if two requests race, one insert wins and
 * the other fails with E11000, which is caught and resolved to the winner.
 *
 * The loser gets a thread rather than an error, because "open the club chat"
 * should never fail because someone else opened it a moment earlier.
 */
export const ensureClubChat = async (clubId, user) => {
  const existing = await CommunityPost.findOne({
    clubId,
    postType: "discussion",
    title: CLUB_CHAT_TITLE,
    isDeleted: false,
  }).sort({ createdAt: 1 });

  if (existing) return existing;

  try {
    return await createPost(
      {
        clubId,
        postType: "discussion",
        title: CLUB_CHAT_TITLE,
        body: "Chat thread",
      },
      user
    );
  } catch (error) {
    if (error.code !== 11000) throw error;

    // Lost the race: the other request's row is committed, so read it.
    const winner = await CommunityPost.findOne({
      clubId,
      postType: "discussion",
      title: CLUB_CHAT_TITLE,
      isDeleted: false,
    }).sort({ createdAt: 1 });

    if (!winner) throw error;
    return winner;
  }
};