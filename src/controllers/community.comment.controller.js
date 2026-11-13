import {
  createComment,
  fetchComments,
  fetchCommentReplies,
  updateComment,
  toggleAcceptAnswer,
  softDeleteComment,
} from "../services/communityComment.service.js";
import { fetchLinkPreview } from "../utils/linkPreview.js";

export const createCommentController = async (req, res) => {
  try {
    const comment = await createComment(req.body, req.user);

    return res.status(201).json({ success: true, data: comment });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const listCommentsController = async (req, res) => {
  try {
    const { page = 1, perPage = 20 } = req.query;

    const result = await fetchComments(
      req.params.postId,
      { skip: (Number(page) - 1) * Number(perPage), limit: Number(perPage) },
      req.user
    );

    return res.status(200).json({
      success: true,
      data: result.comments,
      meta: {
        page: Number(page),
        perPage: Number(perPage),
        total: result.total,
        totalPages: Math.ceil(result.total / Number(perPage)),
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const listRepliesController = async (req, res) => {
  try {
    const { page = 1, perPage = 20 } = req.query;

    const result = await fetchCommentReplies(
      req.params.commentId,
      { skip: (Number(page) - 1) * Number(perPage), limit: Number(perPage) },
      req.user
    );

    return res.status(200).json({
      success: true,
      data: result.replies,
      meta: {
        page: Number(page),
        perPage: Number(perPage),
        total: result.total,
        totalPages: Math.ceil(result.total / Number(perPage)),
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const updateCommentController = async (req, res) => {
  try {
    const comment = await updateComment(req.params.id, req.body.body, req.user);
    return res.status(200).json({ success: true, data: comment });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

export const linkPreviewController = async (req, res) => {
  try {
    const preview = await fetchLinkPreview(req.body.url);
    return res.status(200).json({ success: true, data: preview });
  } catch (error) {
    // A link that cannot be previewed is not a failed request — the composer shows
    // no card and the message sends normally. A 200 with `data: null` keeps the
    // client from treating an unpreviewable link as an error toast.
    return res.status(200).json({ success: true, data: null, message: error.message });
  }
};

export const toggleAcceptAnswerController = async (req, res) => {
  try {
    const comment = await toggleAcceptAnswer(req.params.id, req.user);

    return res.status(200).json({ success: true, data: comment });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const deleteCommentController = async (req, res) => {
  try {
    const comment = await softDeleteComment(req.params.id, req.user);

    return res.status(200).json({ success: true, data: comment });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export default {
  createCommentController,
  listCommentsController,
  listRepliesController,
  updateCommentController,
  linkPreviewController,
  toggleAcceptAnswerController,
  deleteCommentController,
};
