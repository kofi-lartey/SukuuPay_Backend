import mongoose from "mongoose";
import { Club } from "../models/Club.js";
import { Student } from "../models/studentModel.js";
import { User } from "../models/userModel.js";
import ApiError from "../utils/ApiError.js";
import { emitClubUpdated } from "./communityEventEmitter.js";

export const createClub = async (payload, user) => {
  const { name, description, category, privacy } = payload;

  if (!name || name.trim().length === 0) {
    throw new ApiError("Club name is required", 400);
  }

  if (!category) {
    throw new ApiError("Club category is required", 400);
  }

  const validCategories = ["academic", "hobby", "sports", "tech"];
  if (!validCategories.includes(category)) {
    throw new ApiError(`Invalid category. Must be one of: ${validCategories.join(", ")}`, 400);
  }

  const privacyValue = privacy || "public";
  const validPrivacies = ["public", "private"];
  if (!validPrivacies.includes(privacyValue)) {
    throw new ApiError(`Invalid privacy. Must be one of: ${validPrivacies.join(", ")}`, 400);
  }

  const club = new Club({
    schoolId: user.schoolId,
    name: name.trim(),
    description: description ? description.trim() : "",
    category,
    privacy: privacyValue,
    memberIds: user ? [user._id] : [],
    moderatorIds: user ? [user._id] : [],
  });

  await club.save();
  emitClubUpdated(club.schoolId, club._id, "created");
  return club;
};

export const fetchClubs = async ({ schoolId, skip = 0, limit = 20 }, user) => {
  const filter = { schoolId, isDeleted: false };

  const clubs = await Club.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const total = await Club.countDocuments(filter);

  return { clubs, total };
};

export const fetchClubById = async (clubId, user) => {
  const club = await Club.findById(clubId).lean();

  if (!club || club.isDeleted) {
    throw new ApiError("Club not found", 404);
  }

  return club;
};

export const updateClub = async (clubId, payload, user) => {
  const club = await Club.findById(clubId);

  if (!club || club.isDeleted) {
    throw new ApiError("Club not found", 404);
  }

  if (user.role !== "super_admin" && club.moderatorIds.some((id) => id.toString() !== user._id.toString())) {
    throw new ApiError("You do not have permission to update this club", 403);
  }

  if (payload.name !== undefined) club.name = payload.name.trim();
  if (payload.description !== undefined) club.description = payload.description.trim();
  if (payload.category !== undefined) club.category = payload.category;
  if (payload.privacy !== undefined) club.privacy = payload.privacy;

  await club.save();
  emitClubUpdated(club.schoolId, club._id, "updated");
  return club;
};

export const toggleClubMembership = async (clubId, user) => {
  const club = await Club.findById(clubId);

  if (!club || club.isDeleted) {
    throw new ApiError("Club not found", 404);
  }

  if (club.privacy === "private" && user.role !== "super_admin" && !club.moderatorIds.some((id) => id.toString() === user._id.toString())) {
    throw new ApiError("Private clubs can only be joined by invitation", 403);
  }

  if (club.memberIds.includes(user._id)) {
    club.memberIds.pull(user._id);
  } else {
    club.memberIds.push(user._id);
  }

  await club.save();
  emitClubUpdated(club.schoolId, club._id, "membership");
  return { club, isMember: club.memberIds.includes(user._id) };
};

export const softDeleteClub = async (clubId, user) => {
  const club = await Club.findById(clubId);

  if (!club || club.isDeleted) {
    throw new ApiError("Club not found", 404);
  }

  if (user.role !== "super_admin" && club.moderatorIds.some((id) => id.toString() !== user._id.toString())) {
    throw new ApiError("You do not have permission to delete this club", 403);
  }

  club.isDeleted = true;
  await club.save();
  emitClubUpdated(club.schoolId, club._id, "deleted");
  return club;
};

/**
 * Club members with display names, for the chat header and the @mention picker.
 *
 * ## Why both collections
 *
 * `Club.memberIds` is `ref: "User"`, but a student's id lives in `Student`. The
 * same mismatch that made student authors unpopulatable applies here, so members
 * are resolved in two queries and merged rather than populated.
 *
 * A club is not necessarily all students - a teacher may join - so the caller gets
 * each member's role and can count or filter by it. The chat header asks for
 * students specifically.
 */
export const fetchClubMembers = async (clubId, user) => {
  const club = await Club.findById(clubId).lean();

  if (!club || club.isDeleted) {
    throw new ApiError("Club not found", 404);
  }

  const ids = (club.memberIds || []).map((id) => new mongoose.Types.ObjectId(id));
  if (ids.length === 0) return { members: [], studentCount: 0, memberCount: 0 };

  const [students, users] = await Promise.all([
    Student.find({ _id: { $in: ids }, deletedAt: null }).select("studentName firstName lastName studentImage").lean(),
    User.find({ _id: { $in: ids } }).select("name avatar").lean(),
  ]);

  const members = [
    ...students.map((s) => ({
      _id: String(s._id),
      name: s.firstName || s.studentName || "Student",
      fullName: s.studentName || [s.firstName, s.lastName].filter(Boolean).join(" "),
      role: "student",
      avatar: s.studentImage || null,
    })),
    ...users.map((u) => ({
      _id: String(u._id),
      name: u.name || "User",
      fullName: u.name || "User",
      role: "staff",
      avatar: u.avatar || null,
    })),
  ];

  // Preserve club order so the picker does not reshuffle between renders.
  const byId = new Map(members.map((m) => [m._id, m]));
  const ordered = ids.map((id) => byId.get(String(id))).filter(Boolean);

  return {
    members: ordered,
    memberCount: ordered.length,
    studentCount: ordered.filter((m) => m.role === "student").length,
  };
};