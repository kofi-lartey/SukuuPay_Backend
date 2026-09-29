import { Router } from 'express';
import { healthController, versionController, pingController } from '../controllers/health.controller.js';

export const healthRoute = Router();

// ─────────────────────────────────────────────
// Health & utility
// ─────────────────────────────────────────────
// All three are unauthenticated: a load balancer, an uptime monitor and a client
// discovering the API contract all need to reach them without a session, and
// none of them exposes business data. /health and /version report whether a
// credential is *present*, never its value.

// GET /health — full health check. 503 when MongoDB is not connected, so a load
// balancer pulls the instance out instead of sending it traffic it cannot serve.
healthRoute.get('/health', healthController);

// GET /version — build and API version, plus integration configuration status.
healthRoute.get('/version', versionController);

// GET /ping — lightweight uptime probe. Touches no dependency at all.
healthRoute.get('/ping', pingController);
