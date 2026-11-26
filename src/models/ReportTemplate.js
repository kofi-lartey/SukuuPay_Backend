import mongoose from "mongoose";

const REPORT_TEMPLATE_TYPES = ["moe_compliance", "custom_audit", "financial_summary"];
const REPORT_TEMPLATE_FORMATS = ["csv", "pdf", "xlsx"];

const reportTemplateSchema = new mongoose.Schema(
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
    },
    type: {
      type: String,
      enum: REPORT_TEMPLATE_TYPES,
      required: true,
    },
    format: {
      type: String,
      enum: REPORT_TEMPLATE_FORMATS,
      default: "csv",
    },
    moeCompliant: {
      type: Boolean,
      default: false,
    },
    parameters: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
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
  },
  { timestamps: true }
);

reportTemplateSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const ReportTemplate = mongoose.model("ReportTemplate", reportTemplateSchema);
export { REPORT_TEMPLATE_TYPES, REPORT_TEMPLATE_FORMATS };
export default ReportTemplate;
