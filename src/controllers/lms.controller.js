import { StudyPlan, Assessment, Submission, Meeting } from "../models/LMS.js";
import { Student } from "../models/studentModel.js";
import { resolveTeacherClasses } from "../utils/teacherScope.js";
import * as lmsService from "../services/lms.service.js";

const teacherId = (req) => req.teacher._id;
const schoolId = (req) => req.teacher.schoolId;
const isAdmin = (req) => ["school_admin", "super_admin"].includes(req.teacher.role);

// Campus id resolved by the requireCampusMembership middleware (query/body/params),
// or by the controller when a route does not run that middleware.
const campusIdOf = (req) =>
  req.campusId !== undefined
    ? req.campusId
    : (req.query?.campusId ?? req.body?.campusId ?? null);

const fail = (res, e) => {
  const status = e.status || (e.name === "CastError" ? 400 : 500);
  const code = e.code || (e.name === "CastError" ? "INVALID_ID" : "ERROR");
  res.status(status).json({ success: false, message: e.message, ...(code !== "ERROR" ? { code } : {}) });
};

// ── Study Plans ──
export const listStudyPlans = async (req, res) => {
  try {
    const items = await lmsService.listStudyPlans({
      schoolId: schoolId(req),
      teacherId: teacherId(req),
      isAdmin: isAdmin(req),
      campusId: campusIdOf(req),
      className: req.query.className,
    });
    res.json({ success: true, data: items });
  } catch (e) {
    fail(res, e);
  }
};

export const createStudyPlan = async (req, res) => {
  try {
    if (!isAdmin(req) && req.body.className) {
      const classes = await resolveTeacherClasses(req.user, schoolId(req));
      if (!classes.some((c) => c.className === req.body.className)) {
        return res.status(403).json({ success: false, message: "Not assigned to this class" });
      }
    }
    const item = await lmsService.createStudyPlan({
      data: req.body,
      user: req.user,
      schoolId: schoolId(req),
      teacherId: teacherId(req),
      campusId: campusIdOf(req),
    });
    res.status(201).json({ success: true, data: item });
  } catch (e) {
    fail(res, e);
  }
};

export const updateStudyPlan = async (req, res) => {
  try {
    const item = await lmsService.updateStudyPlan({
      id: req.params.id,
      data: req.body,
      user: req.user,
      schoolId: schoolId(req),
      teacherId: teacherId(req),
      isAdmin: isAdmin(req),
    });
    if (!item) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, data: item });
  } catch (e) {
    fail(res, e);
  }
};

export const deleteStudyPlan = async (req, res) => {
  try {
    await lmsService.deleteStudyPlan({
      id: req.params.id,
      schoolId: schoolId(req),
      teacherId: teacherId(req),
      isAdmin: isAdmin(req),
    });
    res.json({ success: true });
  } catch (e) {
    fail(res, e);
  }
};

// ── Assessments ──
export const listAssessments = async (req, res) => {
  try {
    const items = await lmsService.listAssessments({
      schoolId: schoolId(req),
      teacherId: teacherId(req),
      isAdmin: isAdmin(req),
      campusId: campusIdOf(req),
      className: req.query.className,
    });
    res.json({ success: true, data: items });
  } catch (e) {
    fail(res, e);
  }
};

export const createAssessment = async (req, res) => {
  try {
    if (!isAdmin(req) && req.body.className) {
      const classes = await resolveTeacherClasses(req.user, schoolId(req));
      if (!classes.some((c) => c.className === req.body.className)) {
        return res.status(403).json({ success: false, message: "Not assigned to this class" });
      }
    }
    const item = await lmsService.createAssessment({
      data: req.body,
      user: req.user,
      schoolId: schoolId(req),
      teacherId: teacherId(req),
      campusId: campusIdOf(req),
    });
    res.status(201).json({ success: true, data: item });
  } catch (e) {
    fail(res, e);
  }
};

export const updateAssessment = async (req, res) => {
  try {
    const item = await lmsService.updateAssessment({
      id: req.params.id,
      data: req.body,
      user: req.user,
      schoolId: schoolId(req),
      teacherId: teacherId(req),
      isAdmin: isAdmin(req),
    });
    if (!item) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, data: item });
  } catch (e) {
    fail(res, e);
  }
};

export const deleteAssessment = async (req, res) => {
  try {
    await lmsService.deleteAssessment({
      id: req.params.id,
      schoolId: schoolId(req),
      teacherId: teacherId(req),
      isAdmin: isAdmin(req),
    });
    res.json({ success: true });
  } catch (e) {
    fail(res, e);
  }
};

export const listSubmissions = async (req, res) => {
  try {
    const items = await lmsService.listSubmissions({
      assessmentId: req.params.id,
      campusId: campusIdOf(req),
    });
    res.json({ success: true, data: items });
  } catch (e) {
    fail(res, e);
  }
};

export const getSubmission = async (req, res) => {
  try {
    const sub = await lmsService.getSubmission({
      submissionId: req.params.submissionId,
      user: req.user,
      campusId: campusIdOf(req),
    });
    res.json({ success: true, data: sub });
  } catch (e) {
    fail(res, e);
  }
};

export const resetSubmission = async (req, res) => {
  const sub = await Submission.findById(req.params.submissionId);
  if (!sub) return res.status(404).json({ success: false, message: "Not found" });
  await Submission.deleteOne({ _id: sub._id });
  res.json({ success: true, data: { deleted: true } });
};

// Append at end
export const exportLms = async (req, res) => {
  try {
    const kind = req.query.kind;
    const filter = lmsService.buildVisibilityFilter(
      { schoolId: schoolId(req), ...(!isAdmin(req) ? { teacherId: teacherId(req) } : {}) },
      campusIdOf(req)
    );
    let Model;
    if (kind === "studyplans") Model = StudyPlan;
    else if (kind === "lessons") Model = null;
    else if (kind === "assessments") Model = Assessment;
    else return res.status(400).json({ success: false, message: "Invalid kind" });

    let data;
    if (kind === "lessons") {
      const plans = await StudyPlan.find(filter);
      data = plans.flatMap((p) => (p.lessons || []).map((l) => ({ studyPlanId: p._id, studyPlanTitle: p.title, ...l.toObject() })));
    } else {
      data = await Model.find(filter);
    }
    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

export const importLms = async (req, res) => {
  try {
    const { kind, items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ success: false, message: "items must be array" });
    const cid = campusIdOf(req);
    const sharingScope = req.body.sharingScope === "campus" ? "campus" : "school";
    let created = 0;
    const errors = [];
    for (const it of items) {
      try {
        if (kind === "studyplans") {
          const lessons = Array.isArray(it.lessons) ? it.lessons.map((l) => {
            const out = { ...l };
            if (l?.assessmentTitle) {
              // resolve by title (best-effort) within the same school/class
            }
            return out;
          }) : [];
          if (lessons.length) {
            const titles = lessons.map((l) => l.assessmentTitle).filter(Boolean);
            if (titles.length) {
              const assessments = await Assessment.find({
                schoolId: schoolId(req),
                title: { $in: titles },
                ...lmsService.buildVisibilityFilter({}, lmsService.normaliseCampusId(cid)),
              });
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
          await lmsService.createStudyPlan({
            data: { ...it, lessons },
            user: req.user,
            schoolId: schoolId(req),
            teacherId: teacherId(req),
            campusId: cid,
          });
          // createStudyPlan reads sharingScope from data; apply request-level default
          if (sharingScope === "campus" && cid) {
            await StudyPlan.updateMany({ _id: { $in: (await StudyPlan.find({ schoolId: schoolId(req), title: it.title }).select("_id")) } }, { sharingScope: "campus", campusId: cid }).catch(() => {});
          }
        } else if (kind === "assessments") {
          await lmsService.createAssessment({
            data: { ...it, sharingScope },
            user: req.user,
            schoolId: schoolId(req),
            teacherId: teacherId(req),
            campusId: cid,
          });
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
  } catch (e) {
    fail(res, e);
  }
};
export const gradeSubmission = async (req, res) => {
  try {
    const sub = await Submission.findById(req.params.submissionId);
    if (!sub) return res.status(404).json({ success: false, message: "Not found" });
    const { totalScore, feedback, answers } = req.body;
    if (typeof totalScore === "number") sub.totalScore = totalScore;
    if (feedback !== undefined) sub.teacherFeedback = feedback;
    if (Array.isArray(answers)) {
      const assessment = await Assessment.findById(sub.assessmentId);
      const essayIds = new Set((assessment?.questions || []).filter((q) => q.type === "essay").map((q) => String(q._id)));
      const map = new Map(sub.answers.map((a) => [String(a.questionId), a]));
      for (const a of answers) {
        const existing = map.get(String(a.questionId));
        if (existing) {
          if (typeof a.scoreAwarded === "number") existing.scoreAwarded = a.scoreAwarded;
          if (a.teacherFeedback !== undefined) existing.teacherFeedback = a.teacherFeedback;
          if (essayIds.has(String(a.questionId))) existing.graded = true;
        }
      }
      sub.totalScore = sub.answers.reduce((sum, a) => sum + (a.scoreAwarded || 0), 0);
      const allEssaysGraded = sub.answers.every((a) => !essayIds.has(String(a.questionId)) || a.graded);
      if (allEssaysGraded) sub.resultsReleased = true;
    }
    sub.status = "graded";
    sub.gradedAt = new Date();
    sub.resultsReleased = true;
    await sub.save();
    res.json({ success: true, data: sub });
  } catch (e) {
    fail(res, e);
  }
};
// -- Gradebook --
export const getGradebook = async (req, res) => {
  try {
    const sc = schoolId(req);
    const cid = campusIdOf(req);
    const classes = await resolveTeacherClasses(req.user, sc);
    const filtered = req.query.className ? classes.filter((c) => c.className === req.query.className) : classes;
    const result = [];
    for (const cls of filtered) {
      const studentFilter = { schoolId: sc, studentClass: cls.className, deletedAt: null };
      if (cid) studentFilter.campusId = lmsService.normaliseCampusId(cid);
      const students = await Student.find(studentFilter).select("studentName studentId").sort({ studentName: 1 });
      const assessments = await Assessment.find(
        lmsService.buildVisibilityFilter(
          { schoolId: sc, className: cls.className, status: "published" },
          lmsService.normaliseCampusId(cid)
        )
      ).sort({ createdAt: 1 });
      const ids = assessments.map((a) => a._id);
      const submissions = await Submission.find({ assessmentId: { $in: ids }, studentId: { $in: students.map((s) => s._id) } });
      const subMap = new Map(submissions.map((s) => [String(s.studentId) + "|" + String(s.assessmentId), s]));
      const rows = students.map((st) => {
        const grades = {};
        let totalScore = 0;
        let totalPoints = 0;
        for (const a of assessments) {
          const sub = subMap.get(String(st._id) + "|" + String(a._id));
          const pts = (a.questions || []).reduce((s, q) => s + (q.points || 0), 0);
          const score = sub ? (sub.totalScore || 0) : null;
          grades[String(a._id)] = { score, total: pts, status: sub?.status || "not_taken", resultsReleased: !!sub?.resultsReleased };
          if (sub && sub.resultsReleased) { totalScore += score || 0; totalPoints += pts; }
        }
        const cumulative = totalPoints > 0 ? Math.round((totalScore / totalPoints) * 100) : null;
        return { studentId: st._id, studentName: st.studentName, grades, totalScore, totalPoints, cumulative };
      });
      result.push({ className: cls.className, assessments: assessments.map((a) => ({ _id: a._id, title: a.title, totalPoints: (a.questions || []).reduce((s, q) => s + (q.points || 0), 0) })), rows });
    }
    res.json({ success: true, data: result });
  } catch (e) {
    fail(res, e);
  }
};
// -- Analytics --
export const getLmsAnalytics = async (req, res) => {
  try {
    // Lightweight sanitisation, matching getGradebook's inline query handling:
    // className/subject/term/academicYear are read as trimmed strings, no Joi.
    const str = (v) => (typeof v === "string" ? v.trim() : undefined);
    const data = await lmsService.getLmsAnalytics({
      schoolId: schoolId(req),
      teacherId: teacherId(req),
      isAdmin: isAdmin(req),
      campusId: campusIdOf(req),
      className: str(req.query.className),
      subject: str(req.query.subject),
      term: str(req.query.term),
      academicYear: str(req.query.academicYear),
      user: req.user,
    });
    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};
// -- Meetings --
export const createMeeting = async (req, res) => {
  try {
    const sc = schoolId(req);
    const { className } = req.body;
    const classes = await resolveTeacherClasses(req.user, sc);
    if (!classes.some((c) => c.className === className)) {
      return res.status(403).json({ success: false, message: "Not assigned to this class" });
    }
    const m = await lmsService.createMeeting({
      data: req.body,
      user: req.user,
      schoolId: sc,
      teacherId: teacherId(req),
      campusId: campusIdOf(req),
    });
    res.status(201).json({ success: true, data: m });
  } catch (e) {
    fail(res, e);
  }
};

export const listTeacherMeetings = async (req, res) => {
  try {
    const sc = schoolId(req);
    const classes = await resolveTeacherClasses(req.user, sc);
    const classNames = classes.map((c) => c.className);
    const items = await lmsService.listTeacherMeetings({
      schoolId: sc,
      classNames,
      campusId: campusIdOf(req),
    });
    res.json({ success: true, data: items });
  } catch (e) {
    fail(res, e);
  }
};

export const listStudentMeetings = async (req, res) => {
  try {
    const student = await Student.findById(req.user.studentId);
    if (!student) throw new Error("Student not found");
    const items = await Meeting.find({
      schoolId: student.schoolId,
      className: student.studentClass,
      status: { $in: ["live", "scheduled"] },
      ...lmsService.buildVisibilityFilter({}, student.campusId ? String(student.campusId) : null),
    }).sort({ createdAt: -1 });
    res.json({ success: true, data: items });
  } catch (e) {
    fail(res, e);
  }
};
export const deleteMeeting = async (req, res) => {
  try {
    const m = await Meeting.findById(req.params.id);
    if (!m) return res.status(404).json({ success: false, message: "Not found" });
    if (String(m.teacherId) !== String(teacherId(req)) && !isAdmin(req)) return res.status(403).json({ success: false, message: "Forbidden" });
    await Meeting.deleteOne({ _id: m._id });
    res.json({ success: true });
  } catch (e) {
    fail(res, e);
  }
};