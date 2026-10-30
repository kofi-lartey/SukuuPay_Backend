import mongoose from "mongoose";

const lessonSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true, index: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true },
    content: { type: String, default: "" },
    resources: { type: [String], default: [] },
    studyPlanId: { type: mongoose.Schema.Types.ObjectId, ref: "LmsStudyPlan", default: null },
    assignedClasses: { type: [String], default: [] },
    assignedStudents: { type: [mongoose.Schema.Types.ObjectId], ref: "Student", default: [] },
  },
  { timestamps: true }
);

export const LmsLesson = mongoose.model("LmsLesson", lessonSchema);
export default LmsLesson;