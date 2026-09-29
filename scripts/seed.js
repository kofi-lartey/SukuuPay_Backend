// ─────────────────────────────────────────────
// Seed script for the testing phase
// ─────────────────────────────────────────────
// DRY RUN BY DEFAULT. Nothing is written unless you pass --apply.
//
//   node scripts/seed.js            # validate + show the plan, write nothing
//   node scripts/seed.js --apply    # write
//   node scripts/seed.js --apply --reset   # wipe seeded rows first, then write
//
// Idempotent: every record is keyed on a stable natural key, so re-running
// --apply updates in place rather than duplicating. That matters because a
// second run must never hand a tester two schools with the same schoolCode, or
// two students colliding on the (schoolId, studentId) unique index.
//
// Produces the minimum coherent set needed to exercise a payment end to end:
//   super_admin -> school (with SMS + a student) -> student with a parent and a
//   pay-link token -> accepted payment plan -> a settled payment.
//
// The pay-link token is the point of the exercise. Parent-facing routes
// (/pay/:token/*) authenticate on it, so the printed token is what a tester
// pastes into the browser.
//
// Passwords are fixed, documented, and dev-only. They exist so a tester can log
// in; they are not secrets and must never reach production.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { School } from '../src/models/schoolModel.js';
import { Student } from '../src/models/studentModel.js';
import { User } from '../src/models/userModel.js';
import { PaymentPlan } from '../src/models/paymentPlanModel.js';
import { Payment } from '../src/models/paymentModel.js';
import { generateStudentId, resolveAcademicYearStart } from '../src/utils/generateStudentId.js';

dotenv.config({ quiet: true });

const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');

// ── Dev-only credentials. Fixed on purpose so a tester can log in.
// ── Not secrets, and must never reach production.
//
// Domains are under example.com/example.org, which IANA reserves for
// documentation, for two reasons: no real domain can be squatted from this file,
// and — less obviously — the `example` TLD is in Joi's allowlist. The
// `.test`/`.local` TLDs that read as more obviously fake are rejected by
// authValidators.loginSchema as invalid emails, so a seed using them produces
// users who exist in the database but can never log in (422 at the login route).
// That was a real bug in the first version of this script.
const SEED_USERS = [
  {
    key: 'superadmin',
    name: 'Dev Super Admin',
    email: 'admin@example.com',
    phone: '233200000001',
    password: 'SeedAdmin123!',
    role: 'super_admin',
    schoolId: null,
  },
  {
    key: 'schooladmin',
    name: 'Dev School Admin',
    email: 'schooladmin@example.org',
    phone: '233200000002',
    password: 'SeedSchool123!',
    role: 'school_admin',
    schoolId: '@school',
  },
];

const SEED_SCHOOL = {
  key: 'SCH-DEMO-01',
  name: 'Demo Primary School',
  slug: 'demo-primary-school',
  schoolCode: 'SCH-DEMO-01',
  type: 'private',
  phone: '233302000001',
  email: 'office@example.net',
  address: '12 Test Street, Osu',
  city: 'Accra',
  region: 'Greater Accra',
  // Arkesel is the platform default, so it is repeated here explicitly to make
  // the seed self-documenting about which gateway the school uses.
  sms: { provider: 'arke', senderId: 'SukuuPay', balance: 1000 },
  // Hubtel creds stay null: MTN is the primary gateway and is platform-level, so
  // a school without Hubtel creds is a valid, expected configuration — and the
  // MTN-primary path is the one under test.
  payment: { hubtelClientId: null, hubtelClientSecret: null, hubtelApiKey: null },
};

// A real Ghanaian-format MSISDN in E.164. MTN sandbox treats specific numbers
// differently (some auto-approve a prompt, some time out), so the first live
// test may need a different number — this one is for local flow testing.
const SEED_STUDENT = {
  key: 'STU-DEMO-01',
  studentName: 'Kwabena Mensah',
  studentClass: 'Class 3',
  gender: 'male',
  totalOwed: 50000, // GHS 500.00, in pesewas
  totalPaid: 10000, // GHS 100.00 already settled
  deadlineDays: 45,
  parents: [
    {
      parentName: 'Ama Mensah',
      relationship: 'mother',
      phone: '233244123456',
      email: 'ama.mensah@example.com',
      isPrimary: true,
    },
  ],
  emergencyContacts: [
    { contactName: 'Kojo Mensah', relationship: 'uncle', phone: '233205555001' },
  ],
};

const SEED_PLAN = {
  key: 'PLAN-DEMO-01',
  planName: 'Termly Installment Plan',
  totalAmount: 50000, // GHS 500.00
  // The model caps this at 6 and requires >= 2.
  numberOfInstallments: 5,
  intervalDays: 30,
  startDateDays: 0,
};

const log = (...a) => console.log(...a);
const step = (n, msg) => log(`\n[${n}] ${msg}`);

// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// Dry run = real work, then rollback
// ─────────────────────────────────────────────
// The dry run executes every upsert for real inside a transaction and then
// aborts it. That is deliberate, and it is why this is safer than skipping the
// writes: a skip-based dry run never runs the pre-save hooks, the validators or
// the unique indexes, so it cannot tell you whether the seed would actually
// succeed. This way a dry run that prints a plan has also proven the plan works.
//
// It requires the deployment to be a replica set or sharded cluster. The Atlas
// URI here is a sharded cluster, so transactions are available; on a standalone
// mongod this would fail loudly rather than silently writing.

/**
 * Upserts a user.
 *
 * Deliberately uses findOne + save rather than findOneAndUpdate.
 *
 * The password hash is produced by a `pre('save')` hook (userModel.js:160), and
 * mongoose does not fire save hooks for query updates. An earlier version of this
 * script used `findOneAndUpdate` with the plaintext password in `$set`, which
 * stored the password verbatim — anyone reading the users collection saw
 * `SeedAdmin123!` in the clear, and `comparePassword` returned false so the
 * seeded accounts could not log in at all.
 *
 * find-then-save runs the hook, so the password is hashed exactly as it would be
 * through the signup route. It costs one extra round trip and is the only correct
 * way to seed credentials.
 */
const upsertUser = async (spec, schoolId, session) => {
  const existing = await User.findOne({ email: spec.email }).session(session);

  // Field names follow userModel exactly: `name` (not fullName) and `status`
  // (not isActive) — the schema enum is active|invited|suspended|deactivated, and
  // an unrecognised value fails validation rather than being ignored.
  const fields = {
    name: spec.name,
    phone: spec.phone,
    role: spec.role,
    schoolId,
    // A seeded account has no mailbox to verify against, so it is marked
    // verified and active. A user left at the `invited` default cannot log in.
    status: 'active',
    isEmailVerified: true,
    // Always set, so a changed SEED_USERS password takes effect on re-run.
    password: spec.password,
  };

  if (existing) {
    existing.set(fields);
    await existing.save({ session });
    return existing;
  }

  const [doc] = await User.create([{ ...fields, email: spec.email }], { session });
  return doc;
};

const upsertSchool = async (spec, session) => {
  const { key, ...fields } = spec;
  return School.findOneAndUpdate(
    { schoolCode: key },
    { $set: fields },
    { upsert: true, new: true, setDefaultsOnInsert: true, session }
  );
};

const upsertStudent = async (spec, schoolId, schoolCode, createdBy, session) => {
  const { key, deadlineDays, ...fields } = spec;

  const existing = await Student.findOne({ studentName: fields.studentName, schoolId }).session(session);
  if (existing) {
    // Updated in place rather than replaced. Replacing would mint a new
    // uniquePayLinkToken, invalidating any link a tester has already bookmarked
    // or pasted into a browser.
    existing.set({
      ...fields,
      deadline: new Date(Date.now() + deadlineDays * 86400000),
      academicYear: String(new Date().getFullYear()),
    });
    await existing.save({ session });
    return existing;
  }

  // studentId is generated here rather than left to the model's pre-save hook.
  //
  // The hook works by reading the school back from the database to get its
  // schoolCode. Inside a transaction that read is issued without the session, so
  // it does not see the school this same transaction just created and fails with
  // "school code is missing". Generating the id from the code we already hold
  // avoids the round trip and behaves identically in a dry run and in --apply.
  const year = resolveAcademicYearStart(String(new Date().getFullYear()));
  const studentId = await generateStudentId(schoolCode, year);

  // create() rather than an upsert, so the pay-link token pre-save hook runs.
  // An updateOne upsert would bypass `save` and leave the token null, leaving the
  // parent-facing routes unusable.
  const [doc] = await Student.create(
    [
      {
        ...fields,
        studentId,
        schoolId,
        createdBy,
        deadline: new Date(Date.now() + deadlineDays * 86400000),
        academicYear: String(new Date().getFullYear()),
      },
    ],
    { session }
  );
  return doc;
};

const upsertPlan = async (spec, student, createdBy, session) => {
  const { key, startDateDays, totalAmount, numberOfInstallments, intervalDays, planName } = spec;
  const start = new Date(Date.now() + startDateDays * 86400000);

  // The remainder from an uneven split is added to the first installment, not
  // dropped. With floor() on every installment, 50000/3 loses 1 pesewa and the
  // installments would no longer sum to totalAmount — a discrepancy that would
  // surface later as a balance that never reaches zero.
  const base = Math.floor(totalAmount / numberOfInstallments);
  const remainder = totalAmount - base * numberOfInstallments;

  const installments = Array.from({ length: numberOfInstallments }, (_, i) => {
    const due = new Date(start);
    due.setDate(due.getDate() + i * intervalDays);
    return {
      installmentNumber: i + 1,
      amount: base + (i === 0 ? remainder : 0),
      dueDate: due,
      status: 'pending',
    };
  });

  // endDate is the due date of the last installment and is required.
  const endDate = installments[installments.length - 1].dueDate;

  const existing = await PaymentPlan.findOne({ studentId: student._id, planName }).session(session);
  if (existing) {
    // Left in place rather than rebuilt: a plan that has already been paid
    // against must not have its schedule reset by a re-run of the seed.
    return existing;
  }

  const [doc] = await PaymentPlan.create(
    [
      {
        studentId: student._id,
        schoolId: student.schoolId,
        planName,
        totalAmount,
        numberOfInstallments,
        interval: 'monthly',
        installments,
        startDate: start,
        endDate,
        planStatus: 'active',
        createdBy,
      },
    ],
    { session }
  );
  return doc;
};

/**
 * One settled payment, so the balance arithmetic and the audit trail have
 * something real to reconcile against.
 *
 * `settlement.appliedAt` is set by hand because the claim is taken by the
 * provider callback in normal operation; here there is no provider to call back.
 * Setting it keeps a later duplicate webhook a no-op instead of a second credit.
 */
const upsertPayment = async (student, plan, createdBy, session) => {
  const paymentId = 'PAY-SEED-0001';
  const existing = await Payment.findOne({ paymentId }).session(session);
  if (existing) return existing;

  const [doc] = await Payment.create(
    [
      {
        paymentId,
        studentId: student._id,
        schoolId: student.schoolId,
        parentId: null,
        paymentPlanId: plan._id,
        amount: 10000,
        currency: 'GHS',
        status: 'completed',
        paymentMethod: 'momo',
        provider: 'mtn',
        momoPhoneNumber: student.parents[0].phone,
        momoNetwork: 'MTN',
        description: 'Seeded settled payment (no live provider call)',
        receiptNumber: 'RCP-SEED-0001',
        receiptGeneratedAt: new Date(),
        initiatedAt: new Date(),
        completedAt: new Date(),
        settlement: { appliedAt: new Date(), reference: 'SEED-FT-0001' },
        mtnReferenceId: 'SEED-MTN-REF-0001',
        mtnFinancialTransactionId: 'SEED-FT-0001',
        createdBy,
      },
    ],
    { session }
  );
  return doc;
};

const run = async () => {
  if (!APPLY) {
    log('================================================================');
    log(' DRY RUN — every write below executes, then is ROLLED BACK.');
    log(' This validates hooks, validators and indexes without persisting.');
    log(' Re-run with --apply to commit, or --apply --reset to wipe first.');
    log('================================================================');
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  log(`connected: ${mongoose.connection.name}`);

  // A session scopes every write. On a dry run it is aborted at the end, so the
  // database is left exactly as it was found.
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    if (RESET && APPLY) {
      step('reset', 'removing previously seeded rows');
      await Payment.deleteMany({ paymentId: { $in: SEED_PAYMENT_IDS } }).session(session);
      await PaymentPlan.deleteMany({ planName: SEED_PLAN.planName }).session(session);
      await Student.deleteMany({ studentName: SEED_STUDENT.studentName }).session(session);
      await School.deleteMany({ schoolCode: SEED_SCHOOL.schoolCode }).session(session);
      await User.deleteMany({ email: { $in: SEED_USERS.map((u) => u.email) } }).session(session);
      log('  removed seeded payments, plans, students, schools, users');
    }

    step('1/5', 'super admin');
    const admin = await upsertUser(SEED_USERS[0], null, session);
    log(`  super_admin  ${admin.email}`);

    step('2/5', 'school');
    const school = await upsertSchool(SEED_SCHOOL, session);
    log(`  school       ${school.name}  [${school.schoolCode}]  sms=${school.sms?.provider}`);

    step('3/5', 'school admin (scoped to the school)');
    const schoolAdmin = await upsertUser(SEED_USERS[1], school._id, session);
    log(`  school_admin ${schoolAdmin.email}  schoolId=${schoolAdmin.schoolId}`);

    step('4/5', 'student + pay link');
    const student = await upsertStudent(SEED_STUDENT, school._id, school.schoolCode, admin._id, session);
    log(`  student      ${student.studentName}  [${student.studentId}]  ${student.studentClass}`);
    log(`  parent       ${student.parents[0].parentName}  ${student.parents[0].phone}`);
    log(`  owed         GHS ${(student.totalOwed / 100).toFixed(2)}`);
    log(`  paid         GHS ${(student.totalPaid / 100).toFixed(2)}`);
    log(`  balance      GHS ${(student.balance / 100).toFixed(2)}  (recomputed by the model hook)`);

    step('5/5', 'payment plan + settled payment');
    const plan = await upsertPlan(SEED_PLAN, student, admin._id, session);
    const sum = plan.installments.reduce((t, i) => t + i.amount, 0);
    log(`  plan         ${plan.planName}  ${plan.numberOfInstallments} installments`);
    log(`  per month    GHS ${(plan.installments[0].amount / 100).toFixed(2)}`);
    log(`  schedule sum GHS ${(sum / 100).toFixed(2)}  (must equal total GHS ${(plan.totalAmount / 100).toFixed(2)})`);
    if (sum !== plan.totalAmount) {
      throw new Error(`installment sum ${sum} != totalAmount ${plan.totalAmount}`);
    }
    const payment = await upsertPayment(student, plan, admin._id, session);
    log(`  payment      ${payment.paymentId}  GHS ${(payment.amount / 100).toFixed(2)}  ${payment.status}`);

    // ── Report ──
    log('\n================================================================');
    log(APPLY ? ' SEEDED — committing' : ' DRY RUN — validated, rolling back');
    log('================================================================');

    if (APPLY) {
      log('\nLog in with (dev-only, change before any public use):');
      for (const u of SEED_USERS) {
        log(`  ${u.role.padEnd(12)} ${u.email.padEnd(28)} ${u.password}`);
      }
    }

    log('\nParent-facing URLs (no login needed):');
    log(`  view balance   /pay/${student.uniquePayLinkToken}`);
    log(`  initiate       POST /pay/${student.uniquePayLinkToken}/initiate`);
    log(`  verify         POST /pay/${student.uniquePayLinkToken}/verify`);
    log(`  plan activate  POST /api/payment-plans/${plan._id}/accept?phoneNumber=${student.parents[0].phone}`);

    if (APPLY) {
      await session.commitTransaction();
      log('\ncounts after commit:');
      for (const [label, model, q] of [
        ['users', User, { email: { $in: SEED_USERS.map((u) => u.email) } }],
        ['schools', School, { schoolCode: SEED_SCHOOL.schoolCode }],
        ['students', Student, { _id: student._id }],
        ['paymentplans', PaymentPlan, { _id: plan._id }],
        ['payments', Payment, { paymentId: 'PAY-SEED-0001' }],
      ]) {
        log(`  ${label.padEnd(12)} ${await model.countDocuments(q)}`);
      }
      log('\nTo start testing:  npm run dev');
    } else {
      await session.abortTransaction();
      log('\nNothing was persisted. Re-run with --apply to commit.');
    }
  } catch (error) {
    await session.abortTransaction().catch(() => {});
    throw error;
  } finally {
    await session.endSession().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }
};

const SEED_PAYMENT_IDS = ['PAY-SEED-0001'];

run().catch((e) => {
  console.error('\nSEED FAILED:', e.message);
  if (e.errors) {
    for (const [path, err] of Object.entries(e.errors)) {
      console.error(`  ${path}: ${err.message}`);
    }
  }
  process.exit(1);
});
