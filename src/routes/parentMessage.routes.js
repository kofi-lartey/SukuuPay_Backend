import { Router } from "express";
import {
  listParentMessagesController,
  getParentMessageController,
  listStudentMessagesController,
  markParentMessageReadController,
  resolveParentMessageController,
} from "../controllers/parentMessage.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { requireSchool } from "../middleware/requireSchool.js";
import { validate } from "../middleware/validate.js";
import {
  listParentMessagesSchema,
  parentMessageIdParamSchema,
  studentMessageParamSchema,
  resolveParentMessageSchema,
} from "../validations/parentMessage.validation.js";

export const parentMessageRoute = Router();

/**
 * Who may read and act on parent messages.
 *
 * `school_admin` and `accountant` — the same two roles `findSchoolRecipients` in
 * `pay.service.js` alerts. Matching them is not tidiness, it is the whole permission
 * model: if a role is not told about a message, it has no business holding a record
 * of it.
 *
 * **`teacher` was in this list and was removed.** The justification given for giving
 * it was that "a class teacher is frequently the person a parent actually wants to
 * reach". That is true of a message, but it does not survive contact with what this
 * collection holds: `ParentMessage.parentPhone` is stored in full, because a bursar
 * cannot return a call without it, and every row in the school would then be readable
 * by every teacher on the staff. That is the entire parent contact list, handed to
 * the widest set of roles in the product, for a module the parent addressed to the
 * office. The same reasoning already excludes teachers from `findSchoolRecipients`,
 * and `ParentMessage` exists precisely to be durable — so the exclusion has to hold
 * here too or the record outlives the permission.
 *
 * `viewer` is excluded too, and for a simpler reason: read access here is read access
 * to every parent number in the school.
 *
 * `super_admin` is included so the platform console can answer "is this school's
 * parent messaging working" without a tenant impersonation session, which is blocked
 * from writes by `middleware/impersonation.js`.
 */
const requireReader = authorize('super_admin', 'school_admin', 'accountant');

/**
 * `requireSchool` on every route here, and the reason is a status code.
 *
 * `parentMessage.service.js` refuses an account with no school with a `403
 * SCHOOL_ACCESS_DENIED`. That code means "you are a different school's bursar" everywhere
 * else in the product, and `services/api.js:73` routes on the one code that means
 * something else — `SCHOOL_NOT_LINKED`, a 409 with `action: 'school.provision'` — to
 * send a new admin into onboarding. This router never raised it, so a school that had
 * just signed up and not yet finished its profile opened Parent Messages and got
 * "Your account is not linked to a school" rendered as a page-level failure. To a new
 * administrator that reads as the feature being broken rather than as their own account
 * being half-built, and the one action that fixes it was nowhere on the screen.
 *
 * Every other school-scoped module uses `requireSchool` for the same reason, so this
 * router was the odd one out. It runs after `requireReader`, because a role that may
 * not read the module at all has no business being told about onboarding from it.
 */

// ──────────────────── Reads ────────────────────

// GET /parent-messages — the school inbox. Newest first.
parentMessageRoute.get(
  "/parent-messages",
  authenticate,
  requireReader,
  requireSchool,
  validate(listParentMessagesSchema, "query"),
  listParentMessagesController
);

/*
 * Declared before `/:id` on purpose. Both are two-segment paths, so the literal must
 * come first — otherwise "student" is captured as an `:id` and the lookup fails its
 * ObjectId pattern with a 422 that names a message id instead of saying the route does
 * not exist.
 */

// GET /parent-messages/student/:studentId — the thread on a roster record.
parentMessageRoute.get(
  "/parent-messages/student/:studentId",
  authenticate,
  requireReader,
  requireSchool,
  validate(studentMessageParamSchema, "params"),
  validate(listParentMessagesSchema, "query"),
  listStudentMessagesController
);

// GET /parent-messages/:id — one message, with the live student record attached.
parentMessageRoute.get(
  "/parent-messages/:id",
  authenticate,
  requireReader,
  requireSchool,
  validate(parentMessageIdParamSchema, "params"),
  getParentMessageController
);

// ──────────────────── State ────────────────────

// PUT /parent-messages/:id/read
//
// Idempotent by construction: the service returns the message unchanged when it is
// already read rather than 409-ing, because the inbox marks read on open and a bursar
// with two tabs open must not see one of them fail.
parentMessageRoute.put(
  "/parent-messages/:id/read",
  authenticate,
  requireReader,
  requireSchool,
  validate(parentMessageIdParamSchema, "params"),
  markParentMessageReadController
);

// PUT /parent-messages/:id/resolve
parentMessageRoute.put(
  "/parent-messages/:id/resolve",
  authenticate,
  requireReader,
  requireSchool,
  validate(parentMessageIdParamSchema, "params"),
  validate(resolveParentMessageSchema),
  resolveParentMessageController
);

export default parentMessageRoute;