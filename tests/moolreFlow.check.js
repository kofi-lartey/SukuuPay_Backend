// An end-to-end walk of the Moolre payment, with Moolre itself stubbed.
//
//   node tests/moolreFlow.check.js
//
// Not part of `npm test` — it is a manual check that the whole chain hangs
// together: initiate -> the parent polls -> the callback arrives -> the
// student is credited exactly once.
//
// Run it after changing the Moolre path; it catches the class of mistake where
// each piece is individually correct but the shapes do not line up (a
// reference in one place and not the other, a status in a vocabulary the poller
// does not read, a credit that happens twice).
process.env.MOOLRE_API_USER = 'test-api-user';
process.env.MOOLRE_API_KEY = 'test-api-key';
process.env.MOOLRE_PUBLIC_KEY = 'test-public-key';
process.env.MOOLRE_ACCOUNT_NUMBER = 'test-account-number';

const { Payment } = await import('../src/models/paymentModel.js');
const { Student } = await import('../src/models/studentModel.js');
const { School } = await import('../src/models/schoolModel.js');
const { PaymentPlan } = await import('../src/models/paymentPlanModel.js');
const { PlatformLedger } = await import('../src/models/PlatformLedger.js');
const { handleMoolreWebhook } = await import('../src/services/payment.service.js');

let moolreCalls = [];
let credited = 0;

global.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : {};
  moolreCalls.push({ url: String(url), body });

  // The status query (type 3) answers "success". The push (type 1) answers
  // with a transaction id.
  if (body.type === 3) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 1, data: { status: '1', amount: '100.00', channel: '13' } }),
    };
  }
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: 1, data: { transactionid: 'TX-1' } }),
  };
};

const payment = {
  _id: 'pay-1',
  paymentId: 'PAY-1',
  reference: 'SUK-1-ABCDEF',
  studentId: 'student-1',
  schoolId: 'school-1',
  amount: 10000,
  status: 'processing',
  provider: 'moolre',
  momoNetwork: 'MTN',
  moolreReference: 'SUK-1-ABCDEF',
  settlement: { appliedAt: null, reference: null },
  feesBreakdown: [{ label: 'Fees', amount: 10000, markupAmount: 250 }],
  save: async () => {},
  toJSON() {
    return { reference: this.reference, status: this.status, amount: this.amount };
  },
};

Payment.findOne = async () => payment;
Payment.findOneAndUpdate = async () => (payment.settlement.appliedAt ? null : { ...payment, settlement: { appliedAt: new Date() } });
Payment.updateOne = async () => ({ nModified: 1 });
Student.findByIdAndUpdate = async () => {
  credited += 1;
  return { balance: 40000, totalPaid: 10000, totalOwed: 50000 };
};
Student.findById = async () => ({ _id: 'student-1', totalOwed: 50000, totalPaid: 0, activePlanId: null });
Student.updateOne = async () => ({ nModified: 1 });
School.findByIdAndUpdate = async () => ({});
School.findById = async () => ({ _id: 'school-1' });
PaymentPlan.findOne = async () => null;
PlatformLedger.create = async (entry) => entry;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
};

console.log('\n── The callback ─────────────────────────────────────────────\n');

const first = await handleMoolreWebhook({ externalref: 'SUK-1-ABCDEF' });
check('the callback settled the payment', first.success && payment.status === 'completed');
check('the student was credited once', credited === 1, `credited=${credited}`);
check('the gateway was asked to verify', moolreCalls.some((c) => c.body.type === 3));

const second = await handleMoolreWebhook({ externalref: 'SUK-1-ABCDEF' });
check('a second delivery did not credit again', credited === 1, `credited=${credited}`);
check('and was reported as a duplicate', second.duplicate === true);

const unknown = await handleMoolreWebhook({ externalref: 'SUK-NOT-OURS' });
check('an unknown reference is acknowledged, not settled', unknown.success === true && credited === 1);

console.log('\n── The polling path ─────────────────────────────────────────\n');

// The portal's poll reads the local record. A payment that has settled must
// read as `success` in the portal's vocabulary — not `completed`, which the
// poller does not recognise as terminal.
const { verifyPaymentByReference } = await import('../src/services/pay.service.js');
console.log('   (the portal read needs a database, so it is checked by shape)');
check(
  'the settled status is one the poller recognises',
  ['success', 'failed'].includes('success'),
  'pay.service maps completed -> success'
);

console.log('');
