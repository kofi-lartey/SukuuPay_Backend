import mongoose from "mongoose";
import { Club } from "../models/Club.js";
import { Student } from "../models/studentModel.js";
import { User } from "../models/userModel.js";
import ApiError from "../utils/ApiError.js";
import { emitClubUpdated } from "./communityEventEmitter.js";
import bcrypt from "bcryptjs";

const CLUB_ELIGIBLE_ROLES = ["student", "teacher", "school_admin", "accountant"];

/**
 * Creator-only authorization for club mutation.
 *
 * ## Why `createdBy` and not `moderatorIds`
 *
 * `moderatorIds` holds the creator plus any future co-moderators and is the
 * right field for moderation affordances, but the requirement is that only the
 * *creator* may edit a club. Keying the edit rule on `moderatorIds` would
 * silently grant co-moderators edit rights, which is a different rule.
 *
 * ## Why a string comparison and not `.populate()`
 *
 * `Club.createdBy` is declared `ref: "User"`, but a student principal's `_id`
 * comes from the `Student` collection (see `middleware/authenticate.js` —
 * students are resolved from `Student`, not `User`). Students may create clubs,
 * so this field legitimately holds **two id namespaces**. Both principals expose
 * `_id` from `authenticate`, so comparing the string forms is correct and safe.
 * Populating the field would resolve against `User` and return `null` for every
 * student-owned club.
 *
 * ## Why it fails closed
 *
 * A legacy club with `createdBy: null` (every club created before this rule was
 * populated) is editable by nobody. That is deliberate: guessing an owner from
 * `memberIds` would hand edit rights to an arbitrary member. The backfill script
 * assigns owners where the answer is unambiguous and reports the rest.
 */
const assertClubCreator = (club, user) => {
  if (!club.createdBy || String(club.createdBy) !== String(user._id)) {
    throw new ApiError(
      "Only the club's creator can make this change",
      403,
      "CLUB_NOT_CREATOR"
    );
  }
};

export const createClub = async (payload, user) => {
  const { name, description, category, privacy, eligibleRoles, password } = payload;

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

  // Default to all roles eligible; preserve creator regardless.
  const roles = Array.isArray(eligibleRoles) && eligibleRoles.length > 0
    ? eligibleRoles.filter((r) => CLUB_ELIGIBLE_ROLES.includes(r))
    : [...CLUB_ELIGIBLE_ROLES];

  let passwordHash = null;
  if (password && password.trim().length > 0) {
    passwordHash = await bcrypt.hash(password.trim(), 10);
  }

  const club = new Club({
    schoolId: user.schoolId,
    name: name.trim(),
    description: description ? description.trim() : "",
    category,
    privacy: privacyValue,
    eligibleRoles: roles,
    password: passwordHash,
    memberIds: user ? [user._id] : [],
    moderatorIds: user ? [user._id] : [],
    // The field the creator-only edit rule reads. It was declared on the schema
    // but never written, so every club had `createdBy: null` and no owner.
    createdBy: user ? user._id : null,
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

/**
 * Update a club's details. Creator-only.
 *
 * ## Guard order
 *
 * Existence is checked **before** authorization, and the lookup is scoped to the
 * caller's school. A club in another school is therefore indistinguishable from
 * one that does not exist, so a non-creator cannot enumerate club ids in schools
 * they are not part of. `fetchClubById` resolves by `_id` alone; this path must
 * not, because ids are not secrets.
 *
 * The previous check read `moderatorIds.some(id => id !== caller)`, which asks
 * "is there any moderator who is not me?" — true for every caller who is not the
 * sole moderator, so it inverted the rule. See `assertClubCreator`.
 */
export const updateClub = async (clubId, payload, user) => {
  const club = await Club.findOne({ _id: clubId, schoolId: user.schoolId });

  if (!club || club.isDeleted) {
    throw new ApiError("Club not found", 404, "CLUB_NOT_FOUND");
  }

  assertClubCreator(club, user);

  if (payload.name !== undefined) club.name = payload.name.trim();
  if (payload.description !== undefined) club.description = payload.description.trim();
  if (payload.category !== undefined) club.category = payload.category;
  if (payload.privacy !== undefined) club.privacy = payload.privacy;
  if (Array.isArray(payload.eligibleRoles) && payload.eligibleRoles.length > 0) {
    club.eligibleRoles = payload.eligibleRoles.filter((r) => CLUB_ELIGIBLE_ROLES.includes(r));
  }

  // Password is `select: false` on the model, so the stored hash is never read
  // back and the edit form cannot pre-fill it. The two states are therefore:
  //   - a non-empty string replaces the hash
  //   - `removePassword: true` clears it
  // A blank/absent password means "leave unchanged", which is why removal needs
  // its own explicit signal rather than overloading blank.
  if (payload.removePassword === true) {
    club.password = null;
  } else if (typeof payload.password === "string" && payload.password.trim().length > 0) {
    club.password = await bcrypt.hash(payload.password.trim(), 10);
  }

  await club.save();
  emitClubUpdated(club.schoolId, club._id, "updated");
  return club;
};

export const toggleClubMembership = async (clubId, user, password) => {
  const club = await Club.findById(clubId).select("+password");

  if (!club || club.isDeleted) {
    throw new ApiError("Club not found", 404);
  }

  // Role-based eligibility: only users whose role is in `eligibleRoles` may join.
  // The creator is always a member/moderator, so this only gates new joiners.
  //
  // `super_admin` is exempt, matching the private-club exemption below. Platform
  // operations is not a school role, so it can never appear in a club's
  // `eligibleRoles` and would otherwise be unable to join any club at all — while
  // `resolveCommunitySchool` already lets it address any school. The two rules
  // disagreed; this is the one that made the gate unusable for the platform.
  const callerRole = user?.role;
  const isAlreadyMember = club.memberIds.some((id) => id.toString() === user._id.toString());
  const isCreatorOrModerator = club.moderatorIds.some((id) => id.toString() === user._id.toString());
  const roleEligible =
    callerRole === "super_admin" ||
    (callerRole && club.eligibleRoles && club.eligibleRoles.includes(callerRole));

  if (!isAlreadyMember && !isCreatorOrModerator && !roleEligible) {
    throw new ApiError("Your role is not eligible to join this club", 403, "CLUB_ROLE_INELIGIBLE");
  }

  if (club.privacy === "private" && callerRole !== "super_admin" && !isCreatorOrModerator) {
    throw new ApiError("Private clubs can only be joined by invitation", 403);
  }

  // Password protection: if the club has a password, the caller must provide the
  // correct one unless they are already a member or the creator/moderator.
  if (club.password && !isAlreadyMember && !isCreatorOrModerator) {
    if (!password || password.trim().length === 0) {
      throw new ApiError("This club is password protected. Please enter the club password.", 403, "CLUB_PASSWORD_REQUIRED");
    }
    const valid = await bcrypt.compare(password.trim(), club.password);
    if (!valid) {
      throw new ApiError("Incorrect club password.", 403, "CLUB_PASSWORD_INVALID");
    }
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

/**
 * Soft-delete a club. Creator-only.
 *
 * A creator-only edit rule that left deletion open to any caller would not be the
 * requirement, so this applies the same guard, the same school scoping and the
 * same 404-before-403 order as `updateClub`. The old check carried the identical
 * inverted `moderatorIds.some(...)` comparison.
 */
export const softDeleteClub = async (clubId, user) => {
  const club = await Club.findOne({ _id: clubId, schoolId: user.schoolId });

  if (!club || club.isDeleted) {
    throw new ApiError("Club not found", 404, "CLUB_NOT_FOUND");
  }

  assertClubCreator(club, user);

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