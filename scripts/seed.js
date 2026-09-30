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
import { SchoolAd } from '../src/models/SchoolAd.js';
import { generateStudentId, resolveAcademicYearStart, syncStudentIdCounter } from '../src/utils/generateStudentId.js';
import { buildDemoRoster, CLASSES, FINAL_YEAR_CLASSES } from './lib/demoRoster.js';
import { generatePayLinkToken, buildPayLink } from '../src/utils/generatePayLink.js';
import { generateAcceptanceToken } from '../src/utils/planHelpers.js';

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
  sms: { provider: 'arke', senderId: 'SukuuPay', balance: 1420 },
  // Hubtel creds stay null: MTN is the primary gateway and is platform-level, so
  // a school without Hubtel creds is a valid, expected configuration — and the
  // MTN-primary path is the one under test.
  payment: { hubtelClientId: null, hubtelClientSecret: null, hubtelApiKey: null },
  /**
   * A real class list, which the seeded school previously had none of.
   *
   * Two features are dead without it. The roster's class filter is populated
   * from `academic.classes`, so it was empty; and `graduateStudent` refuses
   * anyone outside the final-year classes, so with an empty list nothing could
   * ever graduate — which meant there was no way to produce a cohort, and the
   * Cohorts tab could only ever show its empty state.
   *
   * `finalYearClasses` is named rather than inferred. The fallback is "the last
   * three classes on the list", and this school's list ends `JHS 1, JHS 2, JHS 3`
   * — so a JHS 1 student would have passed the final-year guard meant to stop
   * exactly that. A basic-and-JHS school does not finish anyone in JHS 1, so it
   * says so.
   */
  academic: {
    currentTerm: 'Term 1',
    currentYear: `${new Date().getFullYear()}/${new Date().getFullYear() + 1}`,
    termsPerYear: 3,
    classes: CLASSES,
    finalYearClasses: FINAL_YEAR_CLASSES,
    gradingSystem: 'WAEC',
  },
};

/**
 * The term the active roster is in.
 *
 * Derived from the date rather than hardcoded, so the fixture is not a snapshot
 * of the month it was written: a Ghanaian school year runs September to July, so
 * a seed run in Term 2 or over the long vacation should still produce a current
 * roster rather than one dated in the wrong term.
 */
const CURRENT_TERM = (() => {
  const month = new Date().getMonth(); // 0 = January
  if (month >= 8) return 'Term 1'; // September–November
  if (month >= 0 && month <= 2) return 'Term 2'; // January–March
  if (month >= 3 && month <= 5) return 'Term 3'; // April–June
  return 'Term 3'; // July–August, long vacation
})();

const CURRENT_ACADEMIC_YEAR = (() => {
  const year = new Date().getFullYear();
  // The year rolls in September, which is where the Ghanaian school year starts.
  const start = new Date().getMonth() >= 8 ? year : year - 1;
  return `${start}/${start + 1}`;
})();

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

// ─────────────────────────────────────────────
// AUTH-ASIDE ADVERTISEMENTS
// ─────────────────────────────────────────────
// The login/signup/recovery asides show a rotating band of school creatives, so
// the seed supplies two live ads; without them the band falls back to the
// metrics row and the carousel is never exercised on a fresh database.
//
// Seeded as `approved` and dated far enough ahead to stay live. The public
// endpoint only serves approved ads inside their date window, so a `pending`
// seed would render an empty band and look like a bug.
//
// The images are external placeholder services rather than real creatives: the
// upload path writes to Cloudinary, and a seed should not depend on a live
// Cloudinary account or leave assets behind in the bucket. Both fields are
// https, which the client re-checks before rendering them into an href/alt.
const SEED_ADS = [
  {
    key: 'Greenfield Academy',
    schoolName: 'Greenfield Academy',
    headline: 'Admissions open for 2026',
    imageUrl: 'https://picsum.photos/seed/sukuupay-greenfield/960/540',
    imageAlt: 'Greenfield Academy senior school campus building',
    linkUrl: 'https://example.com/greenfield/apply',
    placement: 'auth_aside',
    sortWeight: 10,
  },
  {
    key: 'Tamale Senior High',
    schoolName: 'Tamale Senior High',
    headline: 'Now accepting BECE entrants',
    imageUrl: 'https://picsum.photos/seed/sukuupay-tamale/960/540',
    imageAlt: 'Students walking through the grounds of Tamale Senior High',
    linkUrl: 'https://example.com/tamale/apply',
    placement: 'auth_aside',
    sortWeight: 5,
  },
];

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

const upsertAd = async (spec, approvedBy, session) => {
  const { key, ...fields } = spec;

  const existing = await SchoolAd.findOne({ schoolName: key }).session(session);
  if (existing) {
    existing.set({
      ...fields,
      status: 'approved',
      approvedBy,
      approvedAt: new Date(),
      deletedAt: null,
      // Pushed out on every run so a seed written months ago is still live.
      endsAt: new Date(Date.now() + 365 * 86400000),
    });
    await existing.save({ session });
    return existing;
  }

  return SchoolAd.create({
    ...fields,
    status: 'approved',
    approvedBy,
    approvedAt: new Date(),
    endsAt: new Date(Date.now() + 365 * 86400000),
    session,
  });
};

/**
 * Writes the bulk demo roster in one `insertMany`.
 *
 * Keyed on the fixture's own deterministic `studentId`s, and matched against
 * what is already there first. Two properties follow:
 *
 * - **Idempotent.** A second `--apply` finds every row by id and updates it in
 *   place, so a tester cannot end up with two JHS 3 cohorts because the seed was
 *   run twice.
 * - **No N round trips.** 278 students at one `find` each is a script that takes
 *   a minute on a laptop; one query for the whole set and one insert is seconds.
 *
 * `create()` is used rather than `insertMany` for the new rows so the pre-save
 * hooks run — they generate the pay-link token and recompute `balance` from
 * `totalOwed - totalPaid`. `insertMany` does fire those hooks, so it is safe, but
 * the tokens are what the parent-facing routes authenticate on and a missing one
 * makes the whole fixture look broken.
 *
 * The 8xxx/7xxx id ranges are above anything the counter reaches alone, so after
 * the fixture lands the counters are raised with `syncStudentIdCounter` — see
 * `run()` — or the next live create would mint `…-0001` and collide.
 */
const upsertDemoStudents = async (specs, schoolId, createdBy, session) => {
  const ids = specs.map((s) => s.studentId);
  const existing = await Student.find({ studentId: { $in: ids } }).session(session);
  const byId = new Map(existing.map((s) => [s.studentId, s]));

  let updated = 0;
  const inserts = [];

  specs.forEach((spec) => {
    const { _feeState, ...fields } = spec;
    const found = byId.get(fields.studentId);

    // `classHistory[].by` is required by the schema, and the fixture does not
    // know the admin's id. Stamping it here attributes every seeded class move to
    // the school admin, which is honest: the admin is who is loading this roster.
    //
    // It also matters for a second reason. `insertMany` **drops documents that
    // fail schema validation without throwing**, so a missing `by` wrote 61 of
    // 278 students and reported success. The completeness check below is what
    // turns that silent partial write into a loud failure.
    const withActor = {
      ...fields,
      classHistory: (fields.classHistory || []).map((entry) => ({
        ...entry,
        by: entry.by || createdBy,
      })),
    };

    // Each student needs their own pay-link token. `uniquePayLinkToken` carries a
    // unique index, and the *model* does not generate it — `createStudent` does,
    // which is why a bulk write without this fails with E11000 on 278 `null`
    // tokens. Minting one here also means every seeded student's parent-facing
    // URL actually works, rather than a row that exists but cannot be paid.
    //
    // An existing row keeps the token it already has: reissuing would invalidate
    // any `/pay/:token` link a tester has already bookmarked or pasted into a
    // browser, and the update path has no reason to break one.
    const token = generatePayLinkToken();

    if (found) {
      found.set({ ...withActor, schoolId, updatedBy: createdBy });
      updated += 1;
    } else {
      inserts.push({
        ...withActor,
        schoolId,
        createdBy,
        updatedBy: createdBy,
        uniquePayLinkToken: token,
        payLink: buildPayLink(token),
      });
    }
  });

  if (updated > 0) {
    // Saved one at a time rather than with `bulkWrite`, because `bulkWrite` does
    // not run `save` hooks and would leave `balance` and the pay-link token
    // unset on every updated row.
    for (const doc of existing) {
      // eslint-disable-next-line no-await-in-loop
      await doc.save({ session });
    }
  }

  const createdDocs = inserts.length
    ? await Student.insertMany(inserts, { session, ordered: false })
    : [];

  // Returned keyed by `studentId` so callers can attach plans and payments to a
  // real document. The fixture's own student specs are plain objects with no
  // `_id`, so referencing them directly produced plans with
  // `studentId: undefined` and a validation failure on a required path.
  const byStudentId = new Map(existing.map((s) => [s.studentId, s]));
  createdDocs.forEach((s) => byStudentId.set(s.studentId, s));

  return { created: createdDocs.length, updated, byStudentId };
};

const upsertDemoPlan = async (spec, schoolId, createdBy, session) => {
  const existing = await PaymentPlan.findOne({ planName: spec.planName, 'meta': spec._ref })
    .session(session);

  const fields = {
    studentId: spec.student._id,
    schoolId,
    planName: spec.planName,
    totalAmount: spec.totalAmount,
    numberOfInstallments: spec.numberOfInstallments,
    interval: spec.interval,
    startDate: spec.startDate,
    endDate: spec.endDate,
    planStatus: spec.planStatus,
    installments: spec.installments,
    // A real 6-char acceptance code, so the parent-facing "reply to accept"
    // flow is exercisable against seeded data instead of only against plans a
    // tester created by hand.
    acceptanceToken: spec.acceptanceToken || (await generateAcceptanceToken()),
    createdBy,
  };

  if (existing) {
    existing.set(fields);
    await existing.save({ session });
    return { plan: existing, created: false };
  }
  // `meta.seedRef` marks the plan as fixture-owned, so a `--reset` can remove
  // exactly these without touching a plan a tester created by hand.
  const plan = await PaymentPlan.create([{ ...fields, meta: { seedRef: spec._ref } }], { session });
  return { plan: plan[0], created: true };
};

const upsertDemoPayment = async (spec, schoolId, createdBy, session) => {
  const existing = await Payment.findOne({ paymentId: spec._ref }).session(session);
  if (existing) return false;

  await Payment.create(
    [
      {
        paymentId: spec._ref,
        studentId: spec.student._id,
        schoolId,
        paymentPlanId: spec.plan?._id || null,
        amount: spec.amount,
        currency: 'GHS',
        status: 'completed',
        paymentMethod: 'momo',
        provider: 'mtn',
        momoPhoneNumber: spec.student.parents?.[0]?.phone || null,
        momoNetwork: spec.network,
        description: 'Seeded installment settlement (no live provider call)',
        receiptNumber: `RCP-${spec._ref}`,
        receiptGeneratedAt: spec.at,
        initiatedAt: spec.at,
        completedAt: spec.at,
        settlement: { appliedAt: spec.at, reference: `SEED-FT-${spec._ref}` },
        mtnReferenceId: `SEED-MTN-${spec._ref}`,
        mtnFinancialTransactionId: `SEED-FT-${spec._ref}`,
        createdBy,
      },
    ],
    { session }
  );
  return true;
};

/**
 * Repairs the `acceptanceToken` unique index where the database disagrees with
 * the schema.
 *
 * The schema declares:
 *   { acceptanceToken: 1 }, { unique: true, partialFilterExpression: { acceptanceToken: { $type: 'string' } } }
 *
 * Databases created before that change have the older `{ unique: true, sparse: true }`.
 * **`sparse` does not work here.** A sparse index omits documents where the field
 * is absent — but `acceptanceToken` is declared `default: null`, so Mongoose writes
 * the field explicitly. The field is present, the index entry exists, and every
 * null collides with every other null. The observable result is that a school can
 * have exactly **one** plan without an acceptance code: the second insert fails
 * with E11000 on `acceptanceToken: null`.
 *
 * That is a live data bug, not a seed artefact — it is merely where it was
 * noticed. Mongoose will not alter an existing index, so the migration has to
 * drop and recreate it explicitly.
 *
 * Done narrowly and reported, rather than via `syncIndexes()`: that would drop any
 * index the schema does not declare, which is not this script's decision to make.
 */
const reconcileAcceptanceTokenIndex = async (log) => {
  const collection = mongoose.connection.db.collection('paymentplans');
  let existing;
  try {
    existing = await collection.indexes();
  } catch {
    return 'collection does not exist yet';
  }

  const index = existing.find((i) => i.name === 'acceptanceToken_1');
  if (!index) return 'not present';
  if (index.partialFilterExpression) return 'already a partial index — no change needed';

  log(`    found        sparse: ${index.sparse === true}, partial: ${false}`);
  await collection.dropIndex('acceptanceToken_1');
  await collection.createIndex(
    { acceptanceToken: 1 },
    { unique: true, partialFilterExpression: { acceptanceToken: { $type: 'string' } } }
  );
  return 'dropped the sparse index and created the partial one';
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

  // ── Before the transaction, and only on --apply ──
  //
  // `dropIndex` and `createIndex` are DDL, and MongoDB refuses DDL inside a
  // transaction: the first attempt aborted the whole seed with "Transaction with
  // { txnNumber: 1 } has been aborted" at the very first index call.
  //
  // A dry run therefore cannot exercise it and does not attempt it — the
  // alternative would be to commit a schema change while claiming nothing was
  // written. It is reported as skipped so the dry-run output does not imply the
  // index is already correct.
  if (APPLY) {
    step('index', 'reconciling the acceptanceToken index');
    log(`  acceptanceToken_1  ${await reconcileAcceptanceTokenIndex(log)}`);
  } else {
    log('\n[index]  acceptanceToken_1  skipped — index changes cannot run in a transaction,');
    log('         so this is only done with --apply.');
  }

  // A session scopes every write. On a dry run it is aborted at the end, so the
  // database is left exactly as it was found.
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    if (RESET && APPLY) {
      step('reset', 'removing previously seeded rows');
      // The bulk fixture is removed by its id shape, not by name: the demo
      // studentIds are `<schoolCode>-<year>-7xxx|8xxx`, which is a stable marker
      // for "the seed owns this row" and survives the names changing.
      const ownId = { $regex: `^${SEED_SCHOOL.schoolCode}-\\d{4}-[78]\\d{3}$` };
      const doomed = await Student.find({ studentId: ownId }).select('_id').session(session);
      const doomedIds = doomed.map((s) => s._id);

      // By explicit `_id`, not by the same regex the find used.
      //
      // With a regex delete, the subsequent `Student.find` in
      // `upsertDemoStudents` still returned all 278 rows, so the run reported
      // "0 created, 278 updated in place" against documents it had just removed.
      // The update then went through the pre-save hook on rows whose write did not
      // land the same way, and 231 students were left with `balance: 0` against a
      // non-zero `totalOwed - totalPaid` — which the roster's fee badges, its
      // "Fully Cleared" tile and its overdue filter all read.
      const deleted = doomedIds.length
        ? (await Student.deleteMany({ _id: { $in: doomedIds } }).session(session)).deletedCount
        : 0;

      const survivors = doomedIds.length
        ? await Student.countDocuments({ _id: { $in: doomedIds } }).session(session)
        : 0;
      if (survivors > 0) {
        throw new Error(
          `reset did not clear the fixture: ${survivors} of ${doomedIds.length} students survived the delete`
        );
      }

      await Payment.deleteMany({ studentId: { $in: doomedIds } }).session(session);
      await PaymentPlan.deleteMany({ studentId: { $in: doomedIds } }).session(session);
      await Payment.deleteMany({ paymentId: { $in: SEED_PAYMENT_IDS } }).session(session);
      await SchoolAd.deleteMany({ schoolName: { $in: SEED_ADS.map((a) => a.key) } }).session(session);
      await PaymentPlan.deleteMany({ planName: SEED_PLAN.planName }).session(session);
      await Student.deleteMany({ studentName: SEED_STUDENT.studentName }).session(session);
      await School.deleteMany({ schoolCode: SEED_SCHOOL.schoolCode }).session(session);
      await User.deleteMany({ email: { $in: SEED_USERS.map((u) => u.email) } }).session(session);
      log(`  removed ${deleted} fixture students and everything hanging off them`);
      log('  removed seeded payments, ads, plans, students, schools, users');
    }

    step('1/11', 'super admin');
    const admin = await upsertUser(SEED_USERS[0], null, session);
    log(`  super_admin  ${admin.email}`);

    step('2/11', 'school');
    const school = await upsertSchool(SEED_SCHOOL, session);
    log(`  school       ${school.name}  [${school.schoolCode}]  sms=${school.sms?.provider}`);

    step('3/11', 'school admin (scoped to the school)');
    const schoolAdmin = await upsertUser(SEED_USERS[1], school._id, session);
    log(`  school_admin ${schoolAdmin.email}  schoolId=${schoolAdmin.schoolId}`);

    step('4/11', 'student + pay link');
    const student = await upsertStudent(SEED_STUDENT, school._id, school.schoolCode, admin._id, session);
    log(`  student      ${student.studentName}  [${student.studentId}]  ${student.studentClass}`);
    log(`  parent       ${student.parents[0].parentName}  ${student.parents[0].phone}`);
    log(`  owed         GHS ${(student.totalOwed / 100).toFixed(2)}`);
    log(`  paid         GHS ${(student.totalPaid / 100).toFixed(2)}`);
    log(`  balance      GHS ${(student.balance / 100).toFixed(2)}  (recomputed by the model hook)`);

    step('5/11', 'payment plan + settled payment');
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

    step('6/11', 'auth-aside advertisements');
    const ads = [];
    for (const spec of SEED_ADS) {
      const ad = await upsertAd(spec, admin._id, session);
      ads.push(ad);
      log(`  ad           ${ad.schoolName}  "${ad.headline}"  [${ad.status}]`);
    }
    log(`  carousel     ${ads.length} live ads on placement=auth_aside (visible on /login, /signup, /forgot-password)`);

    // ─────────────────────────────────────────────
    // The cohort fixture
    // ─────────────────────────────────────────────
    // Everything above seeds one student, which is enough for a payment but not
    // enough for a cohort: `getCohorts` matches on students who graduated, so a
    // database seeded only by the above can never show a cohort at all.
    const demo = buildDemoRoster({
      schoolCode: school.schoolCode,
      academicYear: CURRENT_ACADEMIC_YEAR,
    });

    const allSpecs = [
      ...demo.cohorts.flatMap((c) => c.students),
      ...demo.active,
    ];

    step('7/11', `demo roster — ${allSpecs.length} students`);
    const { created, updated, byStudentId } = await upsertDemoStudents(
      allSpecs,
      school._id,
      schoolAdmin._id,
      session
    );
    log(`  written      ${created} created, ${updated} updated in place`);
    log(`  classes      ${CLASSES.length} (Nursery 1 … JHS 3), final year: ${FINAL_YEAR_CLASSES.join(', ')}`);

    // The count is asserted rather than printed, because this exact failure was
    // silent: `insertMany` returned and stored fewer documents than it was given
    // without throwing, so a log line is not enough to notice a partial write.
    if (byStudentId.size !== allSpecs.length) {
      throw new Error(
        `fixture write is incomplete: ${byStudentId.size} of ${allSpecs.length} students are addressable. ` +
          'Check the unique indexes — uniquePayLinkToken and studentId must both be populated per row.'
      );
    }

    demo.cohorts.forEach((c) => {
      const by = (status) => c.students.filter((s) => s.status === status).length;
      const honors = {};
      c.students.forEach((s) => {
        if (s.honors) honors[s.honors] = (honors[s.honors] || 0) + 1;
      });
      log(
        `  cohort ${c.year}   ${c.students.length} students — ${by('graduated')} graduated, ` +
          `${by('transferred_out')} transferred, ${by('dropped') || by('removed')} withdrew` +
          `  | honors ${Object.entries(honors).map(([k, v]) => `${k}:${v}`).join(' ')}`
      );
    });

    step('8/11', 'active roster fee states');
    const states = {};
    demo.active.forEach((s) => {
      states[s._feeState] = (states[s._feeState] || 0) + 1;
    });
    log(`  term         ${CURRENT_TERM}, ${CURRENT_ACADEMIC_YEAR}`);
    Object.entries(states).forEach(([state, n]) => log(`  ${state.padEnd(12)} ${n}`));
    log('  (cleared → Paid badge; owing → Due Soon; overdue → Overdue red; suspended → off the default filter)');

    step('9/11', `installment plans — ${demo.plans.length}`);
    const seededPlans = [];
    for (const spec of demo.plans) {
      // The document, not the fixture spec — the spec has no `_id`, and a plan
      // pointing at one fails validation on a required path.
      const student = byStudentId.get(spec.student.studentId);
      if (!student) {
        throw new Error(`plan ${spec._ref}: no student for ${spec.student.studentId}`);
      }
      // eslint-disable-next-line no-await-in-loop
      const { plan } = await upsertDemoPlan({ ...spec, student }, school._id, schoolAdmin._id, session);
      seededPlans.push({ ...spec, student, _id: plan._id, plan });
      const sum = plan.installments.reduce((t, i) => t + i.amount, 0);
      if (sum !== plan.totalAmount) {
        throw new Error(`plan ${spec._ref}: installments sum to ${sum}, expected ${plan.totalAmount}`);
      }
    }
    const planStates = {};
    seededPlans.forEach((p) => {
      planStates[p.plan.planStatus] = (planStates[p.plan.planStatus] || 0) + 1;
    });
    log(`  schedules    every plan's installments sum exactly to its totalAmount`);
    Object.entries(planStates).forEach(([k, v]) => log(`  ${k.padEnd(12)} ${v}`));

    step('10/11', `settled payments — ${demo.payments.length}`);
    let paidCount = 0;
    for (const spec of demo.payments) {
      const parent = seededPlans.find((p) => p._ref === spec.plan._ref);
      const student = byStudentId.get(spec.student.studentId);
      // eslint-disable-next-line no-await-in-loop
      const inserted = await upsertDemoPayment(
        { ...spec, student, plan: parent?.plan },
        school._id,
        schoolAdmin._id,
        session
      );
      if (inserted) paidCount += 1;
    }
    log(`  written      ${paidCount} (the rest already existed from a previous run)`);
    const networkMix = {};
    demo.payments.forEach((p) => {
      networkMix[p.network] = (networkMix[p.network] || 0) + 1;
    });
    Object.entries(networkMix).forEach(([k, v]) => log(`  ${k.padEnd(12)} ${v}`));

    step('11/11', 'raising the id counters above the fixture ranges');
    // The fixture assigns explicit ids in the 7xxx/8xxx range so a re-run is
    // idempotent. Left alone, the counter — which allocates from 1 — would hand
    // the next live create `…-0001` and collide with nothing yet, then walk up
    // into the fixture range. Raising it here means the next student a school
    // adds gets a number above the seeded ones.
    // The fixture reports the years it touched. Parsing them back out of the
    // studentIds does not work: a school code is free text and commonly contains
    // hyphens, so `SCH-DEMO-01-2026-8001`.split('-')[1] is `DEMO`.
    for (const year of demo.years) {
      // eslint-disable-next-line no-await-in-loop
      const highest = await syncStudentIdCounter(school.schoolCode, year, session);
      log(`  ${year}          counter raised to ${highest} — the next student gets ${highest + 1}`);
    }

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
        ['schoolads', SchoolAd, { schoolName: { $in: SEED_ADS.map((a) => a.key) } }],
        ['students (fixture)', Student, { schoolId: school._id }],
        ['graduated', Student, { schoolId: school._id, status: 'graduated' }],
        ['cohort years', Student, {
          schoolId: school._id,
          graduationYear: { $ne: null },
        }],
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
