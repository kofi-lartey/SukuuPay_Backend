import { Student } from "../models/studentModel.js";
import { StudyPlan, Assessment, Submission, Meeting } from "../models/LMS.js";
import { buildVisibilityFilter } from "../services/lms.service.js";

const requireStudentByToken = async (token) => {
  const student = await Student.findOne({ uniquePayLinkToken: String(token || "").toUpperCase(), deletedAt: null });
  if (!student) throw new Error("INVALID");
  return student;
};

// The campus a student reads LMS content through. A student with no campus
// (campusId null) is school-wide and sees school-wide content plus every
// campus's shared content; a student at campus X sees school-wide content plus
// campus X's content.
const studentCampusId = (student) => (student.campusId ? String(student.campusId) : null);

export const getStudentLms = async (req, res) => {
  try {
    const student = await requireStudentByToken(req.params.token);
    const cid = studentCampusId(student);
    const base = { schoolId: student.schoolId, className: student.studentClass, status: "published" };
    const [studyPlans, assessments] = await Promise.all([
      StudyPlan.find(buildVisibilityFilter(base, cid)).sort({ createdAt: -1 }),
      Assessment.find(buildVisibilityFilter(base, cid)).sort({ createdAt: -1 }),
    ]);
    const submissions = await Submission.find({ studentId: student._id, schoolId: student.schoolId });
    const subMap = Object.fromEntries(submissions.map((s) => [String(s.assessmentId), s]));
    const assessmentsWithSub = assessments.map((a) => {
      const o = a.toObject();
      const sub = subMap[String(a._id)] || null;
      if (sub && sub.resultsReleased === undefined) sub.resultsReleased = sub.status === "graded";
      o.submission = sub;
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

    // Campus visibility: a campus-scoped assessment is only startable by a
    // student at that campus (or school-wide, campusId null).
    const cid = studentCampusId(student);
    const visible = !assessment.sharingScope || assessment.sharingScope === "school" || !assessment.campusId || String(assessment.campusId) === cid || cid === null;
    if (!visible) return res.status(403).json({ success: false, message: "Not available at your campus" });

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
      sub = new Submission({ schoolId: student.schoolId, campusId: student.campusId || null, assessmentId: assessment._id, studentId: student._id, status: "in_progress" });
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
    if (!sub) sub = new Submission({ schoolId: student.schoolId, campusId: student.campusId || null, assessmentId: assessment._id, studentId: student._id });
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
};export const getStudentMeetings = async (req, res) => {
  try {
    const student = await requireStudentByToken(req.params.token);
    const cid = studentCampusId(student);
    const items = await Meeting.find({
      schoolId: student.schoolId,
      className: student.studentClass,
      status: { $in: ['live', 'scheduled'] },
      ...buildVisibilityFilter({}, cid),
    }).sort({ createdAt: -1 });
    res.json({ success: true, data: items });
  } catch (e) {
    res.status(404).json({ success: false, message: "Invalid link" });
  }
};