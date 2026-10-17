import express from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { requireSchool } from "../middleware/requireSchool.js";
import { validate } from "../middleware/validate.js";
import { uploadBulk, asClientErrors } from "../middleware/upload.js";
import {
  upsertTimetableController,
  importTimetableController,
  submitTimetableController,
  withdrawTimetableController,
  approveTimetableController,
  rejectTimetableController,
  listSubmissionsController,
  deactivateTimetableController,
  republishTimetableController,
  removeTimetableController,
  listRemovalRequestsController,
  confirmRemovalController,
  rejectRemovalController,
  requestRemovalController,
  withdrawRemovalController,
} from "../controllers/admin/timetable.controller.js";
import {
  upsertTimetableSchema,
  timetableTermSchema,
  timetableApproveSchema,
  timetableRejectSchema,
  timetableRemovalRequestSchema,
} from "../validations/admin.timetable.validation.js";
import { classNameParamSchema } from "../validations/admin.academic.validation.js";

/**
 * Class timetables, mounted under `/admin` from `routes/index.js`.
 *
 * A `PUT` because the body is the whole timetable for a class, term and year —
 * a day left out means that day has no lessons. `POST` would read as "add
 * these periods" and leave the school with no way to remove one.
 *
 * `teacher` may write: building the timetable is the timetable officer's job,
 * and the timetable officer is a teacher. `school_admin` may write as well, and
 * `super_admin` for the platform console.
 *
 * `status` in the body is what makes this route the publish boundary too —
 * `"published"` makes the grid readable through every pay link in that class.
 * The default is `"draft"`, so a half-built timetable saved from a form that
 * never mentioned status is never visible to a parent.
 */
const router = express.Router();

router.put(
  "/timetable",
  authenticate,
  authorize("super_admin", "school_admin", "teacher"),
  requireSchool,
  validate(upsertTimetableSchema),
  upsertTimetableController
);

router.post(
  "/timetables/upload",
  authenticate,
  authorize("super_admin", "school_admin", "teacher"),
  requireSchool,
  asClientErrors(uploadBulk),
  importTimetableController
);

/**
 * ── Teacher submission flow ──
 *
 * A teacher builds their own draft, then submits it to the administrator for
 * review. Once submitted the timetable is locked until the administrator
 * approves, rejects, or the teacher withdraws it. `requireTeacher` admits
 * `teacher`, `school_admin` and `super_admin` — the account that owns the
 * draft is the one acting, which the service enforces through `submittedBy`.
 */
router.post(
  "/timetables/:className/submit",
  authenticate,
  authorize("super_admin", "school_admin", "teacher"),
  requireSchool,
  validate(timetableTermSchema, "body"),
  submitTimetableController
);

router.post(
  "/timetables/:className/withdraw",
  authenticate,
  authorize("super_admin", "school_admin", "teacher"),
  requireSchool,
  validate(timetableTermSchema, "body"),
  withdrawTimetableController
);

/**
 * ── Administrator review queue ──
 *
 * Approve and reject are `school_admin` (and `super_admin`) only: a teacher
 * must never sign off their own timetable. A rejection requires a reason, so
 * the teacher knows what to fix before resubmitting.
 */
router.get(
  "/timetables/submissions",
  authenticate,
  authorize("super_admin", "school_admin"),
  requireSchool,
  listSubmissionsController
);

router.post(
  "/timetables/:className/approve",
  authenticate,
  authorize("super_admin", "school_admin"),
  requireSchool,
  validate(timetableApproveSchema, "body"),
  approveTimetableController
);

router.post(
  "/timetables/:className/reject",
  authenticate,
  authorize("super_admin", "school_admin"),
  requireSchool,
  validate(timetableRejectSchema, "body"),
  rejectTimetableController
);

/**
 * ── Deactivation / Re-publication / Removal ──
 *
 * After approval and publication, the headmaster may:
 *  - Deactivate: remove a published timetable from parent/teacher views
 *    without deleting it (reversible via republish).
 *  - Republish: restore a deactivated timetable.
 *  - Remove: permanently soft-delete a timetable (irreversible).
 *
 * Removal requests are a separate flow: the teacher files a request asking
 * the headmaster to remove a timetable they own; the headmaster confirms or
 * rejects the request.
 */
router.post(
  "/timetables/deactivate",
  authenticate,
  authorize("super_admin", "school_admin"),
  requireSchool,
  validate(timetableTermSchema, "body"),
  deactivateTimetableController
);

router.post(
  "/timetables/republish",
  authenticate,
  authorize("super_admin", "school_admin"),
  requireSchool,
  validate(timetableTermSchema, "body"),
  republishTimetableController
);

router.delete(
  "/timetables/:className/remove",
  authenticate,
  authorize("super_admin", "school_admin"),
  requireSchool,
  validate(classNameParamSchema, "params"),
  validate(timetableTermSchema, "query"),
  removeTimetableController
);

/**
 * Removal request queue — the headmaster's review surface for teacher-requested
 * timetable removals. Separate from the submission queue: a removal request is
 * about the timetable's *existence*, a submission is about its *content*.
 */
router.get(
  "/timetables/removal-requests",
  authenticate,
  authorize("super_admin", "school_admin"),
  requireSchool,
  listRemovalRequestsController
);

router.post(
  "/timetables/:className/confirm-removal",
  authenticate,
  authorize("super_admin", "school_admin"),
  requireSchool,
  validate(classNameParamSchema, "params"),
  validate(timetableTermSchema, "body"),
  confirmRemovalController
);

router.post(
  "/timetables/:className/reject-removal",
  authenticate,
  authorize("super_admin", "school_admin"),
  requireSchool,
  validate(classNameParamSchema, "params"),
  validate(timetableTermSchema, "body"),
  rejectRemovalController
);

/**
 * Teacher-initiated removal request — a teacher asks the headmaster to remove
 * a timetable they own. Gated to teacher (and admin, for parity): the service
 * enforces that the timetable's `submittedBy` matches the caller.
 */
router.post(
  "/timetables/:className/request-removal",
  authenticate,
  authorize("super_admin", "school_admin", "teacher"),
  requireSchool,
  validate(timetableRemovalRequestSchema),
  requestRemovalController
);

router.post(
  "/timetables/:className/withdraw-removal",
  authenticate,
  authorize("super_admin", "school_admin", "teacher"),
  requireSchool,
  validate(timetableTermSchema, "body"),
  withdrawRemovalController
);

export const adminTimetableRoute = router;
export default router;
