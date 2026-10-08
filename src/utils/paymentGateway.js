// ─────────────────────────────────────────────
// Payment gateway selection
// ─────────────────────────────────────────────
// Paystack is the primary and, for now, the only **active** payment gateway.
// MTN MoMo, Hubtel, Arke and Mnotify remain wired into the codebase (their
// providers, models and service paths are all still importable) but are held
// in a disabled rail so the platform settles exclusively through Paystack.
//
// The preference is platform-wide via PRIMARY_PAYMENT_GATEWAY and is only
// honoured when the corresponding credentials are actually present, so a
// half-configured deployment fails fast rather than silently downgrading to a
// gateway the operator believes is switched off.
//
// This lives in its own module because both payment.service.js and
// paymentPlan.service.js need it, and they already import each other
// (paymentPlan settles a payment, payment applies it to a plan). Putting the
// selection here keeps that existing cycle out of the dependency graph instead
// of adding a new one.
import { PRIMARY_PAYMENT_GATEWAY } from '../config/env.js';
import { isMtnConfigured } from './mtnApi.js';
import { isPaystackConfigured, resolvePaystackSecretKey } from './paystackApi.js';

/** Gateways retained in the codebase but switched off. */
export const DISABLED_GATEWAYS = ['hubtel', 'arke', 'mnotify', 'mtn'];

/** True when a school carries a complete set of Hubtel credentials. */
export const hubtelIsConfigured = (school) =>
  Boolean(
    school?.payment?.hubtelClientId &&
    school?.payment?.hubtelClientSecret &&
    school?.payment?.hubtelApiKey
  );

/** True when a school (or the platform) has Paystack configured. */
export const paystackIsConfigured = (school) =>
  isPaystackConfigured(school);

/**
 * Resolves which gateway a payment should use.
 *
 * Paystack is the sole active gateway. Other gateways (MTN, Hubtel, Arke,
 * Mnotify) remain in `School.payment.gatewayMode`'s enum for backward
 * compatibility but `resolveGateway` will not route to them — the fallback chain
 * ends at Paystack and throws `PAYMENT_CONFIG_MISSING` when even that is absent.
 *
 * @param {object} school the School document (or its `payment` sub-document)
 * @param {string} [method='card'] - 'card' for Paystack, 'momo' for MoMo
 * @returns {'paystack'}
 */
export const resolveGateway = (school, _method = 'card') => {
  const paystackReady = paystackIsConfigured(school);

  if (PRIMARY_PAYMENT_GATEWAY === 'paystack' && paystackReady) return 'paystack';
  if (paystackReady) return 'paystack';

  const error = new Error(
    'No active payment gateway is configured. Paystack is the only enabled gateway; configure PAYSTACK_SECRET_KEY (platform-level or school-level).'
  );
  error.status = 400;
  error.code = 'PAYMENT_CONFIG_MISSING';
  throw error;
};

/**
 * The gateways this build can drive. Paystack is the only **active** gateway;
 * the others are listed with `active: false` so callers can render them in a
 * "disabled" state while retaining their configuration in the school record.
 */
export const availableGateways = (school) => [
  { id: 'paystack', configured: paystackIsConfigured(school), active: true, label: 'Paystack' },
  { id: 'mtn', configured: isMtnConfigured(), active: false, label: 'MTN MoMo' },
  { id: 'hubtel', configured: hubtelIsConfigured(school), active: false, label: 'Hubtel' },
  { id: 'arke', configured: false, active: false, label: 'Arke' },
  { id: 'mnotify', configured: false, active: false, label: 'Mnotify' },
];

/** Returns the effective Paystack secret key for the given school. */
export const getPaystackSecretKey = (school) => resolvePaystackSecretKey(school);

