import express from "express";
import { getStudentLms, startAssessment, submitAssessment } from "../controllers/lmsStudent.controller.js";

const router = express.Router();
router.get("/:token/lms", getStudentLms);
router.post("/:token/lms/assessments/:assessmentId/start", startAssessment);
router.post("/:token/lms/assessments/:assessmentId/submit", submitAssessment);
export default router;