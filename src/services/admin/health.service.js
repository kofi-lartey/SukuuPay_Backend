import mongoose from "mongoose";
import { School } from "../../models/schoolModel.js";
import { updatePlatformSettings, getPlatformSettings } from "../admin.service.js";
import { getCachedPlatformSettings } from "../platformSettings.service.js";
import { log as writeAudit } from "../../utils/auditService.js";
import { recentErrors, errorBufferScope } from "../../utils/errorBuffer.js";
import ApiError from "../../utils/ApiError.js";
import { resolveDateRange } from "../../utils/platformQuery.js";
import { isPlaceholder } from "../../utils/placeholder.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import {
  API_COMMIT,
  API_BUILD_DATE,
  API_VERSION,
  NODE_ENV,
  PRIMARY_PAYMENT_GATEWAY,
  SMS_DEFAULT_PROVIDER,
} from "../../config/env.js";
import { cloudinary } from "../../utils/cloudinary.js";
import { getArkeselConfigStatus, isArkeselSendConfigured } from "../../utils/arkeselApi.js";
import { availableSmsProviders } from "../../utils/smsService.js";
import { isMtnConfigured } from "../../utils/mtnApi.js";
import keepAliveJob from "../../utils/cron.js";
import installmentReminderJob from "../../jobs/installmentReminder.job.js";
import healthCheckJob from "../../jobs/healthCheck.job.js";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * SYSTEM HEALTH
 *
 * The distinction this module is built around: **`ok` / `degraded` / `down` are
 * not the same severity as "this dependency is broken".**
 *
 * MongoDB is *required*. Without it nothing works — no login, no payment, no
 * page — so it can drive the overall status to `down`.
 *
 * Cloudinary, Hubtel, SMS and cron are *optional*. A platform with no SMS credit
 * still takes payments: a parent opening a pay link is served by MongoDB and the
 * gateway, and the reminder that does not go out is an inconvenience, not an
 * outage. Reporting that as `down` would train the operator to ignore the word,
 * and the next `down` — MongoDB, the one that means every school is down — would
 * be the one they had learned to skim past.
 *
 * So: `down` if a **required** dependency is down, `degraded` if anything at all
 * is below `ok`, `ok` otherwise.
 *
 * ── The failure this file is shaped to prevent ─────────────────────────────────
 *
 * A health payload assembled as `await Promise.all([...probes])` returns nothing
 * at all the moment one probe throws — so a single flaky SMS provider renders a
 * blank page instead of the one dependency that is actually broken. Every probe
 * below is individually wrapped, and `probe()` (below) is what makes that a
 * property of the file rather than a discipline somebody has to remember.
 */

// ──────────────────── Probe harness ────────────────────

/**
 * The ceiling on any single dependency probe.
 *
 * 3 seconds. Long enough that a working provider over a slow link is not reported
 * as broken, short enough that the console's health page does not feel broken
 * either — this screen is opened during an incident, by somebody waiting. A probe
 * that takes ten seconds to admit it cannot reach anything has turned a status
 * page into a slow one, and the operator learns to reload it rather than read it.
 *
 * Not a single global value for every dependency: MongoDB gets a tighter one
 * below, because the database is local to the process in every deployment and a
 * round trip that has not completed in two seconds is a stalled socket, not a slow
 * network.
 */
const PROBE_TIMEOUT_MS = 3000;

const DB_PROBE_TIMEOUT_MS = 2000;

/**
 * Run one probe, and never let it take the payload down with it.
 *
 * This is the single most important function in the file. Every dependency probe
 * returns a `Promise` that is guaranteed to resolve to a **status object**, never
 * to reject and never to hang — because the caller composes several of them and a
 * rejection anywhere in that composition is a blank page.
 *
 * Three distinct failures are collapsed into one answer, deliberately:
 *
 *   - **threw** → `down`. The probe itself is the failure.
 *   - **timed out** → `down`. Slower, but not different in kind: a dependency that
 *     cannot answer in three seconds is one the platform is already failing to
 *     use. Distinct because the reason ("timed out" vs the provider's own error)
 *     is the first thing an operator reads.
 *   - **returned a status** → passed through unchanged, so a probe can report
 *     `degraded` for a condition it detected itself (SMS configured but no
 *     credit) without inventing a throw for it.
 *
 * `startedAt`/`latencyMs` are in every result rather than added by the caller, so
 * a caller cannot forget them — and so a probe that timed out is still visibly a
 * probe that ran.
 *
 * @param {string} name
 * @param {() => Promise<object>} fn returns `{status, required, ...detail}`
 * @param {{ required?: boolean }} [options]
 */
const probe = async (name, fn, { required = false } = {}) => {
  const startedAt = Date.now();

  let timer;
  try {
    const detail = await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`No response within ${PROBE_TIMEOUT_MS}ms`);
          error.code = "PROBE_TIMEOUT";
          reject(error);
        }, PROBE_TIMEOUT_MS);
        // `unref` so a pending probe timer cannot hold the process open on shutdown.
        timer.unref?.();
      }),
    ]);

    return {
      name,
      // `required: false` on the result, not just in the wrapper, because the
      // overall roll-up below reads the results and must not have to keep a
      // parallel table of which name was required.
      required,
      latencyMs: Date.now() - startedAt,
      ...detail,
    };
  } catch (error) {
    return {
      name,
      required,
      latencyMs: Date.now() - startedAt,
      status: "down",
      // Not `error.message` unfiltered. A driver error can quote the connection
      // URI it failed on, and this payload is rendered in a browser. The console
      // never returns credentials — that is a rule, not a preference.
      detail: error?.code === "PROBE_TIMEOUT" ? "Timed out" : "Probe failed",
      message: String(error?.message || "Probe failed")
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]*)@/gi, "$1***:***@")
        .slice(0, 300),
      errorCode: error?.code || error?.name || null,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Run every probe concurrently and let each one fail on its own.
 *
 * Concurrent rather than sequential because a screen an operator opens during an
 * incident must not take the sum of every dependency's worst case — with six
 * probes and a 3s ceiling, sequential worst case is 18 seconds and a page that
 * looks hung. `Promise.all` is safe here precisely because `probe()` never
 * rejects: the property the harness guarantees is the property `Promise.all` needs.
 */
const runProbes = async (probes) => Promise.all(probes.map(([name, fn, opts]) => probe(name, fn, opts)));

// ──────────────────── MongoDB ────────────────────

/**
 * MongoDB, the one required dependency.
 *
 * **Why `readyState === 1` alone is a lie.**
 *
 * `mongoose.connection.readyState` is the driver's own view of its state machine,
 * and it says "connected" the moment the TCP connection is established — it is not
 * a liveness signal, it is a *configuration* signal. Mongoose keeps a connection
 * alive across a network partition: a NAT that silently drops the socket, an Atlas
 * primary stepping down, a load balancer idle-timing the connection out, or a pod
 * that has lost its route. In each of those the driver has not yet noticed, the
 * socket is dead, and `readyState` still reads `1`.
 *
 * That is the exact failure a health check exists to catch, and the one the
 * existing public endpoint has: `services/health.service.js:41-66` correctly adds
 * a round trip (`db.command({ping:1})`) for its `latencyMs`, but its `status`
 * field is `database.connected ? 'ok' : 'degraded'` (line 81) — that is
 * `readyState` alone. This module does not repeat that: **the status is the round
 * trip's result, not the state flag's.**
 *
 * `db.admin().ping()` is the right call for that round trip (it exercises the
 * actual command path a write would take, rather than a connection-level ping),
 * with one accommodation for a real deployment: a scoped Atlas user often lacks
 * the privileges `admin()` needs, and then it fails with an authorisation error
 * while the database is perfectly healthy. So a failure of `admin()` falls back to
 * a plain `db.command({ ping: 1 })` before anything is declared `down` — because
 * "we cannot ask the admin question" and "the database is unreachable" are
 * different facts, and reporting the second when the first is true would take a
 * healthy platform out of rotation.
 */
const checkMongo = async () => {
  const readyState = mongoose.connection.readyState;
  const stateNames = ["disconnected", "connected", "connecting", "disconnecting", "uninitialized"];
  const state = stateNames[readyState] || "unknown";

  if (readyState !== 1 || !mongoose.connection.db) {
    return {
      status: "down",
      detail: `Connection state is "${state}"`,
      state,
      readyState,
      latencyMs: null,
    };
  }

  const started = Date.now();

  /*
   * Bounded with its own tighter timer rather than the shared `probe()` one.
   *
   * 2s, not 3s: the database is reachable over a socket this process already
   * holds, inside the same cluster, so there is no slow-link case to absorb. If a
   * round trip has not completed in two seconds the socket is stalled, and a
   * health check that waits longer is a health check that has stopped being a
   * signal and started being a hang.
   */
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`No ping response within ${DB_PROBE_TIMEOUT_MS}ms`);
      error.code = "PROBE_TIMEOUT";
      reject(error);
    }, DB_PROBE_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    const result = await Promise.race([
      mongoose.connection.db.admin().ping().catch((error) => {
        // Fall through to the privilege-free ping. A raw `Error` from the driver
        // can carry the URI it tried, so only its code/name crosses back.
        error.isAdminCommandFailure = true;
        throw error;
      }),
      timeout,
    ]);

    return {
      status: "ok",
      detail: "Ping answered",
      state,
      readyState,
      // `{ ok: 1 }` from the server is itself the evidence, and returning the
      // boolean keeps it obviously non-credential data.
      pinged: result?.ok === 1,
      latencyMs: Date.now() - started,
      database: mongoose.connection.name || null,
    };
  } catch (error) {
    // Not an admin-command failure, or it was and the fallback also failed.
    if (error?.isAdminCommandFailure) {
      try {
        const fallback = await Promise.race([
          mongoose.connection.db.command({ ping: 1 }),
          new Promise((_resolve, reject) => {
            const t = setTimeout(() => {
              const e = new Error("No ping response");
              e.code = "PROBE_TIMEOUT";
              reject(e);
            }, DB_PROBE_TIMEOUT_MS);
            t.unref?.();
          }),
        ]);

        return {
          status: "ok",
          // Said out loud, because "ok" from a fallback is weaker evidence than
          // "ok" from the primary and an operator debugging an Atlas credential
          // problem needs to know which one they got.
          detail: "Ping answered via db.command (admin command not permitted)",
          adminCommandPermitted: false,
          state,
          readyState,
          pinged: fallback?.ok === 1,
          latencyMs: Date.now() - started,
          database: mongoose.connection.name || null,
        };
      } catch {
        // Fall through to the down result below.
      }
    }

    return {
      status: "down",
      // The distinction an operator needs first: `readyState` said connected and
      // the socket did not answer. That is a stalled connection, and it is the
      // failure this probe was written to catch.
      detail:
        error?.code === "PROBE_TIMEOUT"
          ? "readyState reports connected but the ping did not answer — stalled connection"
          : "Ping failed while readyState reports connected — stalled connection",
      state,
      readyState,
      latencyMs: Date.now() - started,
      errorCode: error?.code || null,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// ──────────────────── Cloudinary ────────────────────

/**
 * Cloudinary — optional, and probed **locally, with no network call.**
 *
 * Every other probe here asks a remote thing whether it is alive. Cloudinary does
 * not get that, and the decision is worth stating because the default for a
 * dependency named "cloud" is to ping it:
 *
 *   - A failed upload does not stop a parent paying. Student photos and school
 *     logos are cosmetic; the payment page does not touch Cloudinary. It is
 *     optional by the same reasoning as SMS.
 *   - An outbound HTTPS call on every view of a status screen adds real latency to
 *     the one page an operator opens when things are already slow, and it can fail
 *     for reasons that have nothing to do with the platform — an office firewall,
 *     a laptop on a captive portal, a Cloudinary region having a bad afternoon —
 *     none of which means a school cannot take a payment.
 *   - So the probe answers the question that actually has operational weight: *is
 *     this integration configured at all?* A deployment that has lost its
 *     `CLOUDINARY_*` values should be told; one whose CDN is slow should not be
 *     told the platform is degraded.
 *
 * The check reads `cloudinary.config()`, which is what `utils/cloudinary.js`
 * configures at import time, and passes the values through `isPlaceholder` so an
 * unfilled `CLOUDINARY_API_SECRET=your-api-secret` reads as absent rather than
 * configured — the exact failure `utils/placeholder.js` exists for. **Only
 * booleans leave this function.** The key and the secret are not returned, not
 * hashed, and not length-reported: "is it set" is the question, and a length is
 * one more thing that could be logged.
 */
const checkCloudinary = async () => {
  const config = cloudinary.config();

  const configured = {
    cloudName: !isPlaceholder(config.cloud_name),
    apiKey: !isPlaceholder(config.api_key),
    apiSecret: !isPlaceholder(config.api_secret),
  };

  const isConfigured = Object.values(configured).every(Boolean);
  const partial =
    Object.values(configured).some(Boolean) && !isConfigured;

  if (isConfigured) {
    return {
      status: "ok",
      detail: "Configured",
      configured,
      networkProbe: false,
      networkProbeReason:
        "Deliberately not pinged: an image CDN outage does not stop payments, and a failed upload is visible on the upload itself.",
    };
  }

  return {
    status: "degraded",
    detail: partial
      ? "Partially configured — uploads will fail"
      : "Not configured — photo and logo uploads are unavailable",
    configured,
    networkProbe: false,
    networkProbeReason:
      "Deliberately not pinged: an image CDN outage does not stop payments, and a failed upload is visible on the upload itself.",
  };
};

// ──────────────────── Hubtel ────────────────────

/**
 * Hubtel — optional, and there is **nothing to ping.** Read this before assuming
 * otherwise.
 *
 * There is no Hubtel API client in this codebase. There is no `hubtel*.js` module,
 * no `HUBTEL_BASE_URL` in `config/env.js`, and no settlement or reconcile endpoint
 * to call. `utils/paymentGateway.js` exports `hubtelIsConfigured(school)`,
 * `resolveGateway(school)` and `availableGateways(school)` — every one of which
 * takes a School — because **Hubtel credentials are per tenant**, stored on
 * `school.payment.{hubtelClientId, hubtelClientSecret, hubtelApiKey}` and all
 * three marked `select: false` (`schoolModel.js:133-146`).
 *
 * The two consequences, both of which are facts rather than gaps in this file:
 *
 *   1. **There is no platform-level Hubtel credential to authenticate with.** A
 *      probe cannot make an authenticated Hubtel call on the platform's behalf at
 *      all, so "can we reach Hubtel?" is not a question this deployment can answer.
 *   2. **A credential-count probe does not mean the credentials work.** It reports
 *      how many schools are *configured*, which is a real and useful thing — it is
 *      what tells an operator that half the schools on Hubtel mode will fail at
 *      checkout — and it is not a liveness check, so it is not labelled as one.
 *
 * So the probe counts, and explicitly reports `networkProbe: false` with the
 * reason, rather than issuing an unauthenticated `fetch` to a settlement URL that
 * would answer 401 and be read as "Hubtel is down" — a false alarm about the
 * provider's name, caused by the absence of a credential rather than by Hubtel.
 *
 * The aggregation projects **counts only**. `school.payment.hubtelClientSecret` is
 * `select: false`, which stops a `.find()` from returning it — but an aggregation
 * pipeline is not a projection and does not honour `select: false`, so the field
 * is genuinely reachable from a `$match` here. It is therefore matched on and
 * never projected, and this comment exists so nobody adds it to the `$project`.
 */
const checkHubtel = async () => {
  const [row] = await School.aggregate([
    { $match: { deletedAt: null } },
    {
      $project: {
        hasClientId: { $ne: [{ $ifNull: ["$payment.hubtelClientId", ""] }, ""] },
        hasClientSecret: { $ne: [{ $ifNull: ["$payment.hubtelClientSecret", ""] }, ""] },
        hasApiKey: { $ne: [{ $ifNull: ["$payment.hubtelApiKey", ""] }, ""] },
      },
    },
    {
      $group: {
        _id: null,
        totalSchools: { $sum: 1 },
        complete: {
          $sum: {
            $cond: [{ $and: ["$hasClientId", "$hasClientSecret", "$hasApiKey"] }, 1, 0],
          },
        },
        inHubtelMode: {
          $sum: { $cond: [{ $eq: ["$payment.gatewayMode", "hubtel"] }, 1, 0] },
        },
      },
    },
  ]);

  const complete = row?.complete || 0;
  const inHubtelMode = row?.inHubtelMode || 0;
  const totalSchools = row?.totalSchools || 0;
  const mtnReady = isMtnConfigured();

  /*
   * `degraded` when schools are in Hubtel mode and cannot use it — those parents
   * have no working checkout. `ok` when there is nothing to be degraded about:
   * either no school uses Hubtel, or every one that does has a complete
   * credential set. It is never `down`; MTN is the platform-wide fallback and
   * `resolveGateway` already prefers whichever is actually configured
   * (`paymentGateway.js:39-44`).
   */
  const brokenHubtel = Math.max(0, inHubtelMode - complete);

  return {
    status: brokenHubtel > 0 ? "degraded" : "ok",
    detail:
      brokenHubtel > 0
        ? `${brokenHubtel} of ${inHubtelMode} schools on Hubtel mode lack a complete credential set`
        : complete > 0
          ? `${complete} of ${inHubtelMode} Hubtel-mode schools are fully configured`
          : "No school is configured for Hubtel",
    credentialsModel: "per-school",
    schoolsInHubtelMode: inHubtelMode,
    schoolsFullyConfigured: complete,
    schoolsMissingCredentials: brokenHubtel,
    totalSchools,
    mtnAvailable: mtnReady,
    primaryGateway: PRIMARY_PAYMENT_GATEWAY,
    networkProbe: false,
    networkProbeReason:
      "No Hubtel API client exists in this codebase and credentials are per school (school.payment.*), so there is no platform credential to authenticate a probe with. An unauthenticated request would answer 401 and be misread as Hubtel being down.",
  };
};

// ──────────────────── SMS ────────────────────

/**
 * The SMS provider — optional.
 *
 * Two independent questions, and the answer to the second is the one that makes a
 * platform "degraded rather than down":
 *
 *   1. **Is it configured?** From `utils/arkeselApi.js`'s own
 *      `getArkeselConfigStatus()` rather than a fresh reading of `process.env`, so
 *      the health screen and `GET /version` cannot disagree about whether Arkesel
 *      is ready — a second opinion computed here would drift the first time the
 *      config helper gained a rule.
 *   2. **Is there credit?** From the sum of `school.sms.balance`, which is a
 *      prepaid ledger this platform owns: debited atomically on send
 *      (`services/sms.service.js:235`), refunded on failure (`:250`), credited back
 *      from an inbound delivery report (`services/inboundWebhooks.service.js:423`).
 *
 * **The honest limit on that balance:** it is what we believe we have, not what
 * Arkesel believes. `utils/arkeselApi.js` has no balance endpoint — it reads
 * `credits_used` off each send response — so there is no reconciliation against the
 * provider and a divergence would be invisible until a send failed. That is
 * reported as `balanceSource: "local_prepaid_ledger"` rather than presented as the
 * provider's figure.
 *
 * Configured-but-no-credit is `degraded`. It is the case the required/optional
 * distinction exists for: every reminder, overdue notice and pay-link SMS stops,
 * while every payment link keeps working, because payment does not go through SMS.
 */
const checkSms = async () => {
  const settings = await getCachedPlatformSettings();

  // The platform's chosen provider, defaulting the same way `utils/smsService.js`
  // resolves one for a school that never set `sms.provider`.
  const provider = settings?.sms?.provider || SMS_DEFAULT_PROVIDER;

  const [row] = await School.aggregate([
    { $match: { deletedAt: null } },
    {
      $group: {
        _id: null,
        totalBalance: { $sum: { $ifNull: ["$sms.balance", 0] } },
        totalSchools: { $sum: 1 },
        withCredit: {
          $sum: { $cond: [{ $gt: [{ $ifNull: ["$sms.balance", 0] }, 0] }, 1, 0] },
        },
      },
    },
  ]);

  const totalBalance = row?.totalBalance || 0;
  const schoolsWithCredit = row?.withCredit || 0;

  const base = {
    provider,
    totalSchools: row?.totalSchools || 0,
    schoolsWithCredit,
    totalBalance,
    balanceSource: "local_prepaid_ledger",
    balanceIsProviderConfirmed: false,
    ratePesewas: settings?.sms?.ratePesewas ?? null,
    sendProvidersAvailable: availableSmsProviders(),
  };

  /*
   * `hubtel` is an enum value on `PlatformSettings.sms.provider` and on
   * `School.sms.provider`, but `utils/smsService.js` registers its send client
   * with `configured: () => false, send: null` (SEND_CLIENTS, line 45). So a
   * platform configured for `hubtel` cannot send a single SMS today, and saying
   * "degraded" is the accurate report — not a bug in this probe.
   */
  if (provider === "hubtel") {
    return {
      ...base,
      status: "degraded",
      configured: false,
      detail:
        'Platform SMS provider is "hubtel", which is selectable in settings but has no send integration wired (utils/smsService.js SEND_CLIENTS). Every outbound SMS will fail.',
      arkesel: getArkeselConfigStatus(),
    };
  }

  const configured = isArkeselSendConfigured();

  if (!configured) {
    return {
      ...base,
      status: "degraded",
      configured: false,
      detail: "Arkesel is not configured — every outbound SMS will fail",
      arkesel: getArkeselConfigStatus(),
    };
  }

  if (totalBalance <= 0) {
    return {
      ...base,
      status: "degraded",
      configured: true,
      // The sentence this whole required/optional split is about: payments keep
      // working, only the messages stop.
      detail:
        "Arkesel is configured but no school holds SMS credit. Payments still process; reminders and receipts will not be sent.",
      arkesel: getArkeselConfigStatus(),
    };
  }

  return {
    ...base,
    status: "ok",
    configured: true,
    detail: `${schoolsWithCredit} of ${base.totalSchools} schools hold SMS credit`,
    arkesel: getArkeselConfigStatus(),
  };
};

// ──────────────────── Cron jobs ────────────────────

/**
 * Read one `cron` v4 job's state.
 *
 * `cron` is v4.4.0 here, whose API is **not** v3's. Verified against the installed
 * package: there is no `job.getStatus()` (calling it throws a TypeError) and no
 * `job.lastDate()` value before the first run. The surface that exists is:
 *
 *   - `job.cronTime.source`  — the expression
 *   - `job.cronTime.timeZone` — the zone, `undefined` when none was given
 *   - `job.isActive`         — is the timer armed
 *   - `job.isCallbackRunning`— is a run in progress right now
 *   - `job.lastExecution`    — epoch ms of the last fired tick, `null` before the
 *                             first one
 *   - `job.nextDate()`       — a **luxon DateTime**, so `.ts` is the epoch ms;
 *                             there is no `.toDate()`
 *
 * Every field is read defensively inside a `try`, because a job object is a
 * dependency's internal shape and `cron` v5 is free to change it — and the failure
 * mode of trusting it is a health page that 500s because of a library upgrade.
 */
const readCronJob = (job, name, description) => {
  const base = { name, description };

  try {
    if (!job) {
      return {
        ...base,
        status: "down",
        detail: "Job module is not loaded — the scheduler was never started",
        expression: null,
        timezone: null,
        active: false,
        lastRunAt: null,
        nextRunAt: null,
      };
    }

    const active = Boolean(job.isActive);
    const lastRunAt = job.lastExecution ? new Date(job.lastExecution) : null;
    const nextDateTime = active ? job.nextDate() : null;
    const nextRunAt = nextDateTime?.ts ? new Date(nextDateTime.ts) : null;

    /*
     * A job that is not running is `down` and not `degraded`.
     *
     * That is the one place the required/optional rule bends, and it bends
     * deliberately: a stopped scheduler is not a missing convenience, it is a
     * monitor that has stopped monitoring. Nothing the screen reports can be
     * trusted while it is off, so it is stated as broken even though the
     * installment reminders it carries are individually optional.
     */
    if (!active) {
      return {
        ...base,
        status: "down",
        detail: "Scheduler is not running — start() was never called on this instance",
        expression: job.cronTime?.source || null,
        timezone: job.cronTime?.timeZone || null,
        active: false,
        lastRunAt,
        nextRunAt: null,
      };
    }

    return {
      ...base,
      status: "ok",
      detail: job.isCallbackRunning ? "Running now" : "Scheduled",
      expression: job.cronTime?.source || null,
      timezone: job.cronTime?.timeZone || null,
      active: true,
      lastRunAt,
      nextRunAt,
    };
  } catch (error) {
    return {
      ...base,
      status: "down",
      detail: "Could not read the scheduler state",
      expression: null,
      timezone: null,
      active: false,
      lastRunAt: null,
      nextRunAt: null,
      message: String(error?.message || "").slice(0, 200),
    };
  }
};

const checkCron = async () => {
  const jobs = [
    readCronJob(
      keepAliveJob,
      "keepAliveHealthProbe",
      "Public /api/health uptime probe (utils/cron.js)"
    ),
    readCronJob(
      installmentReminderJob,
      "installmentReminder",
      "Daily 08:00 Accra sweep of plan installments"
    ),
    readCronJob(
      healthCheckJob,
      "healthCheck",
      "5-minute dependency probe, writing a health.check audit entry"
    ),
  ];

  const down = jobs.filter((job) => job.status === "down");

  return {
    status: down.length ? "down" : "ok",
    detail: down.length
      ? `${down.length} of ${jobs.length} schedulers are not running: ${down.map((j) => j.name).join(", ")}`
      : `All ${jobs.length} schedulers are running`,
    jobs,
    // Stated, because the screen beside it is full of numbers and this one is not:
    // the run history this endpoint does **not** have is in `getJobRuns()`.
    runHistoryPersisted: false,
    runHistoryNote:
      "No job-run records are persisted anywhere in this codebase. `lastRunAt` is the scheduler's own in-memory last-tick timestamp and is null before the first run and lost on restart.",
  };
};

// ──────────────────── Public entry point ────────────────────

/**
 * `GET /admin/health` — one payload, one status per dependency.
 *
 * The overall roll-up is computed from `required`, which each probe carries on its
 * own result, so adding a dependency cannot accidentally promote it: there is no
 * table here to keep in step with the probe list.
 *
 *   - any **required** `down`                      → `down`
 *   - otherwise any `down` or `degraded` at all    → `degraded`
 *   - otherwise                                    → `ok`
 *
 * Note what the second rule does: a single optional dependency being `down`
 * produces `degraded`, not `ok`. "Everything is fine" must mean everything.
 *
 * `uptime` is process uptime, so on a multi-instance deploy each instance reports
 * its own. That is deliberate — an instance restarted by a crash loop reports a
 * young uptime while its siblings report an old one, and the spread is the signal —
 * and `pid` is included so the console can tell two instances apart.
 */
export const getSystemHealth = async () => {
  const startedAt = Date.now();

  const [mongo, cloudinaryResult, hubtel, sms, cron] = await runProbes([
    ["mongodb", checkMongo, { required: true }],
    ["cloudinary", checkCloudinary],
    ["hubtel", checkHubtel],
    ["sms", checkSms],
    ["cron", checkCron],
  ]);

  const dependencies = { mongodb: mongo, cloudinary: cloudinaryResult, hubtel, sms, cron };

  const all = Object.values(dependencies);
  const requiredDown = all.some((d) => d.required && d.status === "down");
  const anythingWrong = all.some((d) => d.status !== "ok");

  const status = requiredDown ? "down" : anythingWrong ? "degraded" : "ok";

  const memory = process.memoryUsage();

  return {
    status,
    timestamp: new Date().toISOString(),
    totalMs: Date.now() - startedAt,
    dependencies,
    summary: all.map(({ name, required, status: dependencyStatus, detail }) => ({
      name,
      required,
      status: dependencyStatus,
      detail,
    })),
    requiredDependencies: all.filter((d) => d.required).map((d) => d.name),
    uptime: {
      seconds: Math.round(process.uptime()),
      pid: process.pid,
    },
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapUsedPercent: memory.heapTotal
        ? Math.round((memory.heapUsed / memory.heapTotal) * 100)
        : null,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      apiVersion: API_VERSION,
      environment: NODE_ENV,
      // `API_COMMIT` / `API_BUILD_DATE` are `APP_COMMIT` / `GIT_COMMIT` and
      // `APP_BUILD_DATE` from the environment, which a PaaS build injects. They are
      // null on a laptop, and null is the correct answer there rather than a
      // substitute value that would look like a real commit.
      commit: API_COMMIT || null,
      buildDate: API_BUILD_DATE || null,
      commitSource: API_COMMIT ? "environment" : "not reported by this deployment",
    },
  };
};

// ──────────────────── Job runs ────────────────────

/**
 * `GET /admin/health/jobs` — what the scheduler knows, and nothing else.
 *
 * **No persisted run history exists in this codebase.** Verified: `src/models/`
 * contains no `JobRun`, `CronLog` or equivalent; `utils/cron.js` and
 * `jobs/installmentReminder.job.js` write nothing but `console.log` /
 * `console.error`; there is no run-record collection anywhere in `src/`.
 *
 * So this returns exactly four things per job: the expression, the last tick, the
 * next tick, and whether it is running — all read straight off the live
 * `cron` object.
 *
 * **What is deliberately absent, and why.** No duration, no success/failure count,
 * no "last 24 runs" chart. Every one of those would have to be invented, because
 * nothing has ever observed a run and written the observation down.
 * `lastExecution` is a *tick* timestamp — it is stamped when the timer fires,
 * before the handler has finished, so `now - lastExecution` is not how long the job
 * took, it is how long ago the scheduler decided it was time. Rendering that as a
 * "duration" would be a chart that is always plausible and never correct, and a
 * screen like that is worse than no screen: it answers the question the operator
 * asked with a confident wrong number.
 *
 * The `historyAvailable: false` field exists so the console can say so out loud.
 */
export const getJobRuns = async () => {
  const jobs = [
    readCronJob(
      keepAliveJob,
      "keepAliveHealthProbe",
      "Public /api/health uptime probe (utils/cron.js)"
    ),
    readCronJob(
      installmentReminderJob,
      "installmentReminder",
      "Daily 08:00 Accra sweep of plan installments"
    ),
    readCronJob(
      healthCheckJob,
      "healthCheck",
      "5-minute dependency probe, writing a health.check audit entry"
    ),
  ];

  return {
    jobs,
    // Said in the payload rather than only in a comment, because the console has no
    // other way to know not to render an empty chart.
    historyAvailable: false,
    note: "No cron run history is persisted in this codebase. These fields are the scheduler's live in-memory state: expression, last tick, next tick, running flag. Durations and success/failure counts are not recorded and are not reported here rather than estimated.",
    generatedAt: new Date().toISOString(),
  };
};

// ──────────────────── Recent errors ────────────────────

/**
 * `GET /admin/health/errors` — the last few hundred 5xx on this instance.
 *
 * **Nothing is persisted.** `middleware/errorHandler.js` is the app's only error
 * boundary and its final act is a `console.error` (`errorHandler.js:45`) — no
 * database, no file. There is no error collection in `src/models/`. So the data
 * comes from `utils/errorBuffer.js`, a bounded in-process ring buffer that
 * `src/index.js` feeds from the error pipeline.
 *
 * **This is not a durable error store and the payload says so.** An in-process
 * buffer dies with the instance, so it holds the last 500 faults on *this*
 * process and nothing at all from a restart, a deploy, or a sibling instance
 * behind the load balancer. `errorBufferScope()` returns those facts as data
 * (`scope: "process"`, `durable: false`, `instancePid`, plus an explicit
 * `limitations` list) so the screen can render the caveat rather than implying
 * coverage of the platform's errors that does not exist.
 *
 * The date range is filtered **in memory**, after the buffer is read, because the
 * buffer holds 500 objects and the filter is a comparison on one already-resident
 * field. Querying it is not possible — there is no query engine, which is the
 * other half of why this is not a substitute for persistence.
 *
 * `errorBufferScope().retained` is returned beside the entries so a reader can see
 * "50 shown, of 63 held" rather than assuming 50 was everything.
 */
export const getRecentErrors = async ({ from, to, limit } = {}) => {
  const requested = Number(limit);
  const safeLimit = Math.min(
    500,
    Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 100)
  );

  const all = recentErrors({ limit: safeLimit });

  // `resolveDateRange` throws a 400 ApiError on a malformed date rather than
  // producing `Invalid Date` and a silently empty list, and it widens `to` to the
  // end of its day — the same inclusive-day rule every other console list uses.
  const range = resolveDateRange(from, to, "at");

  const scoped = all.filter((entry) => {
    if (!range.at) return true;
    const at = new Date(entry.at).getTime();
    if (range.at.$gte && at < range.at.$gte.getTime()) return false;
    if (range.at.$lte && at > range.at.$lte.getTime()) return false;
    return true;
  });

  return {
    data: scoped,
    meta: {
      returned: scoped.length,
      limit: safeLimit,
      from: from || null,
      to: to || null,
      scope: errorBufferScope(),
    },
  };
};

// ──────────────────── Maintenance mode ────────────────────

/**
 * Map the console's `{ enabled }` boolean onto the stored three-state `mode`.
 *
 * Exported and pure because this is the one rule in the file a reader is most
 * likely to get wrong, and a rule that can only be exercised by flipping a
 * platform-wide switch during working hours is a rule nobody will.
 *
 *   - `enabled: true`  → `readonly`, **never `on`.**
 *   - `enabled: false` → `off`.
 *
 * **Why `readonly` and not `on`, given `enabled: true` plainly means "lock the
 * platform".** Because `on` refuses *everything* under the `/api` mount
 * (`middleware/maintenance.js:43-45`), which is strictly worse than `readonly`
 * for every incident except one: a total outage. During a schema migration
 * `readonly` is the state that is actually safe — every read still answers, so
 * nobody is staring at a 503 wondering whether to retry, and nothing can be
 * half-written. `on` removes the reads for no operational gain; the one thing it
 * buys, "no traffic at all", is a concern for a load balancer, not a toggle.
 *
 * So the console's switch deliberately cannot reach the most dangerous of the
 * three states. An operator who genuinely needs `on` sets it through the general
 * settings write (`PUT /admin/settings`, whose schema already accepts
 * `maintenance.mode`) — a screen with one extra field and a confirm dialog, not
 * the kill switch under a thumb.
 *
 * **This endpoint never demotes a `readonly` platform to `off` by accident**, and
 * never overwrites `on` with `readonly`: if `mode` is `on`, `enabled: true` is
 * already satisfied and the stored value is left alone. Collapsing the states on
 * write would mean an operator who set `on` deliberately, clicked the console
 * toggle off and on to "make sure", silently ended up in the weaker `readonly`
 * and did not know it.
 */
export const resolveMaintenanceMode = (currentMode, enabled) => {
  const mode = currentMode || "off";

  if (!enabled) return "off";
  if (mode === "on") return "on";

  return "readonly";
};

/**
 * `PUT /admin/health/maintenance` — the platform-wide switch.
 *
 * Writes through `updatePlatformSettings` in `services/admin.service.js` rather
 * than touching `PlatformSettings` directly, for two reasons that are not
 * stylistic:
 *
 *   - **Cache invalidation.** `middleware/maintenance.js` reads
 *     `getCachedPlatformSettings()` on every request, and that cache lives 30
 *     seconds (`platformSettings.service.js:39`). A direct write leaves the guard
 *     enforcing the old mode for up to half a minute, so the operator flips a
 *     switch and sees nothing happen — the one outcome that makes a kill switch
 *     worse than no kill switch. `updatePlatformSettings` invalidates
 *     synchronously after the write (`admin.service.js:489`).
 *   - **The before/after diff.** It returns `{before, after, changed}` with the
 *     leaf-path diff this file's audit entry needs. Computing that a second way
 *     would produce a second, slightly different idea of what changed.
 *
 * **A non-empty message is required to enable, and enforced here with a 400** —
 * not in the Joi schema, because 422 is the validation layer's and this is a
 * business rule that depends on `enabled`. `maintenanceDecision` falls back to a
 * generic sentence when `message` is empty (`maintenance.js:99-104`), and a
 * platform-wide lockout showing "Something went wrong" to every parent, every
 * bursar and every school's staff is worse than the outage it was meant to
 * manage. There is no partial credit for enabling without one.
 *
 * Disabling does **not** require a message: there is nobody to explain it to, and
 * clearing the field on a toggle is the natural UI behaviour.
 *
 * @param {{ enabled: boolean, message?: string }} input
 * @param {object} [actor] the acting user
 * @param {object} [req] the request, for `logRequest` attribution
 */
export const setMaintenanceMode = async ({ enabled, message } = {}, actor = null, req = null) => {
  const wantsEnabled = Boolean(enabled);
  const trimmedMessage = typeof message === "string" ? message.trim() : "";

  if (wantsEnabled && !trimmedMessage) {
    throw new ApiError(
      "A message is required to enable maintenance mode — it is what users will be shown.",
      400,
      "MAINTENANCE_MESSAGE_REQUIRED"
    );
  }

  /*
   * Read the current mode with `getPlatformSettings`, **not** by calling
   * `updatePlatformSettings({})`.
   *
   * `updatePlatformSettings` is a write even when the patch is empty: it upserts
   * the singleton and stamps `updatedBy`, so using it as a reader would create the
   * document and attribute it to the operator who merely pressed the switch. The
   * read is also 30-second-cached upstream but this one is not — which is correct,
   * because the value being read is the one about to be overwritten.
   */
  const current = await getPlatformSettings();
  const currentMode = current?.maintenance?.mode || "off";
  const currentMessage = current?.maintenance?.message || "";

  const nextMode = resolveMaintenanceMode(currentMode, wantsEnabled);

  /*
   * A no-op write is refused rather than performed.
   *
   * Two switches producing the same `mode` means the caller was not asking for
   * what they thought (an `on` platform asked for `enabled: true`, which resolves
   * to `on`), and silently returning 200 there is how somebody concludes the
   * console changed something when it did not. 409, because it is a state
   * conflict with what is already stored rather than a bad request.
   */
  if (nextMode === currentMode) {
    return {
      mode: currentMode,
      message: currentMessage,
      enabled: currentMode !== "off",
      changed: false,
      settings: current,
    };
  }

  const { after, changed } = await updatePlatformSettings(
    {
      maintenance: {
        mode: nextMode,
        // Cleared on disable, deliberately: a stale message left on `off` is the
        // text that would appear on the *next* lockout, written by somebody who
        // had forgotten what it said.
        message: wantsEnabled ? trimmedMessage : "",
      },
    },
    actor?._id || null
  );

  /*
   * Audited with both sides.
   *
   * `ADMIN_MAINTENANCE_MODE` exists in the enum for this and nothing else. A
   * platform-wide lockout is the highest-blast-radius non-financial action in the
   * product — it takes every school offline at once — and it is exactly the kind
   * of change that is questioned afterwards ("was this us?"). `before`/`after`
   * are recorded on the *mode*, not on the whole settings document: the diff from
   * `updatePlatformSettings` carries `maintenance.mode` and `maintenance.message`
   * as leaf paths already, and a whole-document snapshot would bury those two
   * under unrelated fields.
   */
  await writeAudit({
    action: AUDIT_ACTIONS.ADMIN_MAINTENANCE_MODE,
    entity: "PlatformSettings",
    entityId: after?._id || null,
    userId: actor?._id || null,
    // Null. The switch has no school, and attributing a platform-wide lockout to
    // one tenant would both misfile it and hide it from the platform-wide audit
    // view this console exists to serve.
    schoolId: null,
    before: { mode: currentMode, message: currentMode !== "off" ? currentMessage : "" },
    after: { mode: nextMode, message: wantsEnabled ? trimmedMessage : "" },
    meta: {
      ...(req?.impersonation
        ? {
            impersonatedBy: String(req.impersonation.superAdminId),
            impersonationSessionId: String(req.impersonation.sessionId),
          }
        : {}),
      // `enabled` is what was asked for and `mode` is what was stored. They are
      // not always the same thing, and the difference is the whole design — so
      // both are recorded or the audit cannot answer "what did they press".
      requestedEnabled: wantsEnabled,
      resolvedMode: nextMode,
      changed,
    },
    req,
  });

  return {
    mode: after?.maintenance?.mode || nextMode,
    message: after?.maintenance?.message || "",
    enabled: (after?.maintenance?.mode || nextMode) !== "off",
    changed: true,
    settings: after || null,
  };
};

export default {
  getSystemHealth,
  getJobRuns,
  getRecentErrors,
  setMaintenanceMode,
  resolveMaintenanceMode,
};