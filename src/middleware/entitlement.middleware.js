import { School } from "../models/schoolModel.js";
import { CAMPUS_PLAN, normalizePlan } from "../config/constants.js";

export const requirePlan = (plans = []) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, message: "Authentication required" });
      }

      let schoolId = req.user.schoolId || req.body?.schoolId || req.params?.schoolId;
      const school = schoolId ? await School.findById(schoolId).select("subscription.plan") : null;
      const current = normalizePlan(school?.subscription?.plan) || null;

      if (!plans.includes(current)) {
        return res.status(403).json({
          success: false,
          message: "Entitlement required",
          code: "ENTITLEMENT_REQUIRED",
          meta: { required: plans, current },
        });
      }

      req.school = school;
      return next();
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  };
};

export default requirePlan;
