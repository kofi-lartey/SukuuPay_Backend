import { createHash } from "crypto";
import { SchoolAd, AD_PLACEMENTS } from "../models/SchoolAd.js";
import { School } from "../models/schoolModel.js";
import { User } from "../models/userModel.js";
import { Notification } from "../models/Notification.js";
import { extractPublicId, deleteFromCloudinary, readUploaded } from "../middleware/upload.js";
import { resolveErrorMessage } from "../middleware/errorHandler.js";
import { isFeatureEnabled } from "../services/platformSettings.service.js";
import {
  listSchoolAdRequests,
  getSchoolAdRequest,
  createSchoolAdRequest,
  withdrawSchoolAdRequest,
} from "../services/schoolAdRequest.service.js";
import { NOTIFICATION_TYPES, AUDIT_ACTIONS } from "../config/constants.js";
import auditService from "../utils/auditService.js";

/**
 * The query behind the public slider: what counts as a live ad for one placement.
 *
 * This was inlined in `listPublicSchoolAds` while a separate `isLive` helper sat above
 * it, unused, spelling the same rule in JavaScript. Two definitions of "live" is one
 * more than a codebase should have, and it is the kind of pair that drifts: the query
 * gained `deletedAt: null` and the helper did not, and the helper was the one a new
 * caller would reach for. There is one now, and it is this.
 *
 * **The window is half-open.** An ad is live from `startsAt` (a null start meaning
 * "immediately") up to but not including `endsAt`, which is why an ad whose run has
 * elapsed stops being served without anything having to clean it up.
 *
 * Kept as a plain query object rather than a `SchoolAdQuery` helper so the shape is
 * readable next to the `.select()` and `.sort()` it is used with, and so the index
 * `{ placement, status, endsAt }` on the model is legible as being served by it.
 */
const liveAdsQuery = (placement, now = new Date()) => ({
  // A null placement means "every placement" — the term is omitted
  // rather than matched literally, because `placement: null` in a Mongo
  // query matches only documents whose placement *is* null, and no
  // document has one. This is what `placement=all` on the public
  // endpoint resolves to.
  ...(placement ? { placement } : {}),
  status: "approved",
  deletedAt: null,
  endsAt: { $gt: now },
  $or: [{ startsAt: null }, { startsAt: { $lte: now } }],
});

/** Whether one already-loaded ad is live. Same rule, for a single document. */
const isLive = (ad, now = new Date()) =>
  ad.status === "approved" &&
  !ad.deletedAt &&
  (!ad.startsAt || ad.startsAt <= now) &&
  ad.endsAt > now;

/**
 * Why one ad is not being served, in the order a reader would check.
 *
 * Returns `null` when it is live, and otherwise a short sentence naming **the first**
 * thing that is wrong. Ordered by how often each is the answer and by how much it
 * matters: a draft that was never approved is the ordinary case and is answered first,
 * and a soft-deleted creative is answered first of all because it is the one an operator
 * is least likely to remember doing.
 *
 * The sentences are written for the console row that shows them, so they name the
 * condition in the words an operator would use — not `SCHOOL_ACCESS_DENIED`, not a field
 * name.
 */
const visibilityReason = (ad, now = new Date()) => {
  if (ad.deletedAt) return "This creative was deleted.";
  if (ad.status === "draft") return "Still a draft — approve it to publish it.";
  if (ad.status === "pending") return "Waiting for approval.";
  if (ad.status === "rejected") return "Rejected, so it is not published.";
  if (ad.status !== "approved") return `Not published — its status is “${ad.status}”.`;
  if (ad.endsAt && ad.endsAt <= now) return "Its run has ended — extend the end date to show it again.";
  if (ad.startsAt && ad.startsAt > now) return "Scheduled to start later.";
  return null;
};

// ─────────────────────────────────────────────
// GET /public/school-ads
// Unauthenticated by design: this renders on the login, signup and password
// recovery pages. It therefore exposes a fixed projection and never reuses the
// privileged school list, whose payload carries settlement bank details.
// ─────────────────────────────────────────────
export const listPublicSchoolAds = async (req, res) => {
  try {
    // The platform switch (`features.adsEnabled`).
    //
    // Answered as **200 with an empty list**, not an error, and that is a contract
    // rather than a convenience: this endpoint has exactly two states today — ads
    // or `{ ads: [] }` — and a 503 would give the login page a new failure mode for a
    // thing that is a perfectly normal state of the world. Turning the slider off
    // should look like a school having nothing to promote.
    //
    // `Cache-Control` matters more here than it looks. The success path sets
    // `max-age=300`, so an empty list served *without* `no-store` would keep being
    // served from an edge cache for five minutes after an operator turns the flag
    // back on — the switch would appear not to work, and the console would show it
    // as on.
    const adsEnabled = await isFeatureEnabled("adsEnabled");
    if (!adsEnabled) {
      res.set("Cache-Control", "no-store");
      return res.status(200).json({ success: true, ads: [], adsEnabled: false });
    }

    const placement = req.query.placement || "advertisement_page";
    const now = new Date();

    // `placement=all` is the School Advertisements hub's query: every
    // live creative, across every placement, in one request. The term is
    // simply omitted from the query rather than matched literally — no
    // document carries a placement of "all".
    const query = liveAdsQuery(placement === "all" ? null : placement, now);

    // The hub page asks for up to 24; the default of 6 keeps the small
    // consumers (a single-placement band) exactly as cheap as before.
    const perPage = Math.min(
      Math.max(Number(req.query.perPage) || 6, 1),
      24
    );

    const ads = await SchoolAd.find(query)
      .sort({ sortWeight: -1, createdAt: 1 })
      .limit(perPage)
      // `placement`, `writeup` and `endsAt` are the three fields the hub
      // page renders (a placement badge, the body copy and a run-until
      // date) and the slider does not need — but the projection is shared,
      // and naming them here is what makes one endpoint serve both.
      .select(
        "schoolId schoolName headline writeup imageUrl imageAlt linkUrl placement endsAt"
      )
      .lean();

    /*
     * Caching, and the second half of why a published creative looks broken.
     *
     * This used to answer **every** request with `public, max-age=300,
     * stale-while-revalidate=86400`. So a parent who had the login page open before a
     * super admin posted a creative kept being served the *empty* list they had
     * already cached — and `stale-while-revalidate` lets a stale copy be served for a
     * further day while it revalidates in the background. The operator posts an ad,
     * opens the login page, sees nothing, and concludes the feature is broken. It is
     * the same class of bug as the `no-store` note above, inverted: that comment
     * worried about the flag being turned on and the cache hiding it, and the fix for
     * one direction quietly created the problem in the other.
     *
     * So the cache follows what the response is worth:
     *
     *   - **Empty → `no-store`.** Nothing to cache, and an empty list is exactly the
     *     response that must never outlive the decision to publish.
     *   - **Non-empty → 60 seconds with an ETag.** Short enough that posting an ad is
     *     visible within a minute, long enough that the login page is not refetched on
     *     every navigation. The `stale-while-revalidate` window is dropped deliberately:
     *     it buys nothing over an ETag, which revalidates in one conditional request.
     */
    if (ads.length === 0) {
      res.set("Cache-Control", "no-store");
      return res.status(200).json({ success: true, ads: [], adsEnabled: true });
    }

    const etag = `"${createHash("sha1").update(JSON.stringify(ads)).digest("hex")}"`;
    res.set("ETag", etag);
    res.set("Cache-Control", "public, max-age=60, must-revalidate");

    // A 304 is the whole point of sending one: the body is byte-identical to what the
    // client already holds, so the answer is "keep what you have".
    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }

    return res.status(200).json({
      success: true,
      ads,
      // Present so a client can distinguish "off" from "nobody is advertising".
      // The list alone cannot tell them apart, and a dashboard asking why the
      // sidebar is empty deserves a better answer than an array.
      adsEnabled: true,
    });
  } catch (error) {
    // Never surface an error to the client: the auth pages must degrade to
    // "no ads" rather than showing a broken panel.
    console.error("Public school ads fetch failed:", error.message);
    res.set("Cache-Control", "no-store");
    return res.status(200).json({ success: true, ads: [] });
  }
};

// ─────────────────────────────────────────────
// GET /admin/school-ads — moderation queue
// ─────────────────────────────────────────────
export const listSchoolAds = async (req, res) => {
  try {
    const { page = 1, perPage = 20, placement, status } = req.query;

    const filter = { deletedAt: null };
    // `placement=all` is accepted on the shared schema so the public hub
    // and the moderation queue validate the same vocabulary; here it means
    // "no placement filter" rather than a literal match, which would
    // silently return an empty queue.
    if (placement && placement !== "all") filter.placement = placement;
    if (status) filter.status = status;

    const [ads, total] = await Promise.all([
      SchoolAd.find(filter)
        .sort({ status: 1, endsAt: 1 })
        .skip((page - 1) * perPage)
        .limit(perPage)
        .populate("schoolId", "name")
        .populate("approvedBy", "name email"),
      SchoolAd.countDocuments(filter),
    ]);

    const pages = Math.ceil(total / perPage);

    /*
     * `visibility`, on every row.
     *
     * The console has no way to answer "I posted it, why is it not on the login page?"
     * without the reader being the one to work it out. `status: approved` looks like the
     * whole answer and is not: the public query also wants a live window, a placement
     * that matches where it is being looked for, and no soft delete. So a creative can
     * sit in the queue reading "Approved" and be invisible, and the only symptom is an
     * empty login panel that looks like a broken feature.
     *
     * Naming the reason per row turns that into a readout. It is computed from the same
     * `isLive` the public query's rule lives in, so it cannot be optimistic: the console
     * says "Showing" only when the same rule that serves the page agrees.
     *
     * Not filtered on — a hidden creative must still be visible *in the queue*, because
     * the whole question is how an operator finds out that it is hidden.
     */
    const now = new Date();
    const rows = ads.map((ad) => {
      const doc = ad.toObject ? ad.toObject() : ad;
      const reason = visibilityReason(doc, now);
      return { ...doc, visibility: { live: reason === null, reason } };
    });

    // Envelope note. This handler replied `{ ads, pagination }` while every list
    // endpoint in the product — and `listSchoolAds` in `services/admin.js`, the client
    // for this very route — reads `data` and `meta`. So even once the path was fixed
    // the queue rendered zero rows and an empty pager, because both keys it reads were
    // absent. `ads`/`pagination` are kept alongside as aliases: the public slider
    // handler above has its own separate envelope and is untouched, and dropping these
    // would break any caller written against the original response.
    return res.status(200).json({
      success: true,
      data: rows,
      meta: { page, perPage, total, pages, totalPages: pages },
      ads: rows,
      pagination: { page, perPage, total, pages },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// POST /admin/school-ads
// `image` is the multer-handled creative; `imageUrl` in the body is used when
// an operator pastes an already-hosted asset instead.
// ─────────────────────────────────────────────
export const createSchoolAd = async (req, res) => {
  try {
    // `publish` is destructured out rather than left in `rest`, so it can never reach
    // `SchoolAd.create` as an unknown field. It is a *request*, not a document — the
    // document records the decision it resolved to, in `status`/`approvedAt`.
    const { schoolId, imageUrl, publish, ...rest } = req.body;
    const uploaded = req.file;
    // `path`/`filename`, not `secure_url`/`public_id` — see `readUploaded`. Reading the
    // old names here is what answered "an image is required" about requests that had
    // arrived complete.
    const { url: uploadedUrl, publicId: uploadedPublicId } = readUploaded(uploaded);

    const resolvedImage = uploadedUrl || imageUrl;
    if (!resolvedImage) {
      /*
       * Diagnosed here rather than left as "an image is required".
       *
       * This branch is reached whenever a creative arrives with no usable picture, and
       * the ways it gets there are indistinguishable from the message the client sees:
       * a client that never sent a file, a multipart body whose boundary was missing
       * (busboy then drops every field, so `req.body` is empty and Joi would have
       * failed first), a Cloudinary upload that produced no `secure_url`, or a file
       * part under a name other than the `image` this route is mounted for.
       *
       * The asymmetry is the problem: a body that arrived *with* its fields but without
       * its file looks identical to an operator who forgot to choose one, so the error
       * blames the person instead of the request. These three lines turn the next
       * occurrence into a one-glance answer.
       *
       * Server-side log only. The content type is attacker-influenced, and echoing it
       * back would be a reflected-header surface for no benefit — the operator does not
       * need it, whoever is debugging this does.
       */
      console.error("[AD-CREATE] No usable image on the request", {
        contentType: req.headers["content-type"] || null,
        hasFile: Boolean(req.file),
        // Which fields survived is the discriminator: present-and-no-file means the
        // body parsed and the picture did not arrive; empty means the body never parsed.
        bodyKeys: Object.keys(req.body || {}),
        hasImageUrl: Boolean(imageUrl),
      });

      return res.status(422).json({
        success: false,
        message: "An ad image is required (upload a file or supply imageUrl)",
      });
    }

    // A supplied schoolId must actually exist, otherwise the ad can never be
    // attributed or un-published when a school leaves the platform.
    if (schoolId) {
      const school = await School.findById(schoolId).select("_id").lean();
      if (!school) {
        if (uploaded) await deleteFromCloudinary(uploadedPublicId);
        return res.status(404).json({ success: false, message: "School not found" });
      }
    }

    // Joi coerces `"true"`/`"false"` from a multipart body, so this is a real boolean
    // by the time it arrives — but the strict `=== true` is what keeps a truthy string
    // or a `1` from being read as an instruction to publish. Absent means pending.
    const goLive = publish === true;

    const ad = await SchoolAd.create({
      ...rest,
      schoolId: schoolId || null,
      imageUrl: resolvedImage,
      imagePublicId: uploadedPublicId || extractPublicId(resolvedImage),
      /*
       * The two outcomes of one decision.
       *
       * Posted straight through (`publish: true`) the ad is `approved` from the
       * moment it is written, with the publishing operator recorded as its approver —
       * the platform owner *is* the approval step for a creative the platform wrote,
       * which is why `publish` is a verb and not a status: what it resolves to is
       * here, in one place, and nowhere else.
       *
       * Otherwise it is `pending`, and the only way to move it is `reviewSchoolAd`. An
       * ad must never reach the public slider without somebody having decided that it
       * should.
       */
      status: goLive ? "approved" : "pending",
      approvedBy: goLive ? req.user._id : null,
      approvedAt: goLive ? new Date() : null,
      // **Every ad created through this route is platform-authored.**
      //
      // This is the console path: a super admin writing an ad for the platform or on a
      // school's behalf. There is no school-submitted request here, so the author and
      // the approver are the same person by construction — which satisfies "must be
      // approved by the super admin" without a second pair of eyes, but is an
      // *exception* rather than the rule.
      //
      // Flagged rather than left implicit, because `reviewSchoolAd` writes
      // `selfApproved: true` to the audit log from this field. Without it the audit log
      // would claim a separation of duties that this path never had.
      authoredByPlatform: true,
    });

    /*
     * A publication is audited at the moment it happens.
     *
     * The school path records `ad.request` when a school asks
     * (`schoolAdRequest.service.js:187`) and `ad.review` when a decision is made
     * (`reviewSchoolAd`, below). This handler recorded neither, which left the one
     * event with the largest blast radius — a creative appearing on the login page of
     * every unauthenticated visitor — as the only ad lifecycle step with no trail.
     *
     * `AD_REVIEW` rather than a new action, because "who put this on the public pages,
     * and was it their own work" is the question that action already answers, and
     * `selfApproved` is exactly the flag it carries. `publishedOnCreate` distinguishes
     * it from a creative that was filed and then reviewed afterwards.
     *
     * `log` swallows its own failures, so an audit write can never turn a successful
     * publish into a 500 — the trade is deliberate and is documented on `log`.
     */
    await auditService.log({
      action: AUDIT_ACTIONS.AD_REVIEW,
      entity: "SchoolAd",
      entityId: ad._id,
      userId: req.user._id,
      schoolId: ad.schoolId,
      req,
      meta: {
        action: goLive ? "publish" : "submit",
        status: ad.status,
        placement: ad.placement,
        endsAt: ad.endsAt,
        // True on both paths, and true because of `authoredByPlatform` rather than
        // despite it: the console author is the platform owner.
        selfApproved: true,
        publishedOnCreate: goLive,
      },
    });

    return res.status(201).json({
      success: true,
      // The message is the difference between the two outcomes, stated plainly. A
      // caller that ignores it and toasts "submitted" for a creative that is already
      // on the login page is the failure this prevents.
      message: goLive ? "Ad published" : "Ad submitted for approval",
      // `data` is the envelope every other create endpoint in the product replies
      // with, and the one `createSchoolAd` in `services/admin.js` reads. `ad` is kept
      // as an alias for callers written against the original response.
      data: ad,
      ad,
      published: goLive,
    });
  } catch (error) {
    await deleteFromCloudinary(readUploaded(req.file).publicId);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// PUT /admin/school-ads/:adId
// ─────────────────────────────────────────────
export const updateSchoolAd = async (req, res) => {
  try {
    const { adId } = req.params;
    const { imageUrl, status, ...rest } = req.body;
    const uploaded = req.file;
    const { url: uploadedUrl, publicId: uploadedPublicId } = readUploaded(uploaded);

    const ad = await SchoolAd.findOne({ _id: adId, deletedAt: null });
    if (!ad) {
      if (uploaded) await deleteFromCloudinary(uploadedPublicId);
      return res.status(404).json({ success: false, message: "Ad not found" });
    }

    Object.assign(ad, rest);

    if (uploaded) {
      if (ad.imagePublicId) await deleteFromCloudinary(ad.imagePublicId);
      ad.imageUrl = uploadedUrl;
      ad.imagePublicId = uploadedPublicId;
    } else if (imageUrl) {
      ad.imageUrl = imageUrl;
    }

    // Status is only ever changed through the approval action, so an operator
    // cannot self-approve by hitting this endpoint.
    if (status !== undefined) ad.status = ad.status;

    const updated = await ad.save();
    return res.status(200).json({ success: true, data: updated, ad: updated });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// PUT /admin/school-ads/:adId/approve
// ─────────────────────────────────────────────
export const reviewSchoolAd = async (req, res) => {
  try {
    const { adId } = req.params;
    const { status, rejectedReason } = req.body;

    const ad = await SchoolAd.findOne({ _id: adId, deletedAt: null });
    if (!ad) {
      return res.status(404).json({ success: false, message: "Ad not found" });
    }

    // The copy fields are editable in the same request as the decision, so the
    // expiry check has to run *after* `endsAt` is applied — otherwise a moderator
    // extending a lapsed campaign alongside its approval is refused on the old date.
    // `reviewSchoolAd` in `services/schoolAdRequest.service.js` is the school-facing
    // sibling; this is the console's, and it is where the platform's editorial power
    // over the words lives.
    const {
      headline,
      writeup,
      imageAlt,
      linkUrl,
      placement,
      endsAt,
    } = req.body;

    // Recorded before the comparison so the flag means "the published copy differs from
    // what the school submitted", which is the fact the school needs to be told.
    let copyEdited = false;

    if (headline !== undefined && headline !== ad.headline) {
      ad.headline = headline;
      copyEdited = true;
    }
    if (writeup !== undefined && (writeup || null) !== (ad.writeup || null)) {
      ad.writeup = writeup || null;
      copyEdited = true;
    }
    if (imageAlt !== undefined && imageAlt !== ad.imageAlt) ad.imageAlt = imageAlt;
    if (linkUrl !== undefined) ad.linkUrl = linkUrl;
    if (placement !== undefined) ad.placement = placement;
    if (endsAt !== undefined && new Date(endsAt).getTime() !== new Date(ad.endsAt).getTime()) {
      ad.endsAt = endsAt;
    }

    if (status === "approved" && ad.endsAt <= new Date()) {
      return res.status(422).json({
        success: false,
        message: "This ad has already expired; extend endsAt before approving",
      });
    }

    ad.status = status;
    ad.approvedBy = req.user._id;
    ad.approvedAt = new Date();
    ad.rejectedReason = status === "rejected" ? rejectedReason : "";

    if (status === "approved" && copyEdited) ad.copyEditedByReview = true;

    const updated = await ad.save();

    // ── Tell the school ──
    //
    // Best-effort and *after* the save. The decision is recorded either way; a failed
    // notification means the school finds out on their request list rather than by
    // email, and the moderation queue is not blocked by a mailer.
    try {
      const outcome =
        status === "approved"
          ? NOTIFICATION_TYPES.AD_APPROVED
          : NOTIFICATION_TYPES.AD_REJECTED;

      const staff = await User.find({
        schoolId: ad.schoolId,
        role: { $in: ["school_admin", "accountant"] },
        status: "active",
        deletedAt: null,
      })
        .select("_id")
        .lean();

      if (staff.length) {
        await Notification.insertMany(
          staff.map((member) => ({
            userId: member._id,
            schoolId: ad.schoolId,
            type: outcome,
            title:
              status === "approved"
                ? `Advertisement approved — ${ad.headline}`
                : `Advertisement declined — ${ad.headline}`,
            message:
              status === "approved"
                ? `“${ad.headline}” is now live${copyEdited ? ". The wording was adjusted before publishing — open the request to read the final copy." : "."}`
                : `“${ad.headline}” was declined: ${rejectedReason}`,
            link: "/dashboard/advertisements",
            meta: {
              adId: String(ad._id),
              copyEdited,
              // The final copy, so the school reads what went live rather than
              // discovering a change they did not agree to.
              headline: ad.headline,
              writeup: ad.writeup || null,
            },
          }))
        );
      }
    } catch (error) {
      console.error(`[AD-REVIEW] Notification failed for ${ad._id}:`, error.message);
    }

    await auditService.log({
      action: AUDIT_ACTIONS.AD_REVIEW,
      entity: "SchoolAd",
      entityId: ad._id,
      userId: req.user._id,
      schoolId: ad.schoolId,
      req,
      /*
       * `meta`, not `details`.
       *
       * This block read `details`, which is not a key `auditService.log` destructures
       * — it accepts `meta`. So the object below was dropped whole and every ad review
       * in the audit log recorded *that* a review happened and nothing about which
       * decision it was, who made it, or whether the wording changed. `selfApproved`
       * in particular is the entire reason `authoredByPlatform` is stored on the
       * document, and it was going nowhere. `log` names this exact failure at
       * `auditService.js:45-50`.
       */
      meta: {
        adId: String(ad._id),
        status,
        copyEdited,
        // The separation-of-duties exception, made visible. When the platform authored
        // an ad, the author and the approver are the same person — which satisfies the
        // requirement by construction but is an exception rather than the rule, and
        // recording it is the difference between an honest audit log and one that
        // claims a review the platform did not have.
        selfApproved: Boolean(ad.authoredByPlatform),
        rejectedReason: status === "rejected" ? rejectedReason : undefined,
      },
    });

    return res.status(200).json({
      success: true,
      message:
        status === "approved"
          ? copyEdited
            ? "Ad is now live, with adjusted wording"
            : "Ad is now live"
          : "Ad rejected",
      data: updated,
      ad: updated,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// DELETE /admin/school-ads/:adId
// Soft-deletes, and removes the Cloudinary asset so an unpublished creative
// does not linger in the bucket.
// ─────────────────────────────────────────────
export const deleteSchoolAd = async (req, res) => {
  try {
    const { adId } = req.params;
    const ad = await SchoolAd.findOne({ _id: adId, deletedAt: null });
    if (!ad) {
      return res.status(404).json({ success: false, message: "Ad not found" });
    }

    ad.deletedAt = new Date();
    ad.status = "expired";
    await ad.save();

    if (ad.imagePublicId) await deleteFromCloudinary(ad.imagePublicId);

    return res.status(200).json({ success: true, message: "Ad removed" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// School-facing: advertisement requests
//
// `/schools/me/ad-requests`. The `/me` is the point — there is no school id in the
// path, so there is nothing for a school admin to change to reach another school's
// ads. The service scopes every query by `user.schoolId` as well, because a route
// shape alone is not an authorisation check.
// ─────────────────────────────────────────────

export const listMyAdRequests = async (req, res) => {
  try {
    const { page, perPage, status } = req.query;
    const result = await listSchoolAdRequests({
      schoolId: req.user.schoolId,
      status,
      page: Number(page) || 1,
      perPage: Number(perPage) || 20,
    });

    return res.status(200).json({
      success: true,
      data: result.rows,
      meta: {
        page: result.page,
        perPage: result.perPage,
        total: result.total,
        totalPages: Math.ceil(result.total / result.perPage),
      },
    });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json({ success: false, message: error.message });
  }
};

export const getMyAdRequest = async (req, res) => {
  try {
    const result = await getSchoolAdRequest(req.params.adId, req.user.schoolId);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json({ success: false, message: error.message });
  }
};

export const createMyAdRequest = async (req, res) => {
  try {
    const { imageUrl } = req.body;
    const uploaded = req.file;

    const { url: uploadedUrl, publicId: uploadedPublicId } = readUploaded(uploaded);
    const resolvedImage = uploadedUrl || imageUrl;
    if (!resolvedImage) {
      return res.status(422).json({
        success: false,
        message: "An advertisement needs an image",
      });
    }

    const ad = await createSchoolAdRequest(
      // `imageUrl` is added back because the service needs the resolved creative, and
      // it is explicitly **not** taken from the body when a file was uploaded.
      { ...req.body, imageUrl: resolvedImage },
      req.user,
      uploaded
    );

    return res.status(201).json({
      success: true,
      message:
        "Your advertisement request has been sent for review. You will hear once it is approved.",
      data: ad,
      ad,
    });
  } catch (error) {
    // An uploaded creative that no ad ends up referencing would sit in the bucket
    // costing storage forever, so it is removed on the failure path.
    const orphanPublicId = readUploaded(req.file).publicId;
    try {
      await deleteFromCloudinary(orphanPublicId);
    } catch (cleanupError) {
      console.error(
        `[AD-REQ] Could not remove orphan upload ${orphanPublicId}:`,
        cleanupError.message
      );
    }
    return res
      .status(error.status || 500)
      .json({ success: false, message: resolveErrorMessage(error) });
  }
};

export const withdrawMyAdRequest = async (req, res) => {
  try {
    const result = await withdrawSchoolAdRequest(req.params.adId, req.user);
    return res.status(200).json({
      success: true,
      message: "Your advertisement request has been withdrawn.",
      data: result,
    });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json({ success: false, message: error.message });
  }
};

export { AD_PLACEMENTS, isLive, liveAdsQuery, visibilityReason };
