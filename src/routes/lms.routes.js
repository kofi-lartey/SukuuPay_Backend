import express from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchool } from "../middleware/requireSchool.js";
import { requireTeacher } from "../middleware/roles.js";
import { resolveTeacherActor } from "../utils/teacherScope.js";
import {
  listStudyPlans, createStudyPlan, updateStudyPlan, deleteStudyPlan,
  listAssessments, createAssessment, updateAssessment, deleteAssessment,
  listSubmissions, getSubmission, gradeSubmission,
  exportLms, importLms,
} from "../controllers/lms.controller.js";

const router = express.Router();
router.use(authenticate, requireTeacher, requireSchool);
router.use((req, res, next) => {
  try { req.teacher = resolveTeacherActor(req.user); return next(); }
  catch (e) { return res.status(e.status || 500).json({ success: false, message: e.message }); }
});

router.get("/studyplans", listStudyPlans);
router.post("/studyplans", createStudyPlan);
router.put("/studyplans/:id", updateStudyPlan);
router.delete("/studyplans/:id", deleteStudyPlan);

router.get("/export", exportLms);
router.post("/import", importLms);
router.get("/assessments", listAssessments);
router.post("/assessments", createAssessment);
router.put("/assessments/:id", updateAssessment);
router.delete("/assessments/:id", deleteAssessment);
router.get("/assessments/:id/submissions", listSubmissions);
router.get("/submissions/:submissionId", getSubmission);
router.post("/submissions/:submissionId/grade", gradeSubmission);

export default router;