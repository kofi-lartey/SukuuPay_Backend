import mongoose from "mongoose";

const lessonSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    content: { type: String, default: "" },
    resources: { type: [String], default: [] },
  },
  { _id: true }
);

const studyPlanSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true, index: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    lessons: { type: [lessonSchema], default: [] },
    assignedClasses: { type: [String], default: [] },
    assignedStudents: { type: [mongoose.Schema.Types.ObjectId], ref: "Student", default: [] },
  },
  { timestamps: true }
);

export const LmsStudyPlan = mongoose.model("LmsStudyPlan", studyPlanSchema);
export default LmsStudyPlan;