// ─────────────────────────────────────────────
// Payment gateway selection
// ─────────────────────────────────────────────
// MTN MoMo is the primary gateway for v1; Hubtel is retained as the fallback so a
// school whose MTN credentials are absent — or a parent on a network MTN cannot
// settle — still has a working route to payment.
//
// The preference is platform-wide via PRIMARY_PAYMENT_GATEWAY and is only
// honoured when the corresponding credentials are actually present, so a
// half-configured deployment degrades to Hubtel rather than failing every
// payment with a 503.
//
// This lives in its own module because both payment.service.js and
// paymentPlan.service.js need it, and they already import each other
// (paymentPlan settles a payment, payment applies it to a plan). Putting the
// selection here keeps that existing cycle out of the dependency graph instead
// of adding a new one.
import { PRIMARY_PAYMENT_GATEWAY } from '../config/env.js';
import { isMtnConfigured } from './mtnApi.js';

/** True when a school carries a complete set of Hubtel credentials. */
export const hubtelIsConfigured = (school) =>
  Boolean(
    school?.payment?.hubtelClientId &&
    school?.payment?.hubtelClientSecret &&
    school?.payment?.hubtelApiKey
  );

/**
 * Resolves which gateway a payment should use.
 *
 * MTN wins whenever it is both the configured preference and usable. A school
 * with neither gateway configured is a deployment error the caller must see, so
 * this throws rather than silently picking one.
 *
 * @param {object} school the School document (or its `payment` sub-document)
 * @returns {'mtn'|'hubtel'}
 */
export const resolveGateway = (school) => {
  const preferMtn = PRIMARY_PAYMENT_GATEWAY === 'mtn';
  const mtnReady = isMtnConfigured();
  const hubtelReady = hubtelIsConfigured(school);

  if (preferMtn && mtnReady) return 'mtn';
  if (hubtelReady) return 'hubtel';
  if (mtnReady) return 'mtn';

  const error = new Error(
    'No payment gateway is configured. Set MTN credentials, or the school’s Hubtel credentials.'
  );
  error.status = 400;
  error.code = 'PAYMENT_CONFIG_MISSING';
  throw error;
};

/** The gateways this build can drive, in preference order. */
export const availableGateways = (school) =>
  [
    { id: 'mtn', configured: isMtnConfigured() },
    { id: 'hubtel', configured: hubtelIsConfigured(school) },
  ].filter((gateway) => gateway.configured);
