// Restores whatever scripts/purge-demo-data.js removed.
//
//   node scripts/restore-demo-data.mjs --dry-run   # report only
//   node scripts/restore-demo-data.mjs --apply     # re-insert
//
// Reads demo-data-backup.json. Inserts are upserts keyed on the original _id, so
// running it twice is harmless and it will not clobber a live document that
// happens to share an id.
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import { MONGODB_URI } from '../src/config/env.js';

const APPLY = process.argv.includes('--apply');
const BACKUP = path.resolve('demo-data-backup.json');

if (!fs.existsSync(BACKUP)) {
  console.error('No backup at', BACKUP);
  console.error('Create one with:  node scripts/backup-demo-data.mjs');
  process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
const log = (...a) => console.log(...a);

log(`Backup taken ${backup.takenAt} from ${backup.database}`);
log(`Demo school was ${backup.demoSchoolId}\n`);

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  const groups = [];
  // Parents first so a child never references a document that is not there yet.
  for (const name of ['schools', 'users', 'schoolads', 'counters', 'students', 'paymentplans', 'payments', 'smsmessages']) {
    if (backup[name]?.length) groups.push([name, backup[name]]);
  }
  for (const [name, docs] of Object.entries(backup.otherCollections || {})) {
    if (docs.length) groups.push([name, docs]);
  }

  let total = 0;
  for (const [name, docs] of groups) {
    total += docs.length;
    log(`  ${String(docs.length).padStart(5)}  ${name}`);
  }
  log(`\n${total} documents across ${groups.length} collections.`);

  if (!APPLY) {
    log('\nDRY RUN — nothing written. Re-run with --apply to restore.');
    await mongoose.disconnect();
    return;
  }

  log('');
  for (const [name, docs] of groups) {
    const ops = docs.map((doc) => ({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true,
      },
    }));
    // eslint-disable-next-line no-await-in-loop
    const res = await db.collection(name).bulkWrite(ops, { ordered: false });
    log(
      `  ${name}: upserted ${res.upsertedCount}, replaced ${res.modifiedCount}, ` +
        `matched ${res.matchedCount}`
    );
  }
  log('\nRestored.');
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Restore failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
