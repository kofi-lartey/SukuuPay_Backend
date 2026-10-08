import { School } from '../models/schoolModel.js';
import { DISABLED_GATEWAYS } from '../utils/paymentGateway.js';

/**
 * One-shot boot migration: move every school off the disabled gateway rails.
 *
 * Paystack is now the sole active payment gateway. Hubtel, Arke, Mnotify and
 * MTN remain in the `School.payment.gatewayMode` enum so existing school
 * records are not invalidated by a schema change, but `resolveGateway` no
 * longer routes to them. Without a migration, a school created under the old
 * default (`gatewayMode: "hubbel"`) keeps showing a collection gateway that no
 * payment will ever use, and its admin sees a Setting that contradicts reality.
 *
 * This runs on every boot and is idempotent: it updates only schools still on a
 * disabled mode, so re-runs are a no-op. It does not touch schools already on
 * `paystack` or `manual` (manual is a real state, not a provider).
 */
export const migrateGateways = async () => {
  const result = await School.updateMany(
    {
      deletedAt: null,
      'payment.gatewayMode': { $in: DISABLED_GATEWAYS },
    },
    { $set: { 'payment.gatewayMode': 'paystack' } }
  );

  if (result.nModified > 0) {
    console.log(
      `[gateway-migration] migrated ${result.nModified} school(s) from disabled gateways ` +
        `(${DISABLED_GATEWAYS.join(', ')}) to paystack`
    );
  }

  return {
    migrated: result.nModified,
    matched: result.n,
    disabledGateways: DISABLED_GATEWAYS,
  };
};

export default migrateGateways;
