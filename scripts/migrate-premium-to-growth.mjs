/**
 * Normalizes legacy subscription plan names onto the Free / Starter / Growth
 * tier structure.
 *
 * Run: MONGODB_URI=... node scripts/migrate-premium-to-growth.mjs [--apply]
 *
 * ## Why
 *
 * The published tiers are Free / Starter / Growth, and `School.subscription.plan`
 * is now the enum `["trial", "free", "starter", "growth"]`. Mongoose does not
 * rewrite stored documents when an enum changes, so a school created under the
 * old vocabulary still holds a retired name — `basic`, `standard`, `premium`,
 * `enterprise` — sometimes with a status suffix concatenated on (e.g.
 * `"premiumactive"`). A raw retired value never matches a tier's server list,
 * so `getTierForSchool` returns null and the school silently loses every
 * entitlement while the billing screen shows the raw string.
 *
 * ## The mapping
 *
 *   basic      → free
 *   standard   → starter
 *   premium    → growth   (GH₵ 275 — unchanged fee)
 *   enterprise → growth
 *
 * A status suffix is stripped in the same pass (`"premiumactive"` → `"growth"`),
 * because the suffix is a display artefact, not part of the plan. The monthly
 * fee is left untouched: a premium school already billed 27500 pesewas is
 * already on the Growth price, so only the plan label changes.
 *
 * ## Safety
 *
 * Idempotent: only documents whose stored plan is not already a clean valid
 * value are matched, so re-running is a no-op. Dry-run by default; `--apply`
 * writes. Every rewritten document is printed with its school name so the
 * output is the audit trail.
 */
import mongoose from 'mongoose';
import { MONGODB_URI } from '../src/config/env.js';
import { School } from '../src/models/schoolModel.js';
import { normalizePlan, SUBSCRIPTION_PLANS } from '../src/config/constants.js';

const APPLY = process.argv.includes('--apply');

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Nothing to do.');
  process.exit(1);
}

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  console.log(
    `Connected to ${mongoose.connection.name}. ${APPLY ? 'Applying.' : 'Dry run — pass --apply to write.'}\n`
  );

  // Scan every school that has a plan set. The filter is intentionally broad:
  // the decision of whether a value needs rewriting is made per-document by
  // normalizePlan, so a school already on a clean tier is simply skipped.
  const schools = await School.find({
    'subscription.plan': { $exists: true, $ne: null },
  }).select('name schoolCode subscription.plan subscription.status subscription.monthlyFee');

  const stale = [];
  for (const school of schools) {
    const stored = school.subscription?.plan;
    if (!stored) continue;
    const normalized = normalizePlan(stored);
    const isClean = SUBSCRIPTION_PLANS.includes(String(stored).toLowerCase());
    if (!isClean && normalized && normalized !== stored) {
      stale.push({ school, stored, normalized });
    }
  }

  if (stale.length === 0) {
    console.log('No schools hold a retired or status-suffixed plan. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  console.log(`${stale.length} school(s) to normalize:`);
  for (const { school, stored, normalized } of stale) {
    const fee = ((school.subscription?.monthlyFee ?? 0) / 100).toFixed(2);
    console.log(
      `  ${school._id}  ${school.name} (${school.schoolCode || '—'})  plan "${stored}" → "${normalized}"  fee ${fee} GHS`
    );
    if (APPLY) {
      school.subscription.plan = normalized;
      await school.save();
    }
  }

  console.log(`\n${APPLY ? 'Normalized' : 'Would normalize'} ${stale.length} school(s).`);
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});