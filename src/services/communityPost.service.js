import { CommunityPost } from "../models/CommunityPost.js";
import { consumeRateLimit } from "../utils/rateLimiter.js";
import ApiError from "../utils/ApiError.js";
import { emitPostCreated, emitPostDeleted } from "./communityEventEmitter.js";

const CREATE_RATE_LIMIT_KEY = "community:post:create";

export const createPost = async (payload, user) => {
  const {
    schoolId,
    authorId,
    authorRole,
    authorName,
    authorStudentId,
    clubId,
    postType,
    title,
    body,
    tags,
    media,
  } = payload;

  if (!["student", "teacher", "school_admin", "super_admin"].includes(authorRole)) {
    throw new ApiError("Role '" + authorRole + "' is not allowed to create posts", 403);
  }

  if (authorRole === "parent") {
    throw new ApiError("Community access is not available for parents", 403);
  }

  // Rate limit post creation per user per window
  consumeRateLimit(`${CREATE_RATE_LIMIT_KEY}:${user._id}`, 5, 15 * 60 * 1000);

  const post = new CommunityPost({
    schoolId,
    authorId,
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

  const posts = await CommunityPost.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("authorId", "name studentId avatar")
    .lean();

  const total = await CommunityPost.countDocuments(filter);

  return { posts, total };
};

export const fetchPostById = async (postId, user) => {
  const post = await CommunityPost.findById(postId)
    .populate("authorId", "name studentId avatar")
    .lean();

  if (!post || post.isDeleted) {
    throw new ApiError("Post not found", 404);
  }

  return post;
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
  const { schoolId, authorId, authorRole, authorName, question, options } = payload;

  if (authorRole === "parent") {
    throw new ApiError("Community access is not available for parents", 403);
  }

  if (!options || options.length < 2 || options.length > 10) {
    throw new ApiError("A poll must have between 2 and 10 options", 400);
  }

  const post = new CommunityPost({
    schoolId,
    authorId,
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