import { Router } from "express";
import {
  createStudentController,
  bulkCreateStudentsController,
  listStudentsController,
  getStudentStatsController,
  getStudentProfileController,
  getStudentSelfOverviewController,
  getStudentSelfFeesController,
  getStudentSelfMessagesController,
  getStudentSelfTimetableController,
  getStudentSelfAttendanceController,
  getStudentSelfGradesController,
  getStudentSelfTeachersController,
  getStudentController,
  updateStudentController,
  deleteStudentController,
  restoreStudentController,
  suspendStudentController,
  reactivateStudentController,
  removeStudentController,
  transferStudentController,
  regeneratePayLinkController,
  exportStudentsController,
  promoteStudentController,
  bulkPromoteStudentsController,
  previewPromotionController,
  repeatStudentController,
  clearRepeatController,
  graduateStudentController,
  bulkGraduateStudentsController,
  transferOutStudentController,
  getAlumniController,
  getCohortsController,
  getCohortDetailController,
  addParentController,
  getParentsController,
  updateParentController,
  setPrimaryParentController,
  removeParentController,
  bulkUpdateStudentsController,
  bulkArchiveStudentsController,
  bulkSetStatusController,
  bulkRegeneratePayLinksController,
} from "../controllers/student.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { uploadBulk } from "../middleware/upload.js";
import {
  createStudentSchema,
  updateStudentSchema,
  bulkUploadMetaSchema,
  studentIdParamSchema,
  listStudentsQuerySchema,
  statsQuerySchema,
  suspendStudentSchema,
  transferClassSchema,
  promoteStudentSchema,
  bulkPromoteSchema,
  previewPromotionSchema,
  repeatStudentSchema,
  clearRepeatSchema,
  graduateStudentSchema,
  bulkGraduateSchema,
  transferOutSchema,
  alumniQuerySchema,
  cohortsQuerySchema,
  cohortDetailQuerySchema,
  schoolIdParamSchema,
  cohortIdParamSchema,
  addParentSchema,
  updateParentSchema,
  studentParentParamsSchema,
  setPrimaryParentSchema,
  archiveStudentSchema,
  bulkUpdateSchema,
  bulkArchiveSchema,
  bulkStatusSchema,
  bulkPayLinksSchema,
} from "../validations/student.validation.js";

export const studentRoute = Router();

// Manage who can manage students: school admins and super admins.
const requireSchoolAdmin = authorize("super_admin", "school_admin");

// ── Bulk writes ──
// Registered before the `/:id` routes below. Express matches in registration
// order, and `POST /students/bulk/update` shares a prefix with nothing that
// `/:id` claims, but keeping the group together at the top makes the ordering
// dependency of the file obvious rather than incidental.
studentRoute.post(
  "/students/bulk/update",
  authenticate,
  requireSchoolAdmin,
  validate(bulkUpdateSchema),
  bulkUpdateStudentsController
);

studentRoute.post(
  "/students/bulk/archive",
  authenticate,
  requireSchoolAdmin,
  validate(bulkArchiveSchema),
  bulkArchiveStudentsController
);

studentRoute.post(
  "/students/bulk/status",
  authenticate,
  requireSchoolAdmin,
  validate(bulkStatusSchema),
  bulkSetStatusController
);

studentRoute.post(
  "/students/bulk/pay-links",
  authenticate,
  requireSchoolAdmin,
  validate(bulkPayLinksSchema),
  bulkRegeneratePayLinksController
);

// ── Single create ──
studentRoute.post(
  "/students/single",
  authenticate,
  requireSchoolAdmin,
  validate(createStudentSchema),
  createStudentController
);

// ── Bulk create (multipart file) ──
// uploadBulk must run before the meta validator so the form fields land on
// req.body where Joi can read them.
studentRoute.post(
  "/students/bulk",
  authenticate,
  requireSchoolAdmin,
  uploadBulk,
  validate(bulkUploadMetaSchema, "body"),
  bulkCreateStudentsController
);

// ── List / search (scoped to the caller's school) ──
studentRoute.get(
  "/students",
  authenticate,
  validate(listStudentsQuerySchema, "query"),
  listStudentsController
);

// ── Roster aggregates ──
// Must precede `/students/:id` or "stats" is captured as an id and rejected by
// `studentIdParamSchema`.
studentRoute.get(
  "/students/stats",
  authenticate,
  validate(statsQuerySchema, "query"),
  getStudentStatsController
);

// ── Export (must precede /:id so "/export" is not captured as an id) ──
studentRoute.get(
  "/students/export",
  authenticate,
  validate(listStudentsQuerySchema, "query"),
  exportStudentsController
);

// ── Student self-service overview ──
studentRoute.get(
  "/student/overview",
  authenticate,
  authorize("student"),
  getStudentSelfOverviewController
);

studentRoute.get(
  "/student/attendance",
  authenticate,
  authorize("student"),
  getStudentSelfAttendanceController
);

studentRoute.get(
  "/student/grades",
  authenticate,
  authorize("student"),
  getStudentSelfGradesController
);

studentRoute.get(
  "/student/teachers",
  authenticate,
  authorize("student"),
  getStudentSelfTeachersController
);

studentRoute.get(
  "/student/fees",
  authenticate,
  authorize("student"),
  getStudentSelfFeesController
);

studentRoute.get(
  "/student/messages",
  authenticate,
  authorize("student"),
  getStudentSelfMessagesController
);

studentRoute.get(
  "/student/timetable",
  authenticate,
  authorize("student"),
  getStudentSelfTimetableController
);

// ── Single student ──
studentRoute.get(
  "/students/:id",
  authenticate,
  validate(studentIdParamSchema, "params"),
  getStudentController
);

// Everything the profile drawer needs in one round trip. Registered before
// `/:id` so the literal segment is not swallowed by the parameter.
studentRoute.get(
  "/students/:id/profile",
  authenticate,
  validate(studentIdParamSchema, "params"),
  getStudentProfileController
);

studentRoute.put(
  "/students/:id",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(updateStudentSchema),
  updateStudentController
);

studentRoute.delete(
  "/students/:id",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(archiveStudentSchema),
  deleteStudentController
);

// ── Restore ──
// The inverse of the archive. Without it a mis-click on a bulk selection is
// permanent: there is no hard delete to be careful of, and no way back either.
studentRoute.post(
  "/students/:id/restore",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  restoreStudentController
);

// ── State transitions ──
studentRoute.put(
  "/students/:id/suspend",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(suspendStudentSchema),
  suspendStudentController
);

studentRoute.put(
  "/students/:id/reactivate",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  reactivateStudentController
);

// Alias of `DELETE /students/:id`, kept so existing clients keep working. Both
// now archive; they were byte-for-byte identical before, differing only in the
// word in their response message.
studentRoute.put(
  "/students/:id/remove",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(archiveStudentSchema),
  removeStudentController
);

// ── Transfer class ──
studentRoute.put(
  "/students/:id/transfer-class",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(transferClassSchema),
  transferStudentController
);

// ── Regenerate pay link ──
studentRoute.get(
  "/students/:id/pay-link",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  regeneratePayLinkController
);

// ── Promotion endpoints ──
studentRoute.post(
  "/students/:id/promote",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(promoteStudentSchema),
  promoteStudentController
);

studentRoute.post(
  "/students/bulk-promote/:schoolId",
  authenticate,
  requireSchoolAdmin,
  validate(schoolIdParamSchema, "params"),
  validate(bulkPromoteSchema),
  bulkPromoteStudentsController
);

studentRoute.post(
  "/students/promote/preview",
  authenticate,
  requireSchoolAdmin,
  validate(previewPromotionSchema),
  previewPromotionController
);

// ── Repeat student ──
studentRoute.post(
  "/students/:id/repeat",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(repeatStudentSchema),
  repeatStudentController
);

// Clearing the flag. `updateStudentSchema` no longer accepts `isRepeating`, so
// this is the only way to unset it — and without it the flag was a one-way
// door: `promoteStudent` refuses any repeating student, so a mis-set repeat
// permanently blocked a promotion.
studentRoute.post(
  "/students/:id/unrepeat",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(clearRepeatSchema),
  clearRepeatController
);

// ── Graduation endpoints ──
studentRoute.post(
  "/students/:id/graduate",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(graduateStudentSchema),
  graduateStudentController
);

studentRoute.post(
  "/students/bulk-graduate/:schoolId",
  authenticate,
  requireSchoolAdmin,
  validate(schoolIdParamSchema, "params"),
  validate(bulkGraduateSchema),
  bulkGraduateStudentsController
);

// ── Transfer out ──
studentRoute.post(
  "/students/:id/transfer-out",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(transferOutSchema),
  transferOutStudentController
);

// ── Parent management ──
//
// All four are nested under `/students/:id`.
//
// They used to be `/parents/:parentId` while the controllers read
// `req.params.id` — a path with no `:id` segment, so `studentId` arrived as
// `undefined` and every write failed. The nesting also makes the resource
// obvious: a guardian is addressed as a child of a student, not as a global
// record.
studentRoute.post(
  "/students/:id/parents",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  validate(addParentSchema),
  addParentController
);

// Guarded by role now. It was authenticated only, so any signed-in user — a
// teacher, a viewer — could read every guardian's full phone number from a
// school they had no administrative role in.
studentRoute.get(
  "/students/:id/parents",
  authenticate,
  requireSchoolAdmin,
  validate(studentIdParamSchema, "params"),
  getParentsController
);

studentRoute.put(
  "/students/:id/parents/:parentId",
  authenticate,
  requireSchoolAdmin,
  validate(studentParentParamsSchema, "params"),
  validate(updateParentSchema),
  updateParentController
);

studentRoute.put(
  "/students/:id/parents/:parentId/primary",
  authenticate,
  requireSchoolAdmin,
  validate(studentParentParamsSchema, "params"),
  validate(setPrimaryParentSchema),
  setPrimaryParentController
);

studentRoute.delete(
  "/students/:id/parents/:parentId",
  authenticate,
  requireSchoolAdmin,
  validate(studentParentParamsSchema, "params"),
  removeParentController
);

// ── Alumni & Cohorts ──
studentRoute.get(
  "/alumni/:schoolId",
  authenticate,
  validate(schoolIdParamSchema, "params"),
  validate(alumniQuerySchema, "query"),
  getAlumniController
);

studentRoute.get(
  "/cohorts/:schoolId",
  authenticate,
  validate(schoolIdParamSchema, "params"),
  validate(cohortsQuerySchema, "query"),
  getCohortsController
);

// Two segments, so it can never be shadowed by `/cohorts/:schoolId` above.
//
// Those two routes were `/cohorts/:schoolId` and `/cohorts/:cohortId`, both
// registered on the same path shape. Express matches in order, so the list route
// caught every request: a cohort id reached `schoolIdParamSchema`, which
// demands 24 hex characters, and 422'd. On top of that, the detail route's own
// schema demanded 24 hex while its service consumed `cohort_2026`, so even a
// request that reached the right handler could not have succeeded.
studentRoute.get(
  "/cohorts/detail/:cohortId",
  authenticate,
  validate(cohortIdParamSchema, "params"),
  validate(cohortDetailQuerySchema, "query"),
  getCohortDetailController
);
