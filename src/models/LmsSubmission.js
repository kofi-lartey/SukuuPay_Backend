import mongoose from "mongoose";

const submissionSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true, index: true },
    assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: "LmsAssessment", required: true, index: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    answers: { type: [{ questionIndex: Number, answer: String }], default: [] },
    score: { type: Number, default: null },
    feedback: { type: String, default: "" },
    status: { type: String, enum: ["submitted", "graded"], default: "submitted" },
    gradedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    gradedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const LmsSubmission = mongoose.model("LmsSubmission", submissionSchema);
export default LmsSubmission;