// ─────────────────────────────────────────────
// Payment gateway selection
// ─────────────────────────────────────────────
// Moolre is the primary **active** payment gateway: a Ghanaian EPSP that reaches
// MTN MoMo, Telecel Cash and AT Money through one integration, and carries SMS
// on the same wallet.
//
// MTN Collections is the secondary rail, fully wired but off by default.
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
import { isMoolreConfigured } from './moolreClient.js';

/**
 * True when Moolre is configured platform-wide.
 *
 * Moolre is a platform-level account rather than a per-school one: the
 * merchant wallet, the API keys and the settlement account belong to
 * SukuuPay, and every school's collections run through it. So this does not
 * take a school — there is nothing per-school to vary.
 */
export const moolreIsConfigured = () => isMoolreConfigured();

/**
 * Resolves which gateway a payment should use.
 *
 * Moolre is the primary rail. It is a Ghanaian EPSP licensed by the Bank of
 * Ghana that reaches MTN MoMo, Telecel Cash and AT Money through one
 * integration, and it carries SMS on the same wallet, so a school on Moolre
 * has one vendor and one balance for both collection and reminders.
 *
 * MTN Collections is the secondary rail, fully wired but off by default.
 *
 * The preference is platform-wide via `PRIMARY_PAYMENT_GATEWAY` and is only
 * honoured when the corresponding credentials are actually present, so a
 * half-configured deployment falls back rather than failing at checkout — and
 * so a gateway the operator believes is switched off is never quietly selected
 * because its credentials happen to be lying around in the environment.
 *
 * @param {object} school the School document (or its `payment` sub-document)
 * @param {string} [method='card'] - 'card' for a hosted checkout, 'momo' for MoMo
 * @returns {'moolre'|'mtn'}
 */
export const resolveGateway = (school, method = 'card') => {
  const moolreReady = moolreIsConfigured();
  const mtnReady = isMtnConfigured();

  // The platform's stated preference wins, whenever it is usable.
  if (PRIMARY_PAYMENT_GATEWAY === 'moolre' && moolreReady) return 'moolre';
  if (PRIMARY_PAYMENT_GATEWAY === 'mtn' && mtnReady) return 'mtn';

  // The preferred gateway is not usable, so fall back to whatever *is*
  // configured, in the order that keeps a parent able to pay: Moolre, then
  // MTN.
  if (moolreReady) return 'moolre';
  if (mtnReady) return 'mtn';

  const error = new Error(
    'No payment gateway is configured. Set the Moolre credentials (MOOLRE_API_USER, MOOLRE_API_KEY, MOOLRE_PUBLIC_KEY, MOOLRE_ACCOUNT_NUMBER).'
  );
  error.status = 400;
  error.code = 'PAYMENT_CONFIG_MISSING';
  throw error;
};

/**
 * The gateways this build can drive.
 *
 * `active` is the gateway a payment would *actually* use — resolved through
 * `resolveGateway`, not read off the environment variable. The two are not
 * the same: with `PRIMARY_PAYMENT_GATEWAY=moolre` and no Moolre credentials
 * yet, the preference says Moolre but the platform settles through MTN, and
 * an admin screen that says otherwise is a screen that is lying about where a
 * school's money is going.
 *
 * The disabled rails are listed so their configuration stays visible in the
 * school record while making clear that no payment will use them.
 */
export const availableGateways = (school) => {
  let resolved = null;
  try {
    resolved = resolveGateway(school);
  } catch {
    // Nothing is configured. No gateway is active, and the caller shows that.
    resolved = null;
  }

  return [
    { id: 'moolre', configured: moolreIsConfigured(), active: resolved === 'moolre', label: 'Moolre' },
    { id: 'mtn', configured: isMtnConfigured(), active: resolved === 'mtn', label: 'MTN MoMo' },
    { id: 'arke', configured: false, active: false, label: 'Arke' },
    { id: 'mnotify', configured: false, active: false, label: 'Mnotify' },
  ];
};
