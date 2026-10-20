// Recomputes `student.balance` from `totalOwed` and `totalPaid`.
//
//   npm run balances:check          dry run — reports, changes nothing
//   node scripts/backfillStudentBalances.mjs --apply   applies it
//
// ## Why
//
// `student.balance` is what the parent portal renders as the amount owed, what
// `initiatePayment` validates a payment amount against, and what the school's
// arrears report sums.
//
// The Student model has a `pre("save")` hook that recomputes it — but
// `findByIdAndUpdate` does not run that hook, and the payment settlement path
// used `findByIdAndUpdate`. The balance was therefore only ever written back
// when it went *negative*, so on an ordinary settled payment it was computed
// and discarded. Every student who had paid was still shown the full amount
// outstanding.
//
// The settlement path is fixed. This brings the existing records into line
// with the rule the model has always stated: `balance = totalOwed - totalPaid`,
// floored at zero.
//
// ## Safety
//
// Dry run by default. It prints every student it would change, and the change
// is a single field recomputed from two fields on the same document — it
// cannot invent or lose money, because `totalPaid` is not touched.
import mongoose from 'mongoose';
import { MONGODB_URI } from '../src/config/env.js';

const APPLY = process.argv.includes('--apply');

await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;
const students = db.collection('students');

const stale = await students
  .find({
    deletedAt: null,
    $expr: { $ne: [{ $ifNull: ['$balance', 0] }, { $max: [0, { $subtract: [{ $ifNull: ['$totalOwed', 0] }, { $ifNull: ['$totalPaid', 0] }] }] }] },
  })
  .project({ studentName: 1, totalOwed: 1, totalPaid: 1, balance: 1, schoolId: 1 })
  .toArray();

const total = await students.countDocuments({ deletedAt: null });

console.log(`\nStudent balances — ${MONGODB_URI.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@')}`);
console.log(`${stale.length} of ${total} students have a stale balance\n`);

for (const student of stale.slice(0, 40)) {
  const expected = Math.max(0, (student.totalOwed || 0) - (student.totalPaid || 0));
  console.log(
    `  ${String(student.studentName).slice(0, 28).padEnd(30)} owed ${String(student.totalOwed ?? 0).padStart(7)}` +
      `  paid ${String(student.totalPaid ?? 0).padStart(7)}` +
      `  balance ${String(student.balance ?? 0).padStart(7)} -> ${String(expected).padStart(7)}`
  );
}
if (stale.length > 40) console.log(`  … and ${stale.length - 40} more`);

if (!APPLY) {
  console.log('\nDry run — nothing was changed. Re-run with --apply to fix them.\n');
} else {
  let changed = 0;
  for (const student of stale) {
    const expected = Math.max(0, (student.totalOwed || 0) - (student.totalPaid || 0));
    const result = await students.updateOne(
      { _id: student._id },
      { $set: { balance: expected, updatedAt: new Date() } }
    );
    changed += result.modifiedCount;
  }
  console.log(`\nApplied — ${changed} balance(s) recomputed.\n`);
}

await mongoose.disconnect();
