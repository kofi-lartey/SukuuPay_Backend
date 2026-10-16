// ─────────────────────────────────────────────
// Fix stale onboardingCompleted for join-flow users
// ─────────────────────────────────────────────
//
//   npm run fix:onboarding-completed
//
// Sets `onboardingCompleted: true` on every teacher, accountant, and viewer
// who is already linked to a live school but whose flag is still false.
//
// The flag was only ever set to `true` for the platform owner
// (`boot/ensureSuperAdmin.js`).  The join-flow approval path
// (`school.service.js:decideJoinRequest`) and the invitation path
// (`userController.js:inviteUser`) did not write it, so any account that
// joined a school through either route carries `onboardingCompleted: false`
// even after being linked.  On a backend that lacks the SCHOOL_JOIN_ROLES
// branch in `onboardingBlock`, that stale flag routes them through onboarding
// again on every login.
//
// This script is idempotent: re-running it finds zero candidates the second
// time.  It only touches non-deleted users who have a non-null schoolId
// pointing at a non-deleted school, so it will never mark a pending or
// dangling account as complete.
//
// Usage:
//   MONGODB_URI=... node scripts/fix-onboarding-completed.js
//
import mongoose from 'mongoose';
import { User } from '../src/models/userModel.js';
import { School } from '../src/models/schoolModel.js';
import { SCHOOL_JOIN_ROLES } from '../src/config/constants.js';
import { MONGODB_URI } from '../src/config/env.js';

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Nothing to do.');
  process.exit(1);
}

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected.\n');

  const candidates = await User.find({
    role: { $in: SCHOOL_JOIN_ROLES },
    schoolId: { $ne: null },
    onboardingCompleted: false,
    deletedAt: null,
  })
    .select('_id name email role schoolId')
    .lean();

  if (candidates.length === 0) {
    console.log('No stale records found. Nothing to update.');
    await mongoose.disconnect();
    return;
  }

  console.log(`── Found ${candidates.length} stale record(s) ──`);

  let fixed = 0;
  let skippedDangling = [];

  for (const user of candidates) {
    const alive = await School.exists({ _id: user.schoolId, deletedAt: null });
    if (!alive) {
      skippedDangling.push(user);
      console.log(`  SKIP  ${user.email}  role=${user.role}  schoolId=${user.schoolId} (school is deleted)`);
      continue;
    }

    await User.updateOne(
      { _id: user._id },
      { $set: { onboardingCompleted: true } }
    );
    fixed++;
    console.log(`  FIX   ${user.email}  role=${user.role}  schoolId=${user.schoolId}`);
  }

  console.log(`\n── Summary ──`);
  console.log(`Fixed:          ${fixed}`);
  console.log(`Skipped (dangling): ${skippedDangling.length}`);
  console.log(`Total:          ${candidates.length}`);

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Migration failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
