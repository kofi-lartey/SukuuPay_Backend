import mongoose from "mongoose";

const lessonSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  resourceLinks: [{ title: String, url: String }],
  assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Assessment", default: null },
  order: { type: Number, default: 1 },
});

const studyPlanSchema = new mongoose.Schema({
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true, index: true },
  className: { type: String, required: true },
  subject: { type: String, required: true },
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  title: { type: String, required: true },
  description: { type: String },
  coverImage: { type: String, default: "" },
  term: { type: String, required: true },
  academicYear: { type: String, required: true },
  status: { type: String, enum: ["draft", "published"], default: "draft" },
  lessons: [lessonSchema],
}, { timestamps: true });

const questionSchema = new mongoose.Schema({
  type: { type: String, enum: ["multiple_choice", "essay"], required: true },
  questionText: { type: String, required: true },
  options: [String],
  correctAnswer: { type: String },
  points: { type: Number, default: 1 },
  keywords: [String],
  syllabusRef: String,
  rubricStandard: String,
});

const assessmentSchema = new mongoose.Schema({
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true, index: true },
  className: { type: String, required: true },
  subject: { type: String, required: true },
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  title: { type: String, required: true },
  instructions: { type: String },
  dueDate: { type: Date, required: true },
  durationMinutes: { type: Number, default: 0 },
  status: { type: String, enum: ["draft", "published", "closed"], default: "draft" },
  attachedToLesson: { type: Boolean, default: false },
  questions: [questionSchema],
}, { timestamps: true });

const answerSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  studentAnswer: { type: String, default: "" },
  isCorrect: { type: Boolean, default: null },
  scoreAwarded: { type: Number, default: 0 },
  teacherFeedback: { type: String, default: "" },
  graded: { type: Boolean, default: false },
});

const submissionSchema = new mongoose.Schema({
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true, index: true },
  assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Assessment", required: true, index: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
  status: { type: String, enum: ["in_progress", "submitted", "graded"], default: "in_progress" },
  startedAt: { type: Date },
  expiresAt: { type: Date },
  answers: [answerSchema],
  totalScore: { type: Number, default: 0 },
  submittedAt: { type: Date },
  gradedAt: { type: Date },
  resultsReleased: { type: Boolean, default: false },
  teacherFeedback: { type: String, default: "" },
}, { timestamps: true });

const meetingSchema = new mongoose.Schema({
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true, index: true },
  className: { type: String, required: true, index: true },
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  title: { type: String, required: true },
  roomName: { type: String, required: true, unique: true },
  startAt: { type: Date },
  endAt: { type: Date },
  status: { type: String, enum: ["scheduled", "live", "ended"], default: "live" },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

export const StudyPlan = mongoose.model("StudyPlan", studyPlanSchema);
export const Meeting = mongoose.model("Meeting", meetingSchema);
export const Assessment = mongoose.model("Assessment", assessmentSchema);
export const Submission = mongoose.model("Submission", submissionSchema);
export default { StudyPlan, Assessment, Submission };