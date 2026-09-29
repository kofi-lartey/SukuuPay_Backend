import mongoose from "mongoose";

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
      default: null,
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
