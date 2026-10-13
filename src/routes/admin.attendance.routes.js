import express from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { requireSchool } from "../middleware/requireSchool.js";
import { validate } from "../middleware/validate.js";
import {
  bulkMarkAttendanceController,
  autoMarkPresentController,
} from "../controllers/admin/attendance.controller.js";
import {
  bulkMarkAttendanceSchema,
  autoMarkPresentSchema,
} from "../validations/admin.attendance.validation.js";

/**
 * The school's register, mounted under `/admin` from `routes/index.js`.
 *
 * **Not inside `admin.routes.js`,** which is the *platform* console: it gates
 * every route on `authorize('super_admin')` at the router level, and a teacher
 * taking a roll in Tamale is not the platform owner. Mounting these beside that
 * router, each with its own gate, is what keeps the two apart — and it is why
 * nothing in here may assume the `super_admin` role.
 *
 * ## Who may mark attendance
 *
 * `teacher` and `school_admin` (and `super_admin`, who can act across every
 * tenant). A teacher is included because the register *is* a teacher's job: the
 * class teacher is the only person in the building who knows the child was at
 * the clinic this morning. `accountant` and `viewer` are excluded — attendance
 * is not money and is not a reporting surface.
 *
 * `requireSchool` runs after `authorize`, because an account with no school
 * should be sent into onboarding rather than told it has no access.
 */
const router = express.Router();

router.post(
  "/attendance/bulk",
  authenticate,
  authorize("super_admin", "school_admin", "teacher"),
  requireSchool,
  validate(bulkMarkAttendanceSchema),
  bulkMarkAttendanceController
);

router.post(
  "/attendance/auto-present",
  authenticate,
  authorize("super_admin", "school_admin", "teacher"),
  requireSchool,
  validate(autoMarkPresentSchema),
  autoMarkPresentController
);

export const adminAttendanceRoute = router;
export default router;
