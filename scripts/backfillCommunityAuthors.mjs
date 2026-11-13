// Fills `authorName` and `authorModel` on existing community posts and comments.
//
//   node scripts/backfillCommunityAuthors.mjs            dry run — reports, changes nothing
//   node scripts/backfillCommunityAuthors.mjs --apply    applies it
//
// ## Why
//
// Every community post and comment written by a student rendered as "Unknown".
// Two independent faults produced that:
//
//   1. `createPost`/`createComment` snapshotted `user?.name`, but the student
//      principal built by `middleware/authenticate.js` had no `name` — the
//      `Student` collection stores `studentName`/`firstName`. Staff rows were
//      fine, which is why only students showed "Unknown".
//   2. `authorId` was declared `ref: "User"` on both collections, so populating
//      a student author queried `users` with a `students` `_id`. Even with a
//      name on the principal, the read path could not recover one.
//
// Both are fixed at the source. This brings the rows already in the database
// into line — without it the fix appears not to work, because every post written
// before the deploy keeps rendering "Unknown" forever.
//
// ## Safety
//
// Dry run by default. Only `authorName` and `authorModel` are written; the
// author's id, the post body and the school are never touched, so a wrong guess
// here cannot move a post between schools or reattribute it to another person —
// it can only set a display name to the value the author's own record holds.
import mongoose from 'mongoose';
import { MONGODB_URI } from '../src/config/env.js';

const APPLY = process.argv.includes('--apply');

const COLLECTIONS = [
  { name: 'communityposts', label: 'posts' },
  { name: 'communitycomments', label: 'comments' },
];

/** The name to snapshot for a principal, matching `utils/communityAuthor.js`. */
const displayName = (doc) => {
  if (!doc) return null;
  return doc.firstName || doc.name || doc.studentName || null;
};

await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;

console.log(`\nCommunity author backfill — ${MONGODB_URI.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@')}`);
console.log(APPLY ? 'mode: APPLY\n' : 'mode: dry run (pass --apply to write)\n');

for (const { name, label } of COLLECTIONS) {
  const collection = db.collection(name);

  // A row needs work if it has no display name, or if `authorModel` is missing
  // or wrong for its role — the latter is what makes `authorId` populatable.
  const rows = await collection
    .find({
      $or: [
        { authorName: { $in: [null, ''] } },
        { authorModel: { $exists: false } },
        { authorModel: null },
      ],
    })
    .project({ authorId: 1, authorRole: 1, authorName: 1, authorModel: 1 })
    .toArray();

  console.log(`${label}: ${rows.length} row(s) need attention`);

  if (rows.length === 0) continue;

  // Resolve every referenced author in two queries rather than one per row.
  const studentIds = [
    ...new Set(rows.filter((r) => r.authorRole === 'student').map((r) => String(r.authorId))),
  ];
  const userIds = [
    ...new Set(rows.filter((r) => r.authorRole !== 'student').map((r) => String(r.authorId))),
  ];

  const toMap = (docs) => new Map(docs.map((d) => [String(d._id), d]));

  const [students, users] = await Promise.all([
    studentIds.length
      ? db.collection('students').find({ _id: { $in: studentIds.map((id) => new mongoose.Types.ObjectId(id)) } }).toArray()
      : Promise.resolve([]),
    userIds.length
      ? db.collection('users').find({ _id: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } }).toArray()
      : Promise.resolve([]),
  ]);

  const studentMap = toMap(students);
  const userMap = toMap(users);

  const updates = [];
  let unresolved = 0;

  for (const row of rows) {
    const isStudent = row.authorRole === 'student';
    const author = isStudent ? studentMap.get(String(row.authorId)) : userMap.get(String(row.authorId));
    const authorModel = isStudent ? 'Student' : 'User';
    const name = displayName(author);

    if (!name) {
      unresolved += 1;
      console.log(`  ! ${String(row._id)} — no ${authorModel} found for ${row.authorId}, left alone`);
      continue;
    }

    const changes = {};
    if (row.authorName !== name) changes.authorName = name;
    if (row.authorModel !== authorModel) changes.authorModel = authorModel;

    if (Object.keys(changes).length === 0) continue;

    console.log(
      `  ${String(row._id)} — authorName ${JSON.stringify(row.authorName)} -> ${JSON.stringify(name)}` +
        `, authorModel ${JSON.stringify(row.authorModel ?? null)} -> ${JSON.stringify(authorModel)}`
    );

    updates.push({ updateOne: { filter: { _id: row._id }, update: { $set: changes } } });
  }

  if (unresolved > 0) {
    console.log(`  ${unresolved} row(s) could not be resolved and were skipped`);
  }

  if (!APPLY) {
    console.log(`  dry run: ${updates.length} update(s) would be written\n`);
    continue;
  }

  if (updates.length === 0) {
    console.log('  nothing to write\n');
    continue;
  }

  const result = await collection.bulkWrite(updates, { ordered: false });
  console.log(`  wrote ${result.modifiedCount} of ${updates.length} update(s)\n`);
}

await mongoose.disconnect();