import Joi from "joi";
import { AD_PLACEMENTS, AD_STATUSES } from "../models/SchoolAd.js";

const objectId = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .required()
  .messages({ "string.pattern.base": "Invalid school ID format" });

// Ads render client-side from this value, so only https is accepted. A
// javascript: or data: URL here would turn every auth page into an XSS sink.
const safeUrl = Joi.string()
  .uri({ scheme: ["https"] })
  .trim()
  .max(500)
  .required()
  .messages({
    "string.uri": "linkUrl must be a valid https URL",
  });

const adBody = {
  schoolId: Joi.alternatives().try(Joi.string().allow("", null), Joi.valid(null)),
  schoolName: Joi.string().trim().min(2).max(150).required(),
  headline: Joi.string().trim().min(4).max(60).required(),
  // The body copy. The reason `headline`'s 60-character cap is survivable at all:
  // without this field a requester has exactly one sentence to say everything, and the
  // product can only ever publish a title.
  writeup: Joi.string().trim().max(600).allow("").optional(),
  imageUrl: Joi.string().trim().max(500).allow("").optional(),
  // Up to four creatives. `imageUrl` stays the primary one.
  imageUrls: Joi.array()
    .items(Joi.string().trim().uri().max(500))
    .max(4)
    .optional()
    .messages({ "array.max": "An advertisement carries at most 4 images" }),
  imageAlt: Joi.string().trim().min(5).max(160).required(),
  linkUrl: safeUrl,
  placement: Joi.string().valid(...AD_PLACEMENTS).default("auth_aside"),
  endsAt: Joi.date().iso().required(),
  sortWeight: Joi.number().integer().min(-100).max(100).default(0),
};

/**
 * `POST /admin/school-ads` — the platform console authoring a creative.
 *
 * **This is the only ad schema that can produce a live ad, and it still cannot be
 * told *what* status to write.** There is no `status` key. What it has instead is
 * `publish`, a boolean that means "post this straight to the public pages", and it
 * defaults to `false`.
 *
 * That indirection is the whole design, and it is worth being explicit about why a
 * bare `status` field was not added instead:
 *
 *   - **A status field is an open vocabulary.** `status: "approved"` written into a
 *     document is indistinguishable from `"pending"` a year later, and the next person
 *     to add `Joi.valid("expired")` to this schema has quietly given the console a
 *     way to expire an ad — which is a *different* operation with a different reason.
 *   - **`publish` is a verb, not a state.** It says what the caller is asking to
 *     happen, and the server decides what that means. `true` resolves to `approved`
 *     plus `approvedBy`/`approvedAt`; `false` resolves to `pending`. A future "post it
 *     now but starting in March" is a change to what `true` does, not a new value a
 *     caller can pass.
 *   - **The safe answer is the default one.** A creative written by the platform
 *     owner is normally posted directly, but the invariant that matters — *nothing
 *     reaches the login page of every visitor without somebody asking for it* — must
 *     not depend on a field the caller remembered to set. `false` means a caller that
 *     forgets the flag gets a filed pending ad and a toast, not a live one.
 *
 * `status` stays absent from `updateSchoolAdSchema` for the same reason it was absent
 * here before: an edit that could set a status would be a second way to publish.
 */
export const createSchoolAdSchema = Joi.object({
  ...adBody,
  publish: Joi.boolean().default(false),
})
  .custom((value, helpers) => {
    // A null startsAt means "live immediately".
    if (value.endsAt && new Date(value.endsAt) <= new Date()) {
      return helpers.message({
        custom: "endsAt must be in the future",
      });
    }
    return value;
  })
  .messages({ custom: "endsAt must be in the future" });

export const updateSchoolAdSchema = Joi.object({
  schoolName: Joi.string().trim().min(2).max(150).optional(),
  headline: Joi.string().trim().min(4).max(60).optional(),
  writeup: Joi.string().trim().max(600).allow("").optional(),
  imageUrl: Joi.string().trim().max(500).allow("").optional(),
  imageUrls: Joi.array()
    .items(Joi.string().trim().uri().max(500))
    .max(4)
    .optional()
    .messages({ "array.max": "An advertisement carries at most 4 images" }),
  imageAlt: Joi.string().trim().min(5).max(160).optional(),
  linkUrl: safeUrl.optional(),
  placement: Joi.string().valid(...AD_PLACEMENTS).optional(),
  endsAt: Joi.date().iso().optional(),
  sortWeight: Joi.number().integer().min(-100).max(100).optional(),
  // `status` and `rejectedReason` are deliberately absent: they are settable
  // only through the approve/reject endpoint, so an edit can never self-approve.
}).min(1);

/**
 * `POST /schools/me/ad-requests` — a school asking to be advertised.
 *
 * **No `schoolId` and no `status` in the body, by design rather than by omission.**
 *
 *  - `schoolId` comes from the session. A field here would be a `school_admin`-reachable
 *    way to publish an ad as another school, and these render on the public login and
 *    signup pages — so that is defacement, not a data error. The service also
 *    destructures its fields individually instead of spreading the body, so the
 *    guarantee does not depend on `stripUnknown` having been configured.
 *  - `status` is forced to `pending` server-side. There is no route a school can reach
 *    that writes an approved ad.
 *
 * `imageUrl` is accepted because the console route lets an operator paste an
 * already-hosted asset; on the school path the multer upload is preferred and the
 * controller refuses the request if neither is present.
 *
 * `endsAt` is `.min("now")` rather than only `.iso()`: `reviewSchoolAd` refuses to
 * approve an ad whose window has closed, so accepting a past date produces a request
 * that is dead on arrival and costs the school a round trip.
 */
export const createSchoolAdRequestSchema = Joi.object({
  headline: Joi.string().trim().min(4).max(60).required().messages({
    "string.min": "Give the advertisement a headline of at least 4 characters",
    "string.max": "The headline is limited to 60 characters — put the detail in the writeup",
  }),
  writeup: Joi.string().trim().max(600).allow("").optional(),
  imageUrl: Joi.string().trim().max(500).allow("").optional(),
  imageUrls: Joi.array()
    .items(Joi.string().trim().uri().max(500))
    .max(4)
    .optional()
    .messages({ "array.max": "An advertisement carries at most 4 images" }),
  // Required, same reason as the console schema: an ad whose meaning is only in pixels
  // is unreadable to a screen reader, and these render on every unauthenticated page.
  imageAlt: Joi.string().trim().min(5).max(160).required(),
  linkUrl: safeUrl,
  placement: Joi.string().valid(...AD_PLACEMENTS).default("auth_aside"),
  endsAt: Joi.date().min("now").required().messages({
    "date.min": "Choose an end date in the future",
  }),
});

export const listSchoolAdRequestsSchema = Joi.object({
  status: Joi.string().valid(...AD_STATUSES, "all").default("all"),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(50).default(20),
});

export const schoolAdIdParamSchema = Joi.object({
  adId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({ "string.pattern.base": "Invalid ad ID format" }),
});

export const listSchoolAdsQuerySchema = Joi.object({
  // No default here: this schema is shared by the public slider and the admin
  // moderation queue, and a default would hide every other placement from the
  // queue. listPublicSchoolAds falls back to "auth_aside" itself.
  placement: Joi.string().valid(...AD_PLACEMENTS).optional(),
  status: Joi.string().valid(...AD_STATUSES).optional(),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

/**
 * `PUT /admin/school-ads/:adId/review`
 *
 * **The copy fields are editable here, in the same request as the decision.** That is
 * the product requirement — a super admin may author ad content as well as review a
 * school's — and folding it into one action is what makes it usable: tightening a
 * school's submission and approving it is a single decision, and splitting it across
 * `/school-ads/:adId` then `/approve` would mean a half-finished edit could be left
 * sitting in the queue.
 *
 * `endsAt` is editable for the same reason and a second one: `reviewSchoolAd` refuses to
 * approve an expired ad, so a moderator extending a lapsed campaign *has* to be able to
 * change the date as part of approving it.
 *
 * When the body carries copy that differs from what is stored, `reviewSchoolAd` sets
 * `copyEditedByReview`, so the school can be told what changed before it sees it on the
 * login page. Silently publishing different words as the school's own is worse than
 * publishing their words.
 */
export const approveSchoolAdSchema = Joi.object({
  status: Joi.string()
    .valid("approved", "rejected")
    .required()
    .messages({ "any.only": "status must be approved or rejected" }),
  headline: Joi.string().trim().min(4).max(60).optional(),
  writeup: Joi.string().trim().max(600).allow("").optional(),
  imageAlt: Joi.string().trim().min(5).max(160).optional(),
  linkUrl: safeUrl.optional(),
  placement: Joi.string().valid(...AD_PLACEMENTS).optional(),
  endsAt: Joi.date().iso().optional(),
  rejectedReason: Joi.string().trim().max(300).allow("").optional(),
}).custom((value, helpers) => {
  if (value.status === "rejected" && !value.rejectedReason) {
    return helpers.message({
      custom: "A reason is required when rejecting an ad",
    });
  }
  return value;
}).messages({ custom: "A reason is required when rejecting an ad" });

export { objectId };
