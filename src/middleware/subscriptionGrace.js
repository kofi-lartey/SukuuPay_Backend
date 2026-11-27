import { School } from "../models/schoolModel.js";
import { addDays } from "../utils/dateHelpers.js";

/**
 * Subscription grace-period and lock middleware.
 *
 * Runs after `authenticate` on every school-scoped request. Enforces the
 * seven-day grace period after a paid subscription expires:
 *
 *   - `active` and past `currentPeriodEnd` → `grace`, `gracePeriodEnd = currentPeriodEnd + 7 days`
 *   - `grace` and past `gracePeriodEnd` → `locked`
 *   - `locked` → 403 with `redirectToSubscription: true`
 *
 * `trial`, `expired`, `suspended`, `cancelled` are left alone — those are
 * handled by `trialExpiryMiddleware` and the manual-payment approval flow.
 *
 * Never throws: a check failure is logged and the request passes through, so a
 * database hiccup cannot strand every school on the platform.
 */
export const subscriptionGraceMiddleware = async (req, res, next) => {
  if (!req.user?.schoolId) return next();

  try {
    const school = await School.findById(req.user.schoolId).select(
      "subscription.plan subscription.status subscription.currentPeriodEnd subscription.gracePeriodEnd subscription.paymentStatus"
    );
    if (!school) return next();

    const sub = school.subscription || {};
    const now = new Date();

    // A live paid subscription whose period has ended enters the grace window.
    if (
      sub.status === "active" &&
      sub.currentPeriodEnd &&
      new Date(sub.currentPeriodEnd).getTime() < now.getTime()
    ) {
      // Still within the seven-day grace window: full access continues.
      if (!sub.gracePeriodEnd || now.getTime() <= new Date(sub.gracePeriodEnd).getTime()) {
        school.subscription.status = "grace";
        school.subscription.gracePeriodEnd = sub.gracePeriodEnd
          ? new Date(sub.gracePeriodEnd)
          : addDays(new Date(sub.currentPeriodEnd), 7);
        await school.save();
      } else {
        // Grace window elapsed and still unpaid: lock the school.
        school.subscription.status = "locked";
        await school.save();

        return res.status(403).json({
          success: false,
          message: "Your subscription has expired. Please renew to regain access.",
          code: "SUBSCRIPTION_LOCKED",
          redirectToSubscription: true,
        });
      }
    }

    // A grace-period school whose window has elapsed: lock it.
    if (
      sub.status === "grace" &&
      sub.gracePeriodEnd &&
      new Date(sub.gracePeriodEnd).getTime() < now.getTime()
    ) {
      school.subscription.status = "locked";
      await school.save();

      return res.status(403).json({
        success: false,
        message: "Your subscription has expired. Please renew to regain access.",
        code: "SUBSCRIPTION_LOCKED",
        redirectToSubscription: true,
      });
    }

    // Already locked: refuse access and point at the subscription page.
    if (sub.status === "locked") {
      return res.status(403).json({
        success: false,
        message: "Your subscription has expired. Please renew to regain access.",
        code: "SUBSCRIPTION_LOCKED",
        redirectToSubscription: true,
      });
    }

    next();
  } catch (error) {
    console.error("[subscription-grace] check failed:", error.message);
    next();
  }
};
