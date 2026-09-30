// ─────────────────────────────────────────────
// Audit unlinked accounts (FR-8)
// ─────────────────────────────────────────────
//
//   node scripts/audit-unlinked-users.js
//
// READ-ONLY. This script never writes.
//
// The short version: there is no migration to run. `schoolId: null` is already
// the trigger for the provisioning path, so an account stranded by the old
// "contact support" dead end is repaired the moment it logs in — it lands on
// Step 1 in CREATE mode and creates its own school. Deleting the dead-end card
// is the actual fix.
//
// What this script is for is knowing the blast radius before shipping, and
// catching accounts in states the wizard will *not* resolve on its own:
//   - `schoolId` pointing at a soft-deleted school (DANGLING). The account can
//     provision again, but its old school data is unreachable.
//   - accounts that marked onboarding complete yet never had a school, which is
//     how the guard could previously wave one into the dashboard.
//   - the historical signup `schoolIntent`, which shows what was collected and
//     thrown away, and how much Step 1 prefill will recover.
//
// Usage:
//   MONGODB_URI=... node scripts/audit-unlinked-users.js
//
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { MONGODB_URI } from '../src/config/env.js';
import { User } from '../src/models/userModel.js';
import { School } from '../src/models/schoolModel.js';
import { SchoolJoinRequest } from '../src/models/SchoolJoinRequest.js';

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Nothing to do.');
  process.exit(1);
}

const pct = (n, total) => (total ? `${((n / total) * 100).toFixed(1)}%` : 'n/a');

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected. Reading only.\n');

  const totalUsers = await User.countDocuments({ deletedAt: null });
  const unlinked = await User.countDocuments({
    schoolId: null,
    role: { $ne: 'super_admin' },
    deletedAt: null,
  });

  console.log('── Population ─────────────────────────────────────────');
  console.log(`Active accounts (excl. deleted) : ${totalUsers}`);
  console.log(`Unlinked, will hit provisioning: ${unlinked}  (${pct(unlinked, totalUsers)})`);
  console.log('');

  // The state the wizard cannot fix on its own.
  const dangling = await User.find({ schoolId: { $ne: null }, deletedAt: null })
    .select('_id name email schoolId')
    .lean();

  const danglingLive = [];
  for (const user of dangling) {
    const alive = await School.exists({ _id: user.schoolId, deletedAt: null });
    if (!alive) danglingLive.push(user);
  }

  console.log('── Dangling references (archived schools) ────────────');
  console.log(`Accounts pointing at a soft-deleted school: ${danglingLive.length}`);
  danglingLive.slice(0, 20).forEach((u) => {
    console.log(`  ${u.email}  ->  schoolId ${u.schoolId}`);
  });
  if (danglingLive.length > 20) console.log(`  … and ${danglingLive.length - 20} more`);
  console.log('');

  // `onboardingCompleted` used to be a localStorage flag, so this combination
  // could exist in the database only after this change. Worth confirming it is
  // empty rather than assuming.
  const completedButUnlinked = await User.find({
    schoolId: null,
    role: { $ne: 'super_admin' },
    onboardingCompleted: true,
    deletedAt: null,
  })
    .select('_id name email')
    .lean();

  console.log('── Flag/school mismatches ───────────────────────────');
  console.log(`Marked complete but never linked: ${completedButUnlinked.length}`);
  completedButUnlinked.forEach((u) => console.log(`  ${u.email}`));
  console.log('');

  // How much of the discarded signup data survived on the new field.
  const withIntent = await User.countDocuments({
    schoolId: null,
    'schoolIntent.name': { $exists: true, $nin: ['', null] },
    deletedAt: null,
  });

  console.log('── Recoverable Step 1 prefill ───────────────────────');
  console.log(`Unlinked accounts carrying a school intent: ${withIntent} / ${unlinked}`);
  if (withIntent < unlinked) {
    console.log(
      '  The remainder predate the signup fix. Their school name was discarded by\n' +
      '  `stripUnknown` and only ever lived in the browser, so it cannot be\n' +
      '  recovered server-side — those bursars will retype it. Expected, not a bug.'
    );
  }
  console.log('');

  const pendingJoins = await SchoolJoinRequest.countDocuments({ status: 'pending' });
  console.log('── Join requests ─────────────────────────────────────');
  console.log(`Pending (awaiting a school admin): ${pendingJoins}`);
  console.log('');

  console.log('Done. No data was modified.');
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Audit failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
