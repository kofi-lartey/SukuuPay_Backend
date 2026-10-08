import mongoose from "mongoose";

const ID_CARD_AUDIENCE = ["student", "staff", "prefect", "visitor", "custom"];

const idCardTemplateSchema = new mongoose.Schema(
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
      maxlength: 80,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },
    isSystem: {
      type: Boolean,
      default: false,
    },
    audience: {
      type: String,
      enum: ID_CARD_AUDIENCE,
      default: "student",
      index: true,
    },
    fields: {
      showPhoto: { type: Boolean, default: true },
      showQr: { type: Boolean, default: true },
      showStamp: { type: Boolean, default: true },
      showEmergency: { type: Boolean, default: true },
      showGuardian: { type: Boolean, default: true },
      showClass: { type: Boolean, default: true },
      showStudentId: { type: Boolean, default: true },
    },
    layout: {
      sheetLayout: {
        type: String,
        enum: ["6up_a4_landscape", "9up_a4_landscape"],
        default: "6up_a4_landscape",
      },
      sides: {
        type: String,
        enum: ["front_back", "front"],
        default: "front_back",
      },
      includeCutGuides: { type: Boolean, default: false },
    },
    theme: {
      brandColor: { type: String, default: null },
      accentColor: { type: String, default: null },
    },
    text: {
      termsOverride: { type: String, maxlength: 500, default: null },
      footerLeft: { type: String, default: "SUKUUPAY" },
      footerRight: { type: String, default: null },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

idCardTemplateSchema.index({ schoolId: 1, slug: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
idCardTemplateSchema.index({ schoolId: 1, isDefault: 1 });
idCardTemplateSchema.index({ schoolId: 1, audience: 1 });

idCardTemplateSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const IdCardTemplate = mongoose.model("IdCardTemplate", idCardTemplateSchema);
export { ID_CARD_AUDIENCE };
