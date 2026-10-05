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
     *
     * A school handed a PDF with no instructions guesses: prints single-sided and ends
     * up with 200 fronts and no backs, or scales to fit and gets cards that are not
     * CR80 and do not fit a badge holder. Naming the layout on the batch makes the
     * download page able to say "5 per sheet, double-sided, flip on the short edge"
     * without guessing what the generator defaulted to on the day it ran.
     */
    sheetLayout: {
      type: String,
      enum: SHEET_LAYOUT_NAMES,
      default: DEFAULT_SHEET_LAYOUT,
    },

    /** Cards on one sheet. Derived from `sheetLayout`, stored for the same reason. */
    cardsPerSheet: {
      type: Number,
      default: 5,
      min: 1,
    },

    /**
     * Front/back pairs in the file.
     *
     * `ceil(cards / cardsPerSheet)`, doubled when both sides are printed. `Math.max(1,
     * …)` rather than a bare `ceil`, so an empty batch records one sheet instead of
     * zero — "0 pages" reads as a failed job rather than an empty one.
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
