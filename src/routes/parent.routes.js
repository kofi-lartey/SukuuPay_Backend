import express from "express";
import { payLinkViewLimit, payNotifySchoolLimit } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import { uploadParentAudioRoute, exposeParentAudioToBody } from "../middleware/upload.js";
import {
  getParentAttendanceController,
  getParentRecordsController,
  getParentRecordsPdfController,
  getParentTimetableController,
} from "../controllers/parent/parent.controller.js";
import {
  getConversationsController,
  getConversationController,
  createMessageController,
  markConversationReadController,
} from "../controllers/parent/messages.controller.js";
import {
  getNotificationsController,
  markNotificationReadController,
  markAllNotificationsReadController,
} from "../controllers/parent/notifications.controller.js";
import { payTokenParamSchema } from "../validations/payment.validation.js";
import {
  attendanceQuerySchema,
  recordsQuerySchema,
  timetableQuerySchema,
  parentMessageSchema,
  parentNotificationQuerySchema,
} from "../validations/parent.validation.js";

/**
 * The parent portal's academic surface, mounted at `/pay` from
 * `routes/index.js` so every route here answers `/pay/:token/...`.
 *
 * Kept out of `payment.routes.js` on purpose. That file owns money: the page,
 * the history, the initiate, the webhook. These three reads are attendance,
 * report cards and a timetable — a different audience (a parent on a phone
 * looking at a calendar), a different authorisation story (a published record
 * rather than a balance), and no shared code with the fee surface beyond the
 * token lookup. Mixing them is how the school's bursary module ends up
 * importing the register.
 *
 * ## Why `/records.pdf` and not `/records?format=pdf`
 *
 * The browser downloads what the URL ends in. A `Content-Disposition` on
 * `/records?format=pdf` still lands in the tab when a parent middle-clicks it,
 * and the JSON envelope lands in the file when the disposition header is lost
 * on a redirect. The suffix is part of the route.
 */
const router = express.Router();

// The rate limiter is `payLinkViewLimit` — the same 60/hour, token-keyed budget
// every other parent read already spends (`middleware/rateLimit.js`). Reusing it
// is not a shortcut: a parent who opens the portal has one budget no matter how
// many screens they look at, and a second, separately-keyed limiter per resource
// would multiply the ceiling by the number of resources.
//
// It runs *before* `validate`, matching the order every existing `/pay/:token`
// route uses. A malformed token therefore costs nothing it would not otherwise
// cost: the limiter's key is derived from the token, so a garbage token burns
// only its own bucket.
router.get(
  "/:token/attendance",
  payLinkViewLimit,
  validate(payTokenParamSchema, "params"),
  validate(attendanceQuerySchema, "query"),
  getParentAttendanceController
);

router.get(
  "/:token/records",
  payLinkViewLimit,
  validate(payTokenParamSchema, "params"),
  validate(recordsQuerySchema, "query"),
  getParentRecordsController
);

router.get(
  "/:token/records.pdf",
  payLinkViewLimit,
  validate(payTokenParamSchema, "params"),
  validate(recordsQuerySchema, "query"),
  getParentRecordsPdfController
);

router.get(
  "/:token/timetable",
  payLinkViewLimit,
  validate(payTokenParamSchema, "params"),
  validate(timetableQuerySchema, "query"),
  getParentTimetableController
);

// ── Parent messaging ──────────────────────────────────────────────────────
// The parent's conversations with the school office, scoped to the student the
// pay token names. Reads reuse `payLinkViewLimit` (the shared 60/hour token
// budget); writes reuse `payNotifySchoolLimit` (3/day), matching the existing
// `/pay/:token/notify-school` ceiling so a parent cannot spam the inbox.

router.get(
  "/:token/messages",
  payLinkViewLimit,
  validate(payTokenParamSchema, "params"),
  validate(parentNotificationQuerySchema, "query"),
  getConversationsController
);

router.get(
  "/:token/messages/:threadId",
  payLinkViewLimit,
  validate(payTokenParamSchema, "params"),
  getConversationController
);

router.post(
  "/:token/messages",
  uploadParentAudioRoute,
  exposeParentAudioToBody,
  payNotifySchoolLimit,
  validate(payTokenParamSchema, "params"),
  validate(parentMessageSchema),
  createMessageController
);

router.put(
  "/:token/messages/:threadId/read",
  payNotifySchoolLimit,
  validate(payTokenParamSchema, "params"),
  markConversationReadController
);

// ── Parent notifications ──────────────────────────────────────────────────

router.get(
  "/:token/notifications",
  payLinkViewLimit,
  validate(payTokenParamSchema, "params"),
  validate(parentNotificationQuerySchema, "query"),
  getNotificationsController
);

router.put(
  "/:token/notifications/read-all",
  payNotifySchoolLimit,
  validate(payTokenParamSchema, "params"),
  markAllNotificationsReadController
);

router.put(
  "/:token/notifications/:id/read",
  payNotifySchoolLimit,
  validate(payTokenParamSchema, "params"),
  markNotificationReadController
);

export const parentRoute = router;
export default router;
