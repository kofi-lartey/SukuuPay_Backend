import { resolveErrorMessage } from "../../middleware/errorHandler.js";
import {
  listParentConversations,
  getParentConversation,
  createParentMessage,
  markParentConversationRead,
} from "../../services/parent/messages.service.js";

/**
 * The parent's messaging surface, mounted at `/pay/:token/messages...` from
 * `routes/index.js`. Unauthenticated — the token is the credential — so each
 * handler hashes the token before its audit entry (via the service) and shims
 * errors through `resolveErrorMessage` to keep a gateway message off a parent's
 * screen. Mirrors the two rules the academic controllers in
 * `controllers/parent/parent.controller.js` already follow.
 */

export const getConversationsController = async (req, res) => {
  try {
    const { token } = req.params;
    const { page, perPage } = req.query;
    const data = await listParentConversations(token, { page, perPage });

    return res.status(200).json({ success: true, message: "Conversations retrieved", data });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export const getConversationController = async (req, res) => {
  try {
    const { token, threadId } = req.params;
    const data = await getParentConversation(token, threadId);

    return res.status(200).json({ success: true, message: "Conversation retrieved", data });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export const createMessageController = async (req, res) => {
  try {
    const { token } = req.params;
    const { subject, body, threadId } = req.body;
    const data = await createParentMessage(token, { subject, body, threadId }, req.file);

    return res.status(201).json({ success: true, message: "Message sent", data });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export const markConversationReadController = async (req, res) => {
  try {
    const { token, threadId } = req.params;
    const data = await markParentConversationRead(token, threadId);

    return res.status(200).json({ success: true, message: "Conversation marked read", data });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export default {
  getConversationsController,
  getConversationController,
  createMessageController,
  markConversationReadController,
};
