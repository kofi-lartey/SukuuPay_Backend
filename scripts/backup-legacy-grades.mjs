/**
 * Backs up the grade rows that still hold a retired assessment type, so the
 * migration that folds them onto the terminal report's two columns can be
 * undone.
 *
 *   node scripts/backup-legacy-grades.mjs
 *
 * The migration *deletes* the rows it folds, which is the only irreversible
 * part of it. A backup of them is what makes the change a decision rather than
 * a one-way door: if the averaged class score is not what a school wanted, the
 * original marks are still on disk.
 *
 * Writes one JSON file and touches no collection. The rows are stored as
 * extended JSON, so the restore puts back the exact values — including the
 * dates and the approval trail.
 */
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";
import { MONGODB_URI } from "../src/config/env.js";

const OUT = path.resolve("legacy-grades-backup.json");

/** The retired vocabulary, and what each value becomes. */
const LEGACY_TYPES = ["class_test", "quiz", "assignment", "exam"];

if (!MONGODB_URI) {
  console.error("MONGODB_URI is not set. Nothing to do.");
  process.exit(1);
}

await mongoose.connect(MONGODB_URI);
console.log(`Connected to ${mongoose.connection.name}.`);

const docs = await mongoose.connection.db
  .collection("grades")
  .find({ assessmentType: { $in: LEGACY_TYPES }, deletedAt: null })
  .toArray();

if (!docs.length) {
  console.log("No grades hold a retired assessment type. Nothing to back up.");
  await mongoose.disconnect();
  process.exit(0);
}

const backup = {
  takenAt: new Date().toISOString(),
  database: mongoose.connection.name,
  collection: "grades",
  note:
    "Restore with scripts/restore-legacy-grades.mjs. BSON-shaped values are stored as extended JSON.",
  grades: docs,
};

fs.writeFileSync(OUT, JSON.stringify(backup, null, 2));

const byType = docs.reduce((counts, doc) => {
  counts[doc.assessmentType] = (counts[doc.assessmentType] || 0) + 1;
  return counts;
}, {});

console.log(`\nBacked up ${docs.length} legacy grade row(s): ${JSON.stringify(byType)}`);
console.log(`  ${OUT}`);
console.log(`  ${fs.statSync(OUT).size} bytes`);
console.log("Restore: node scripts/restore-legacy-grades.mjs");

await mongoose.disconnect();
