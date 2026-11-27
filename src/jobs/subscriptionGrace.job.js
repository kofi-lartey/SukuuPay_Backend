import cron from "cron";
import { School } from "../models/schoolModel.js";

// Every hour: proactively flip grace-period subscriptions whose seven-day
// window has elapsed to `locked`, so dashboards, emails and reports reflect
// the correct state without waiting for the next request.
const runSubscriptionGraceSweep = async () => {
  const now = new Date();

  const result = await School.updateMany(
    {
      "subscription.status": "grace",
      "subscription.gracePeriodEnd": { $lt: now },
    },
    {
      $set: {
        "subscription.status": "locked",
        "subscription.updatedAt": now,
      },
    }
  );

  if (result.modifiedCount > 0) {
    console.log(
      `[SUBSCRIPTION-GRACE] Locked ${result.modifiedCount} school(s) whose grace period expired at ${now.toISOString()}`
    );
  }
};

const job = new cron.CronJob(
  "0 * * * *",
  runSubscriptionGraceSweep,
  null,
  false,
  "Africa/Accra"
);

export default job;
