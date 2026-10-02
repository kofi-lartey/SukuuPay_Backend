import Joi from "joi";
import { MAX_PER_PAGE, DEFAULT_PER_PAGE } from "../utils/platformQuery.js";

/**
 * `POST /admin/impersonate/:schoolId`
 *
 * **The one console body schema that is not a patch.**
 *
 * `SUKUU_ADMIN_CONVENTIONS.md` section 6 makes every schema patch-by-default -
 * every field optional plus `.min(1)` on the object - so a client writing back a
 * whole document cannot blank what it did not mean to change. That rule exists
 * for endpoints that *modify* something, where a missing key and a deliberate
 * clear are the same wire format and the safe reading is "leave it alone".
 *
 * This endpoint creates the most sensitive record in the product, and a session
 * with no reason attached to it is a session that cannot be explained to
 * anybody afterwards: not to the school's head teacher who finds the entry in
 * their own activity log, and not to an auditor months later. There is no
 * "partial" version of that record, so the field is genuinely required and
 * `.min(1)` on the object is not applicable - an empty object is a refusal, not
 * a no-op.
 *
 * **Why 10 is the floor.** The reason is shown to a third party, so it has to
 * carry a subject and a situation. "Testing" (7), "debug" (5) and "fix" (3) all
 * clear a `.min(1)` and none of them tells a school what happened to them or an
 * auditor what was being looked for. Ten characters is roughly "checking why
 * Kwame Mensah's payment failed", which is the shortest string that is still an
 * answer. The 500 ceiling is the model's (`ImpersonationSession.js:86`); matching
 * it here means a 500-character reason cannot pass validation and then fail as a
 * `ValidationError` inside `ImpersonationSession.create`, which would abort the
 * start *after* the operator was told nothing about why.
 *
 * `.trim()` is declared before the bounds so the length is measured on the text
 * that will actually be stored. A reason padded to ten spaces is not a reason,
 * and a validation layer that counted it would have written that into the
 * tenant's log.
 */
const startImpersonationSchema = Joi.object({
  reason: Joi.string().trim().min(10).max(500).required(),
});

/**
 * `GET /admin/impersonate/sessions`
 *
 * Both filters are optional strings validated as 24-hex rather than left to the
 * service, so a typo in a pasted id is a 422 naming the field instead of a 400
 * with a message that does not say which of the two was wrong. The service's
 * `optionalId` re-checks them - the schema is for the wire, the service is
 * reachable from places that have no request - but a filter that arrives as
 * `"abc"` has no business reaching Mongo either way.
 *
 * The page bounds are **imported**, not written as `20` and `200`, unlike
 * `listAllSchoolsQuerySchema` in `admin.validation.js:13` which hard-codes them.
 * That literal and `platformQuery.js` are two statements of one rule, and the
 * console already has a `MAX_PER_PAGE` that the service layer clamps to: a
 * schema allowing 1000 and a service capping at 200 is a validation that
 * accepts a request the API then quietly changes the shape of, and the person
 * debugging that is the one who typed the number.
 */
const listImpersonationSessionsQuerySchema = Joi.object({
  schoolId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      "string.pattern.base": "Invalid school ID format",
    }),
  superAdminId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      "string.pattern.base": "Invalid super admin ID format",
    }),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(MAX_PER_PAGE).default(DEFAULT_PER_PAGE),
});

/**
 * `GET /admin/impersonate/sessions/:id`
 *
 * The param is named `id` rather than `sessionId` so it matches
 * `schoolIdParamSchema`'s shape and every other `:id` route in the console - the
 * route table is the only place the name is visible, and one convention is worth
 * more than a descriptive one here.
 *
 * Validated as a 24-hex string rather than with `mongoose.Types.ObjectId.isValid`,
 * which also accepts a 12-character string and would let that through to a
 * `CastError` in the service. `stripUnknown: true` (`middleware/validate.js:42`)
 * means an extra key is removed rather than rejected, so a client sending the
 * whole object back cannot smuggle a field past this.
 */
const impersonationSessionIdParamSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "Invalid impersonation session ID format",
    }),
});

export {
  startImpersonationSchema,
  listImpersonationSessionsQuerySchema,
  impersonationSessionIdParamSchema,
};

export default {
  startImpersonationSchema,
  listImpersonationSessionsQuerySchema,
  impersonationSessionIdParamSchema,
};
