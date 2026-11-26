import cron from "cron";
import mongoose from "mongoose";
import { ReportJob } from "../models/ReportJob.js";
import { runReportJob } from "../services/reports.service.js";

/**
 * Report export worker.
 *
 * Polls for `ReportJob` documents in the `queued` state, claims each one
 * atomically (queued -> processing), runs the report through
 * `reports.service.runReportJob`, which renders CSV/PDF/XLSX, uploads the
 * file to Cloudinary and marks the job `completed` with a signed download
 * URL and `expiresAt`. Any failure marks the job `failed` and records
 * `errorMessage`.
 *
 * Claiming with `findOneAndUpdate` makes the worker safe to run behind more
 * than one process instance: a job is only ever processed by the instance
 * that successfully flips it to `processing`.
 */

const SCHEDULE = process.env.REPORT_JOB_CRON_SCHEDULE || "* * * * *";
const TIMEZONE = "Africa/Accra";
const BATCH_LIMIT = 10;

const claimQueuedJobs = async () => {
  const claimed = [];
  for (let i = 0; i < BATCH_LIMIT; i += 1) {
    const job = await ReportJob.findOneAndUpdate(
      { status: "queued" },
      { $set: { status: "processing" } },
      { sort: { createdAt: 1 }, returnDocument: "after" }
    );
    if (!job) break;
    claimed.push(job);
  }
  return claimed;
};

const processJob = async (job) => {
  try {
    await runReportJob(job._id);
    // `runReportJob` already persisted the terminal `completed`/`failed`
    // state, so nothing further is required on success.
  } catch (error) {
    // `runReportJob` already flipped the job to `failed` and saved
    // `errorMessage`. Re-read once to reflect the latest state in logs.
    const refreshed = await ReportJob.findById(job._id).select("status errorMessage").lean();
    console.error(
      `[REPORT-JOB] Job ${job._id} failed: ${error?.message || error}` +
        (refreshed ? ` (stored status: ${refreshed.status})` : "")
    );
  }
};

const job = new cron.CronJob(
  SCHEDULE,
  async () => {
    try {
      const jobs = await claimQueuedJobs();
      if (jobs.length === 0) return;
      // Process claimed jobs sequentially so a single job's Cloudinary upload
      // cannot interleave with itself; different jobs are independent.
      for (const jobDoc of jobs) {
        await processJob(jobDoc);
      }
    } catch (error) {
      console.error("[REPORT-JOB] Scan cycle failed:", error?.message || error);
    }
  },
  null,
  // Not auto-started: `src/index.js` calls `.start()` explicitly so "what this
  // process runs" stays readable in one place.
  false,
  TIMEZONE
);

export default job;

// Exported for tests and manual `node -e` runs without waiting for the timer.
export { claimQueuedJobs, processJob, runReportJob };
