import { SchoolAd, AD_PLACEMENTS } from "../models/SchoolAd.js";
import { School } from "../models/schoolModel.js";
import { User } from "../models/userModel.js";
import { Notification } from "../models/Notification.js";
import { extractPublicId, deleteFromCloudinary } from "../middleware/upload.js";
import { isFeatureEnabled } from "../services/platformSettings.service.js";
import {
  listSchoolAdRequests,
  getSchoolAdRequest,
  createSchoolAdRequest,
  withdrawSchoolAdRequest,
} from "../services/schoolAdRequest.service.js";
import { NOTIFICATION_TYPES, AUDIT_ACTIONS } from "../config/constants.js";
import auditService from "../utils/auditService.js";

const isLive = (ad, now = new Date()) =>
  ad.status === "approved" &&
  (!ad.startsAt || ad.startsAt <= now) &&
  ad.endsAt > now;

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

    const placement = req.query.placement || "auth_aside";
    const now = new Date();

    const ads = await SchoolAd.find({
      placement,
      status: "approved",
      deletedAt: null,
      endsAt: { $gt: now },
      $or: [{ startsAt: null }, { startsAt: { $lte: now } }],
    })
      .sort({ sortWeight: -1, createdAt: 1 })
      .limit(6)
      .select("schoolName headline imageUrl imageAlt linkUrl")
      .lean();

    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
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
    if (placement) filter.placement = placement;
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

    // Envelope note. This handler replied `{ ads, pagination }` while every list
    // endpoint in the product — and `listSchoolAds` in `services/admin.js`, the client
    // for this very route — reads `data` and `meta`. So even once the path was fixed
    // the queue rendered zero rows and an empty pager, because both keys it reads were
    // absent. `ads`/`pagination` are kept alongside as aliases: the public slider
    // handler above has its own separate envelope and is untouched, and dropping these
    // would break any caller written against the original response.
    return res.status(200).json({
      success: true,
      data: ads,
      meta: { page, perPage, total, pages, totalPages: pages },
      ads,
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
    const { schoolId, imageUrl, ...rest } = req.body;
    const uploaded = req.file;

    const resolvedImage = uploaded?.secure_url || imageUrl;
    if (!resolvedImage) {
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
        if (uploaded) await deleteFromCloudinary(uploaded.public_id);
        return res.status(404).json({ success: false, message: "School not found" });
      }
    }

    const ad = await SchoolAd.create({
      ...rest,
      schoolId: schoolId || null,
      imageUrl: resolvedImage,
      imagePublicId: uploaded?.public_id || extractPublicId(resolvedImage),
      // New submissions always start unapproved: an ad must never reach the
      // public slider without a human approving it.
      status: "pending",
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

    return res.status(201).json({
      success: true,
      message: "Ad submitted for approval",
      // `data` is the envelope every other create endpoint in the product replies
      // with, and the one `createSchoolAd` in `services/admin.js` reads. `ad` is kept
      // as an alias for callers written against the original response.
      data: ad,
      ad,
    });
  } catch (error) {
    if (req.file?.public_id) await deleteFromCloudinary(req.file.public_id);
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

    const ad = await SchoolAd.findOne({ _id: adId, deletedAt: null });
    if (!ad) {
      if (uploaded) await deleteFromCloudinary(uploaded.public_id);
      return res.status(404).json({ success: false, message: "Ad not found" });
    }

    Object.assign(ad, rest);

    if (uploaded) {
      if (ad.imagePublicId) await deleteFromCloudinary(ad.imagePublicId);
      ad.imageUrl = uploaded.secure_url;
      ad.imagePublicId = uploaded.public_id;
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
      details: {
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

    const resolvedImage = uploaded?.secure_url || imageUrl;
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
    if (req.file?.public_id) {
      try {
        await deleteFromCloudinary(req.file.public_id);
      } catch (cleanupError) {
        console.error(
          `[AD-REQ] Could not remove orphan upload ${req.file.public_id}:`,
          cleanupError.message
        );
      }
    }
    return res
      .status(error.status || 500)
      .json({ success: false, message: error.message });
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

export { AD_PLACEMENTS, isLive };
