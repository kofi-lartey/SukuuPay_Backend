import mongoose from "mongoose";

const lmsSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true, index: true },
    campusId: { type: mongoose.Schema.Types.ObjectId, ref: "Campus", default: null, index: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sharingScope: { type: String, enum: ["campus", "school"], default: "school" },
    type: { type: String, enum: ["studyplan", "lesson", "resource", "assessment"], required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    content: { type: String, default: "" },
    links: { type: [String], default: [] },
    questions: { type: Array, default: [] },
    assignedTo: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    grades: { type: Array, default: [] },
  },
  { timestamps: true }
);

export const LmsItem = mongoose.model("LmsItem", lmsSchema);
export default LmsItem;