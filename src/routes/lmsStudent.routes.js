import express from "express";
import { getStudentLms, submitAssessment } from "../controllers/lmsStudent.controller.js";

const router = express.Router();
router.get("/:token/lms", getStudentLms);
router.post("/:token/lms/assessments/:assessmentId/submit", submitAssessment);
export default router;