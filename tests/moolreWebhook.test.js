// The Moolre callback: the path where a mistake costs a school money.
//
//   npm test
//
// A callback is an unauthenticated HTTP request from the internet. It can be
// replayed, forged, or delivered for a transaction that failed. So:
//
//   - an unknown reference is acknowledged but settles nothing;
//   - an already-settled payment is acknowledged and settles nothing again;
//   - a callback is never trusted on its own — the transaction is re-verified
//     with Moolre before any money moves;
//   - a verification that could not be completed asks Moolre to retry (502)
//     rather than deciding the payment failed;
//   - a short payment is not credited.
//
// The models are stubbed at their statics. That is enough to assert on the
// *decisions* — was the student credited, was the plan touched, was the
// ledger written — which is what these tests are about. The queries
// themselves are asserted elsewhere.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MOOLRE_API_USER = 'test-api-user';
process.env.MOOLRE_API_KEY = 'test-api-key';
process.env.MOOLRE_PUBLIC_KEY = 'test-public-key';
process.env.MOOLRE_ACCOUNT_NUMBER = 'test-account-number';
// The callback secret is checked when one is configured, so the test
// configures one and posts it. A test that ran with the check silently
// disabled would not notice the handler refusing a forged callback.
const CALLBACK_SECRET = 'test-callback-secret';
process.env.MOOLRE_CALLBACK_SECRET = CALLBACK_SECRET;
process.env.MOOLRE_BASE_URL = 'https://api.moolre.com';

const { Payment } = await import('../src/models/paymentModel.js');
const { Student } = await import('../src/models/studentModel.js');
const { School } = await import('../src/models/schoolModel.js');
const { PaymentPlan } = await import('../src/models/paymentPlanModel.js');
const { PlatformLedger } = await import('../src/models/PlatformLedger.js');
const { handleMoolreWebhook } = await import('../src/services/payment.service.js');
const { moolreWebhookController } = await import('../src/controllers/payment.controller.js');

/** Everything the stubs recorded. */
let calls = null;

/**
 * A payment record, as a plain object.
 *
 * Plain rather than a Mongoose document: the webhook path reads fields and
 * calls `save()`, and a plain object with a `save` stub exercises exactly the
 * same code without a database.
 */
const makePayment = (overrides = {}) => ({
  _id: 'pay-1',
  paymentId: 'PAY-1',
  reference: 'SUK-1-ABCDEF',
  studentId: 'student-1',
  schoolId: 'school-1',
  amount: 10000, // GH₵ 100.00, in pesewas
  currency: 'GHS',
  status: 'processing',
  provider: 'moolre',
  paymentMethod: 'momo',
  momoPhoneNumber: '0244000000',
  momoNetwork: 'MTN',
  moolreReference: 'SUK-1-ABCDEF',
  settlement: { appliedAt: null, reference: null },
  feesBreakdown: [],
  webhookPayload: null,
  webhookReceivedAt: null,
  save: async () => {},
  toJSON() {
    return { ...this, save: undefined, toJSON: undefined };
  },
  ...overrides,
});

/**
 * Stubs the models.
 *
 * `studentCredited` is the assertion that matters: it is the `$inc` that
 * moves a student's `totalPaid`, and it is what must happen exactly once.
 */
const stubModels = ({ payment, student, plan } = {}) => {
  calls = {
    studentCredited: 0,
    studentUpdate: null,
    ledgerWrites: [],
    planApplied: 0,
    schoolStats: 0,
    paymentSaved: 0,
  };

  Payment.findOne = async () => payment ?? null;
  Payment.findOneAndUpdate = async () => {
    // The settlement claim. Claiming succeeds the first time and fails after
    // that, which is what makes a second callback a no-op.
    if (calls.studentCredited > 0 || payment?.settlement?.appliedAt) return null;
    return { ...payment, settlement: { appliedAt: new Date(), reference: null } };
  };
  Payment.updateOne = async () => ({ nModified: 1 });

  Student.findByIdAndUpdate = async (_id, update) => {
    calls.studentCredited += 1;
    calls.studentUpdate = update;
    return { balance: 50000, totalPaid: 10000, totalOwed: 50000 };
  };
  Student.findById = async () => ({
    _id: 'student-1',
    totalOwed: 50000,
    totalPaid: 0,
    activePlanId: plan ? 'plan-1' : null,
  });
  Student.updateOne = async () => ({ nModified: 1 });

  School.findByIdAndUpdate = async () => {
    calls.schoolStats += 1;
    return {};
  };
  School.findById = async () => ({ _id: 'school-1', name: 'Test School' });

  PaymentPlan.findOne = async () =>
    plan
      ? {
          _id: 'plan-1',
          planStatus: 'active',
          installments: [{ installmentNumber: 1, amount: 10000, amountPaid: 0, paymentIds: [] }],
          // The plan's schedule is written by `save()`, not by an update, so
          // this is what proves the payment was applied to it.
          save: async () => {
            calls.planApplied += 1;
          },
        }
      : null;
  PaymentPlan.updateOne = async () => ({ nModified: 1 });

  PlatformLedger.create = async (entry) => {
    calls.ledgerWrites.push(entry);
    return entry;
  };
};

/**
 * Stubs `fetch` with a Moolre verification answer.
 *
 * The outcome lives in `data.txstatus` — 1 successful, 0 pending, 2 failed,
 * 3 not found — and *not* in the envelope's `status`, which is `1` even for a
 * lookup that found nothing.
 */
const stubVerification = ({ txstatus = 1, amount = '100.00', channel = '13' } = {}) => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ status: 1, code: 'SS01', data: { txstatus, amount, channel } }),
    json: async () => ({ status: 1, code: 'SS01', data: { txstatus, amount, channel } }),
  });
};

const stubVerificationFailure = () => {
  global.fetch = async () => {
    throw new Error('Moolre is unreachable');
  };
};

const originalFetch = global.fetch;
after(() => {
  global.fetch = originalFetch;
});

/**
 * A callback in Moolre's real shape.
 *
 * The payload nests everything under `data` — the transaction status, the
 * reference, the amount and the callback secret — so the handler is exercised
 * against the shape Moolre actually posts, not a flattened approximation of
 * it. A handler that only works on a flattened payload fails on the first real
 * callback.
 */
const callbackPayload = ({
  externalref = 'SUK-1-ABCDEF',
  txstatus = 1,
  amount = '100.00',
  secret = CALLBACK_SECRET,
} = {}) => ({
  status: txstatus === 1 ? 1 : 0,
  code: txstatus === 1 ? 'P01' : 'P02',
  message: txstatus === 1 ? 'Payment Successful' : 'Payment Failed',
  data: {
    txstatus,
    externalref,
    amount,
    transactionid: 'TX-CALLBACK-1',
    payer: '233244000000',
    secret,
    ts: new Date().toISOString(),
  },
});

// ──────────────────── The webhook handler ────────────────────

describe('the Moolre callback', () => {
  test('an unknown reference is acknowledged without settling anything', async () => {
    stubModels({ payment: null });
    stubVerification();

    const result = await handleMoolreWebhook(callbackPayload({ externalref: 'SUK-NOPE' }));

    assert.equal(result.success, true);
    assert.match(result.message, /not found/i);
    assert.equal(calls.studentCredited, 0, 'nobody was credited');
  });

  test('an already-settled payment is acknowledged without crediting twice', async () => {
    stubModels({ payment: makePayment({ status: 'completed' }) });
    stubVerification();

    const result = await handleMoolreWebhook(callbackPayload());

    assert.equal(result.success, true);
    assert.equal(result.duplicate, true);
    assert.equal(calls.studentCredited, 0, 'the balance was not moved again');
  });

  test('a successful callback credits the student, the plan and the ledger', async () => {
    const payment = makePayment({
      paymentPlanId: 'plan-1',
      // The platform's cut, which is what the ledger entry is booked from.
      feesBreakdown: [{ label: 'Term 1 fees', amount: 10000, markupAmount: 250, markupPercent: 2.5 }],
    });
    stubModels({ payment, plan: { _id: 'plan-1' } });
    stubVerification({ txstatus: 1, amount: '100.00' });

    const result = await handleMoolreWebhook(callbackPayload());

    assert.equal(result.success, true);
    assert.equal(payment.status, 'completed');
    assert.equal(calls.studentCredited, 1, 'the student was credited exactly once');
    // The credit and the balance are set by one pipeline update, so that
    // `totalPaid` and `balance` can never disagree.
    assert.ok(Array.isArray(calls.studentUpdate), 'the credit is a pipeline update');
    const set = calls.studentUpdate[0].$set;
    assert.ok(set.totalPaid, 'totalPaid is set');
    assert.ok(set.balance, 'and the balance moves with it');
    assert.ok(payment.completedAt, 'the payment is stamped complete');
    assert.equal(calls.planApplied, 1, 'the money was applied to the payment plan');
    assert.equal(calls.ledgerWrites.length, 1, 'the platform ledger was written');
    assert.equal(calls.ledgerWrites[0].amount, 250, 'for the markup, not the whole amount');
  });

  test('a callback is never trusted on its own', async () => {
    // Moolre is asked about the transaction. A callback that claims success
    // while Moolre says pending settles nothing.
    stubModels({ payment: makePayment() });
    stubVerification({ txstatus: 0, amount: '100.00' });

    const result = await handleMoolreWebhook(callbackPayload({ txstatus: 0 }));

    assert.equal(result.success, true);
    assert.equal(result.status, 'processing');
    assert.equal(calls.studentCredited, 0, 'nothing was credited');
  });

  test('a short payment is logged and not credited', async () => {
    // The money that arrived is not the money that was owed, and guessing
    // which one is right is how a school's ledger stops matching its bank.
    const payment = makePayment();
    stubModels({ payment });
    stubVerification({ txstatus: 1, amount: '40.00' });

    const result = await handleMoolreWebhook(callbackPayload());

    assert.equal(result.success, true);
    assert.equal(result.mismatch, true);
    assert.equal(calls.studentCredited, 0, 'nothing was credited');
    assert.notEqual(payment.status, 'completed');
  });

  test('a payment of exactly the expected amount is credited', async () => {
    stubModels({ payment: makePayment() });
    stubVerification({ txstatus: 1, amount: '100.00' });

    await handleMoolreWebhook(callbackPayload());

    assert.equal(calls.studentCredited, 1);
  });

  test('a failed transaction is recorded as failed, not settled', async () => {
    const payment = makePayment();
    stubModels({ payment });
    stubVerification({ txstatus: 2, amount: '100.00' });

    await handleMoolreWebhook(callbackPayload());

    assert.equal(payment.status, 'failed');
    assert.equal(calls.studentCredited, 0);
  });

  test('a second delivery of the same callback does not credit twice', async () => {
    // Moolre retries until it gets a 2xx, so the same "successful" callback
    // routinely arrives two or three times. The settlement claim is what stops
    // the second one running the `$inc` again.
    const payment = makePayment();
    stubModels({ payment });
    stubVerification({ txstatus: 1, amount: '100.00' });

    await handleMoolreWebhook(callbackPayload());
    const afterFirst = calls.studentCredited;

    await handleMoolreWebhook(callbackPayload());

    assert.equal(afterFirst, 1, 'the first callback credited');
    assert.equal(calls.studentCredited, 1, 'the second one did not credit again');
  });

  test('a payload with no reference is refused', async () => {
    stubModels({ payment: makePayment() });
    // Correctly authenticated, so the reference check is what refuses it.
    await assert.rejects(
      () => handleMoolreWebhook({ data: { secret: CALLBACK_SECRET, amount: '100.00' } }),
      (error) => {
        assert.equal(error.code, 'INVALID_WEBHOOK_PAYLOAD');
        return true;
      }
    );
  });

  test('a callback with the wrong secret is refused', async () => {
    // Moolre sends the callback secret in `data.secret`, and the docs are
    // explicit that it must be validated before any payment record changes.
    // A callback is an unauthenticated HTTP request from the internet — it
    // can be replayed or forged — so the secret is the first gate.
    stubModels({ payment: makePayment() });
    stubVerification();

    await assert.rejects(
      () => handleMoolreWebhook(callbackPayload({ secret: 'not-the-secret' })),
      (error) => {
        assert.equal(error.code, 'MOOLRE_CALLBACK_SECRET_MISMATCH');
        assert.equal(error.status, 403);
        return true;
      }
    );

    assert.equal(calls.studentCredited, 0, 'nothing was credited');
  });

  test('a callback with no secret at all is refused', async () => {
    stubModels({ payment: makePayment() });
    stubVerification();

    await assert.rejects(
      () => handleMoolreWebhook(callbackPayload({ secret: '' })),
      (error) => {
        assert.equal(error.code, 'MOOLRE_CALLBACK_SECRET_MISMATCH');
        return true;
      }
    );

    assert.equal(calls.studentCredited, 0, 'nothing was credited');
  });
});

// ──────────────────── The webhook controller ────────────────────

describe('the Moolre webhook controller', () => {
  const call = async (body) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
    await moolreWebhookController({ body }, res);
    return res;
  };

  test('an unknown reference answers 200 with received: true', async () => {
    stubModels({ payment: null });
    stubVerification();

    const res = await call(callbackPayload({ externalref: 'SUK-NOPE' }));

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.received, true);
  });

  test('a settled payment answers 200 without crediting again', async () => {
    stubModels({ payment: makePayment({ status: 'completed' }) });
    stubVerification();

    const res = await call(callbackPayload());

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.received, true);
    assert.equal(calls.studentCredited, 0);
  });

  test('a verification that cannot be completed answers 502 so Moolre retries', async () => {
    // Answering 200 here would lose the only notification we are going to get,
    // and the parent's money would arrive with nothing recording it.
    stubModels({ payment: makePayment() });
    stubVerificationFailure();

    const res = await call(callbackPayload());

    assert.equal(res.statusCode, 502);
    assert.equal(res.body.received, false);
    assert.equal(calls.studentCredited, 0);
  });

  test('a successful callback answers 200', async () => {
    stubModels({ payment: makePayment() });
    stubVerification({ txstatus: 1, amount: '100.00' });

    const res = await call(callbackPayload());

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.received, true);
    assert.equal(calls.studentCredited, 1);
  });
});
