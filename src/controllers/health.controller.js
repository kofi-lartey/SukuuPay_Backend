import { getHealth, getVersion, getPing } from '../services/health.service.js';

// ── GET /health — full health check ──
export const healthController = async (_req, res) => {
  try {
    const health = await getHealth();
    // A degraded dependency must be visible to a load balancer as a non-2xx, or
    // this instance keeps receiving traffic it cannot serve.
    const status = health.database.connected ? 200 : 503;

    // `status` stays at the top level: this endpoint previously answered
    // `{ status: 'ok' }`, and existing uptime monitors read that exact field.
    return res.status(status).json({
      success: health.database.connected,
      status: health.status,
      timestamp: health.timestamp,
      data: health,
    });
  } catch (error) {
    // The health endpoint is the last thing that should ever fail loudly.
    console.error('[HEALTH] Health check failed:', error);
    return res.status(503).json({
      success: false,
      status: 'unhealthy',
      message: 'Health check failed',
    });
  }
};

// ── GET /version — build and API version ──
export const versionController = (_req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: getVersion(),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── GET /ping — lightweight uptime check ──
export const pingController = (_req, res) => {
  try {
    return res.status(200).json(getPing());
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
