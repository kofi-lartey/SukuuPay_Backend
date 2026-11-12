import mongoose from "mongoose";

/**
 * Gamification state for a student: points earned from community activity and
 * the badges unlocked along the way. One row per user, keyed to the school so a
 * student who moves (or is transferred) does not inherit another school's tally.
 */
const COMMUNITY_BADGES = [
  "TOP_HELPER",
  "CLUB_LEADER",
  "EARLY_ADOPTER",
  "EVENT_PARTICIPANT",
];

const studentGamificationSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    xp: {
      type: Number,
      default: 0,
      min: 0,
    },
    badges: [
      {
        type: String,
        enum: COMMUNITY_BADGES,
      },
    ],
  },
  { timestamps: true }
);

studentGamificationSchema.index({ schoolId: 1, xp: -1 });

studentGamificationSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const COMMUNITY_BADGES_VALUES = COMMUNITY_BADGES;

export const StudentGamification = mongoose.model(
  "StudentGamification",
  studentGamificationSchema
);
export default StudentGamification;
