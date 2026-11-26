import mongoose from "mongoose";

const REPORT_JOB_STATUSES = ["queued", "processing", "completed", "failed"];

const reportJobSchema = new mongoose.Schema(
  {
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReportTemplate",
      required: true,
      index: true,
    },
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: REPORT_JOB_STATUSES,
      default: "queued",
      index: true,
    },
    fileUrl: {
      type: String,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    downloadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    downloadedAt: {
      type: Date,
      default: null,
    },
    errorMessage: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

reportJobSchema.index({ schoolId: 1, createdAt: -1 });
reportJobSchema.index({ templateId: 1, createdAt: -1 });

reportJobSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const ReportJob = mongoose.model("ReportJob", reportJobSchema);
export { REPORT_JOB_STATUSES };
export default ReportJob;
