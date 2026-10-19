import express from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { requireSchool } from "../middleware/requireSchool.js";
import { validate } from "../middleware/validate.js";
import {
  compileClassReportCardsController,
  publishClassReportCardsController,
} from "../controllers/admin/records.controller.js";
import { markTeacherAttendanceController, listTeacherAttendanceController } from "../controllers/admin/teacherAttendance.controller.js";
import { getTeacherAttendanceReportController } from "../controllers/admin/teacherAttendanceReport.controller.js";
import { getAdminClassGradesController } from "../controllers/admin/classGrades.controller.js";
import {
  compileReportCardsSchema,
  publishReportCardsSchema,
} from "../validations/admin.records.validation.js";

/**
 * Report cards, mounted under `/admin` from `routes/index.js`.
 *
 * ## Compile and publish are gated differently, on purpose
 *
 * **Compile** — `school_admin`, `teacher`, `super_admin`. The class teacher
 * assembles the subject scores; refusing them the endpoint would mean emailing a
 * spreadsheet to the office to be typed in by someone who was not in the room.
 *
 * **Publish** — `school_admin`, `super_admin` only. This is the disclosure
 * boundary: it is the moment every parent holding the student's pay link can
 * read a grade, and it cannot be undone by a phone call. A teacher who has
 * finished compiling asks the headteacher to publish, which is how a Ghanaian
 * school already works — the class teacher marks, the head signs.
 *
 * `requireSchool` answers an unlinked account with `409 SCHOOL_NOT_LINKED`, the
 * same actionable refusal every other school-scoped module gives.
 */
const router = express.Router();

const mayCompile = authorize("super_admin", "school_admin", "teacher");
const mayPublish = authorize("super_admin", "school_admin");

router.post(
  "/records/compile",
  authenticate,
  mayCompile,
  requireSchool,
  validate(compileReportCardsSchema),
  compileClassReportCardsController
);

router.post(
  "/records/publish",
  authenticate,
  mayPublish,
  requireSchool,
  validate(publishReportCardsSchema),
  publishClassReportCardsController
);

router.get(
  "/reports/teacher-attendance",
  authenticate,
  authorize("super_admin", "school_admin"),
  requireSchool,
  getTeacherAttendanceReportController
);

router.get("/teacher-attendance", authenticate, authorize("super_admin", "school_admin"), requireSchool, listTeacherAttendanceController);
router.post("/teacher-attendance", authenticate, authorize("super_admin", "school_admin"), requireSchool, markTeacherAttendanceController);

router.get("/class-grades", authenticate, authorize("super_admin", "school_admin"), requireSchool, getAdminClassGradesController);

export const adminRecordsRoute = router;
export default router;
