import { SchoolAd, AD_PLACEMENTS } from "../models/SchoolAd.js";
import { School } from "../models/schoolModel.js";
import { extractPublicId, deleteFromCloudinary } from "../middleware/upload.js";
import { isFeatureEnabled } from "../services/platformSettings.service.js";

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

    return res.status(200).json({
      success: true,
      ads,
      pagination: { page, perPage, total, pages: Math.ceil(total / perPage) },
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
    });

    return res.status(201).json({
      success: true,
      message: "Ad submitted for approval",
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
    return res.status(200).json({ success: true, ad: updated });
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

    const updated = await ad.save();
    return res.status(200).json({
      success: true,
      message: status === "approved" ? "Ad is now live" : "Ad rejected",
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

export { AD_PLACEMENTS, isLive };
