import {
  addReaction,
  fetchReactions,
  fetchReactionCount,
  removeReaction,
} from "../services/communityReaction.service.js";

export const addReactionController = async (req, res) => {
  try {
    const result = await addReaction(req.body, req.user);

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const listReactionsController = async (req, res) => {
  try {
    const { targetId, targetType } = req.params;

    const result = await fetchReactions(targetId, targetType);

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const getReactionCountController = async (req, res) => {
  try {
    const { targetId, targetType } = req.params;

    const result = await fetchReactionCount(targetId, targetType);

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const removeReactionController = async (req, res) => {
  try {
    await removeReaction(req.params.targetId, req.params.targetType, req.user._id);

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export default {
  addReactionController,
  listReactionsController,
  getReactionCountController,
  removeReactionController,
};
