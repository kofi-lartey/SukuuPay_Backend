// Backfills `Club.createdBy`, the field the creator-only edit rule reads.
//
//   node scripts/backfillClubCreatedBy.mjs            dry run — reports, writes nothing
//   node scripts/backfillClubCreatedBy.mjs --apply    applies it
//
// ## Why this is needed
//
// `Club.createdBy` was declared on the schema but never written by `createClub`,
// so every club created before that was fixed has `createdBy: null`. The
// creator-only rule in `club.service.js` fails closed on `null`, which means
// without this run those clubs are editable by nobody — including their actual
// creator. That is the correct fail-safe, not the desired end state.
//
// ## Why it will not guess
//
// A club with several moderators has several plausible owners, and picking the
// first would silently hand edit rights to an arbitrary person. Those are left
// `null` and reported. Clauses with exactly one moderator are unambiguous and
// are adopted.
//
// Idempotent: it only touches documents where `createdBy` is null or missing, so
// a second run is a no-op.
import mongoose from 'mongoose';
import { MONGODB_URI } from '../src/config/env.js';

const APPLY = process.argv.includes('--apply');

await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;

const clubs = await db
  .collection('clubs')
  .find({ isDeleted: false, $or: [{ createdBy: null }, { createdBy: { $exists: false } }] })
  .toArray();

console.log(`\nClub createdBy backfill — ${MONGODB_URI.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@')}`);
console.log(APPLY ? 'mode: APPLY\n' : 'mode: dry run (pass --apply to write)\n');
console.log(`${clubs.length} club(s) without an owner\n`);

let adopted = 0;
const ambiguous = [];
const ownerless = [];

for (const club of clubs) {
  const moderators = Array.isArray(club.moderatorIds) ? club.moderatorIds : [];

  if (moderators.length === 1) {
    adopted += 1;
    console.log(`adopt  ${String(club._id)} "${club.name}" -> moderator ${String(moderators[0])}`);
    if (APPLY) {
      // eslint-disable-next-line no-await-in-loop
      await db
        .collection('clubs')
        .updateOne({ _id: club._id }, { $set: { createdBy: moderators[0] } });
    }
    continue;
  }

  if (moderators.length === 0) {
    ownerless.push(club);
    console.log(`skip   ${String(club._id)} "${club.name}" — no moderators, no candidate owner`);
    continue;
  }

  ambiguous.push(club);
  console.log(
    `skip   ${String(club._id)} "${club.name}" — ${moderators.length} moderators, cannot choose an owner`
  );
}

console.log('');
if (ambiguous.length > 0) {
  console.log(`${ambiguous.length} club(s) have several moderators and need a manual decision:`);
  for (const club of ambiguous) {
    console.log(`  ${String(club._id)} "${club.name}" -> [${club.moderatorIds.map(String).join(', ')}]`);
  }
  console.log('');
}
if (ownerless.length > 0) {
  console.log(`${ownerless.length} club(s) have no moderators and no candidate owner:`);
  for (const club of ownerless) {
    console.log(`  ${String(club._id)} "${club.name}"`);
  }
  console.log('');
}

if (adopted === 0) {
  console.log('Nothing to adopt.');
} else if (!APPLY) {
  console.log(`Dry run: ${adopted} club(s) would be assigned an owner`);
} else {
  console.log(`Assigned an owner to ${adopted} club(s)`);
}

const unowned = ambiguous.length + ownerless.length;
if (unowned > 0) {
  console.log(
    `\n${unowned} club(s) remain ownerless and are therefore editable by nobody under the creator-only rule.`
  );
}

await mongoose.disconnect();