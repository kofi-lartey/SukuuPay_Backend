import { School } from '../models/schoolModel.js';

/**
 * One-shot boot migration: move every school off the retired gateway rails.
 *
 * Moolre is the active payment gateway. Hubtel and Paystack have been removed
 * outright — their clients, routes, model fields and credentials are gone — so
 * a school still carrying `gatewayMode: "hubtel"` or `"paystack"` is left with
 * a value the schema no longer accepts, and every save of that school fails
 * validation. Without a migration, those records are poisoned.
 *
 * The same applies to `sms.provider`: "hubtel" is no longer a selectable
 * provider, so a school on it is moved to the platform default.
 *
 * This runs on every boot and is idempotent: it updates only schools still on a
 * retired mode, so re-runs are a no-op. It does not touch schools already on
 * `moolre` or `manual` (manual is a real state, not a provider).
 */
const RETIRED_PAYMENT_MODES = ['hubtel', 'paystack', 'arke', 'mnotify'];
const RETIRED_SMS_PROVIDERS = ['hubtel'];

export const migrateGateways = async () => {
  const payment = await School.updateMany(
    {
      deletedAt: null,
      'payment.gatewayMode': { $in: RETIRED_PAYMENT_MODES },
    },
    { $set: { 'payment.gatewayMode': 'moolre' } }
  );

  const sms = await School.updateMany(
    {
      deletedAt: null,
      'sms.provider': { $in: RETIRED_SMS_PROVIDERS },
    },
    { $set: { 'sms.provider': 'moolre' } }
  );

  if (payment.nModified > 0) {
    console.log(
      `[gateway-migration] migrated ${payment.nModified} school(s) from retired gateways ` +
        `(${RETIRED_PAYMENT_MODES.join(', ')}) to moolre`
    );
  }

  if (sms.nModified > 0) {
    console.log(
      `[gateway-migration] migrated ${sms.nModified} school(s) from retired SMS providers ` +
        `(${RETIRED_SMS_PROVIDERS.join(', ')}) to moolre`
    );
  }

  return {
    migrated: payment.nModified,
    matched: payment.n,
    disabledGateways: RETIRED_PAYMENT_MODES,
    migratedSmsProviders: sms.nModified,
  };
};

export default migrateGateways;
