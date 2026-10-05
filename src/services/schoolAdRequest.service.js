import mongoose from "mongoose";
import { SchoolAd } from "../models/SchoolAd.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/userModel.js";
import { School } from "../models/schoolModel.js";
import ApiError from "../utils/ApiError.js";
import auditService from "../utils/auditService.js";
import { NOTIFICATION_TYPES, AUDIT_ACTIONS } from "../config/constants.js";

/**
 * The school's side of advertisement requests.
 *
 * ## Why this is a separate service and not two more controller handlers
 *
 * Because the scoping is the whole security story, and it does not belong in a
 * controller next to an admin handler that does the opposite thing.
 *
 * `createSchoolAd` (admin) trusts `req.body.schoolId`, because a super admin may
 * legitimately write an ad for any school. A `school_admin`-authenticated route that
 * copied that shape would let **any school publish an advertisement as another
 * school** — and these render on the public login and signup pages, so that is
 * defacement rather than a data bug. Every read and write here therefore takes the
 * school from `user.schoolId` and puts it **in the query**, never from a parameter.
 */

/**
 * The ad requests this school has made, newest first.
 *
 * `schoolId` is forced rather than filtered on a parameter, so there is no request a
 * school admin can make that returns another school's ads — not by passing an id, and
 * not by omitting the filter and seeing everything.
 */
export const listSchoolAdRequests = async ({ schoolId, status, page, perPage }) => {
  if (!schoolId) {
    throw new ApiError("Your account is not linked to a school", 403, "SCHOOL_ACCESS_DENIED");
  }

  const filter = {
    schoolId: new mongoose.Types.ObjectId(schoolId),
    // Not `deletedAt: null` — a school should see that its ad was withdrawn, with the
    // reason, rather than have it silently vanish from the list and leave them
    // wondering. The console can still soft-delete; the record is the school's.
  };

  if (status && status !== "all") filter.status = status;

  const skip = (page - 1) * perPage;
  const [rows, total] = await Promise.all([
    SchoolAd.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .populate("approvedBy", "firstName lastName")
      .lean(),
    SchoolAd.countDocuments(filter),
  ]);

  return { rows, total, page, perPage };
};

/**
 * A school's advertisement request.
 *
 * Scoped by both `_id` **and** `schoolId`. Scoping only on `_id` would be enough for
 * authorisation today and is exactly the kind of thing that stops being enough the
 * moment a second caller appears.
 */
export const getSchoolAdRequest = async (adId, schoolId) => {
  if (!mongoose.Types.ObjectId.isValid(adId)) {
    throw new ApiError("Invalid advertisement ID", 400, "INVALID_AD_ID");
  }

  const ad = await SchoolAd.findOne({
    _id: adId,
    schoolId: schoolId ? new mongoose.Types.ObjectId(schoolId) : null,
  }).lean();

  if (!ad) {
    throw new ApiError("Advertisement not found", 404, "AD_NOT_FOUND");
  }
  return ad;
};

/**
 * A school asks to be advertised.
 *
 * `status` is **forced to `pending`** and `authoredByPlatform` to `false`, from
 * constants rather than from the caller's spread. That is the same rule
 * `createSchoolAd` follows for the console, and it is the reason the two paths can
 * share a collection: there is no route a school can reach that writes an `approved`
 * ad.
 *
 * A school may also **withdraw** its own pending request. Rejected and approved ads
 * are left alone — an approved ad is live on the public pages, and a school pulling it
 * is an unpublish, which is the console's decision.
 *
 * @param {object} data validated body
 * @param {{ _id, schoolId }} user
 * @param {{ secure_url: string, public_id: string } | null} uploaded the multer file
 */
export const createSchoolAdRequest = async (data, user, uploaded) => {
  const { schoolId } = user;

  if (!schoolId) {
    throw new ApiError("Your account is not linked to a school", 403, "SCHOOL_ACCESS_DENIED");
  }

  const school = await School.findById(schoolId).select("name").lean();
  if (!school) {
    throw new ApiError("Your school could not be found", 404, "SCHOOL_NOT_FOUND");
  }

  // Destructured rather than spread, so a body carrying `schoolId`, `status`,
  // `approvedBy` or `_id` cannot reach the document. `stripUnknown` in the validation
  // middleware would catch most of it, but this does not depend on that middleware
  // having been configured.
  const {
    headline,
    writeup,
    imageAlt,
    linkUrl,
    placement,
    endsAt,
    imageUrls,
  } = data;

  const ad = await SchoolAd.create({
    schoolId: new mongoose.Types.ObjectId(schoolId),
    // Denormalised from the school, not from the request body — a school cannot
    // advertise itself under another school's name even if the validation changes.
    schoolName: school.name,
    headline,
    writeup: writeup || null,
    imageAlt,
    linkUrl,
    placement: placement || "auth_aside",
    endsAt,
    imageUrls: imageUrls || [],
    status: "pending",
    requestedBy: user._id,
    authoredByPlatform: false,
    imageUrl: uploaded?.secure_url,
    imagePublicId: uploaded?.public_id || null,
  });

  // ── Tell the platform ──
  //
  // Guarded, and *after* the ad is written. The ad existing is the point; a failed
  // notification means a moderator finds it on the queue instead of being told, and
  // the school would otherwise be told their request was lost when it was not.
  try {
    const moderators = await User.find({
      role: "super_admin",
      status: "active",
      deletedAt: null,
    })
      .select("_id")
      .lean();

    if (moderators.length) {
      await Notification.insertMany(
        moderators.map((moderator) => ({
          userId: moderator._id,
          schoolId,
          type: NOTIFICATION_TYPES.AD_REQUEST,
          title: `Advertisement request — ${school.name}`,
          message: `${school.name} submitted “${headline}” for ${
            placement || "auth_aside"
          }. Review it before it can go live.`,
          link: "/admin/content",
          meta: {
            adId: String(ad._id),
            schoolId: String(schoolId),
            headline,
            hasWriteup: Boolean(writeup),
          },
        }))
      );
    }
  } catch (error) {
    console.error(
      `[AD-REQ] Moderator notification failed for ${ad._id}:`,
      error.message
    );
  }

  await auditService.log({
    action: AUDIT_ACTIONS.AD_REQUEST,
    entity: "SchoolAd",
    entityId: ad._id,
    userId: user._id,
    schoolId,
    details: { adId: String(ad._id), placement: ad.placement, headline: ad.headline },
  });

  return ad;
};

/**
 * A school withdraws its own request.
 *
 * Pending and `draft` only. `approved` is live on public pages and unpublishing is a
 * console decision; `rejected` is history, and letting a school delete the record of
 * why it was turned down would remove the only trace of that decision.
 */
export const withdrawSchoolAdRequest = async (adId, user) => {
  const ad = await getSchoolAdRequest(adId, user.schoolId);

  if (!["pending", "draft"].includes(ad.status)) {
    throw new ApiError(
      ad.status === "approved"
        ? "This advertisement is live. Contact support to take it down."
        : "Only a request that has not been reviewed can be withdrawn.",
      409,
      "AD_NOT_WITHDRAWABLE"
    );
  }

  ad.deletedAt = new Date();
  ad.status = "expired";
  await ad.save();

  await auditService.log({
    action: AUDIT_ACTIONS.AD_REQUEST,
    entity: "SchoolAd",
    entityId: ad._id,
    userId: user._id,
    schoolId: user.schoolId,
    details: { adId: String(ad._id), withdrawn: true },
  });

  return ad;
};

export default {
  listSchoolAdRequests,
  getSchoolAdRequest,
  createSchoolAdRequest,
  withdrawSchoolAdRequest,
};