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

export const startAssessment = async (req, res) => {
  try {
    const student = await requireStudentByToken(req.params.token);
    const assessment = await Assessment.findById(req.params.assessmentId);
    if (!assessment) return res.status(404).json({ success: false, message: "Not found" });
    if (assessment.status !== "published") return res.status(400).json({ success: false, message: "Not available" });
    if (assessment.className !== student.studentClass) return res.status(403).json({ success: false, message: "Not assigned" });
    if (assessment.dueDate && new Date() > new Date(assessment.dueDate)) {
      return res.status(400).json({ success: false, message: "Assessment expired" });
    }

    let sub = await Submission.findOne({ assessmentId: assessment._id, studentId: student._id });
    if (sub && (sub.status === "submitted" || sub.status === "graded")) {
      const totalPts = (assessment.questions || []).reduce((s, q) => s + (q.points || 0), 0);
      const score = sub.totalScore || 0;
      const passed = totalPts > 0 && score >= 0.5 * totalPts;
      if (!passed) {
        sub.status = "in_progress";
        sub.answers = [];
        sub.totalScore = 0;
        sub.startedAt = null;
        sub.expiresAt = null;
      } else {
        return res.json({ success: true, data: { submission: sub, expiresAt: sub.expiresAt, locked: true } });
      }
    }
    if (!sub) {
      sub = new Submission({ schoolId: student.schoolId, assessmentId: assessment._id, studentId: student._id, status: "in_progress" });
    }
    if (!sub.startedAt) {
      sub.startedAt = new Date();
      if (assessment.durationMinutes && assessment.durationMinutes > 0) {
        sub.expiresAt = new Date(sub.startedAt.getTime() + assessment.durationMinutes * 60 * 1000);
      } else {
        sub.expiresAt = assessment.dueDate ? new Date(assessment.dueDate) : null;
      }
    }
    if (assessment.dueDate && sub.expiresAt && sub.expiresAt > new Date(assessment.dueDate)) {
      sub.expiresAt = new Date(assessment.dueDate);
    }
    await sub.save();
    res.json({ success: true, data: { submission: sub, expiresAt: sub.expiresAt, locked: false } });
  } catch (e) {
    res.status(404).json({ success: false, message: "Invalid link" });
  }
};

export const submitAssessment = async (req, res) => {
  try {
    const student = await requireStudentByToken(req.params.token);
    const assessment = await Assessment.findById(req.params.assessmentId);
    if (!assessment) return res.status(404).json({ success: false, message: "Not found" });

    const existing = await Submission.findOne({ assessmentId: assessment._id, studentId: student._id });
    if (existing?.expiresAt && new Date() > new Date(new Date(existing.expiresAt).getTime() + 30000)) {
      return res.status(400).json({ success: false, message: "Time expired" });
    }

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
        studentAnswer: a.studentAnswer ?? "",
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
    const final = req.body.final !== false;
    if (final) {
      sub.status = hasEssay ? "submitted" : "graded";
      sub.submittedAt = new Date();
      if (!hasEssay) {
        sub.gradedAt = new Date();
        sub.resultsReleased = true;
      }
    } else if (sub.status !== "submitted" && sub.status !== "graded") {
      sub.status = "in_progress";
    }
    await sub.save();
    res.json({ success: true, data: sub });
  } catch (e) {
    res.status(404).json({ success: false, message: "Invalid link" });
  }
};