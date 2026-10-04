import {
  listParentMessages,
  getParentMessage,
  listStudentMessages,
  markParentMessageRead,
  resolveParentMessage,
} from "../services/parentMessage.service.js";

/**
 * The school's parent-message inbox.
 *
 * Thin by design — every query, scope decision and state transition lives in
 * `parentMessage.service.js`. The only thing decided here is the response envelope,
 * which is the same `{ success, data, meta }` shape every other list endpoint in the
 * product replies with, so `toPageMeta` on the client and `Pagination` work unchanged.
 */

// GET /parent-messages?status=&q=&hasAudio=&studentId=&page=&perPage=
export const listParentMessagesController = async (req, res) => {
  try {
    const result = await listParentMessages(req.query, req.user);

    return res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
      // Tab counts ride along rather than costing four extra requests per page load.
      counts: result.counts,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// GET /parent-messages/:id
export const getParentMessageController = async (req, res) => {
  try {
    const result = await getParentMessage(req.params.id, req.user);

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// GET /parent-messages/student/:studentId
export const listStudentMessagesController = async (req, res) => {
  try {
    const result = await listStudentMessages(req.params.studentId, req.query, req.user);

    return res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// PUT /parent-messages/:id/read
export const markParentMessageReadController = async (req, res) => {
  try {
    const result = await markParentMessageRead(req.params.id, req.user);

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// PUT /parent-messages/:id/resolve
export const resolveParentMessageController = async (req, res) => {
  try {
    const result = await resolveParentMessage(req.params.id, req.body, req.user);

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export default {
  listParentMessagesController,
  getParentMessageController,
  listStudentMessagesController,
  markParentMessageReadController,
  resolveParentMessageController,
};