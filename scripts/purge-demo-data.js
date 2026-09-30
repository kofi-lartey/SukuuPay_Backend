// ─────────────────────────────────────────────
// Purge demo / mock data
// ─────────────────────────────────────────────
//
//   node scripts/purge-demo-data.js           # report only, writes nothing
//   node scripts/purge-demo-data.js --apply   # delete
//
// Removes everything the seed and the mock fixtures left behind, and nothing
// else. The live school, its admin, and any account a real person registered are
// untouched — this script is the one place that decides what counts as demo, so
// the criteria are enumerated rather than pattern-matched.
//
//   school    Demo Primary School (SCH-DEMO-01) and everything hanging off it
//   users     the two seeded accounts and the three *.sukuupay.test / testuser
//             accounts. One of them, admin@example.com, is a super_admin with a
//             documented password and was a real login on this cluster.
//   ads       the two seeded creatives, which go live on /login, /signup and
//             /forgot-password with placeholder images and example.com links
//   counters  the student-id counter for the demo school code
//
// What is deliberately KEPT, and why:
//
//   Prampram Bole D/A + ko.filartey12@gmail.com — the real school and its admin.
//   The three unlinked kofi* accounts — they are not demo data. They are real
//     signups that never finished onboarding (two of them are obvious typos of
//     the third), and deleting someone's abandoned registration is not this
//     script's call. Unlinked accounts are cheap and re-provisioning one is the
//     normal onboarding path.
//
// A backup is required. `scripts/backup-demo-data.mjs` writes
// `demo-data-backup.json`; `scripts/restore-demo-data.mjs` puts it back. This
// script refuses to run --apply without one, because a delete on a live cluster
// with no undo is not a thing to be casual about.
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import { MONGODB_URI } from '../src/config/env.js';

const APPLY = process.argv.includes('--apply');
const BACKUP = path.resolve('demo-data-backup.json');

const SEED_EMAILS = ['admin@example.com', 'schooladmin@example.org'];
const TEST_EMAILS = [
  'admin@sukuupay.test',
  'schooladmin@sukuupay.test',
  'testuser184123@example.com',
];
const DEMO_SCHOOL_CODE = 'SCH-DEMO-01';
// The seeded creatives, matched on their placeholder link host rather than by
// name, so a re-seed that changed a headline is still caught.
const AD_PLACEHOLDER_LINK = /example\.com/;

if (APPLY && !fs.existsSync(BACKUP)) {
  console.error('Refusing to delete: no backup at', BACKUP);
  console.error('Run:  node scripts/backup-demo-data.mjs');
  process.exit(1);
}

const log = (...a) => console.log(...a);

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  const c = (n) => db.collection(n);

  const demoSchool = await c('schools').findOne({ schoolCode: DEMO_SCHOOL_CODE });
  if (!demoSchool) {
    log('No demo school found. Nothing to purge.');
    await mongoose.disconnect();
    return;
  }
  const demoId = demoSchool._id;

  const students = await c('students').find({ schoolId: demoId }).project({ _id: 1 }).toArray();
  const studentIds = students.map((s) => s._id);

  // Ordered children-before-parent, so nothing is ever orphaned mid-run.
  const steps = [
    ['payments', { $or: [{ schoolId: demoId }, { studentId: { $in: studentIds } }] }],
    ['paymentplans', { $or: [{ schoolId: demoId }, { studentId: { $in: studentIds } }] }],
    ['smsmessages', { schoolId: demoId }],
    ['students', { schoolId: demoId }],
    ['users', { email: { $in: [...SEED_EMAILS, ...TEST_EMAILS] } }],
    ['schoolads', { linkUrl: AD_PLACEHOLDER_LINK }],
    ['counters', { key: { $regex: DEMO_SCHOOL_CODE } }],
    ['schools', { _id: demoId }],
  ];

  // Anything else that still points at the demo school.
  const known = new Set(steps.map(([name]) => name));
  for (const { name } of await db.listCollections().toArray()) {
    if (known.has(name) || name.startsWith('probe_') || name === 'system.profile') continue;
    const n = await c(name).countDocuments({ schoolId: demoId });
    if (n) steps.push([name, { schoolId: demoId }]);
  }

  log(`\nTarget: ${demoSchool.name} [${DEMO_SCHOOL_CODE}]  ${demoId}`);
  log(`${students.length} students, and everything referencing them.\n`);

  let total = 0;
  const planned = [];
  for (const [name, query] of steps) {
    // eslint-disable-next-line no-await-in-loop
    const n = await c(name).countDocuments(query);
    total += n;
    planned.push([name, query, n]);
    log(`  ${String(n).padStart(5)}  ${name}`);
  }

  log(`\n${total} documents across ${planned.filter(([, , n]) => n).length} collections.`);

  if (!APPLY) {
    log('\nDRY RUN — nothing deleted.');
    log('Back up, then re-run with --apply:');
    log('  node scripts/backup-demo-data.mjs');
    log('  node scripts/purge-demo-data.js --apply');
    await mongoose.disconnect();
    return;
  }

  log('');
  for (const [name, query] of planned) {
    // eslint-disable-next-line no-await-in-loop
    const res = await c(name).deleteMany(query);
    log(`  deleted ${res.deletedCount}  ${name}`);
  }

  log('\n── After ──');
  const remainingSchools = await c('schools').find({}, { projection: { name: 1, schoolCode: 1, 'academic.classes': 1 } }).toArray();
  remainingSchools.forEach((s) =>
    log(`  school    ${s.name} [${s.schoolCode}] classes=${s.academic?.classes?.length ?? 0}`)
  );
  const remainingUsers = await c('users').find({}, { projection: { email: 1, role: 1, schoolId: 1 } }).toArray();
  remainingUsers.forEach((u) =>
    log(`  user      ${u.email}  role=${u.role}  school=${u.schoolId || 'none'}`)
  );
  log(`  students  ${await c('students').countDocuments({})}`);
  log(`  plans     ${await c('paymentplans').countDocuments({})}`);
  log(`  payments  ${await c('payments').countDocuments({})}`);
  log(`  ads       ${await c('schoolads').countDocuments({})}`);

  log('\nTo restore:  node scripts/restore-demo-data.mjs');
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Purge failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
