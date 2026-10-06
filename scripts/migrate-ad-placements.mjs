/**
 * Remaps retired ad placements onto the surviving vocabulary.
 *
 * Run: MONGODB_URI=... node scripts/migrate-ad-placements.mjs [--apply]
 *
 * ## Why
 *
 * `AD_PLACEMENTS` is now `["advertisement_page", "home_hero"]`. The
 * `auth_aside` (login & signup aside) and `dashboard_sidebar` (school
 * dashboard aside) placements were retired when those surfaces stopped
 * carrying advertisements. Mongoose does not rewrite stored documents
 * when an enum changes, so every creative still holding a retired value
 * is invisible everywhere — no public query matches it, and the
 * moderation queue shows the raw retired string.
 *
 * ## The mapping
 *
 *   auth_aside        → advertisement_page   (the hub is the closest surviving surface)
 *   dashboard_sidebar → advertisement_page   (no dashboard ad surface exists)
 *
 * Both retired placements pointed at public marketing surfaces, and the
 * School Advertisements hub is the only public surface left, so both
 * remap onto it. A creative's run window, status and sort weight are
 * untouched — only the placement changes.
 *
 * ## Safety
 *
 * Idempotent: the filter matches only documents whose placement is one
 * of the two retired values, so re-running is a no-op. Dry-run by
 * default; `--apply` writes. Every remapped document is printed with
 * its headline so the output is the audit trail.
 */
import mongoose from 'mongoose';
import { MONGODB_URI } from '../src/config/env.js';
import { SchoolAd } from '../src/models/SchoolAd.js';

const APPLY = process.argv.includes('--apply');

const REMAP = {
  auth_aside: 'advertisement_page',
  dashboard_sidebar: 'advertisement_page',
};

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Nothing to do.');
  process.exit(1);
}

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to ${mongoose.connection.name}. ${APPLY ? 'Applying.' : 'Dry run — pass --apply to write.'}\n`);

  const retired = Object.keys(REMAP);
  const stale = await SchoolAd.find({
    placement: { $in: retired },
    deletedAt: null,
  }).select('headline placement status endsAt');

  if (stale.length === 0) {
    console.log('No creatives hold a retired placement. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  console.log(`${stale.length} creative(s) to remap:`);
  for (const ad of stale) {
    const next = REMAP[ad.placement];
    console.log(`  ${ad._id}  ${ad.placement} → ${next}  "${ad.headline}"`);
    if (APPLY) {
      ad.placement = next;
      await ad.save();
    }
  }

  console.log(`\n${APPLY ? 'Remapped' : 'Would remap'} ${stale.length} creative(s).`);
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
