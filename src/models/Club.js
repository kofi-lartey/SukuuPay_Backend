import mongoose from "mongoose";

/**
 * A student club within a school. Clubs are how the community groups
 * conversation: members chat inside the club, share resources into the vault,
 * and run events against the membership.
 */
const COMMUNITY_CATEGORIES = ["academic", "hobby", "sports", "tech"];
const COMMUNITY_PRIVACIES = ["public", "private"];

const clubSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      default: null,
      trim: true,
      maxlength: 2000,
    },
    category: {
      type: String,
      enum: COMMUNITY_CATEGORIES,
      default: "academic",
      index: true,
    },
    privacy: {
      type: String,
      enum: COMMUNITY_PRIVACIES,
      default: "public",
      index: true,
    },
    memberIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: "User", default: [] },
    ],
    moderatorIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: "User", default: [] },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

clubSchema.index({ schoolId: 1, createdAt: -1 });
clubSchema.index({ schoolId: 1, category: 1, privacy: 1, createdAt: -1 });

clubSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const CLUB_CATEGORIES_VALUES = COMMUNITY_CATEGORIES;
export const CLUB_PRIVACIES_VALUES = COMMUNITY_PRIVACIES;

export const Club = mongoose.model("Club", clubSchema);
export default Club;
