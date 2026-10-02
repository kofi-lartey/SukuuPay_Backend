import Joi from "joi";
import { MAX_PER_PAGE, DEFAULT_PER_PAGE } from "../utils/platformQuery.js";

/**
 * Joi schemas for the announcement endpoints.
 *
 * Two conventions from `SUKUU_ADMIN_CONVENTIONS.md` shape this file.
 *
 * **Patches by default.** Every field is optional plus `.min(1)` on the object,
 * so a client that reads a document, changes one field and writes the whole thing
 * back cannot blank what it did not mean to change. The exception is
 * `createAnnouncementSchema`, where a missing `title` is not a partial update but
 * a malformed notice — that is the "only `.required()` when the operation is
 * genuinely impossible without it" case.
 *
 * **`endsAt > startsAt` is deliberately absent.** It looks like a `.when()` with
 * `.greater()` on Joi, and putting it there would be wrong twice over. First,
 * 422 is owned by this layer — so the *status* would be right — but the message
 * would be Joi's `"endsAt" must be greater than "startsAt"`, which does not say
 * the one thing that matters: a window that closes at or before it opens is never
 * live, so the notice would not have been shown to anybody even once. Second and
 * worse, `startsAt` and `endsAt` are not both in the payload on a PATCH. A PUT of
 * `{ startsAt: <later than the stored endsAt> }` is a well-formed request against
 * Joi and produces an announcement that can never be displayed. The check has to
 * be made against the merged document, which is
 * `assertAudienceConsistent`'s neighbour in the service. The validation layer
 * checks what a single request says; the service checks what the document will
 * mean.
 */

/**
 * A 24-character hex ObjectId.
 *
 * The pattern, not `Joi.string().hex()`, because `hex()` accepts any even-length
 * hex string — a 4-character `"beef"` passes it and then fails inside
 * `optionalId` with a 400 whose message ("Invalid announcement ID") is less
 * specific than what Joi could have said here. Rejecting it in the schema keeps
 * every malformed-id failure on one status code and one wording.
 */
const objectId = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({ "string.pattern.base": "Invalid ID format" });

/**
 * `GET /admin/announcements/:id`, `PUT` and `DELETE`.
 *
 * Validated at `params` rather than trusted. `optionalId` in `platformQuery.js`
 * would catch it either way, but catching it here means the 422 arrives before
 * the handler runs and carries Joi's wording.
 */
const announcementIdParamSchema = Joi.object({
  id: objectId.required().messages({ "any.required": "An announcement ID is required" }),
});

/**
 * `GET /admin/announcements`
 *
 * `active` is a real boolean rather than the string `"true"`. Joi converts query
 * strings (`convert: true` in `middleware/validate.js:43`), and an absent flag
 * stays `undefined` rather than becoming `false` — so `?active=false` is
 * distinguishable from `?active=` only by Joi's own conversion, and both mean
 * "no filter", which is correct: the default read is *everything*, newest
 * `startsAt` first.
 *
 * `perPage` is capped at `MAX_PER_PAGE` (200) rather than an arbitrary number,
 * because `resolvePagination` clamps to the same ceiling. Both exist on purpose:
 * Joi's cap produces a 422 a client can act on, and the clamp in
 * `platformQuery.js` guarantees the ceiling for callers that never pass through
 * this middleware. One ceiling, enforced twice, rather than two ceilings.
 */
const listAnnouncementsQuerySchema = Joi.object({
  active: Joi.boolean().optional(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(MAX_PER_PAGE).default(DEFAULT_PER_PAGE),
});

/**
 * `targetAudience`.
 *
 * The three values are `PlatformAnnouncement.js:71-76`'s enum, copied rather
 * than imported so that a change to the model is a deliberate edit here that
 * somebody reads, rather than a silent widening of what the console accepts
 * because someone added a fourth value to the schema. `Joi.valid()` on a model
 * enum is the cheapest kind of contract to keep.
 *
 * Note this is *not* the same vocabulary as the SMS broadcast's audience. That
 * one is `all_schools | selected_schools` — the third announcement audience,
 * `all_admins`, means "every school's admins" rather than "every school's
 * users", and the SMS broadcast has no equivalent because it is already scoped to
 * school admins by definition. Sharing one enum between the two would imply a
 * fourth SMS audience that does not exist.
 */
const targetAudience = Joi.string()
  .valid("all_schools", "selected_schools", "all_admins")
  .default("all_schools");

/**
 * `POST /admin/announcements`
 *
 * `.required()` on exactly three fields, and each earns it:
 *
 *   - `title` / `body` — the notice itself. A row with neither is not an
 *     announcement, it is an empty object with a date range.
 *   - `startsAt` — the model's own choice, and the right one: required rather
 *     than defaulted to now, so that scheduling a future notice is the *same
 *     write* as publishing one today and the only difference is the value. A
 *     defaulted `startsAt` would make "I scheduled this for Monday" a payload
 *     that omits the field, which is indistinguishable from "publish immediately"
 *     on the wire.
 *
 * `targetSchoolIds` is **optional here and the rule is enforced in the service**,
 * not by `.when()`. A Joi `.when()` could express "required if the audience is
 * `selected_schools`, forbidden otherwise", but it can only look at the one
 * payload in front of it — so on a PATCH it would compare the *new* audience
 * against the *absent* id list and either demand ids the caller is not sending
 * or accept stale ones it cannot see. It would also answer with a 422 carrying a
 * field-level message, where the real problem is a contradiction between two
 * fields and deserves an explanation. See `assertAudienceConsistent`.
 *
 * `body` is capped at 2000 to match `PlatformAnnouncement.body.maxlength`.
 * Both, not either: the model cap is what actually protects the database, and
 * the Joi cap is what stops a 40k-character notice from being carried across the
 * wire and rejected on arrival. A cap that exists only in the model produces a
 * 500-adjacent `ValidationError` from the write; a cap that exists only in Joi
 * produces nothing at all for any other caller of the service.
 *
 * `.max(LIMITS.MAX_SMS_MESSAGE_BODY)` is deliberately **not** applied — that is
 * 480, an SMS composer limit, and this is a notice rendered in a browser where
 * the constraint is legibility, not a 160-character handset.
 */
const createAnnouncementSchema = Joi.object({
  title: Joi.string().trim().min(1).max(150).required(),
  body: Joi.string().trim().min(1).max(2000).required(),
  severity: Joi.string().valid("info", "warning", "critical").default("info"),
  targetAudience,
  targetSchoolIds: Joi.array().items(objectId).max(500).optional(),
  startsAt: Joi.date().iso().required(),
  // `.allow(null)` because `null` is the stored meaning of "no end date" — a
  // standing notice — and a client clearing a previously-set `endsAt` has to be
  // able to say so. Without it Joi would treat the explicit null as a type error
  // and the notice could never be made open-ended again.
  endsAt: Joi.date().iso().allow(null).optional(),
});

/**
 * `PUT /admin/announcements/:id`
 *
 * Every field optional, `.min(1)` on the object. An empty body is a 422 rather
 * than a no-op on purpose: a client that meant to change something and sent
 * nothing has a bug, and answering "no changes to save" to it hides that bug
 * until somebody relies on the change having happened.
 *
 * `title`/`body` keep `.min(1)` but drop `.required()` — the patch rule. They
 * still cannot be blanked, because an announcement with an empty title is worse
 * than one that kept its old title.
 *
 * `isActive` is writable here as well as through `DELETE`. That is not a hole in
 * the withdraw-not-delete rule: setting it false is the *same* deactivation,
 * audited with `admin.announcement_delete` when done through the DELETE route.
 * A console that wants a "withdrawn" toggle in a settings pane should call the
 * DELETE route rather than this field, and the reason is in the service — but
 * forbidding the field here would leave an operator with no way to re-activate a
 * notice they withdrew by accident, which is a real and common recovery.
 */
const updateAnnouncementSchema = Joi.object({
  title: Joi.string().trim().min(1).max(150).optional(),
  body: Joi.string().trim().min(1).max(2000).optional(),
  severity: Joi.string().valid("info", "warning", "critical").optional(),
  targetAudience: Joi.string()
    .valid("all_schools", "selected_schools", "all_admins")
    .optional(),
  targetSchoolIds: Joi.array().items(objectId).max(500).optional(),
  startsAt: Joi.date().iso().optional(),
  endsAt: Joi.date().iso().allow(null).optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

export {
  announcementIdParamSchema,
  listAnnouncementsQuerySchema,
  createAnnouncementSchema,
  updateAnnouncementSchema,
};