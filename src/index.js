import express from 'express';
import { MONGODB_URI, PORT } from './config/env.js';
import cors from 'cors';
import mongoose from 'mongoose';
import job from './utils/cron.js';
import installmentReminderJob from './jobs/installmentReminder.job.js';
import healthCheckJob from './jobs/healthCheck.job.js';
import routes from './routes/index.js';
import { healthRoute } from './routes/health.routes.js';
import { whatsappRoute } from './routes/whatsapp.routes.js';
import { webhookRoute } from './routes/webhooks.routes.js';
import errorHandler from './middleware/errorHandler.js';
import { recordRequestError } from './utils/errorBuffer.js';
import { ensureSuperAdmin } from './boot/ensureSuperAdmin.js';
import { migrateGateways } from './boot/migrateGateways.js';

const app = express();

job.start(); // Start the cron job to run the health check every 14 minutes
installmentReminderJob.start(); // Daily 08:00 Accra sweep of plan installments
healthCheckJob.start(); // Every 5 min: probes MongoDB, payment gateways and SMS
app.set('trust proxy', 1);

// ─────────────────────────────────────────────
// Raw body capture
// ─────────────────────────────────────────────
// Meta, Hubtel and Arkesel sign the exact bytes they sent, so their callbacks
// can only be authenticated against the unparsed body: a JSON parse followed by
// `JSON.stringify` reorders nothing but re-escapes unicode, collapses nothing
// but rewrites the separators, and the HMAC will not match. `verify` hands us
// the buffer before the parser discards it.
//
// `req.rawBody` is read only by the signature verifiers in
// utils/signatures.js; nothing else should depend on it.
const captureRawBody = (req, res, buf) => {
  req.rawBody = buf;
};

app.use(express.json({ verify: captureRawBody }));
// Arkesel posts its delivery report as a form, which needs the same treatment.
app.use(express.urlencoded({ extended: true, verify: captureRawBody }));
app.use(cors());

// Health, version and ping are mounted at the root: a load balancer and an
// uptime monitor reach them before any path prefix is applied.
app.use('/', healthRoute);

// Third-party callbacks are mounted at the root as well, because the URLs are
// registered with the providers and must stay stable. The same routers are also
// mounted under /api below, so an operator working from the rest of the API can
// reach them at the documented /api path too.
app.use('/', webhookRoute);
app.use('/', whatsappRoute);

app.use('/api', routes);

app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Feeds the in-process error ring buffer (`utils/errorBuffer.js`) that backs
// `GET /admin/health/errors`, then forwards. Nothing is persisted anywhere —
// `errorHandler.js` below only console.errors — so without this the console's
// recent-errors screen has no data and would have to invent some.
//
// Registered immediately before `errorHandler` so it sees the error first, and it
// is purely additive: `errorHandler` stays the single authority on what a client
// sees, still the thing that strips 5xx messages. The `next(error)` here is
// Express's own mechanism — an errored request has no handler left to answer it —
// and is not the "never forward an error" rule that applies to controllers.
app.use(recordRequestError);

app.use(errorHandler);

// Bind the port BEFORE connecting to MongoDB.
//
// Render (and most PaaS routers) route traffic to the process by probing the
// port it was told to expect, and they give a deploy only a short window to
// accept a connection. Listening only after `mongoose.connect()` resolved meant
// any slow, retried, or failed connection left nothing bound, so the deploy
// died with "No server listening on port …" even though the process was alive
// and the database was fine.
//
// Listening first also means `/health` is reachable while the database is still
// connecting or down — which is exactly when an operator or uptime monitor most
// needs a truthful answer. The health controller already reports the database
// state, so the endpoint can describe a degraded instance instead of not
// answering at all.
const server = app.listen(PORT, () => {
  // 0.0.0.0, not localhost: a server bound to loopback is unreachable from
  // outside the container, which presents the same symptom as never binding.
  console.log(`Server listening on port ${PORT} (bound 0.0.0.0)`);
});

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB successfully!');

    // The single platform owner, provisioned from SUPER_ADMIN_EMAIL /
    // SUPER_ADMIN_PASSWORD and reconciled on every boot.
    //
    // It runs here, inside the connect handler, and not beside `app.listen`
    // because it writes to Mongo — and `app.listen` is deliberately first so a
    // slow connect cannot kill a deploy (see the comment above). A reconcile that
    // could not reach the database would provision nothing and report success.
    //
    // Fatal on failure, like the connect itself: an instance whose port is bound
    // and whose `/health` answers 200, with no account that can reach
    // `/api/admin`, is worse than an instance that restarts. There is no in-product
    // way to create a platform owner — that is the point of the invariant — so a
    // silent failure here has no recovery but a redeploy, and a loud one at least
    // says why.
    await ensureSuperAdmin();
    // One-shot migration: move any school still on a disabled gateway mode
    // (hubbel, arke, mnotify) to the sole active gateway, paystack.
    // Idempotent — re-runs are a no-op.
    await migrateGateways();
  })
  .catch((error) => {
    console.error('Database connection failed:', error);
    // Exit non-zero so the platform restarts or rolls the deploy back. Without
    // this the process stays up with a listening port but no database, serving
    // 5xx on every request while looking "healthy" to a load balancer.
    server.close(() => process.exit(1));
    // Do not wait on a close that cannot complete (an in-flight connection
    // would keep the process alive indefinitely).
    setTimeout(() => process.exit(1), 5000).unref();
  });

export default app;
