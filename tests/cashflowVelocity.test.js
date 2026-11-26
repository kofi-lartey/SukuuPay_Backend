// Contract tests for the cashflow *velocity* analytics endpoint.
//
//   node --test tests/cashflowVelocity.test.js
//
// Pure unit suite — no database, no network. Models are stubbed before the
// service is imported (the same approach adminAnalytics.test.js uses), because the
// service holds direct references to the model objects.
//
// The properties worth pinning, none of which a passing import or a code review
// would catch:
//
//   1. **Empty weeks are explicit zeros, never gaps.** The series walks the horizon
//      week by week; a week with no installments must still appear with
//      projected/collected/velocity of 0, or a chart draws a straight line across a
//      quiet week and presents stillness as trend.
//   2. **Velocity guards the zero denominator.** Nothing projected is 0, not NaN.
//   3. **averageDaysToPay is read from paidAt, and may be negative** (paid early).
//   4. **Tranches sum back to the projected total** when they fall in the horizon.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const modelHandles = {};

const loadModels = async () => {
  if (Object.keys(modelHandles).length) return modelHandles;
  for (const [name, path] of [
    ['School', '../src/models/schoolModel.js'],
    ['Student', '../src/models/studentModel.js'],
    ['Payment', '../src/models/paymentModel.js'],
    ['PaymentPlan', '../src/models/paymentPlanModel.js'],
  ]) {
    const mod = await import(path);
    modelHandles[name] = Object.values(mod).find((v) => v?.schema?.indexes);
  }
  return modelHandles;
};

await loadModels();

const { School, Student, PaymentPlan } = modelHandles;

// The plan rows the stubbed PaymentPlan.find resolves to. Each test sets this.
let plans = [];

const stubQuery = (rows = []) => {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    skip: () => chain,
    lean: () => Promise.resolve(rows),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
};

School.findById = () => {
  const school = { name: 'Velocity Test School' };
  const chain = {
    select: () => chain,
    lean: () => Promise.resolve(school),
    then: (resolve, reject) => Promise.resolve(school).then(resolve, reject),
  };
  return chain;
};
Student.find = () => stubQuery([]);
PaymentPlan.find = () => stubQuery(plans);

const { getCashflowVelocity } = await import('../src/services/analytics.service.js');

const SCHOOL_ID = '507f1f77bcf86cd799439011';
const user = { _id: 'user-1', role: 'school_admin', schoolId: SCHOOL_ID };

// asOf is a Thursday (2026-01-01); the Sunday-anchored weeks walked for a 30-day
// horizon are Dec 28, Jan 4, Jan 11, Jan 18, Jan 25 — five buckets.
const AS_OF = '2026-01-01';
const HORIZON = 30;

const run = (query = {}) =>
  getCashflowVelocity(SCHOOL_ID, { horizon: HORIZON, asOf: AS_OF, ...query }, user);

const makePlan = (installments) => ({
  studentId: 'student-1',
  planStatus: 'active',
  startDate: new Date(AS_OF),
  endDate: new Date('2026-06-01'),
  installments,
});

describe('empty range yields explicit zero buckets, not gaps', () => {
  test('every week in the horizon is present and zero', async () => {
    plans = [];
    const result = await run();

    assert.equal(result.series.length, 5);
    for (const bucket of result.series) {
      assert.equal(bucket.projected, 0);
      assert.equal(bucket.collected, 0);
      assert.equal(bucket.velocity, 0);
    }
    // Consecutive weeks, no missing period between them.
    const starts = result.series.map((b) => b.startDate);
    for (let i = 1; i < starts.length; i += 1) {
      const gap = new Date(starts[i]) - new Date(starts[i - 1]);
      assert.equal(gap, 7 * 86400000, 'a week is missing from the series');
    }
  });

  test('the first bucket is the Sunday on or before asOf', async () => {
    plans = [];
    const result = await run();
    assert.equal(result.series[0].period, 'week_2025-12-28');
  });
});

describe('velocity is 0 when nothing is projected', () => {
  test('a zero-amount installment yields collectionVelocity 0, not NaN', async () => {
    plans = [
      makePlan([
        { amount: 0, amountPaid: 0, dueDate: new Date('2026-01-05'), status: 'pending' },
      ]),
    ];
    const result = await run();

    assert.equal(result.summary.projectedInflow, 0);
    assert.equal(result.summary.collectionVelocity, 0);
    assert.equal(result.summary.collectedToDate, 0);
  });
});

describe('averageDaysToPay is computed from paidAt', () => {
  test('mean of (paidAt - dueDate) in days, on-time counts, rate is a share', async () => {
    plans = [
      makePlan([
        // Paid exactly on the due date -> 0 days, on time.
        {
          amount: 10000,
          amountPaid: 10000,
          dueDate: new Date('2026-01-10'),
          paidAt: new Date('2026-01-10'),
          status: 'paid',
        },
        // Paid 4 days late -> +4 days, not on time.
        {
          amount: 10000,
          amountPaid: 10000,
          dueDate: new Date('2026-01-10'),
          paidAt: new Date('2026-01-14'),
          status: 'paid',
        },
      ]),
    ];
    const result = await run();

    assert.equal(result.summary.averageDaysToPay, 2);
    assert.equal(result.summary.onTimeRate, 0.5);
  });

  test('paying early yields a negative average, kept as-is', async () => {
    plans = [
      makePlan([
        {
          amount: 10000,
          amountPaid: 10000,
          dueDate: new Date('2026-01-20'),
          paidAt: new Date('2026-01-15'),
          status: 'paid',
        },
      ]),
    ];
    const result = await run();
    assert.equal(result.summary.averageDaysToPay, -5);
    assert.equal(result.summary.onTimeRate, 1);
  });
});

describe('tranches sum back to the projected total', () => {
  test('installments in the horizon add up across the weekly buckets', async () => {
    plans = [
      makePlan([
        {
          amount: 10000,
          amountPaid: 5000,
          dueDate: new Date('2026-01-05'),
          status: 'partial',
        },
        {
          amount: 20000,
          amountPaid: 0,
          dueDate: new Date('2026-01-20'),
          status: 'pending',
        },
      ]),
    ];
    const result = await run();

    assert.equal(result.summary.projectedInflow, 30000);
    assert.equal(result.summary.collectedToDate, 5000);

    const summedProjected = result.series.reduce((s, b) => s + b.projected, 0);
    const summedCollected = result.series.reduce((s, b) => s + b.collected, 0);
    assert.equal(summedProjected, 30000);
    assert.equal(summedCollected, 5000);

    // Velocity overall is the ratio of the two totals.
    assert.equal(result.summary.collectionVelocity, 0.17);
  });

  test('an installment outside the horizon is counted overall but not bucketed', async () => {
    plans = [
      makePlan([
        {
          amount: 10000,
          amountPaid: 0,
          dueDate: new Date('2026-01-05'),
          status: 'pending',
        },
        {
          amount: 99999,
          amountPaid: 0,
          dueDate: new Date('2026-06-01'),
          status: 'pending',
        },
      ]),
    ];
    const result = await run();

    // Overall totals include both installments...
    assert.equal(result.summary.projectedInflow, 109999);
    // ...but only the in-horizon one lands in a weekly bucket.
    const summedProjected = result.series.reduce((s, b) => s + b.projected, 0);
    assert.equal(summedProjected, 10000);
  });
});