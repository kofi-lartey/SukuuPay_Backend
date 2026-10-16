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
} from "../controllers/admin/timetable.controller.js";
import {
  upsertTimetableSchema,
  timetableTermSchema,
  timetableApproveSchema,
  timetableRejectSchema,
} from "../validations/admin.timetable.validation.js";

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

export const adminTimetableRoute = router;
export default router;
