import { getCachedPlatformSettings } from "../services/platformSettings.service.js";

/**
 * Refuses writes (or everything) while the platform is in maintenance.
 *
 * Three modes, because "the platform is down" and "the platform is up but nobody
 * may change anything" are different situations and an operator in the middle of a
 * migration needs the second one:
 *
 *   - `off`      — everything is allowed.
 *   - `readonly` — reads pass, writes are refused. This is the state a schema
 *                   migration wants: every page still loads, so nobody is staring at
 *                   an error wondering whether they should retry, and nothing can
 *                   be half-written.
 *   - `on`       — everything under the mount point is refused.
 *
 * **Where it is mounted is the load-bearing part of this file.**
 *
 * It is mounted on the `/api` router, never globally, because payment and WhatsApp
 * callbacks are mounted at the *root* in `index.js` (lines 48–49) before
 * `/api` (line 51). A global `app.use(maintenanceGuard)` above those lines would
 * refuse a Hubtel settlement callback mid-migration — turning a planned outage into
 * lost money, and doing it silently, because the provider's retry would also be
 * refused. Nothing about maintenance may touch a webhook.
 *
 * The same routers are *also* mounted inside `/api` (`routes/index.js:50–52`), so
 * `/api/webhooks/*` is covered by this guard. In production the providers are
 * configured against `WEBHOOK_BASE_URL`, which has no `/api` prefix, so they hit the
 * root mount and are unaffected.
 *
 * **Refusals are answered directly**, not thrown with `next(err)`.
 *
 * `errorHandler.js` replaces the message of any 5xx with the string "Something went
 * wrong" and never emits `code` — so a thrown `ApiError(message, 503, …)` would reach
 * the user with the sentence stripped and the machine-readable code gone, which is
 * the opposite of what a maintenance response is for. Answering inline is also what
 * `rateLimit.js` and `requireSchool.js` do.
 *
 * **`GET /api/health`, `PUT /api/admin/settings` and `PUT /api/admin/health/maintenance`
 * are exempt** — see the note on `EXEMPT_PATHS` below. The first so a deliberate
 * outage does not also look like a failing one; the other two because a kill switch
 * must never be behind itself, and the console reaches that same switch through two
 * different paths.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Paths that are never refused, whatever the mode.
 *
 * `/api/health` — `utils/cron.js` probes exactly that path, and a 503 there makes the
 * keep-alive log an error every cycle for a state the operator chose deliberately.
 * The guard is also mounted after `healthRoute`, so the route normally answers first;
 * this is the braces.
 *
 * `/api/admin/settings` — **the switch must not be behind the switch.** Without this
 * exemption, maintenance mode is a one-way door: turning it on refuses every write,
 * and the one write that could turn it off is itself refused. An operator who set
 * `readonly` to run a migration and then needed a single further change had no way
 * back — not through the console, not through the API, only by redeploying or
 * editing Mongo by hand. Every kill switch needs its own way out.
 *
 * `/api/admin/health/maintenance` — the **same argument, for the same switch by a
 * different door.** The console does not edit `maintenance.mode` through the
 * settings endpoint; it calls `PUT /admin/health/maintenance`, which is a different
 * path and was therefore not covered by the exemption above. The result was that the
 * health screen's toggle worked on a healthy platform and was itself refused the
 * moment it had been used — which is precisely when somebody needs it. A second route
 * onto the same state needs its own exemption; an exemption is per path, not per
 * concept, and assuming otherwise is how a kill switch acquires a one-way door
 * without anybody editing it.
 *
 * Exempting these paths opens no hole: they change only platform configuration,
 * which is precisely what the person enabling maintenance already has the authority
 * to do.
 */
const EXEMPT_PATHS = [
  "/api/health",
  "/health",
  "/api/admin/settings",
  "/api/admin/health/maintenance",
  "/admin/health/maintenance",
];

/**
 * The whole decision, as a pure function.
 *
 * Extracted so it can be tested without a database, which matters because this is
 * the one piece of middleware on the hot path that can refuse *every* request. A bug
 * here is a total outage, and a rule that can only be exercised by starting the
 * server and turning a flag is a rule that will not be.
 *
 * Returns `{ allow: true }` or `{ allow: false, code, mode, message }`.
 */
export const maintenanceDecision = ({
  mode = "off",
  method = "GET",
  path = "",
  message = "",
}) => {
  if (mode === "off") return { allow: true };

  // Query strings are stripped before comparison: `/api/health?verbose=1` must not
  // miss the exemption and turn the keep-alive probe into a reported outage.
  const cleanPath = String(path).split("?")[0].replace(/\/$/, "") || "/";
  if (EXEMPT_PATHS.includes(cleanPath)) return { allow: true };

  // `PATCH` is deliberately absent from `SAFE_METHODS`: it is a write, and the
  // failure from allowing one is silent — the resource looks updated and is not.
  if (mode === "readonly" && SAFE_METHODS.has(String(method).toUpperCase())) {
    return { allow: true };
  }

  return {
    allow: false,
    code: mode === "readonly" ? "MAINTENANCE_READONLY" : "MAINTENANCE_MODE",
    mode,
    message:
      message ||
      (mode === "readonly"
        ? "SukuuPay is in maintenance mode. You can read everything as normal, but changes are paused."
        : "SukuuPay is down for maintenance. Please try again shortly."),
  };
};

/**
 * `GET /api/health` is exempt. `utils/cron.js` probes exactly that path, and under
 * `on` a 503 there makes the keep-alive log an error every cycle for a state the
 * operator chose deliberately. The guard is also mounted after `healthRoute` in
 * `routes/index.js`, so the route normally answers first — this is the braces.
 */
export const maintenanceGuard = async (req, res, next) => {
  let settings;
  try {
    settings = await getCachedPlatformSettings();
  } catch {
    // Fail open. `getCachedPlatformSettings` already defaults rather than throwing;
    // this is the same rule applied one level out. A guard that cannot read its own
    // configuration must not become the outage it exists to prevent.
    return next();
  }

  const decision = maintenanceDecision({
    mode: settings?.maintenance?.mode,
    method: req.method,
    path: req.originalUrl || req.url || "",
    message: settings?.maintenance?.message || "",
  });

  if (decision.allow) return next();

  res.set("Retry-After", "300");

  return res.status(503).json({
    success: false,
    // Named for what happened, not for what the client should do: this is not the
    // client's fault, and a bare "try again later" with no reason produces exactly
    // the support ticket it was supposed to prevent.
    code: decision.code,
    mode: decision.mode,
    message: decision.message,
    retryAfter: 300,
  });
};

export default maintenanceGuard;