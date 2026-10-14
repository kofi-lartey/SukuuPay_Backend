import express from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireTeacher, requireSchoolAdmin } from "../middleware/roles.js";
import { requireSchool } from "../middleware/requireSchool.js";
import { validate } from "../middleware/validate.js";
import {
  submitClassGradesController,
  approveClassGradesController,
  rejectClassGradesController,
  reopenRejectedGradesController,
  getGradeApprovalQueueController,
} from "../controllers/admin/gradeApproval.controller.js";
import {
  listClassesController,
  createClassController,
  archiveClassController,
  getClassAssignmentsController,
  assignClassTeacherController,
  assignSubjectTeacherController,
  unassignSubjectTeacherController,
} from "../controllers/admin/class.controller.js";
import {
  compileClassReportsController,
  setHeadRemarkController,
  publishClassReportsController,
  unpublishClassReportsController,
  getReportReviewQueueController,
} from "../controllers/admin/recordsApproval.controller.js";
import {
  saveTimetableForClassController,
  getTimetableController,
  listTimetablesController,
  publishTimetableController,
} from "../controllers/admin/timetable.controller.js";
import { getAcademicOverviewController } from "../controllers/admin/academicDashboard.controller.js";
import {
  listTeacherStudentsController,
  listTeacherAssignmentCountsController,
  assignStudentsController,
  unassignStudentsController,
} from "../controllers/admin/teacherAssignment.controller.js";
import {
  submitGradesSchema,
  approveGradesSchema,
  rejectGradesSchema,
  reopenGradesSchema,
  overviewQuerySchema,
  createClassSchema,
  classNameParamSchema,
  assignClassTeacherSchema,
  assignSubjectTeacherSchema,
  subjectTeacherParamsSchema,
  compileReportsSchema,
  setHeadRemarkSchema,
  publishReportsSchema,
  saveTimetableSchema,
  timetableQuerySchema,
  publishTimetableSchema,
} from "../validations/admin.academic.validation.js";
import {
  teacherIdParamSchema,
  listTeacherStudentsQuerySchema,
  assignStudentsSchema,
  unassignStudentsSchema,
} from "../validations/teacherAssignment.validation.js";

/**
 * The headmaster's academic console — the review, approval and configuration
 * layer between the teacher who enters data and the parent who reads it.
 *
 * Mounted at `/admin` from `routes/index.js`, **before** the platform console
 * (`adminRoute`), for the same load-bearing reason the three existing academic
 * routers are: `adminRoute` gates every route on `authorize('super_admin')` at
 * the router level, and a teacher in Tamale submitting a class's grades is not
 * the platform owner. Once that gate answers `403` Express does not fall
 * through to the next `/admin` mount, so the school-scoped surface has to be
 * matched first. None of these paths collide with the platform console's
 * (`/academic`, `/grades`, `/reports/{compile,publish,…}`, `/classes`,
 * `/timetables` are all new), which is what makes the ordering safe.
 *
 * ## The gate, per route
 *
 * `authenticate` runs for everything (applied once below). On top of it each
 * route names the role it needs and then `requireSchool` (an unlinked account
 * gets `409 SCHOOL_NOT_LINKED`, after the role check — an account with no school
 * belongs in onboarding, not a permissions error):
 *
 *   - **`requireTeacher`** — entering and submitting marks, compiling reports,
 *     writing timetables. The class teacher submits; the headmaster approves.
 *   - **`requireSchoolAdmin`** — approving and rejecting marks, publishing and
 *     unpublishing report cards, the headmaster's remark, class management,
 *     publishing timetables, and the oversight dashboard. The disclosure and
 *     governance boundary; a `teacher` is excluded on purpose.
 *
 * `schoolId` is read from the token in the controllers and is never taken from
 * the body, so a caller cannot reach another school's data — the same rule
 * every school-scoped module runs on.
 */
const router = express.Router();

router.use(authenticate);

// ── Overview ──
router.get(
  "/academic/overview",
  requireSchoolAdmin,
  requireSchool,
  validate(overviewQuerySchema, "query"),
  getAcademicOverviewController
);

// ── Grade approval ──
router.get(
  "/grades/approval-queue",
  requireSchoolAdmin,
  requireSchool,
  validate(overviewQuerySchema, "query"),
  getGradeApprovalQueueController
);
router.post("/grades/submit", requireTeacher, requireSchool, validate(submitGradesSchema), submitClassGradesController);
router.post("/grades/approve", requireSchoolAdmin, requireSchool, validate(approveGradesSchema), approveClassGradesController);
router.post("/grades/reject", requireSchoolAdmin, requireSchool, validate(rejectGradesSchema), rejectClassGradesController);
router.post("/grades/reopen", requireTeacher, requireSchool, validate(reopenGradesSchema), reopenRejectedGradesController);

// ── Report card review ──
router.get(
  "/reports/review-queue",
  requireTeacher,
  requireSchool,
  validate(overviewQuerySchema, "query"),
  getReportReviewQueueController
);
router.post("/reports/compile", requireTeacher, requireSchool, validate(compileReportsSchema), compileClassReportsController);
router.post("/reports/head-remark", requireSchoolAdmin, requireSchool, validate(setHeadRemarkSchema), setHeadRemarkController);
router.post("/reports/publish", requireSchoolAdmin, requireSchool, validate(publishReportsSchema), publishClassReportsController);
router.post("/reports/unpublish", requireSchoolAdmin, requireSchool, validate(publishReportsSchema), unpublishClassReportsController);

// ── Classes ──
// A class is a name, addressed as a URL-encoded path segment. The three
// assignment sub-paths are longer than the bare `:className` and are registered
// ahead of the `DELETE /classes/:className` below, so a name can never shadow
// them.
router.get("/classes", requireSchoolAdmin, requireSchool, listClassesController);
router.post("/classes", requireSchoolAdmin, requireSchool, validate(createClassSchema), createClassController);
router.get(
  "/classes/:className/assignments",
  requireSchoolAdmin,
  requireSchool,
  validate(classNameParamSchema, "params"),
  getClassAssignmentsController
);
router.put(
  "/classes/:className/teacher",
  requireSchoolAdmin,
  requireSchool,
  validate(classNameParamSchema, "params"),
  validate(assignClassTeacherSchema),
  assignClassTeacherController
);
router.post(
  "/classes/:className/subject-teacher",
  requireSchoolAdmin,
  requireSchool,
  validate(classNameParamSchema, "params"),
  validate(assignSubjectTeacherSchema),
  assignSubjectTeacherController
);
router.delete(
  "/classes/:className/subject-teacher/:subject",
  requireSchoolAdmin,
  requireSchool,
  validate(subjectTeacherParamsSchema, "params"),
  unassignSubjectTeacherController
);
router.delete(
  "/classes/:className",
  requireSchoolAdmin,
  requireSchool,
  validate(classNameParamSchema, "params"),
  archiveClassController
);

// ── Teacher assignment ─────────────────────────────────────────────────────
// Which *students* a teacher is responsible for — a different question from
// which *classes* they teach, and one the class endpoints above cannot answer:
// `User.assignedClasses` holds `{ className, subject }` rows, and a form
// teacher, a remedial teacher and a house master can all hold the same child.
// The student→teacher link therefore lives in `models/TeacherAssignment.js`.
//
// `requireSchoolAdmin` on all four. A `teacher` may read their own students
// through the teacher portal's `/teacher` surface, but *naming who is
// responsible for whom* is a headmaster's decision, so the whole group is a
// disclosure boundary rather than a write boundary.
//
// The literal `teacher-assignment-counts` is registered before the `:teacherId`
// routes, for the fixed-before-wildcard rule the file states above: a param
// route would otherwise capture it and read a count for a teacher whose id is
// the word "teacher-assignment-counts".
//
// `POST` carries both assignment paths — individual `studentIds` and a class
// name — because they are one intent ("link these children to this teacher")
// with two selectors. `DELETE` is separate because withdrawing is not the
// inverse of assigning: it refuses class-mediated rows unless `force`, see
// `unassignStudents` in the service.
router.get(
  "/users/teacher-assignment-counts",
  requireSchoolAdmin,
  requireSchool,
  listTeacherAssignmentCountsController
);
router.get(
  "/users/:teacherId/students",
  requireSchoolAdmin,
  requireSchool,
  validate(teacherIdParamSchema, "params"),
  validate(listTeacherStudentsQuerySchema, "query"),
  listTeacherStudentsController
);
router.post(
  "/users/:teacherId/students",
  requireSchoolAdmin,
  requireSchool,
  validate(teacherIdParamSchema, "params"),
  // Both body shapes, one route. Validation's `.xor('studentIds','className')`
  // is what makes "both at once" a 400 rather than a decision made by whichever
  // key the controller happens to read first, and an empty body a 400 too.
  validate(assignStudentsSchema),
  assignStudentsController
);
router.delete(
  "/users/:teacherId/students",
  requireSchoolAdmin,
  requireSchool,
  validate(teacherIdParamSchema, "params"),
  validate(unassignStudentsSchema),
  unassignStudentsController
);

// ── Timetables ──
// GET/POST on the literal can never be captured by the param — the same
// fixed-before-wildcard rule the platform console documents.
router.get("/timetables", requireTeacher, requireSchool, validate(timetableQuerySchema, "query"), listTimetablesController);
router.put("/timetables", requireTeacher, requireSchool, validate(saveTimetableSchema), saveTimetableForClassController);
router.post("/timetables/publish", requireSchoolAdmin, requireSchool, validate(publishTimetableSchema), publishTimetableController);
router.get(
  "/timetables/:className",
  requireTeacher,
  requireSchool,
  validate(classNameParamSchema, "params"),
  validate(timetableQuerySchema, "query"),
  getTimetableController
);

export const adminAcademicRoute = router;
export default router;
