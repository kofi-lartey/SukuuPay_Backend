// The Moolre callback, end to end, against a real database.
//
//   node scripts/moolreCallbackE2E.mjs
//
// The unit tests prove the handler makes the right *decisions*. This proves
// the whole chain — HTTP POST → route → validation → controller → service →
// model → settlement — actually moves a student's balance.
//
// It creates its own school and student, so nothing that belongs to a real
// school is touched, and it removes everything it created on the way out.
//
// The database is the one in `.env`. If that is a shared or production
// cluster, that is why the test builds its own school rather than borrowing
// one: a test that mutates a real student's balance is not a test.
import mongoose from 'mongoose';
import { MONGODB_URI, MOOLRE_CALLBACK_SECRET } from '../src/config/env.js';

const TAG = 'zz-moolre-e2e';
const AMOUNT_PESEWAS = 2500; // GH¢ 25.00
const TOTAL_OWED = 10000; // GH¢ 100.00

const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

let schoolId = null;
let studentId = null;
let paymentId = null;

const cleanup = async () => {
  console.log('\n── Cleaning up ───────────────────────────────────────────────────\n');
  try {
    if (paymentId) {
      await mongoose.connection.db.collection('payments').deleteMany({ _id: paymentId });
      console.log('  removed the test payment');
    }
    if (studentId) {
      await mongoose.connection.db.collection('students').deleteMany({ _id: studentId });
      console.log('  removed the test student');
    }
    if (schoolId) {
      await mongoose.connection.db.collection('schools').deleteMany({ _id: schoolId });
      console.log('  removed the test school');
    }
    await mongoose.connection.db
      .collection('platformledgers')
      .deleteMany({ description: { $regex: TAG } });
    console.log('  removed any test ledger rows');
  } catch (error) {
    console.log('  cleanup failed:', error.message);
  }
};

try {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;

  // ── 1. Fixtures ───────────────────────────────────────────────────────
  console.log('\n── 1. Fixtures ───────────────────────────────────────────────────\n');

  const school = await db.collection('schools').insertOne({
    name: `Moolre E2E ${TAG}`,
    slug: `moolre-e2e-${Date.now().toString(36)}`,
    type: 'private',
    phone: '0300000000',
    email: 'e2e@moolre.invalid',
    address: 'Test Address',
    city: 'Accra',
    ghanaRegion: 'Greater Accra',
    status: 'active',
    payment: { gatewayMode: 'moolre' },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  schoolId = school.insertedId;

  const student = await db.collection('students').insertOne({
    studentName: `Moolre E2E Student ${TAG}`,
    schoolId,
    className: 'Test Class',
    status: 'active',
    totalOwed: TOTAL_OWED,
    totalPaid: 0,
    balance: TOTAL_OWED,
    parentName: 'E2E Parent',
    parentPhone: '0557655008',
    parentRelationship: 'Father',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  studentId = student.insertedId;

  const payment = await db.collection('payments').insertOne({
    studentId,
    schoolId,
    amount: AMOUNT_PESEWAS,
    currency: 'GHS',
    status: 'processing',
    paymentMethod: 'momo',
    provider: 'moolre',
    momoPhoneNumber: '0557655008',
    momoNetwork: 'VODAFONE',
    moolreReference: `SUK-E2E-${Date.now().toString(36).toUpperCase()}`,
    reference: `SUK-E2E-${Date.now().toString(36).toUpperCase()}`,
    description: `E2E ${TAG}`,
    settlement: { appliedAt: null, reference: null },
    feesBreakdown: [],
    // Required by the schema. It is only used to attribute the audit entry,
    // so a synthetic id is enough — and it is removed with the payment.
    createdBy: new mongoose.Types.ObjectId(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  paymentId = payment.insertedId;

  check('the test school, student and payment exist', true, `payment ${paymentId}`);

  // ── 2. The callback, through the real handler ────────────────────────
  console.log('\n── 2. The callback ───────────────────────────────────────────────\n');

  const { handleMoolreWebhook } = await import('../src/services/payment.service.js');
  const reference = `SUK-E2E-${Date.now().toString(36).toUpperCase()}`;
  await db.collection('payments').updateOne({ _id: paymentId }, { $set: { reference, moolreReference: reference } });

  const callback = {
    status: 1,
    code: 'P01',
    message: 'Payment Successful',
    data: {
      txstatus: 1,
      externalref: reference,
      amount: (AMOUNT_PESEWAS / 100).toFixed(2),
      transactionid: 'TX-E2E-1',
      payer: '233557655008',
      secret: MOOLRE_CALLBACK_SECRET,
      ts: new Date().toISOString(),
    },
  };

  // Moolre's own verification of the transaction, stubbed: the handler always
  // asks Moolre whether the money actually arrived, and this test is about
  // what happens after that answer comes back "yes".
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    if (body.type === 1) {
      // Payment status: successful, for the right amount.
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 1,
            code: 'SS01',
            data: {
              txstatus: 1,
              amount: (AMOUNT_PESEWAS / 100).toFixed(2),
              channel: '6',
              transactionid: 'TX-E2E-1',
              externalref: reference,
            },
          }),
      };
    }
    return originalFetch(url, options);
  };

  const result = await handleMoolreWebhook(callback);
  global.fetch = originalFetch;

  check('the callback was accepted', result.success === true, JSON.stringify(result.status || ''));
  check('the payment settled', paymentDocStatus(result) === 'completed', `status=${paymentDocStatus(result)}`);

  // ── 3. The money actually moved ──────────────────────────────────────
  console.log('\n── 3. The settlement ─────────────────────────────────────────────\n');

  const after = await db.collection('students').findOne({ _id: studentId });
  check(
    'the student was credited',
    after.totalPaid === AMOUNT_PESEWAS,
    `totalPaid=${after.totalPaid} (expected ${AMOUNT_PESEWAS})`
  );
  check(
    'the balance went down',
    after.balance === TOTAL_OWED - AMOUNT_PESEWAS,
    `balance=${after.balance} (expected ${TOTAL_OWED - AMOUNT_PESEWAS})`
  );

  const stored = await db.collection('payments').findOne({ _id: paymentId });
  check('the payment is marked completed', stored.status === 'completed', `status=${stored.status}`);
  check(
    'the settlement was claimed',
    Boolean(stored.settlement?.appliedAt),
    `appliedAt=${stored.settlement?.appliedAt}`
  );
  check('the callback payload was recorded', Boolean(stored.webhookPayload));

  // ── 4. A second delivery must not credit twice ───────────────────────
  console.log('\n── 4. Idempotency ───────────────────────────────────────────────\n');

  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    if (body.type === 1) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 1,
            code: 'SS01',
            data: { txstatus: 1, amount: (AMOUNT_PESEWAS / 100).toFixed(2), channel: '6', externalref: reference },
          }),
      };
    }
    return originalFetch(url, options);
  };
  await handleMoolreWebhook(callback);
  global.fetch = originalFetch;

  const afterSecond = await db.collection('students').findOne({ _id: studentId });
  check(
    'a second delivery did not credit again',
    afterSecond.totalPaid === AMOUNT_PESEWAS,
    `totalPaid=${afterSecond.totalPaid} (expected ${AMOUNT_PESEWAS})`
  );
} catch (error) {
  console.error('\nFAILED:', error.message);
  console.error(error.stack?.split('\n').slice(0, 6).join('\n'));
  process.exitCode = 1;
} finally {
  await cleanup();
  await mongoose.disconnect();
}

function paymentDocStatus(result) {
  return result?.payment?.status ?? result?.status ?? null;
}
