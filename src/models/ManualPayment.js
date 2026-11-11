import mongoose from "mongoose";

const manualPaymentSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      index: true,
    },
    referenceCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    expectedAmount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "completed", "expired"],
      default: "pending",
      index: true,
    },
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    amountReceived: { type: Number, default: null },
  },
  { timestamps: true }
);

manualPaymentSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

export const ManualPayment = mongoose.model("ManualPayment", manualPaymentSchema);
export default ManualPayment;
