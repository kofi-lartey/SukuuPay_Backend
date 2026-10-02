import cron from "cron";
import mongoose from "mongoose";
import { log } from "../utils/auditService.js";
import { getArkeselConfigStatus, isArkeselSendConfigured } from "../utils/arkeselApi.js";
import { isMtnConfigured } from "../utils/mtnApi.js";
import { isPlaceholder } from "../utils/placeholder.js";
import { School } from "../models/schoolModel.js";
import { getCachedPlatformSettings } from "../services/platformSettings.service.js";
import { AUDIT_ACTIONS } from "../config/constants.js";
import { SMS_DEFAULT_PROVIDER } from "../config/env.js";

/**
 * The 5-minute dependency monitor.
 *
 * ── What it is for ────────────────────────────────────────────────────────────
 *
 * A scheduled health check answers one question that no on-demand endpoint can:
 * **was the platform healthy when nobody was looking?** `GET /admin/health` reports
 * the present. This records the past, and its real product is not the entry it
 * writes but the **gap** it leaves when it stops.
 *
 * A console that shows "all dependencies healthy" is worthless at 02:00 when a
 * school's dashboard has been quietly failing since midnight — no operator is
 * watching a screen at 02:00, so nothing was recorded, so the morning opens with a
 * green light and no evidence. This job is what makes "healthy overnight" a claim
 * rather than an absence of complaints.
 *
 * ── Why one audit entry per cycle, every five minutes ─────────────────────────
 *
 * That is 288 entries a day, ~105,000 a year, and it is worth being explicit that
 * this is a deliberate cost rather than an oversight:
 *
 *   - **It is the only evidence the monitor is alive.** `lastRunAt` on a live
 *     `cron` object (see `services/admin/health.service.js`) is in-memory: null
 *     before the first tick and gone on restart. The audit row is the durable
 *     artefact, and a series with a hole in it is read directly — "the last entry
 *     was 40 minutes ago" is the sentence that tells an operator the job died.
 *   - **A per-cycle row is what makes a gap visible.** A "last known good"
 *     document would report a stale healthy status and a gap would look identical
 *     to an outage that never happened.
 *   - **The volume is genuinely trivial.** 288 small documents a day is ~3 MB a
 *     year on `AuditLog`, which already indexes `{action, createdAt}` for exactly
 *     this query (`AuditLog.js:167`) and is the collection with a compound index
 *     per read pattern. Storing the history costs less than storing the log
 *     messages the platform already writes on every payment.
 *   - **It is filterable out.** The `health.check` action is a distinct enum value,
 *     so a school reading its own log never sees these rows (they carry
 *     `schoolId: null` and its log is scoped), and the console filters on
 *     `action` — the mechanism `admin.auditLogs.service.js` exposes.
 *
 * A `createMany`/insert-only-if-changed design was rejected: "no entry" is
 * indistinguishable from "job did not run", which is the one distinction this file
 * exists to preserve.
 */

/** Every 5 minutes. Bounded, and never overlapping with itself. */
const SCHEDULE = "*/5 * * * *";

/** Ghana has no DST and is permanently UTC+0, so this is exact, not approximate. */
const TIMEZONE = "Africa/Accra";

/** The database round trip. Tight, because the socket is already open and local. */
const DB_TIMEOUT_MS = 2000;

/**
 * Resolve after `ms`, or reject.
 *
 * Used to bound the database round trip. A timer that is not cleared would keep
 * the event loop alive for the remainder of its window on every cycle, which over
 * a long-lived process is a slow leak of pending callbacks — the reason this is a
 * helper that clears in `finally` rather than three inline `Promise.race`s.
 */
const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * MongoDB, by round trip rather than by `readyState`.
 *
 * The reason is written out at length in `services/admin/health.service.js`
 * (`checkMongo`) and applies identically here: `readyState === 1` means the
 * driver's state machine believes it connected, which it keeps believing across a
 * silently dropped socket, a stepped-down primary or a removed network route. A
 * monitor that trusts that flag is a monitor that reports healthy for exactly the
 * interval in which the platform is not. So the status comes from a ping.
 */
const probeMongo = async () => {
  const started = Date.now();

  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return { status: "down", latencyMs: null, detail: "Connection is not established" };
  }

  try {
    const result = await withTimeout(
      mongoose.connection.db.admin().ping(),
      DB_TIMEOUT_MS,
      "MongoDB ping"
    );

    return {
      status: "ok",
      latencyMs: Date.now() - started,
      detail: "Ping answered",
    };
  } catch (error) {
    return {
      status: "down",
      latencyMs: Date.now() - started,
      detail: "readyState is connected but the ping did not answer",
      error: String(error?.message || "").slice(0, 200),
    };
  }
};

/**
 * Hubtel — **configuration reachability only, and there is nothing to reach.**
 *
 * Restated here because this job is where someone will look to find a Hubtel ping
 * and should find this paragraph instead of a bare boolean.
 *
 * There is no Hubtel API client in this codebase and no platform-level Hubtel
 * credential: credentials are per school on `school.payment.*`, all `select: false`
 * (`schoolModel.js:133-146`), and `utils/paymentGateway.js` only exports
 * per-School helpers. So this probe cannot make an authenticated call and does not
 * pretend to. It counts how many schools carry a complete credential set — a real
 * operational fact — and reports `networkProbe: false`.
 *
 * What it reports instead of Hubtel is **MTN**, which *is* a platform-level
 * integration with a real client (`utils/mtnApi.js`). Since `resolveGateway`
 * already falls back to whichever is configured, MTN's readiness is what actually
 * determines whether a parent can pay, and that is the question worth asking every
 * five minutes.
 */
const probePayments = async () => {
  const hubtel = await School.aggregate([
    { $match: { deletedAt: null, "payment.gatewayMode": "hubtel" } },
    {
      $project: {
        complete: {
          $and: [
            { $ne: [{ $ifNull: ["$payment.hubtelClientId", ""] }, ""] },
            { $ne: [{ $ifNull: ["$payment.hubtelClientSecret", ""] }, ""] },
            { $ne: [{ $ifNull: ["$payment.hubtelApiKey", ""] }, ""] },
          ],
        },
      },
    },
    { $group: { _id: null, total: { $sum: 1 }, configured: { $sum: { $cond: ["$complete", 1, 0] } } } },
  ]);

  const hubtelRow = hubtel[0];
  const mtnConfigured = isMtnConfigured();

  /*
   * `ok` when at least one route can actually take a payment.
   *
   * Both "no school uses Hubtel" and "every Hubtel school is configured" are `ok`:
   * neither is a condition an operator needs to act on, and reporting a platform
   * with no Hubtel schools as degraded would train them to ignore the field.
   */
  const anyRouteWorks = mtnConfigured || (hubtelRow?.configured || 0) > 0;

  return {
    status: anyRouteWorks ? "ok" : "down",
    detail: anyRouteWorks
      ? "At least one payment gateway is usable"
      : "No payment gateway is usable — MTN is unconfigured and no Hubtel school has a complete credential set",
    mtnConfigured,
    hubtelSchools: hubtelRow?.total || 0,
    hubtelConfigured: hubtelRow?.configured || 0,
    hubtelNetworkProbe: false,
    hubtelNote:
      "Per-school credentials only; no platform Hubtel credential exists, so no authenticated probe is possible.",
  };
};

/**
 * The SMS provider.
 *
 * Both halves of the question — configured *and* funded — because "Arkesel is set
 * up" and "there is credit to send with" fail independently and produce the same
 * symptom for a bursar: no messages.
 *
 * `degraded`, never `down`. A platform out of SMS credit still takes payments;
 * a parent opening a pay link never touches SMS. Marking it `down` would make the
 * overall health `down` for something that is an inconvenience, and would mean the
 * word `down` no longer identifies the one condition that takes every school
 * offline at once.
 */
const probeSms = async () => {
  const settings = await getCachedPlatformSettings();
  const provider = settings?.sms?.provider || SMS_DEFAULT_PROVIDER;

  const [row] = await School.aggregate([
    { $match: { deletedAt: null } },
    { $group: { _id: null, balance: { $sum: { $ifNull: ["$sms.balance", 0] } } } },
  ]);

  const balance = row?.balance || 0;
  const config = getArkeselConfigStatus();

  let status = "ok";
  let detail = "Configured and funded";

  if (provider === "hubtel") {
    // Selectable in settings, but `utils/smsService.js` registers it with
    // `send: null` — so every outbound SMS fails. Reported, not worked around.
    status = "degraded";
    detail = 'Platform provider is "hubtel", which has no send integration wired';
  } else if (!isArkeselSendConfigured() || isPlaceholder(config.apiKey)) {
    status = "degraded";
    detail = "Arkesel is not configured";
  } else if (balance <= 0) {
    status = "degraded";
    detail = "Configured but no school holds SMS credit";
  }

  return {
    status,
    detail,
    provider,
    // The platform's own prepaid ledger, not the provider's balance — there is no
    // balance endpoint in `utils/arkeselApi.js` to reconcile it against.
    balanceSource: "local_prepaid_ledger",
    totalBalance: balance,
    senderIdValid: config.senderIdValid,
  };
};

/**
 * One cycle. Exported so a test or a manual `node -e` can run it without waiting
 * for the timer, and so the entry point below is a thin wrapper.
 *
 * Probes run concurrently and each is individually caught: this job writes one
 * audit row describing the whole cycle, so a single throw would replace a
 * five-line diagnostic with one line saying "the job failed" — losing the
 * information the entry exists to carry.
 */
export const runHealthCheck = async () => {
  const [mongo, payments, sms] = await Promise.all([
    probeMongo().catch((error) => ({
      status: "down",
      detail: "Probe threw",
      error: String(error?.message || "").slice(0, 200),
    })),
    probePayments().catch((error) => ({
      status: "down",
      detail: "Probe threw",
      error: String(error?.message || "").slice(0, 200),
    })),
    probeSms().catch((error) => ({
      status: "down",
      detail: "Probe threw",
      error: String(error?.message || "").slice(0, 200),
    })),
  ]);

  // Only MongoDB is required here, for the same reason it is the only required
  // dependency in `services/admin/health.service.js`: without it there is no
  // platform. The record says `required: false` on the other two so a reader
  // scanning `meta.checks` can see that a `down` payments probe did not make the
  // platform `down`.
  const requiredDown = mongo.status === "down";

  const checks = { mongodb: mongo, payments, sms };

  const status = requiredDown ? "down" : Object.values(checks).some((c) => c.status !== "ok") ? "degraded" : "ok";

  /*
   * One entry per cycle, always written.
   *
   * `log()` from `utils/auditService.js` rather than a bare `AuditLog.create`,
   * because `log` is fire-and-forget and swallows its own failure: an audit write
   * that throws must not be able to stop the next cycle from being scheduled. It
   * also means this job needs no request object — `logRequest` exists for
   * controllers, and there is no request here.
   *
   * `userId` and `schoolId` are both null. There is no actor (this is the
   * scheduler, not a person) and no tenant (the platform is not a school). A
   * platform-wide check attributed to a school would put an infrastructure fact in
   * a tenant's log, and attributed to the super admin would claim an operator did
   * something at 03:00.
   */
  await log({
    action: AUDIT_ACTIONS.HEALTH_CHECK,
    entity: "SystemHealth",
    entityId: null,
    userId: null,
    schoolId: null,
    meta: {
      status,
      // Required-ness travels with each check so the row is self-describing
      // without the reader having to know this file.
      requiredDependencies: ["mongodb"],
      checks,
    },
  });

  console.log(
    `[HEALTH-JOB] ${new Date().toISOString()} — ${status}` +
      ` (mongodb=${mongo.status}, payments=${payments.status}, sms=${sms.status})`
  );

  return { status, checks };
};

/**
 * The scheduled entry point.
 *
 * **`try`/`catch` around the whole body, and it is not optional.** An `async`
 * callback handed to `cron` is invoked without anybody awaiting it, so a rejection
 * is an unhandled promise rejection — which in Node 15+ terminates the process by
 * default. A monitoring job that can kill the thing it monitors has defeated its
 * own purpose: it would take the API down at the exact moment the API was
 * misbehaving.
 *
 * The catch logs to `console.error` and returns. It does not rethrow and does not
 * retry: the next cycle is five minutes away, and a retry loop against a database
 * that is refusing connections would add load to an outage.
 */
const job = new cron.CronJob(
  SCHEDULE,
  async () => {
    try {
      await runHealthCheck();
    } catch (error) {
      console.error("[HEALTH-JOB] Health check cycle failed:", error.message);
    }
  },
  null,
  // Not auto-started, matching `jobs/installmentReminder.job.js`: `src/index.js`
  // calls `.start()` explicitly, which keeps "what this process runs" readable in
  // one place instead of split across module side effects.
  false,
  TIMEZONE
);

export default job;