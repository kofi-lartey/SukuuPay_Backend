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

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB successfully!');

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Database connection failed:', error);
  });

export default app;
