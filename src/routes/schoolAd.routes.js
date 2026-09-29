import { Router } from "express";
import { listPublicSchoolAds } from "../controllers/schoolAd.controller.js";
import { validate } from "../middleware/validate.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { listSchoolAdsQuerySchema } from "../validations/schoolAd.validation.js";

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

export default publicAdRoute;
