// Verifies the seeded data against the real service functions — the same code
// the API calls — so "the cohort feature works" is a checked claim rather than
// an assumption.
//
//   node scripts/verify-seed.mjs
//
// Read-only. Nothing is written.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { School } from '../src/models/schoolModel.js';
import { User } from '../src/models/userModel.js';
import {
  getCohorts,
  getCohortDetail,
  getAlumni,
  getStudentStats,
  listStudents,
} from '../src/services/student.service.js';

dotenv.config({ quiet: true });
await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

const fail = [];
const expect = (name, condition, detail) => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) fail.push(name);
};

const school = await School.findOne({ schoolCode: 'SCH-DEMO-01' });
if (!school) {
  console.error('No seeded school. Run `npm run seed:apply` first.');
  process.exit(1);
}

// A real user document, so the services see the same shape they see in
// production — including `schoolId`, which is what the scope checks read.
const bursar = await User.findOne({ schoolId: school._id, role: 'school_admin' });

console.log(`\nschool: ${school.name} [${school.schoolCode}]`);
console.log(
  `classes: ${school.academic.classes.length}, final year: ${(school.academic.finalYearClasses || []).join(', ') || '(fallback: last 3)'}\n`
);

console.log('COHORTS');
const cohorts = await getCohorts({ schoolId: String(school._id), page: 1, limit: 20 }, bursar);
expect('cohorts are returned', cohorts.cohorts.length > 0, `${cohorts.cohorts.length} cohorts`);

cohorts.cohorts.forEach((c) => {
  console.log(
    `      ${c.name}  ${c.academicYear}  ${c.studentCount} students  ` +
      `(${c.graduatedCount} graduated, ${c.transferredCount} transferred, ${c.droppedCount} withdrew)`
  );
});

const totalInCohorts = cohorts.cohorts.reduce((n, c) => n + c.studentCount, 0);
const graduatedTotal = cohorts.cohorts.reduce((n, c) => n + c.graduatedCount, 0);
expect(
  'every cohort member is accounted for',
  totalInCohorts === graduatedTotal + cohorts.cohorts.reduce((n, c) => n + c.transferredCount + c.droppedCount, 0),
  `${totalInCohorts} = ${graduatedTotal} + transferred + withdrew`
);
expect('transferred and withdrew counts are not always zero', cohorts.cohorts.some((c) => c.transferredCount > 0 || c.droppedCount > 0));
expect('honors are recorded', cohorts.cohorts.some((c) => c.honorsBreakdown && Object.values(c.honorsBreakdown).some((v) => v > 0)));

console.log('\nCOHORT DETAIL');
const target = cohorts.cohorts[0];
// `id`, not `_id`: the list formats it as `cohort_2026`, which is what the detail
// route's validator accepts. `_id` here is the raw graduationYear.
const detail = await getCohortDetail(target.id, { schoolId: String(school._id), page: 1, limit: 50 }, bursar);
expect('detail opens for a cohort', Boolean(detail?.cohort), `${target.id}`);
expect(
  'detail count matches the list',
  detail.cohort.statistics.totalStudents === target.studentCount,
  `list said ${target.studentCount}, detail says ${detail.cohort.statistics.totalStudents}`
);
expect('detail lists students', detail.students.length > 0, `${detail.students.length} rows`);
expect(
  'final-year classes carry real counts',
  detail.cohort.classes.every((c) => typeof c.studentCount === 'number'),
  detail.cohort.classes.map((c) => `${c.name}:${c.studentCount}`).join(' ')
);
console.log(
  `      honors: ${JSON.stringify(detail.cohort.statistics.honorsBreakdown)}`
);

console.log('\nALUMNI');
const alumni = await getAlumni(
  { schoolId: String(school._id), page: 1, limit: 10, honors: 'HONORS' },
  bursar
);
expect('honors filter returns rows', alumni.alumni.length > 0, `${alumni.alumni.length} with HONORS`);
expect(
  'every returned alumnus is a real graduate',
  alumni.alumni.every((a) => a.status === 'graduated' && a.isAlumni),
  ''
);
expect(
  'certificate numbers are stored',
  alumni.alumni.every((a) => Boolean(a.certificateNumber)),
  alumni.alumni[0] ? alumni.alumni[0].certificateNumber : ''
);

console.log('\nROSTER');
const stats = await getStudentStats({ status: 'active' }, bursar);
expect('roster stats computed', stats.totalRoster > 0, `${stats.totalRoster} active, ${stats.fullyCleared} cleared, ${stats.overdueStudents} overdue`);

const list = await listStudents({ status: 'active', perPage: 5, sortBy: 'balance', sortOrder: 'desc' }, bursar);
expect('roster paginates', list.data.length === 5, `page 1 of ${list.meta.totalPages} (${list.meta.total} total)`);
expect(
  'balances are real, not all zero',
  list.data.some((s) => s.balance > 0),
  `top balance ${(list.data[0]?.balance / 100).toFixed(2)}`
);

const overdue = await listStudents({ status: 'active', feeStatus: 'overdue', perPage: 50 }, bursar);
expect(
  'every row the overdue filter returns really is overdue',
  overdue.data.every((s) => s.balance > 0 && new Date(s.deadline) < new Date()),
  `${overdue.data.length} rows`
);

const cleared = await listStudents({ status: 'active', feeStatus: 'cleared', perPage: 50 }, bursar);
expect(
  'every row the cleared filter returns has no balance',
  cleared.data.every((s) => (s.balance || 0) <= 0),
  `${cleared.data.length} rows`
);

console.log('\nDATA INTEGRITY');
const { Student: StudentModel } = await import('../src/models/studentModel.js');

const mismatched = await StudentModel.countDocuments({
  $expr: {
    $ne: [
      '$balance',
      { $subtract: [{ $ifNull: ['$totalOwed', 0] }, { $ifNull: ['$totalPaid', 0] }] },
    ],
  },
});
expect(
  'every balance equals totalOwed - totalPaid',
  mismatched === 0,
  `${mismatched} mismatched`
);

const payLinkLess = await StudentModel.countDocuments({ balance: { $exists: false } });
expect('no student is missing a balance', payLinkLess === 0);

const noToken = await StudentModel.countDocuments({ uniquePayLinkToken: null });
expect('every student has a pay-link token', noToken === 0, `${noToken} without`);

const noGuardian = await StudentModel.countDocuments({ parents: { $size: 0 } });
expect('every student has a guardian', noGuardian === 0, `${noGuardian} without`);

// The index the seed repairs. A stale `sparse: true` version is the difference
// between "one plan may lack an acceptance code" and "every plan may".
const planIndexes = await mongoose.connection.db.collection('paymentplans').indexes();
const tokenIndex = planIndexes.find((i) => i.name === 'acceptanceToken_1');
expect(
  'acceptanceToken index is partial, not sparse',
  Boolean(tokenIndex?.partialFilterExpression),
  tokenIndex ? JSON.stringify(tokenIndex.partialFilterExpression || { sparse: tokenIndex.sparse }) : 'missing'
);

await mongoose.disconnect();

console.log(`\n${fail.length ? `${fail.length} FAILED: ${fail.join(', ')}` : 'all checks passed'}`);
process.exit(fail.length ? 1 : 0);
