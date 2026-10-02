import {
  getSystemHealth,
  getJobRuns,
  getRecentErrors,
  setMaintenanceMode,
} from "../../services/admin/health.service.js";

/*
 * Thin handlers: one service call each, no branching on business rules, no
 * `next(error)`, every `res.status(...).json(...)` returned.
 *
 * Behind `authenticate` + `authorize('super_admin')` on `routes/admin.routes.js`.
 * The maintenance write is the one that needs it most — it is a platform-wide
 * switch — and it is the only write among these four.
 */

// ─────────────────────────────────────────────
// GET /admin/health — status per dependency
// ─────────────────────────────────────────────
/*
 * Always 200, including when the payload says `status: "down"`.
 *
 * Deliberate, and worth stating because it looks wrong: this is an
 * *authenticated console screen*, not the public `/api/health` probe that a load
 * balancer hits (`controllers/health.controller.js:9` answers 503 there, correctly
 * — a load balancer must be able to pull the instance out).
 *
 * Here the caller is a logged-in super admin asking what is broken. Answering 503
 * would make the browser's fetch layer treat a perfectly good diagnostic as a
 * transport failure, and the console's error handler would replace the payload —
 * the one thing that was wrong — with "Something went wrong", which
 * `errorHandler.js:61` does to any 5xx message. The status of the platform is
 * data here. It is in `data.status`.
 */
export const getSystemHealthController = async (_req, res) => {
  try {
    const result = await getSystemHealth();

    return res.status(200).json({
      success: true,
      message: "System health retrieved successfully",
      data: result,
    });
  } catch (error) {
    /*
     * Reached only if `getSystemHealth` itself fails, which it should not: every
     * dependency probe is individually wrapped so a flaky provider cannot get
     * here. Logged with the real error because this is the screen that exists to
     * explain an outage, and returning a bare 500 to it would be the last silence.
     */
    console.error("[ADMIN] System health could not be assembled:", error.message);

    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /admin/health/jobs — scheduler state
// ─────────────────────────────────────────────
export const getJobRunsController = async (_req, res) => {
  try {
    const result = await getJobRuns();

    return res.status(200).json({
      success: true,
      message: "Job schedules retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /admin/health/errors — recent 5xx on this instance
// ─────────────────────────────────────────────
export const getRecentErrorsController = async (req, res) => {
  try {
    const result = await getRecentErrors({
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
    });

    return res.status(200).json({
      success: true,
      message: "Recent errors retrieved successfully",
      data: result.data,
      // The `scope` block travels in `meta` and says, as data, that this is one
      // process's ring buffer and not a durable store. A screen that renders
      // "last 500 errors" over it is stating something false; shipping the caveat
      // in the payload is what makes the screen honest.
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// PUT /admin/health/maintenance — the platform-wide switch
// ─────────────────────────────────────────────
/*
 * `req` is passed through to the service, not just `req.user`.
 *
 * The service writes the `ADMIN_MAINTENANCE_MODE` audit entry and has to attach
 * `meta.impersonatedBy` / `meta.impersonationSessionId` when
 * `req.impersonation` is set — and that pointer is only on the request, never on
 * `req.user`. A controller that forwarded `req.user` alone would silently lose
 * the attribution on exactly the request type where it matters most.
 */
export const setMaintenanceModeController = async (req, res) => {
  try {
    const result = await setMaintenanceMode(
      {
        enabled: req.body?.enabled,
        message: req.body?.message,
      },
      req.user,
      req
    );

    return res.status(200).json({
      success: true,
      message: result.enabled
        ? `Maintenance mode is now "${result.mode}"`
        : "Maintenance mode is off",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};