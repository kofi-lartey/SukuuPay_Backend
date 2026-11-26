import mongoose from "mongoose";

/**
 * A campus belonging to a school.
 *
 * A school on the Campus tier is one legal entity with several physical sites.
 * Students, payments, disbursements and users all carry a `campusId` that points
 * here, so this is the unit a bursar reconciles a site against and the boundary
 * a multi-signatory limit is applied within.
 *
 * `code` is unique *within a school*, not globally: two schools may both have a
 * "MAIN" campus, and the compound index below is what makes that legal while
 * still refusing a second campus with the same code under one school.
 */
const campusSchema = new mongoose.Schema(
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
      maxlength: 150,
    },
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    address: {
      type: String,
      trim: true,
      default: "",
    },
    region: {
      type: String,
      trim: true,
      default: "",
    },
    bursarEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    status: {
      type: String,
      enum: ["active", "suspended", "archived"],
      default: "active",
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// A campus code is unique within its school, not across the platform.
campusSchema.index({ schoolId: 1, code: 1 }, { unique: true });
campusSchema.index({ schoolId: 1, status: 1 });

campusSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const CAMPUS_STATUSES = ["active", "suspended", "archived"];
export const CAMPUS_STATUS_VALUES = CAMPUS_STATUSES;

export const Campus = mongoose.model("Campus", campusSchema);
export default Campus;