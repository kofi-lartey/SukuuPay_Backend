import mongoose from "mongoose";
import {
  SHEET_LAYOUT_NAMES,
  DEFAULT_SHEET_LAYOUT,
} from "../utils/idCardSheet.js";

const ID_CARD_BATCH_STATUS = ["pending", "generating", "ready", "failed"];

const idCardBatchSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    studentIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Student",
      },
    ],
    totalCards: {
      type: Number,
      required: true,
      min: 1,
    },
    pdfUrl: {
      type: String,
      default: null,
    },
    publicId: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ID_CARD_BATCH_STATUS,
      default: "pending",
      index: true,
    },
    generationError: {
      type: String,
      default: "",
    },

    /**
     * How the PDF was laid out, so the download page can tell the school what it is
     * about to print.
     */
    sheetLayout: {
      type: String,
      enum: SHEET_LAYOUT_NAMES,
      default: DEFAULT_SHEET_LAYOUT,
    },

    /** Cards on one sheet. Derived from `sheetLayout`, stored for the same reason. */
    cardsPerSheet: {
      type: Number,
      default: 6,
      min: 1,
    },

    /**
     * Front/back pairs in the file.
     *
     * `ceil(cards / cardsPerSheet)`, doubled when both sides are printed.
     */
    sheetCount: {
      type: Number,
      default: 1,
      min: 0,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    /**
     * The template that was used for this batch, if any.
     * Null means the school's default settings were used.
     * Stored so reprints use the same layout even if the template changes.
     */
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IdCardTemplate",
      default: null,
      index: true,
    },

    /**
     * The full settings snapshot used to generate this batch.
     * Stored at creation time so reprints are stable even if the template or
     * school settings change later.
     */
    settingsSnapshot: {
      sheetLayout: { type: String, default: DEFAULT_SHEET_LAYOUT },
      sides: { type: String, enum: ["front_back", "front"], default: "front_back" },
      includeCutGuides: { type: Boolean, default: false },
      showPhoto: { type: Boolean, default: true },
      showQr: { type: Boolean, default: true },
      showStamp: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

idCardBatchSchema.index({ schoolId: 1, createdAt: -1 });

idCardBatchSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const IdCardBatch = mongoose.model("IdCardBatch", idCardBatchSchema);
export { ID_CARD_BATCH_STATUS };
