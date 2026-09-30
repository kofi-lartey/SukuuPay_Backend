// Backs up every record the demo purge is about to remove, so it can be restored.
// Writes only a JSON file. Touches no collection.
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import { MONGODB_URI } from '../src/config/env.js';

const OUT = path.resolve('demo-data-backup.json');

const SEED_EMAILS = ['admin@example.com', 'schooladmin@example.org'];
const TEST_EMAILS = ['admin@sukuupay.test', 'schooladmin@sukuupay.test', 'testuser184123@example.com'];
const DEMO_SCHOOL_CODE = 'SCH-DEMO-01';

await mongoose.connect(MONGODB_URI);
const db = mongoose.connection.db;

const demoSchool = await db.collection('schools').findOne({ schoolCode: DEMO_SCHOOL_CODE });
if (!demoSchool) {
  console.log('No demo school found. Nothing to back up.');
  await mongoose.disconnect();
  process.exit(0);
}
const demoId = demoSchool._id;

const backup = {
  takenAt: new Date().toISOString(),
  database: mongoose.connection.name,
  demoSchoolId: String(demoId),
  note: 'Restore with scripts/restore-demo-data.mjs. BSON-shaped values are stored as extended JSON.',
};

const dump = async (name, query, project) => {
  const docs = await db.collection(name).find(query, project ? { projection: project } : undefined).toArray();
  backup[name] = docs;
  console.log(`  ${String(docs.length).padStart(5)}  ${name}`);
  return docs.length;
};

console.log('Backing up:');
const students = await dump('students', { schoolId: demoId });
const studentIds = (await db.collection('students').find({ schoolId: demoId }).project({ _id: 1 }).toArray()).map((s) => s._id);

await dump('paymentplans', { $or: [{ schoolId: demoId }, { studentId: { $in: studentIds } }] });
await dump('payments', { $or: [{ schoolId: demoId }, { studentId: { $in: studentIds } }] });
await dump('smsmessages', { schoolId: demoId });
await dump('users', { email: { $in: [...SEED_EMAILS, ...TEST_EMAILS] } });
await dump('schools', { _id: demoId });
await dump('schoolads', { linkUrl: { $regex: 'example\\.com' } });
await dump('counters', { key: { $regex: 'SCH-DEMO-01' } });

// Any collection not enumerated above that still points at the demo school, so
// the backup stays complete even if a new dependent collection appears later.
const known = new Set(['students', 'paymentplans', 'payments', 'smsmessages', 'users', 'schools', 'schoolads', 'counters']);
backup.otherCollections = {};
for (const { name } of await db.listCollections().toArray()) {
  if (known.has(name) || name.startsWith('probe_') || name === 'system.profile') continue;
  const docs = await db.collection(name).find({ schoolId: demoId }).toArray();
  if (docs.length) {
    backup.otherCollections[name] = docs;
    console.log(`  ${String(docs.length).padStart(5)}  ${name} (unlisted dependent)`);
  }
}

fs.writeFileSync(OUT, JSON.stringify(backup, null, 2));
console.log(`\nWrote ${OUT}`);
console.log(`  ${students} students, ${fs.statSync(OUT).size} bytes`);
console.log('Restore: node scripts/restore-demo-data.mjs');
await mongoose.disconnect();
