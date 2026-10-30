import { Student } from "../models/studentModel.js";
import { StudyPlan, Assessment, Submission } from "../models/LMS.js";

const requireStudentByToken = async (token) => {
  const student = await Student.findOne({ uniquePayLinkToken: String(token || "").toUpperCase(), deletedAt: null });
  if (!student) throw new Error("INVALID");
  return student;
};

export const getStudentLms = async (req, res) => {
  try {
    const student = await requireStudentByToken(req.params.token);
    const [studyPlans, assessments] = await Promise.all([
      StudyPlan.find({ schoolId: student.schoolId, className: student.studentClass, status: "published" }).sort({ createdAt: -1 }),
      Assessment.find({ schoolId: student.schoolId, className: student.studentClass, status: "published" }).sort({ createdAt: -1 }),
    ]);
    const submissions = await Submission.find({ studentId: student._id });
    const subMap = Object.fromEntries(submissions.map((s) => [String(s.assessmentId), s]));
    const assessmentsWithSub = assessments.map((a) => {
      const o = a.toObject();
      o.submission = subMap[String(a._id)] || null;
      return o;
    });
    res.json({ success: true, data: { student: { _id: student._id, name: student.studentName, class: student.studentClass }, studyPlans, assessments: assessmentsWithSub } });
  } catch (e) {
    res.status(404).json({ success: false, message: "Invalid link" });
  }
};

export const submitAssessment = async (req, res) => {
  try {
    const student = await requireStudentByToken(req.params.token);
    const assessment = await Assessment.findById(req.params.assessmentId);
    if (!assessment) return res.status(404).json({ success: false, message: "Not found" });

    const qMap = new Map(assessment.questions.map((q) => [String(q._id), q]));
    const answers = (req.body.answers || []).map((a) => {
      const q = qMap.get(String(a.questionId));
      let isCorrect = null;
      let scoreAwarded = 0;
      if (q && q.type === "multiple_choice") {
        isCorrect = String(a.studentAnswer) === String(q.correctAnswer);
        scoreAwarded = isCorrect ? (q.points || 1) : 0;
      }
      return {
        questionId: a.questionId,
        studentAnswer: a.studentAnswer,
        isCorrect,
        scoreAwarded,
        teacherFeedback: "",
      };
    });

    const hasEssay = assessment.questions.some((q) => q.type === "essay");
    const totalScore = answers.reduce((s, a) => s + (a.scoreAwarded || 0), 0);

    let sub = await Submission.findOne({ assessmentId: assessment._id, studentId: student._id });
    if (!sub) sub = new Submission({ schoolId: student.schoolId, assessmentId: assessment._id, studentId: student._id });
    sub.answers = answers;
    sub.totalScore = totalScore;
    sub.status = hasEssay ? "submitted" : "graded";
    sub.submittedAt = new Date();
    if (!hasEssay) sub.gradedAt = new Date();
    await sub.save();
    res.json({ success: true, data: sub });
  } catch (e) {
    res.status(404).json({ success: false, message: "Invalid link" });
  }
};