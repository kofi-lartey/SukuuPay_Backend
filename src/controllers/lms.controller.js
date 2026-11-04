import { StudyPlan, Assessment, Submission } from "../models/LMS.js";
import { Student } from "../models/studentModel.js";
import { resolveTeacherClasses } from "../utils/teacherScope.js";

const teacherId = (req) => req.teacher._id;
const schoolId = (req) => req.teacher.schoolId;
const isAdmin = (req) => ["school_admin", "super_admin"].includes(req.teacher.role);

// ── Study Plans ──
export const listStudyPlans = async (req, res) => {
  const filter = { schoolId: schoolId(req) };
  if (!isAdmin(req)) filter.teacherId = teacherId(req);
  if (req.query.className) filter.className = req.query.className;
  const items = await StudyPlan.find(filter).sort({ createdAt: -1 });
  res.json({ success: true, data: items });
};

export const createStudyPlan = async (req, res) => {
  if (!isAdmin(req) && req.body.className) {
    const classes = await resolveTeacherClasses(req.user, schoolId(req));
    if (!classes.some((c) => c.className === req.body.className)) {
      return res.status(403).json({ success: false, message: "Not assigned to this class" });
    }
  }
  try {
    const item = await StudyPlan.create({ ...req.body, schoolId: schoolId(req), teacherId: teacherId(req) });
    res.status(201).json({ success: true, data: item });
  } catch (e) {
    res.status(422).json({ success: false, message: e.message });
  }
};

export const updateStudyPlan = async (req, res) => {
  const filter = { _id: req.params.id, schoolId: schoolId(req) };
  if (!isAdmin(req)) filter.teacherId = teacherId(req);
  const item = await StudyPlan.findOneAndUpdate(filter, req.body, { returnDocument: 'after' });
  if (!item) return res.status(404).json({ success: false, message: "Not found" });
  res.json({ success: true, data: item });
};

export const deleteStudyPlan = async (req, res) => {
  const filter = { _id: req.params.id, schoolId: schoolId(req) };
  if (!isAdmin(req)) filter.teacherId = teacherId(req);
  const item = await StudyPlan.findOneAndDelete(filter);
  if (!item) return res.status(404).json({ success: false, message: "Not found" });
  res.json({ success: true });
};

// ── Assessments ──
export const listAssessments = async (req, res) => {
  const filter = { schoolId: schoolId(req) };
  if (!isAdmin(req)) filter.teacherId = teacherId(req);
  if (req.query.className) filter.className = req.query.className;
  const items = await Assessment.find(filter).sort({ createdAt: -1 });
  res.json({ success: true, data: items });
};

export const createAssessment = async (req, res) => {
  if (!isAdmin(req) && req.body.className) {
    const classes = await resolveTeacherClasses(req.user, schoolId(req));
    if (!classes.some((c) => c.className === req.body.className)) {
      return res.status(403).json({ success: false, message: "Not assigned to this class" });
    }
  }
  const payload = { ...req.body, schoolId: schoolId(req), teacherId: teacherId(req) };
  if (payload.status === "draft") {
    if (!payload.className) payload.className = "Unassigned";
    if (!payload.subject) payload.subject = "General";
    if (!payload.dueDate) payload.dueDate = new Date(Date.now() + 7 * 86400000);
    if (!payload.title) payload.title = "Untitled Assessment";
  }
  const item = await Assessment.create(payload);
  res.status(201).json({ success: true, data: item });
};

export const updateAssessment = async (req, res) => {
  const filter = { _id: req.params.id, schoolId: schoolId(req) };
  if (!isAdmin(req)) filter.teacherId = teacherId(req);
  const payload = { ...req.body };
  if (payload.status === "draft") {
    if (!payload.className) payload.className = "Unassigned";
    if (!payload.subject) payload.subject = "General";
    if (!payload.dueDate) payload.dueDate = new Date(Date.now() + 7 * 86400000);
    if (!payload.title) payload.title = "Untitled Assessment";
  }
  const item = await Assessment.findOneAndUpdate(filter, payload, { returnDocument: 'after' });
  if (!item) return res.status(404).json({ success: false, message: "Not found" });
  res.json({ success: true, data: item });
};

export const deleteAssessment = async (req, res) => {
  const filter = { _id: req.params.id, schoolId: schoolId(req) };
  if (!isAdmin(req)) filter.teacherId = teacherId(req);
  const item = await Assessment.findOneAndDelete(filter);
  if (!item) return res.status(404).json({ success: false, message: "Not found" });
  res.json({ success: true });
};

export const listSubmissions = async (req, res) => {
  const assessment = await Assessment.findById(req.params.id);
  if (!assessment) return res.status(404).json({ success: false, message: "Not found" });
  const items = await Submission.find({ assessmentId: assessment._id }).populate("studentId", "studentName studentClass").sort({ createdAt: -1 });
  res.json({ success: true, data: items });
};

export const getSubmission = async (req, res) => {
  const sub = await Submission.findById(req.params.submissionId).populate("studentId", "studentName studentClass").populate("assessmentId");
  if (!sub) return res.status(404).json({ success: false, message: "Not found" });
  res.json({ success: true, data: sub });
};

export const resetSubmission = async (req, res) => {
  const sub = await Submission.findById(req.params.submissionId);
  if (!sub) return res.status(404).json({ success: false, message: "Not found" });
  await Submission.deleteOne({ _id: sub._id });
  res.json({ success: true, data: { deleted: true } });
};

// Append at end
export const exportLms = async (req, res) => {
  const kind = req.query.kind;
  const filter = { schoolId: schoolId(req) };
  if (!isAdmin(req)) filter.teacherId = teacherId(req);
  let Model;
  if (kind === "studyplans") Model = StudyPlan;
  else if (kind === "lessons") Model = null;
  else if (kind === "assessments") Model = Assessment;
  else return res.status(400).json({ success: false, message: "Invalid kind" });

  let data;
  if (kind === "lessons") {
    data = await (await import("../models/LMS.js")).LmsLesson ? [] : [];
  }
  // We don't have LmsLesson model in new schema; lessons are embedded in StudyPlan.
  if (kind === "lessons") {
    const plans = await StudyPlan.find(filter);
    data = plans.flatMap((p) => (p.lessons || []).map((l) => ({ studyPlanId: p._id, studyPlanTitle: p.title, ...l.toObject() })));
  } else {
    data = await Model.find(filter);
  }
  res.json({ success: true, data });
};

export const importLms = async (req, res) => {
  const { kind, items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ success: false, message: "items must be array" });
  let created = 0;
  const errors = [];
  for (const it of items) {
    try {
      if (kind === "studyplans") {
        const lessons = Array.isArray(it.lessons) ? it.lessons.map((l) => {
          const out = { ...l };
          if (l?.assessmentTitle) {
            // resolve by title (best-effort) within the same school/class
            // done after; keep title for now
          }
          return out;
        }) : [];
        // resolve assessment titles
        if (lessons.length) {
          const titles = lessons.map((l) => l.assessmentTitle).filter(Boolean);
          if (titles.length) {
            const assessments = await Assessment.find({ schoolId: schoolId(req), title: { $in: titles } });
            const map = new Map(assessments.map((a) => [a.title, a._id]));
            for (const l of lessons) {
              if (l.assessmentTitle && map.has(l.assessmentTitle)) {
                l.assessmentId = map.get(l.assessmentTitle);
              }
              delete l.assessmentTitle;
            }
          } else {
            for (const l of lessons) delete l.assessmentTitle;
          }
        }
        await StudyPlan.create({ ...it, lessons, schoolId: schoolId(req), teacherId: teacherId(req) });
      } else if (kind === "assessments") {
        await Assessment.create({ ...it, schoolId: schoolId(req), teacherId: teacherId(req) });
      } else if (kind === "lessons") {
        if (it.studyPlanId) {
          await StudyPlan.findByIdAndUpdate(it.studyPlanId, { $push: { lessons: { title: it.title, content: it.content, resourceLinks: it.resourceLinks || [], order: it.order || 1 } } });
        } else {
          errors.push("Missing studyPlanId for lesson");
          continue;
        }
      } else {
        return res.status(400).json({ success: false, message: "Invalid kind" });
      }
      created++;
    } catch (e) {
      errors.push(e.message);
    }
  }
  res.status(errors.length ? 422 : 200).json({ success: errors.length === 0, created, errors });
};
export const gradeSubmission = async (req, res) => {
  const sub = await Submission.findById(req.params.submissionId);
  if (!sub) return res.status(404).json({ success: false, message: "Not found" });
  const { totalScore, feedback, answers } = req.body;
  if (typeof totalScore === "number") sub.totalScore = totalScore;
  if (feedback !== undefined) sub.teacherFeedback = feedback;
  if (Array.isArray(answers)) {
    // merge per-answer grading
    const map = new Map(sub.answers.map((a) => [String(a.questionId), a]));
    for (const a of answers) {
      const existing = map.get(String(a.questionId));
      if (existing) {
        if (typeof a.scoreAwarded === "number") existing.scoreAwarded = a.scoreAwarded;
        if (a.teacherFeedback !== undefined) existing.teacherFeedback = a.teacherFeedback;
      }
    }
    sub.totalScore = sub.answers.reduce((sum, a) => sum + (a.scoreAwarded || 0), 0);
  }
  sub.status = "graded";
  sub.gradedAt = new Date();
  await sub.save();
  res.json({ success: true, data: sub });
};
