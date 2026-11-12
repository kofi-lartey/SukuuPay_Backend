import { Club } from "../models/Club.js";
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
