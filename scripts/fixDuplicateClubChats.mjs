// Collapses duplicate "Club Chat" threads, keeping the one with the messages.
//
//   node scripts/fixDuplicateClubChats.mjs            dry run — reports, changes nothing
//   node scripts/fixDuplicateClubChats.mjs --apply    applies it
//
// ## Why duplicates exist
//
// `useClubChat` does a get-or-create: list the club's posts, and if there is no
// "Club Chat" thread, create one. That is not atomic. Two mounts in the same
// second — React's double-invoked effect in development, or a second tab — both
// observe "no thread" and both create one. The result is two Club Chat posts for
// one club, and whichever the client picks first is the one it reads, so the
// thread with the messages renders as empty.
//
// ## What this keeps
//
// The thread with the most live comments, not the oldest. The oldest is the
// arbitrary loser of the race and is exactly the one that ends up empty. The
// others are soft-deleted (`isDeleted: true`), never removed, so a mistaken run
// is reversible with a single field.
//
// Comments are not moved. Every duplicate here was empty when it was created;
// if a future run finds messages on more than one, it reports that and leaves
// them alone rather than guessing at a merge.
import mongoose from 'mongoose';
import { MONGODB_URI } from '../src/config/env.js';

const APPLY = process.argv.includes('--apply');
const TITLE = 'Club Chat';

await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;

const posts = await db
  .collection('communityposts')
  .find({ postType: 'discussion', title: TITLE, isDeleted: false })
  .toArray();

console.log(`\nDuplicate Club Chat threads — ${MONGODB_URI.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@')}`);
console.log(APPLY ? 'mode: APPLY\n' : 'mode: dry run (pass --apply to write)\n');

const byClub = new Map();
for (const post of posts) {
  const key = String(post.clubId);
  if (!byClub.has(key)) byClub.set(key, []);
  byClub.get(key).push(post);
}

let toDelete = 0;
let skipped = 0;

for (const [clubId, group] of byClub) {
  if (group.length < 2) continue;

  // How many live comments each thread holds.
  const withCounts = [];
  for (const post of group) {
    // eslint-disable-next-line no-await-in-loop
    const comments = await db
      .collection('communitycomments')
      .countDocuments({ postId: post._id, isDeleted: false });
    withCounts.push({ post, comments });
  }

  withCounts.sort((a, b) => b.comments - a.comments);
  const [keeper, ...rest] = withCounts;

  console.log(`club ${clubId}: ${group.length} threads`);
  console.log(`  keep   ${String(keeper.post._id)} (${keeper.comments} comments)`);

  const losers = rest.filter((entry) => entry.comments > 0);
  if (losers.length > 0) {
    skipped += 1;
    console.log(
      `  ! ${losers.length} other thread(s) also hold comments — leaving them alone rather than merging`
    );
    continue;
  }

  for (const entry of rest) {
    console.log(`  delete ${String(entry.post._id)} (${entry.comments} comments)`);
    toDelete += 1;
    if (APPLY) {
      // eslint-disable-next-line no-await-in-loop
      await db
        .collection('communityposts')
        .updateOne({ _id: entry.post._id }, { $set: { isDeleted: true } });
    }
  }
}

if (skipped > 0) {
  console.log(`\n${skipped} club(s) need a manual look — not changed`);
}

if (toDelete === 0) {
  console.log('No duplicates to remove.');
} else if (!APPLY) {
  console.log(`\nDry run: ${toDelete} thread(s) would be soft-deleted`);
} else {
  console.log(`\nSoft-deleted ${toDelete} thread(s)`);
}

await mongoose.disconnect();