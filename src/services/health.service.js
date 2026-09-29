import { createRequire } from 'node:module';
import mongoose from 'mongoose';
import { API_COMMIT, API_BUILD_DATE, API_NAME, API_VERSION, NODE_ENV, PRIMARY_PAYMENT_GATEWAY } from '../config/env.js';
import { getWhatsAppConfigStatus } from '../utils/whatsappApi.js';
import { getMtnConfigStatus } from '../utils/mtnApi.js';
import { getArkeselConfigStatus } from '../utils/arkeselApi.js';
import { availableSmsProviders } from '../utils/smsService.js';
import { SMS_DEFAULT_PROVIDER } from '../config/env.js';

// The npm package version is read through createRequire rather than a JSON
// import: `with { type: 'json' }` needs a Node version floor the project does
// not pin, and a hardcoded copy drifts the moment package.json is bumped.
const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

const startedAt = new Date();
const bootTime = Date.now();

/** Human-readable mongoose connection state, for the health payload. */
const describeConnection = () => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting', 'uninitialized'];
  const state = states[mongoose.connection.readyState] ?? 'unknown';
  return {
    state,
    connected: mongoose.connection.readyState === 1,
    name: mongoose.connection.name || null,
    host: mongoose.connection.host || null,
  };
};

// The database probe is bounded. A health endpoint that hangs is worse than one
// that reports a timeout: a load balancer's check would block on it, and the
// instance would look alive while serving nothing.
const DB_PROBE_TIMEOUT_MS = 2000;

/**
 * Round-trip time to the database, which is what actually determines whether
 * requests are being served slowly. Bounded, and never throws.
 */
const measureDatabaseLatency = () =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), DB_PROBE_TIMEOUT_MS);
    timer.unref?.();

    const started = Date.now();
    // `ping` against the connection's own database, not the admin database:
    // the admin command needs privileges a scoped Atlas user may not have, and
    // then the callback never arrives.
    mongoose.connection.db
      .command({ ping: 1 })
      .then(() => {
        clearTimeout(timer);
        finish(Date.now() - started);
      })
      .catch(() => {
        clearTimeout(timer);
        finish(null);
      });
  });

/**
 * Full health check.
 *
 * Reports 503 when the database is not connected, so a load balancer pulls the
 * instance out instead of sending it traffic it cannot serve. Memory is
 * included because the process that runs out of heap is the failure an operator
 * most often cannot see from the outside.
 */
export const getHealth = async () => {
  const memory = process.memoryUsage();
  const database = describeConnection();

  return {
    status: database.connected ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    version: API_VERSION,
    environment: NODE_ENV,
    database: {
      ...database,
      latencyMs: database.connected ? await measureDatabaseLatency() : null,
    },
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
    },
    node: process.version,
    pid: process.pid,
  };
};

/**
 * Build and API version.
 *
 * Exposes which messaging integrations are configured. This reports only
 * whether a credential is present, never its value, and the endpoint is
 * deliberately unauthenticated so a client can discover the contract before
 * logging in.
 */
export const getVersion = () => ({
  name: API_NAME,
  version: pkg.version,
  apiVersion: API_VERSION,
  commit: API_COMMIT,
  buildDate: API_BUILD_DATE,
  startedAt: startedAt.toISOString(),
  startedAtEpochMs: bootTime,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  environment: NODE_ENV,
  integrations: {
    whatsapp: getWhatsAppConfigStatus(),
    sms: {
      // The provider a school gets when it has not chosen one. Per-school
      // overrides live on `school.sms.provider` and are resolved at send time.
      defaultProvider: SMS_DEFAULT_PROVIDER,
      // Providers with a working send integration. Empty means every outbound
      // SMS will fail — see the arkesel block for why.
      sendProviders: availableSmsProviders(),
      arkesel: getArkeselConfigStatus(),
    },
    payments: {
      primaryGateway: PRIMARY_PAYMENT_GATEWAY,
      mtn: getMtnConfigStatus(),
      // Hubtel credentials are per-school, so only the platform's view is
      // reported here; whether a given school is Hubtel-capable is resolved per
      // payment by utils/paymentGateway.js.
      hubtel: { note: 'Per-school credentials; resolved at payment time' },
    },
  },
});

/**
 * Lightweight uptime probe.
 *
 * Touches nothing — no database, no config — so a monitoring check that runs
 * every few seconds cannot itself become load. Answering here proves the event
 * loop is turning, which is the only question a ping should answer.
 */
export const getPing = () => ({
  pong: true,
  status: 'ok',
  timestamp: new Date().toISOString(),
  uptimeSeconds: Math.round(process.uptime()),
});
