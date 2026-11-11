import { School } from "../models/schoolModel.js";

/**
 * Trial expiry middleware.
 *
 * Runs after `authenticate` on every school-scoped request. When a school's
 * trial has expired (`trialEndsAt` in the past and `subscription.status` still
 * `"trial"`), it flips the status to `"expired"` in one write and answers with
 * a 403 whose body carries `redirectToPricing: true`. The frontend reads that
 * flag and sends the school to the pricing page instead of rendering a module.
 *
 * Schools that are already `active`, `expired`, `suspended` or `cancelled` are
 * left alone — only a live trial that has run out of time is acted on.
 */
export const trialExpiryMiddleware = async (req, res, next) => {
  if (!req.user?.schoolId) return next();

  try {
    const school = await School.findById(req.user.schoolId).select(
      "subscription.plan subscription.status subscription.trialEndsAt subscription.paymentStatus"
    );
    if (!school) return next();

    const sub = school.subscription || {};
    const now = new Date();

    // Only a live trial whose end date has passed needs expiring.
    if (
      sub.status === "trial" &&
      sub.trialEndsAt &&
      new Date(sub.trialEndsAt).getTime() < now.getTime()
    ) {
      school.subscription.status = "expired";
      school.subscription.paymentStatus = "none";
      await school.save();

      return res.status(403).json({
        success: false,
        message: "Your free trial has ended. Select a paid plan to continue.",
        code: "TRIAL_EXPIRED",
        redirectToPricing: true,
      });
    }

    next();
  } catch (error) {
    // Never let a trial check break a working request: log and pass through.
    console.error("[trial-expiry] check failed:", error.message);
    next();
  }
};
