import express from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchool } from "../middleware/requireSchool.js";
import { requireTeacher } from "../middleware/roles.js";
import { requireCampusMembership } from "../middleware/campus.middleware.js";
import { resolveTeacherActor } from "../utils/teacherScope.js";
import {
  listStudyPlans, createStudyPlan, updateStudyPlan, deleteStudyPlan,
  listAssessments, createAssessment, updateAssessment, deleteAssessment,
  listSubmissions, getSubmission, gradeSubmission, resetSubmission,
  exportLms, importLms, getGradebook, getLmsAnalytics,
  createMeeting, listTeacherMeetings, deleteMeeting,
} from "../controllers/lms.controller.js";

const router = express.Router();
router.use(authenticate, requireTeacher, requireSchool);
router.use((req, res, next) => {
  try { req.teacher = resolveTeacherActor(req.user); return next(); }
  catch (e) { return res.status(e.status || 500).json({ success: false, message: e.message }); }
});
// Campus scoping: a request that names ?campusId (or body/param) is gated on the
// caller belonging to that campus; a school-wide request (no campusId) passes
// through and the service applies the visibility filter.
router.use(requireCampusMembership);

router.get("/studyplans", listStudyPlans);
router.post("/studyplans", createStudyPlan);
router.put("/studyplans/:id", updateStudyPlan);
router.delete("/studyplans/:id", deleteStudyPlan);

router.get("/gradebook", getGradebook);
router.get("/analytics", getLmsAnalytics);
router.post("/meetings", createMeeting);
router.get("/meetings", listTeacherMeetings);
router.delete("/meetings/:id", deleteMeeting);
router.post("/import", importLms);
router.get("/assessments", listAssessments);
router.post("/assessments", createAssessment);
router.put("/assessments/:id", updateAssessment);
router.delete("/assessments/:id", deleteAssessment);
router.get("/assessments/:id/submissions", listSubmissions);
router.get("/submissions/:submissionId", getSubmission);
router.post("/submissions/:submissionId/grade", gradeSubmission);
router.post("/submissions/:submissionId/reset", resetSubmission);

export default router;