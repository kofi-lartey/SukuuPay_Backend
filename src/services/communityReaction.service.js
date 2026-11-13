import { CommunityReaction } from "../models/CommunityReaction.js";
import { CommunityPost } from "../models/CommunityPost.js";
import { CommunityComment } from "../models/CommunityComment.js";
import ApiError from "../utils/ApiError.js";
import { emitReaction } from "./communityEventEmitter.js";

/**
 * Reactions on posts and comments.
 *
 * ## The field is `type`, and that is the whole bug
 *
 * The API accepts `reactionType` (that is the documented payload) but the schema
 * stores `type`. The service used to pass `reactionType` straight into the model,
 * where Mongoose's strict mode dropped it and the schema default filled in
 * `'like'`. So **every reaction in the database was a like**, and the toggle never
 * matched — tapping "fire" then "fire" again returned `updated` instead of
 * removing, and the count endpoint grouped on a field that was never written.
 *
 * The payload key stays `reactionType` for compatibility; the mapping happens here.
 *
 * A reaction is one row per (target, user), so "toggle" is a delete rather than a
 * flag flip: tapping the same reaction again removes it, and tapping a different
 * one rewrites the row in place.
 */

const REACTION_TYPES = ["like", "helpful", "fire", "support"];
const TARGET_TYPES = ["post", "comment"];

export const addReaction = async (payload, user) => {
  const { targetId, targetType, reactionType } = payload;

  if (!REACTION_TYPES.includes(reactionType)) {
    throw new ApiError(`Invalid reaction type. Must be one of: ${REACTION_TYPES.join(", ")}`, 400);
  }

  if (!TARGET_TYPES.includes(targetType)) {
    throw new ApiError(`Invalid targetType. Must be one of: ${TARGET_TYPES.join(", ")}`, 400);
  }

  /*
   * The target is resolved first, for two reasons.
   *
   * `CommunityReaction.schoolId` is `required: true` and was never set here, so
   * every save failed Mongoose validation and the endpoint answered 500 — the
   * reaction button has never worked. The school comes from the target, because
   * the broadcast has to reach the room that owns the post.
   *
   * Resolving before the write also means a reaction cannot be left pointing at a
   * post that no longer exists.
   */
  const target =
    targetType === "post"
      ? await CommunityPost.findById(targetId).select("schoolId").lean()
      : await CommunityComment.findById(targetId).select("schoolId").lean();

  if (!target) {
    throw new ApiError("That post is no longer available", 404);
  }

  // Check if this user already has a reaction on this target.
  const existing = await CommunityReaction.findOne({
    targetId,
    targetType,
    userId: user._id,
  });

  if (existing) {
    // Toggle: same reaction removes it, a different one is rewritten in place.
    if (existing.type === reactionType) {
      await existing.deleteOne();
      emitReaction(target.schoolId, targetId, targetType, null);
      return { alreadyReacted: true, removed: true };
    }

    existing.type = reactionType;
    await existing.save();
    emitReaction(target.schoolId, targetId, targetType, reactionType);
    return { alreadyReacted: true, updated: true, reactionType };
  }

  const reaction = new CommunityReaction({
    schoolId: target.schoolId,
    targetId,
    targetType,
    type: reactionType,
    userId: user._id,
  });

  await reaction.save();
  emitReaction(target.schoolId, targetId, targetType, reactionType);

  return { alreadyReacted: false, added: true, reactionType };
};

export const fetchReactions = async (targetId, targetType) => {
  if (!TARGET_TYPES.includes(targetType)) {
    throw new ApiError(`Invalid targetType. Must be one of: ${TARGET_TYPES.join(", ")}`, 400);
  }

  const reactions = await CommunityReaction.find({ targetId, targetType })
    .populate("userId", "name studentName firstName")
    .lean();

  return reactions;
};

export const fetchReactionCount = async (targetId, targetType) => {
  if (!TARGET_TYPES.includes(targetType)) {
    throw new ApiError(`Invalid targetType. Must be one of: ${TARGET_TYPES.join(", ")}`, 400);
  }

  /*
   * `find` + reduce rather than an aggregation pipeline.
   *
   * `Model.aggregate` does not cast its arguments, so `$match: { targetId }` with
   * the string the route hands over never matched an ObjectId — the count endpoint
   * returned four zeros for every post, forever. Mongoose casts `find` normally.
   */
  const rows = await CommunityReaction.find({ targetId, targetType })
    .select("type")
    .lean();

  const result = {};
  for (const type of REACTION_TYPES) result[type] = 0;
  for (const row of rows) {
    if (row.type in result) result[row.type] += 1;
  }

  return result;
};

export const removeReaction = async (targetId, targetType, userId) => {
  await CommunityReaction.deleteOne({ targetId, targetType, userId });
};