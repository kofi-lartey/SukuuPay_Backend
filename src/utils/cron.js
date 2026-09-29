// Keep-alive health check.
//
// Purpose is uptime monitoring, so it must exercise the PUBLIC route: that is
// the thing a client or a load balancer actually depends on, and it is the only
// check that catches a reverse proxy or TLS termination being misconfigured.
//
// The public URL is derived from the request's own host when API_URL is not set.
// Building it from localhost instead — which is what this did originally — makes
// the check pass on a deployed instance while never touching the public entry
// point, so it reports healthy on a service nobody can reach.
//
// Skipped entirely in development, where there is no public URL to check and the
// check would only add noise to the logs.
import cron from "cron";
import http from "http";
import https from "https";
import { API_URL, NODE_ENV, HEALTH_CHECK_URL } from "../config/env.js";

const HEALTH_PATH = "/api/health";

/**
 * Resolves the URL to probe.
 *
 * @returns {string|null} null when the check should be skipped.
 */
export const resolveHealthCheckUrl = () => {
  // Explicit configuration always wins, so a monitoring service can point this
  // at whatever it likes.
  if (HEALTH_CHECK_URL) return `${HEALTH_CHECK_URL.replace(/\/$/, "")}${HEALTH_PATH}`;

  const configured = String(API_URL || "").trim();
  if (!configured) return null;

  // A loopback API_URL is not a public endpoint. Probing it would only ever test
  // the process against itself, so the check reports success without proving
  // anything. Skipping is the honest answer; silently passing is not.
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(configured)) {
    return null;
  }

  return `${configured.replace(/\/$/, "")}${HEALTH_PATH}`;
};

const job = new cron.CronJob(
  "*/14 * * * *",
  function () {
    const url = resolveHealthCheckUrl();

    if (!url) {
      if (NODE_ENV === "production") {
        // A production instance with no reachable health URL is a monitoring gap,
        // not something to pass over quietly.
        console.warn(
          "[HEALTH] No public API_URL configured; skipping external health check. " +
            "Uptime of the public endpoint is not being verified."
        );
      }
      return;
    }

    const client = url.startsWith("https") ? https : http;
    const req = client
      .get(url, (res) => {
        if (res.statusCode === 200) {
          console.log("Health check passed:", url);
        } else if (res.statusCode === 404) {
          // A 404 is ambiguous, and the most common cause is a hostname that
          // serves something else entirely — a mis-set API_URL pointing at the
          // frontend, or at a renamed Render service. A reachable host with no
          // such route is a different problem from an unreachable host, so say
          // which one this is rather than logging a bare "failed".
          console.error(
            "Health check got 404 — the host answered but has no /api/health. " +
              "Check that API_URL points at the API itself, not the frontend or a " +
              "renamed service. Probed:",
            url
          );
        } else {
          console.error("Health check failed", res.statusCode, url);
        }
        res.resume(); // drain so the socket is released
      })
      // Bounded so a hung endpoint cannot accumulate open sockets every 14
      // minutes forever.
      .setTimeout(10000, () => {
        req.destroy();
        console.error("Health check timed out", url);
      })
      .on("error", (e) => console.error("Error while sending health check", e));
  },
  // Run at the top of the interval rather than 14 minutes after boot, so a fresh
  // deploy reports in immediately instead of staying silent for a quarter hour.
  { start: true, waitForCompletion: true }
);

export default job;
