import express from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchool } from "../middleware/requireSchool.js";
import { validate } from "../middleware/validate.js";
import { requireTeacher } from "../middleware/roles.js";
import {
  getTeacherStudentsController,
  getTeacherStudentMessagesController,
  sendTeacherStudentMessageController,
  markTeacherStudentMessageReadController,
  editTeacherStudentMessageController,
  deleteTeacherStudentMessageController,
} from "../controllers/teacherStudentMessage.controller.js";
import { uploadTeacherMessageRoute } from "../middleware/upload.js";
import { resolveTeacherActor } from "../utils/teacherScope.js";
import {
  getDashboardController,
  getMyClassesController,
  getClassRosterController,
  getClassSummaryController,
  getAttendanceForDateController,
  getStudentAttendanceController,
  getClassGradesController,
  getStudentGradesController,
  saveSingleGradeController,
  saveBulkGradesController,
  getScheduleController,
  getAvailableClassesController,
  acceptCurrentPeriodController,
} from "../controllers/teacher/teacher.controller.js";
import {
  submitTimetableController,
  withdrawTimetableController,
  listTimetablesForTeacherController,
  getTimetableForTeacherController,
  requestRemovalController,
  withdrawRemovalController,
} from "../controllers/admin/timetable.controller.js";
import {
  classQuerySchema,
  classSummaryParamsSchema,
  classSummaryQuerySchema,
  attendanceQuerySchema,
  studentIdParamSchema,
  studentAttendanceQuerySchema,
  classGradesQuerySchema,
  studentGradesQuerySchema,
  saveSingleGradeSchema,
  saveBulkGradesSchema,
} from "../validations/teacher.validation.js";
import {
  timetableTermSchema,
  timetableRemovalRequestSchema,
} from "../validations/admin.timetable.validation.js";

/**
 * The teacher portal's surface.
 *
 * Mounted at `/api/teacher` from `routes/index.js`, and **before** the platform
 * console for the same reason the three admin routers are: those routers gate on
 * `super_admin` at the router level, and a teacher taking a roll in Tamale is
 * not the platform owner. Nothing here is under `/admin`, so no path collides
 * and no ordering hazard exists — but the gate below is what makes this router
 * safe on its own.
 *
 * ## The gate, in three layers
 *
 *  1. `authenticate` — a valid token and a live `req.user`.
 *  2. `requireTeacher` — the role check (`middleware/roles.js`).
 *  3. `requireSchool` — a usable school, *after* the role check rather than
 *     before it. An account with no school should be sent into onboarding
 *     rather than told it has no access, which is the same ordering
 *     `admin.attendance.routes.js` uses and the reason it is worth copying.
 *
 * ## The school a request is scoped to
 *
 * Resolved once here, into `req.teacher`, rather than read as `req.user.schoolId`
 * in every service. A super admin's own `schoolId` is null by design while they
 * are impersonating a school, and reading it raw 401s them out of the portal
 * they were explicitly admitted to. See `resolveTeacherActor`.
 */
const router = express.Router();

router.use(authenticate, requireTeacher, requireSchool);

// Everything below acts as `req.teacher`, never as `req.user`.
router.use((req, res, next) => {
  try {
    req.teacher = resolveTeacherActor(req.user);
    return next();
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
});

// ── Dashboard ──
// No validator: there is no input beyond the token, and the token *is* the
// scope. A schema here would only ever restate what the handler already knows.
router.get("/dashboard", getDashboardController);

// ── Classes ──
router.get("/classes", getMyClassesController);
router.get("/classes/available", getAvailableClassesController);
// Route order matters: `/classes/roster` is a static path and is registered
// before `/classes/:className/summary`, so a roster read can never be captured
// by the summary route's `:className`.
router.get(
  "/classes/roster",
  validate(classQuerySchema, "query"),
  getClassRosterController
);
router.get(
  "/classes/:className/summary",
  validate(classSummaryParamsSchema, "params"),
  validate(classSummaryQuerySchema, "query"),
  getClassSummaryController
);

// ── Attendance ──
router.get(
  "/attendance",
  validate(attendanceQuerySchema, "query"),
  getAttendanceForDateController
);
router.get(
  "/students/:studentId/attendance",
  validate(studentIdParamSchema, "params"),
  validate(studentAttendanceQuerySchema, "query"),
  getStudentAttendanceController
);

// ── Grades ──
router.get(
  "/grades",
  validate(classGradesQuerySchema, "query"),
  getClassGradesController
);
router.get(
  "/students/:studentId/grades",
  validate(studentIdParamSchema, "params"),
  validate(studentGradesQuerySchema, "query"),
  getStudentGradesController
);
router.post(
  "/grades/single",
  validate(saveSingleGradeSchema),
  saveSingleGradeController
);
router.post(
  "/grades/bulk",
  validate(saveBulkGradesSchema),
  saveBulkGradesController
);

// ── Schedule ──
router.get("/schedule", getScheduleController);

router.post("/accept-period", acceptCurrentPeriodController);

// ── Timetables (teacher submission flow) ──
// A teacher drafts a timetable through `PUT /admin/timetables` (gated to
// `teacher` there), then submits or withdraws it here. Listing and reading
// their own timetables stay on the teacher surface so the UI never has to
// cross into `/admin`.
router.get(
  "/timetables",
  validate(timetableTermSchema, "query"),
  listTimetablesForTeacherController
);
router.get(
  "/timetables/:className",
  validate(timetableTermSchema, "query"),
  getTimetableForTeacherController
);
router.post(
  "/timetables/:className/submit",
  validate(timetableTermSchema, "body"),
  submitTimetableController
);
router.post(
  "/timetables/:className/withdraw",
  validate(timetableTermSchema, "body"),
  withdrawTimetableController
);

/**
 * ── Removal requests ──
 *
 * A teacher can request removal of a timetable they own (submitted or approved).
 * The request goes to the admin's removal-request queue for review.
 */
router.post(
  "/timetables/:className/request-removal",
  validate(timetableRemovalRequestSchema),
  requestRemovalController
);

router.post(
  "/timetables/:className/withdraw-removal",
  validate(timetableTermSchema, "body"),
  withdrawRemovalController
);

// ── Assigned students & messaging ──
router.get("/students", getTeacherStudentsController);
router.get("/students/:studentId/messages", getTeacherStudentMessagesController);
router.post(
  "/students/:studentId/messages",
  uploadTeacherMessageRoute,
  sendTeacherStudentMessageController
);
router.put("/messages/:messageId/read", markTeacherStudentMessageReadController);
router.put("/messages/:messageId", editTeacherStudentMessageController);
router.delete("/messages/:messageId", deleteTeacherStudentMessageController);

export const teacherRoute = router;
export default router;
