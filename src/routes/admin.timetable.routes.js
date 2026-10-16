import express from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { requireSchool } from "../middleware/requireSchool.js";
import { validate } from "../middleware/validate.js";
import { uploadBulk, asClientErrors } from "../middleware/upload.js";
import { upsertTimetableController, importTimetableController } from "../controllers/admin/timetable.controller.js";
import { upsertTimetableSchema } from "../validations/admin.timetable.validation.js";

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

export const adminTimetableRoute = router;
export default router;
