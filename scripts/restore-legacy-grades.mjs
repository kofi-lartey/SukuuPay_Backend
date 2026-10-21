/**
 * Puts back the grade rows a migration folded away.
 *
 *   node scripts/restore-legacy-grades.mjs [--apply]
 *
 * The counterpart to `backup-legacy-grades.mjs`. It re-inserts the rows in
 * `legacy-grades-backup.json` with their original ids, so the grade book is
 * byte-for-byte what it was before `migrate-grades-to-class-exam.mjs` ran.
 *
 * Dry-run by default: it reports what it *would* put back and what is already
 * there. `--apply` writes. A row whose id is already present is left alone
 * rather than overwritten, so restoring twice cannot destroy a mark that has
 * since been corrected.
 */
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";
import { MONGODB_URI } from "../src/config/env.js";

const APPLY = process.argv.includes("--apply");
const IN = path.resolve("legacy-grades-backup.json");

if (!MONGODB_URI) {
  console.error("MONGODB_URI is not set. Nothing to do.");
  process.exit(1);
}

if (!fs.existsSync(IN)) {
  console.error(`No backup at ${IN}. Run scripts/backup-legacy-grades.mjs first.`);
  process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(IN, "utf8"));
const docs = backup.grades || [];

await mongoose.connect(MONGODB_URI);
console.log(
  `Connected to ${mongoose.connection.name}. ${
    APPLY ? "Restoring." : "Dry run — pass --apply to write."
  }\n`
);

const collection = mongoose.connection.db.collection(backup.collection || "grades");

let alreadyThere = 0;
const toInsert = [];
for (const doc of docs) {
  const existing = await collection.findOne({ _id: doc._id });
  if (existing) {
    alreadyThere += 1;
    continue;
  }
  toInsert.push(doc);
}

console.log(`  ${docs.length} row(s) in the backup`);
console.log(`  ${alreadyThere} already in the database — left alone`);
console.log(`  ${toInsert.length} to put back`);

if (APPLY && toInsert.length) {
  const result = await collection.insertMany(toInsert, { ordered: false });
  console.log(`\nRestored ${result.insertedCount} row(s).`);
} else if (APPLY) {
  console.log("\nNothing to restore.");
} else {
  console.log("\nNothing was written. Pass --apply to restore.");
}

await mongoose.disconnect();
