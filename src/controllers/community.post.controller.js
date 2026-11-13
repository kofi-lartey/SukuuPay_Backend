import {
  createPost,
  fetchPosts,
  fetchPostById,
  softDeletePost,
  togglePostStatus,
  bookmarkPost,
  createPoll,
  ensureClubChat,
} from "../services/communityPost.service.js";

/**
 * Posts: create discussion/question/poll/resource posts, list feed, soft-delete.
 *
 * Thin by design â€” every query, scope decision and state transition lives in
 * `communityPost.service.js`. Controllers only decide the response envelope,
 * which is the same `{ success, data }` shape every other endpoint in the
 * product replies with.
 */

export const createPostController = async (req, res) => {
  try {
    const post = await createPost(req.body, req.user);

    return res.status(201).json({ success: true, data: post });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const createPollController = async (req, res) => {
  try {
    const post = await createPoll(req.body, req.user);

    return res.status(201).json({ success: true, data: post });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const listPostsController = async (req, res) => {
  try {
    const { schoolId } = req.user;
    const { clubId, postType, page = 1, perPage = 20 } = req.query;

    const result = await fetchPosts(
      {
        schoolId,
        clubId,
        postType,
        skip: (Number(page) - 1) * Number(perPage),
        limit: Number(perPage),
      },
      req.user
    );

    return res.status(200).json({
      success: true,
      data: result.posts,
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

export const getPostController = async (req, res) => {
  try {
    const post = await fetchPostById(req.params.id, req.user);

    return res.status(200).json({ success: true, data: post });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const deletePostController = async (req, res) => {
  try {
    const post = await softDeletePost(req.params.id, req.user);

    return res.status(200).json({ success: true, data: post });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const togglePostStatusController = async (req, res) => {
  try {
    const post = await togglePostStatus(req.params.id, req.user, req.body.status);

    return res.status(200).json({ success: true, data: post });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const toggleBookmarkController = async (req, res) => {
  try {
    const post = await bookmarkPost(req.params.id, req.user);

    return res.status(200).json({ success: true, data: post });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * `POST /api/community/clubs/:clubId/chat` — get-or-create the club's chat thread.
 *
 * A single server-authoritative call rather than "list posts, then create if
 * absent". The client-side version raced with itself and produced two threads for
 * one club, which is how a thread full of messages came to render as empty.
 */
export const ensureClubChatController = async (req, res) => {
  try {
    const post = await ensureClubChat(req.params.clubId, req.user);
    return res.status(200).json({ success: true, data: post });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

export default {
  createPostController,
  createPollController,
  ensureClubChatController,
  listPostsController,
  getPostController,
  deletePostController,
  togglePostStatusController,
  toggleBookmarkController,
};
