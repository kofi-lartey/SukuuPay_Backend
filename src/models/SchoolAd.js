import mongoose from "mongoose";

// Placements keep the ad surface addressable without duplicating the document.
// `auth_aside` is the green CTA panel on the authentication screens.
export const AD_PLACEMENTS = ["auth_aside", "home_hero", "dashboard_sidebar"];

export const AD_STATUSES = [
  "draft",
  "pending",
  "approved",
  "rejected",
  "expired",
];

const schoolAdSchema = new mongoose.Schema(
  {
    // Denormalised rather than joined: the public slider endpoint is a hot,
    // unauthenticated path and must not trigger a populate per slide.
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      default: null,
      index: true,
    },
    schoolName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },
    headline: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    // Already transformed by Cloudinary on upload; stored as delivered so the
    // client never has to build a transformation URL itself.
    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },
    imagePublicId: {
      type: String,
      default: null,
      select: false,
    },
    // Required. A slider that carries text only in pixels is unreadable to a
    // screen reader, and these render on every unauthenticated auth page.
    imageAlt: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    // https only, enforced in validation: the client renders these directly.
    linkUrl: {
      type: String,
      required: true,
      trim: true,
    },
    placement: {
      type: String,
      enum: AD_PLACEMENTS,
      default: "auth_aside",
      index: true,
    },
    status: {
      type: String,
      enum: AD_STATUSES,
      default: "draft",
      index: true,
    },
    startsAt: {
      type: Date,
      default: null,
    },
    endsAt: {
      type: Date,
      required: true,
    },
    sortWeight: {
      type: Number,
      default: 0,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    rejectedReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: "",
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

// Serves the public query: placement + live status + the date window.
schoolAdSchema.index({ placement: 1, status: 1, endsAt: 1 });
schoolAdSchema.index({ placement: 1, sortWeight: -1, startsAt: 1 });

schoolAdSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const SchoolAd = mongoose.model("SchoolAd", schoolAdSchema);
export default SchoolAd;
