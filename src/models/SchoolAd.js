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

    /**
     * The body copy.
     *
     * Added because `headline` is capped at 60 characters and that is a title, not an
     * advertisement. A school asking to be advertised writes "Admissions open for
     * 2026/27 — apply now" and then has nowhere to say *anything else*, so the only
     * copy the product could publish was a headline. This is the field the requester
     * writes and the super admin edits.
     *
     * Nullable, not required: an ad may legitimately be a logo plus a link, and
     * requiring prose would push submissions toward filling the field with filler.
     */
    writeup: {
      type: String,
      default: null,
      trim: true,
      maxlength: 600,
    },

    /**
     * Up to four images.
     *
     * The request is for "images", plural, and one slot could not carry them — the
     * second upload would overwrite the first. `imageUrl` stays the **primary** image
     * and is what the existing placements render; `imageUrls` holds the rest for a
     * carousel or a second variant.
     *
     * Bounded at four by `MAX_AD_IMAGES`. Not a styling constraint: every extra image
     * is another Cloudinary asset the platform pays to store for the life of the ad.
     */
    imageUrls: {
      type: [String],
      default: [],
      validate: {
        validator: (value) => value.length <= 4,
        message: "An advertisement carries at most 4 images",
      },
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

    /**
     * The school user who submitted this, null for a platform-authored ad.
     *
     * Set only on the school-facing create path and **only** from `req.user.schoolId`
     * and `req.user._id` — never from a request parameter. The admin route trusts
     * `:id` because an admin may write for any school; copying that shape into a
     * `school_admin`-authenticated route would let any school publish an ad as another
     * school, which on the public auth pages is a defacement.
     */
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    /**
     * True when a super admin authored this rather than a school submitting it.
     *
     * The product requirement is that a super admin may *create* ad content as well as
     * review a school's, and that anything published is approved. When the author and
     * the approver are the same person that requirement is satisfied by construction,
     * but it is an exception rather than the rule — so it is a flag, and the audit row
     * records `selfApproved: true`. Silently collapsing the two cases would make the
     * audit log claim a separation of duties the platform did not have.
     */
    authoredByPlatform: {
      type: Boolean,
      default: false,
    },

    /**
     * Whether the super admin's copy edits were applied during review.
     *
     * Set when `reviewSchoolAd` changes `writeup` or `headline` on the way to
     * `approved`, so a school can see that what goes live is not what they submitted —
     * rather than discovering it from the login page.
     */
    copyEditedByReview: {
      type: Boolean,
      default: false,
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
