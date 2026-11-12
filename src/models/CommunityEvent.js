import mongoose from "mongoose";

/**
 * A school community event. Members RSVP by id; the feed can surface events the
 * student is attending or has interest in, and the community page can render a
 * calendar-style list.
 */
const COMMUNITY_EVENT_TYPES = ["meeting", "competition", "trip", "activity", "virtual"];
const COMMUNITY_EVENT_STATUSES = ["draft", "published", "cancelled"];

const communityEventSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    description: {
      type: String,
      default: null,
      trim: true,
      maxlength: 4000,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    clubId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Club",
      default: null,
      index: true,
    },
    eventType: {
      type: String,
      enum: COMMUNITY_EVENT_TYPES,
      default: "activity",
      index: true,
    },
    startAt: {
      type: Date,
      required: true,
      index: true,
    },
    endAt: {
      type: Date,
      default: null,
    },
    location: {
      type: String,
      default: null,
      trim: true,
      maxlength: 300,
    },
    isVirtual: {
      type: Boolean,
      default: false,
    },
    rsvpIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: "User", default: [] },
    ],
    status: {
      type: String,
      enum: COMMUNITY_EVENT_STATUSES,
      default: "published",
      index: true,
    },
  },
  { timestamps: true }
);

communityEventSchema.index({ schoolId: 1, startAt: -1 });
communityEventSchema.index({ schoolId: 1, status: 1, startAt: -1 });

communityEventSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const COMMUNITY_EVENT_TYPES_VALUES = COMMUNITY_EVENT_TYPES;
export const COMMUNITY_EVENT_STATUSES_VALUES = COMMUNITY_EVENT_STATUSES;

export const CommunityEvent = mongoose.model("CommunityEvent", communityEventSchema);
export default CommunityEvent;
