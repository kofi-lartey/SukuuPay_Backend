import mongoose from "mongoose";

const questionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["mcq", "essay"], required: true },
    prompt: { type: String, required: true },
    options: { type: [String], default: [] },
    correctAnswer: { type: String, default: "" },
    points: { type: Number, default: 1 },
  },
  { _id: true }
);

const assessmentSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true, index: true },
    campusId: { type: mongoose.Schema.Types.ObjectId, ref: "Campus", default: null, index: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    questions: { type: [questionSchema], default: [] },
    assignedClasses: { type: [String], default: [] },
    assignedStudents: { type: [mongoose.Schema.Types.ObjectId], ref: "Student", default: [] },
    dueDate: { type: Date, default: null },
  },
  { timestamps: true }
);

export const LmsAssessment = mongoose.model("LmsAssessment", assessmentSchema);
export default LmsAssessment;