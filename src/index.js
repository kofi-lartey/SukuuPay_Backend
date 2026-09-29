import express from 'express';
import { MONGODB_URI, PORT } from './config/env.js';
import cors from 'cors';
import mongoose from 'mongoose';
import job from './utils/cron.js';
import installmentReminderJob from './jobs/installmentReminder.job.js';
import routes from './routes/index.js';
import { healthRoute } from './routes/health.routes.js';
import { whatsappRoute } from './routes/whatsapp.routes.js';
import { webhookRoute } from './routes/webhooks.routes.js';
import errorHandler from './middleware/errorHandler.js';

const app = express();

job.start(); // Start the cron job to run the health check every 14 minutes
installmentReminderJob.start(); // Daily 08:00 Accra sweep of plan installments
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
  .then(() => {
    console.log('Connected to MongoDB successfully!');
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
