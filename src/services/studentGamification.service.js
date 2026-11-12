import { StudentGamification } from "../models/StudentGamification.js";
import { CommunityPost } from "../models/CommunityPost.js";
import { CommunityComment } from "../models/CommunityComment.js";
import { CommunityReaction } from "../models/CommunityReaction.js";
import { Club } from "../models/Club.js";
import ApiError from "../utils/ApiError.js";

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const getOrCreateGamification = async (userId, schoolId) => {
  let row = await StudentGamification.findOne({ userId, schoolId });

  if (!row) {
    row = new StudentGamification({
      userId,
      schoolId,
      xp: 0,
      badges: [],
    });
  }

  return row;
};

export const awardXp = async (userId, schoolId, amount, action) => {
  const row = await getOrCreateGamification(userId, schoolId);
  row.xp += amount;

  // Award badges based on milestones
  if (row.xp >= 100 && !row.badges.includes("TOP_HELPER")) {
    row.badges.push("TOP_HELPER");
  }
  if (row.xp >= 500 && !row.badges.includes("CLUB_LEADER")) {
    row.badges.push("CLUB_LEADER");
  }
  if (row.xp >= 100 && !row.badges.includes("EARLY_ADOPTER")) {
    row.badges.push("EARLY_ADOPTER");
  }

  await row.save();
  return row;
};

export const awardXpForPost = async (postId, userId, schoolId) => {
  const post = await CommunityPost.findById(postId);
  if (!post || post.isDeleted) return;

  // Creator gets 10 XP for a post
  await awardXp(userId, schoolId, 10, "post_create");
};

export const awardXpForComment = async (commentId, userId, schoolId) => {
  const comment = await CommunityComment.findById(commentId);
  if (!comment || comment.isDeleted) return;

  // Comment author gets 5 XP
  await awardXp(userId, schoolId, 5, "comment_create");
};

export const awardXpForAcceptedAnswer = async (commentId, userId, schoolId) => {
  const comment = await CommunityComment.findById(commentId);
  if (!comment || comment.isDeleted) return;

  // Author of accepted answer gets 15 XP
  await awardXp(userId, schoolId, 15, "accepted_answer");
};

export const awardXpForReaction = async (targetId, targetType, reactorUserId, schoolId) => {
  if (targetType === "post") {
    // Post author gets 3 XP per like/helpful reaction
    await awardXp(reactorUserId, schoolId, 3, "reaction_like");
  } else if (targetType === "comment") {
    // Comment author gets 2 XP per reaction
    await awardXp(reactorUserId, schoolId, 2, "reaction_comment");
  }
};

export const getGamificationSummary = async (schoolId) => {
  const rows = await StudentGamification.find({ schoolId })
    .sort({ xp: -1 })
    .limit(10)
    .select("xp badges userId")
    .lean();

  return rows.map((row) => ({
    userId: row.userId,
    xp: row.xp,
    badges: row.badges,
  }));
};

export const getStudentGamification = async (userId, schoolId) => {
  const row = await StudentGamification.findOne({ userId, schoolId }).lean();

  if (!row) {
    return { xp: 0, badges: [] };
  }

  return {
    xp: row.xp,
    badges: row.badges,
  };
};