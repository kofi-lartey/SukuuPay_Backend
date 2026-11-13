import { CommunityPost } from "../models/CommunityPost.js";
import { CommunityComment } from "../models/CommunityComment.js";
import ApiError from "../utils/ApiError.js";
import { emitCommentCreated } from "./communityEventEmitter.js";
import { resolveRole } from "../middleware/communityAuth.js";
import { fetchLinkPreview, firstUrlIn } from "../utils/linkPreview.js";
import {
  authorDisplayName,
  authorModelForRole,
  withResolvedAuthorName,
} from "../utils/communityAuthor.js";

/**
 * How long a message stays editable.
 *
 * Fifteen minutes. Long enough to fix a typo after the fact, short enough that a
 * message someone has already replied to cannot be rewritten under them — which is
 * the failure mode an unbounded edit window creates.
 */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Resolves the preview card for a message body, or null.
 *
 * Best-effort by design: a link whose site blocks bots, times out, or returns a
 * 403 produces no card and must not stop the message. The fetch itself is
 * SSRF-guarded (`utils/linkPreview.js`) — the server is fetching a URL a student
 * chose, which is exactly the shape of request that file exists to constrain.
 */
const previewFor = async (body) => {
  const url = firstUrlIn(body);
  if (!url) return null;

  try {
    return await fetchLinkPreview(url);
  } catch (error) {
    console.warn(`[CommunityComment] link preview failed for ${url}: ${error.message}`);
    return null;
  }
};

export const createComment = async (payload, user) => {
  const { postId, parentCommentId, body, media, forwardedFrom } = payload;

  /*
   * Same rule as posts: the author comes from the authenticated principal.
   * `validate(createCommentSchema)` runs with `stripUnknown: true` and that
   * schema does not declare `authorId`/`authorRole`/`schoolId`/`authorName`,
   * so reading them off the body yielded `authorRole === undefined` and a 403
   * "Only students, teachers, and school admins may comment" for every caller.
   */
  const authorRole = resolveRole(user);
  const authorId = user?._id;
  const schoolId = user?.schoolId;
  const authorName = authorDisplayName(user);
  const authorModel = authorModelForRole(authorRole);

  if (!authorId || !schoolId) {
    throw new ApiError("Your account is not linked to a school", 403, "SCHOOL_ACCESS_DENIED");
  }

  if (!["student", "teacher", "school_admin", "super_admin"].includes(authorRole)) {
    throw new ApiError("Only students, teachers, and school admins may comment", 403);
  }

  // Verify post exists and is not deleted
  const post = await CommunityPost.findById(postId);
  if (!post || post.isDeleted) {
    throw new ApiError("Post not found", 404);
  }

  /*
   * A post belongs to exactly one school, and the principal is pinned to
   * theirs. Without this a teacher could comment on another school's post by
   * guessing an id, and the comment would be written with the *commenter's*
   * schoolId — a row that appears in two scopes at once.
   */
  if (String(post.schoolId) !== String(schoolId)) {
    throw new ApiError("You do not have access to that post", 403, "SCHOOL_ACCESS_DENIED");
  }

  // If replying to a comment, verify it belongs to the same post
  if (parentCommentId) {
    const parentComment = await CommunityComment.findById(parentCommentId);
    if (!parentComment || parentComment.postId.toString() !== postId) {
      throw new ApiError("Parent comment not found or does not belong to this post", 404);
    }
  }

  /*
   * Forwarding copies a message into this thread with a pointer back at the
   * original. The source is resolved here rather than trusted from the client for
   * the same reason identity is: a body that named an arbitrary id could quote a
   * message from another school.
   */
  let forwardedFromAuthor = null;
  let forwardedFromId = null;
  if (forwardedFrom) {
    const source = await CommunityComment.findById(forwardedFrom);
    if (!source || source.isDeleted) {
      throw new ApiError("That message no longer exists", 404);
    }
    if (String(source.schoolId) !== String(schoolId)) {
      throw new ApiError("You cannot forward a message from another school", 403, "SCHOOL_ACCESS_DENIED");
    }
    forwardedFromId = source._id;
    forwardedFromAuthor = source.authorName || null;
  }

  // A message must carry text, a file, or a forward.
  if (!body && (!media || media.length === 0) && !forwardedFromId) {
    throw new ApiError("Write something or attach a file", 400, "MESSAGE_EMPTY");
  }

  const comment = new CommunityComment({
    postId,
    schoolId,
    parentCommentId,
    body: body || null,
    media: media || [],
    forwardedFrom: forwardedFromId,
    forwardedFromAuthor,
    linkPreview: await previewFor(body),
    authorId,
    authorModel,
    authorRole,
    authorName,
  });

  await comment.save();

  /*
   * The emitter was imported but never called, so a new comment only appeared
   * for whoever refetched — in a chat thread that reads as "my message did not
   * send" for everyone else in the room.
   */
  emitCommentCreated(schoolId, postId, comment._id);

  return comment;
};

/**
 * Edits a message inside the edit window.
 *
 * The author is the only editor, and only for `EDIT_WINDOW_MS` after posting. The
 * window is measured from `createdAt`, not from the last edit, so it cannot be
 * extended by editing repeatedly.
 *
 * `editedAt` is stamped rather than a boolean flag, because the UI needs to show
 * *that* it was edited and a reader asking "how stale is this?" needs a time.
 */
export const updateComment = async (commentId, body, user) => {
  const role = resolveRole(user);
  const userId = user?._id;

  const comment = await CommunityComment.findById(commentId);
  if (!comment || comment.isDeleted) {
    throw new ApiError("Message not found", 404);
  }

  if (String(comment.authorId) !== String(userId)) {
    throw new ApiError("You can only edit your own message", 403);
  }

  const age = Date.now() - new Date(comment.createdAt).getTime();
  if (age > EDIT_WINDOW_MS) {
    throw new ApiError("That message can no longer be edited", 403, "EDIT_WINDOW_CLOSED");
  }

  const text = (body || "").trim();
  if (!text) {
    throw new ApiError("A message cannot be empty", 400);
  }

  comment.body = text;
  comment.editedAt = new Date();
  comment.linkPreview = await previewFor(text);

  await comment.save();
  return comment;
};

export const fetchComments = async (postId, { skip = 0, limit = 20 }, user) => {
  const post = await CommunityPost.findById(postId);
  if (!post || post.isDeleted) {
    throw new ApiError("Post not found", 404);
  }

  const comments = await CommunityComment.find({ postId, isDeleted: false })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("authorId", "name firstName studentName studentId avatar studentImage")
    // The quoted parent a reply shows above its body. Populated rather than left
    // as an id so the thread can render "replying to Kwame" without a second
    // request per reply.
    .populate("parentCommentId", "_id authorName body")
    .lean();

  const total = await CommunityComment.countDocuments({ postId, isDeleted: false });

  return { comments: comments.map(withResolvedAuthorName), total };
};

export const fetchCommentReplies = async (parentCommentId, { skip = 0, limit = 20 }, user) => {
  const replies = await CommunityComment.find({ parentCommentId, isDeleted: false })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("authorId", "name firstName studentName studentId avatar studentImage")
    .lean();

  const total = await CommunityComment.countDocuments({ parentCommentId, isDeleted: false });

  return { replies: replies.map(withResolvedAuthorName), total };
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

  // A second delete is not an error: two devices tapping the same message, or a
  // retry after a slow network, should both end in "gone" rather than a 404 that
  // the client would surface as a failure.
  if (!comment || comment.isDeleted) {
    throw new ApiError("Message not found", 404);
  }

  if (comment.authorId.toString() !== user._id.toString() && user.role !== "super_admin") {
    throw new ApiError("You do not have permission to delete this message", 403);
  }

  comment.isDeleted = true;
  await comment.save();
  return comment;
};