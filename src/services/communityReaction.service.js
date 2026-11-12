import { CommunityReaction } from "../models/CommunityReaction.js";
import ApiError from "../utils/ApiError.js";
import { emitReaction } from "./communityEventEmitter.js";

export const addReaction = async (payload, user) => {
  const { targetId, targetType, reactionType } = payload;

  if (!["like", "helpful", "fire", "support"].includes(reactionType)) {
    throw new ApiError(`Invalid reaction type. Must be one of: like, helpful, fire, support`, 400);
  }

  if (targetType !== "post" && targetType !== "comment") {
    throw new ApiError(`Invalid targetType. Must be one of: post, comment`, 400);
  }

  // Check if user already has a reaction on this target
  const existing = await CommunityReaction.findOne({
    targetId,
    targetType,
    userId: user._id,
  });

  if (existing) {
    // Toggle: if same reaction, remove it; if different, update it
    if (existing.reactionType === reactionType) {
      await existing.deleteOne();
      return { alreadyReacted: true, removed: true };
    }
    existing.reactionType = reactionType;
    await existing.save();
    return { alreadyReacted: true, updated: true, reactionType };
  }

  const reaction = new CommunityReaction({
    targetId,
    targetType,
    reactionType,
    userId: user._id,
  });

  await reaction.save();
  emitReaction(schoolId, targetId, targetType, reactionType);
  return { alreadyReacted: false, added: true, reactionType };
};

export const fetchReactions = async (targetId, targetType) => {
  if (targetType !== "post" && targetType !== "comment") {
    throw new ApiError(`Invalid targetType. Must be one of: post, comment`, 400);
  }

  const reactions = await CommunityReaction.find({ targetId, targetType })
    .populate("userId", "name")
    .lean();

  return reactions;
};

export const fetchReactionCount = async (targetId, targetType) => {
  if (targetType !== "post" && targetType !== "comment") {
    throw new ApiError(`Invalid targetType. Must be one of: post, comment`, 400);
  }

  const counts = await CommunityReaction.aggregate([
    { $match: { targetId, targetType } },
    { $group: { _id: "$reactionType", count: { $sum: 1 } } },
  ]);

  const result = {};
  counts.forEach((c) => {
    result[c._id] = c.count;
  });

  // Ensure all reaction types have a count (default to 0)
  ["like", "helpful", "fire", "support"].forEach((rt) => {
    if (!(rt in result)) {
      result[rt] = 0;
    }
  });

  return result;
};

export const removeReaction = async (targetId, targetType, userId) => {
  await CommunityReaction.deleteOne({ targetId, targetType, userId });
};