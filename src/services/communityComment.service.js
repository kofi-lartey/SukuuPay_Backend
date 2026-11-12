import { CommunityPost } from "../models/CommunityPost.js";
import { CommunityComment } from "../models/CommunityComment.js";
import ApiError from "../utils/ApiError.js";
import { emitCommentCreated } from "./communityEventEmitter.js";

export const createComment = async (payload, user) => {
  const { postId, schoolId, parentCommentId, body, authorId, authorRole, authorName } = payload;

  if (!["student", "teacher", "school_admin"].includes(authorRole)) {
    throw new ApiError("Only students, teachers, and school admins may comment", 403);
  }

  if (authorRole === "parent") {
    throw new ApiError("Community access is not available for parents", 403);
  }

  // Verify post exists and is not deleted
  const post = await CommunityPost.findById(postId);
  if (!post || post.isDeleted) {
    throw new ApiError("Post not found", 404);
  }

  // If replying to a comment, verify it belongs to the same post
  if (parentCommentId) {
    const parentComment = await CommunityComment.findById(parentCommentId);
    if (!parentComment || parentComment.postId.toString() !== postId) {
      throw new ApiError("Parent comment not found or does not belong to this post", 404);
    }
  }

  const comment = new CommunityComment({
    postId,
    schoolId,
    parentCommentId,
    body,
    authorId,
    authorRole,
    authorName,
  });

  await comment.save();
  return comment;
};

export const fetchComments = async (postId, { skip = 0, limit = 20 }, user) => {
  // Verify post exists
  const post = await CommunityPost.findById(postId);
  if (!post || post.isDeleted) {
    throw new ApiError("Post not found", 404);
  }

  const comments = await CommunityComment.find({ postId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("authorId", "name studentId avatar")
    .lean();

  const total = await CommunityComment.countDocuments({ postId });

  return { comments, total };
};

export const fetchCommentReplies = async (parentCommentId, { skip = 0, limit = 20 }, user) => {
  const replies = await CommunityComment.find({ parentCommentId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("authorId", "name studentId avatar")
    .lean();

  const total = await CommunityComment.countDocuments({ parentCommentId });

  return { replies, total };
};

export const toggleAcceptAnswer = async (commentId, user) => {
  const comment = await CommunityComment.findById(commentId);

  if (!comment) throw new ApiError("Comment not found", 404);

  if (comment.authorId.toString() !== user._id.toString() && user.role !== "super_admin") {
    throw new ApiError("Only the comment author or super_admin can accept an answer", 403);
  }

  comment.isAcceptedAnswer = !comment.isAcceptedAnswer;
  await comment.save();
  return comment;
};

export const softDeleteComment = async (commentId, user) => {
  const comment = await CommunityComment.findById(commentId);

  if (!comment) throw new ApiError("Comment not found", 404);

  if (comment.authorId.toString() !== user._id.toString() && user.role !== "super_admin") {
    throw new ApiError("You do not have permission to delete this comment", 403);
  }

  comment.isDeleted = true;
  await comment.save();
  return comment;
};