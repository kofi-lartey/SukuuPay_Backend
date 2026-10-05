import { Router } from "express";
import {
  listPublicSchoolAds,
  listMyAdRequests,
  getMyAdRequest,
  createMyAdRequest,
  withdrawMyAdRequest,
} from "../controllers/schoolAd.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { uploadSchoolAd } from "../middleware/upload.js";
import {
  listSchoolAdsQuerySchema,
  createSchoolAdRequestSchema,
  listSchoolAdRequestsSchema,
  schoolAdIdParamSchema,
} from "../validations/schoolAd.validation.js";

export const publicAdRoute = Router();

// Deliberately unauthenticated: this is the only ad route reachable without a
// session. The handler returns a fixed projection and no error state, so an
// abuse attempt degrades to an empty slider rather than leaking anything.
const adsLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

publicAdRoute.get(
  "/public/school-ads",
  adsLimiter,
  validate(listSchoolAdsQuerySchema, "query"),
  listPublicSchoolAds
);

/**
 * A school's own advertisement requests.
 *
 * ## `/schools/me/ad-requests`, and why there is no school id
 *
 * The console can write an ad for any school, so `createSchoolAd` trusts `req.body
 * .schoolId`. Copying that shape onto a `school_admin`-authenticated route would let
 * **any school publish an advertisement as another school** — and these render on the
 * public login and signup pages, so the consequence is defacement rather than a data
 * error.
 *
 * So there is no school id in the path at all: the session supplies it, and the service
 * additionally puts it **in the query**. Two independent checks, because a route shape
 * is not an authorisation check and the next refactor moves the query somewhere.
 *
 * ## Who
 *
 * `school_admin` and `accountant`. A teacher has no advertising budget and no reason to
 * be on the approvals list; `viewer` likewise. This matches the money-permission
 * pattern used by `smsRequest.routes.js`.
 */
export const schoolAdRoute = Router();

const requireAdvertiser = authorize("school_admin", "accountant");

/**
 * Rate limit on the create path.
 *
 * Each submission stores a Cloudinary creative for the life of the ad, so an unbounded
 * loop is a storage cost, not just noise. Twelve an hour is far more than any school
 * submits.
 */
const submitLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 12,
  message: 'Too many advertisement requests this hour. Please contact support.',
});

schoolAdRoute.get(
  "/schools/me/ad-requests",
  authenticate,
  requireAdvertiser,
  validate(listSchoolAdRequestsSchema, "query"),
  listMyAdRequests
);

/*
 * `uploadSchoolAd` is `.single("image")`, so it calls `next()` untouched when the
 * request is not multipart and the `imageUrl`-in-the-body form still works. It runs
 * before `validate` because multer has to parse the multipart body before Joi can see
 * the text fields inside it.
 *
 * `validate` is the first thing these routes did not have. The console's five sibling
 * routes carried no validation at all until recently, which meant the https-only
 * `linkUrl` rule — the thing standing between a submitted ad and a `javascript:` URL
 * executing on every visitor's login page — was written and never mounted.
 */
schoolAdRoute.post(
  "/schools/me/ad-requests",
  authenticate,
  requireAdvertiser,
  submitLimit,
  uploadSchoolAd,
  validate(createSchoolAdRequestSchema),
  createMyAdRequest
);

schoolAdRoute.get(
  "/schools/me/ad-requests/:adId",
  authenticate,
  requireAdvertiser,
  validate(schoolAdIdParamSchema, "params"),
  getMyAdRequest
);

// Withdraw, not delete: pending and draft only, and the service refuses anything a
// moderator has already decided on.
schoolAdRoute.delete(
  "/schools/me/ad-requests/:adId",
  authenticate,
  requireAdvertiser,
  validate(schoolAdIdParamSchema, "params"),
  withdrawMyAdRequest
);

export default publicAdRoute;
