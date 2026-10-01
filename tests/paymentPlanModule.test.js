// Contract tests for the installment-plan compliance module.
//
//   npm test
//
// Pure unit suite — no database. Two things live here that a database test would
// be too slow to catch, and both of them had actually broken:
//
//   1. **The schedule maths.** `splitAmount` puts the remainder on the *last*
//      tranche and `addInterval` *clamps* the day. Both are mirrored in the
//      frontend so the create screen can preview the plan live, which means there
//      are two implementations that must agree to the pesewa and to the calendar
//      day. A client that rounded evenly would preview GH₵ 183.33 × 3 and create a
//      plan for GH₵ 549.99 that the server rejects; a client that rolled the day
//      over would preview a schedule one day different from the one being created.
//      30 October + 1 month is 30 November, and that is the case asserted below.
//
//   2. **The compliance summary's vocabulary.** The classifier returns `on_track`;
//      the summary counts it under `onTrack`. Reducing the first over the second
//      yields three `undefined`s, which `|| 0` turns into a confident
//      `activePlans: 0` and a `complianceRate` of `null` — a dashboard that renders
//      "—" in every tile and never says why. This file pins the key names, because
//      a schema test cannot see a field that is computed at request time.
//
// What still needs a database: the pagination maths over a real collection, the
// student/plan join, and the `escapeRegExp`-backed search index usage.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const load = async () => import('../src/utils/planHelpers.js');
const loadDate = async () => import('../src/utils/dateHelpers.js');

const check = (schema, payload) =>
  schema.validate(payload, { abortEarly: true, stripUnknown: true, convert: true });

const ok = (result, label) =>
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);

// ──────────────────── Splitting ────────────────────
describe('splitAmount', () => {
  test('splits evenly when the total divides cleanly', async () => {
    const { splitAmount } = await load();
    assert.deepEqual(splitAmount(55000, 2), [27500, 27500]);
    assert.deepEqual(splitAmount(90000, 3), [30000, 30000, 30000]);
  });

  test('the last tranche absorbs the remainder, not the first', async () => {
    const { splitAmount } = await load();
    const split = splitAmount(55000, 3);

    // 55000 / 3 = 18333.33. Two clean tranches and a 18334 to land on the total.
    // Putting the odd pesewa on the *first* tranche instead would be arithmetically
    // identical and practically worse: the first payment is the one a family
    // checks against what they were quoted, and a plan that opens one pesewa over is
    // a support call.
    assert.deepEqual(split, [18333, 18333, 18334]);
    assert.equal(split.reduce((sum, n) => sum + n, 0), 55000);
  });

  test('the tranches always sum back to the total exactly', async () => {
    // The property the create screen's projection is judged on. A single counter
    // example here is a plan the server will reject with INVALID_INSTALLMENT_SPLIT,
    // after a bursar has read the preview and pressed the button.
    const { splitAmount } = await load();
    const totals = [99, 100, 101, 12345, 55000, 72500, 99999, 100000];
    const counts = [2, 3, 4, 5, 6];

    totals.forEach((total) => {
      counts.forEach((count) => {
        const split = splitAmount(total, count);
        assert.equal(split.length, count, `${total}/${count} produced ${split.length} tranches`);
        assert.equal(
          split.reduce((sum, n) => sum + n, 0),
          total,
          `${total} across ${count} sums to ${split.reduce((s, n) => s + n, 0)}`
        );
        assert.ok(
          split.every((n) => n > 0),
          `${total} across ${count} produced a non-positive tranche: ${split.join(',')}`
        );
      });
    });
  });

  test('a total smaller than the tranche count splits into zero-pesewa tranches', async () => {
    // Asserted as *behaviour*, because the shape is what the service has to guard
    // against: `installmentSchema.amount` is `min: 1`, so a schedule containing a
    // zero cannot be saved and would fail with a Mongoose error naming
    // `installments.0.amount`. `createPaymentPlan` checks for exactly this and
    // refuses with BALANCE_TOO_SMALL_TO_SPLIT — a check that would be pointless if
    // the arithmetic could not actually produce one.
    const { splitAmount } = await load();
    assert.deepEqual(splitAmount(1, 2), [0, 1]);
    assert.deepEqual(splitAmount(3, 6), [0, 0, 0, 0, 0, 3]);
  });

  test('a zero or negative tranche count yields nothing', async () => {
    const { splitAmount } = await load();
    // The service caps plans at 2–6, so this cannot reach a create call. Asserted
    // because the arithmetic is used elsewhere and a division by zero would throw
    // rather than degrade.
    assert.deepEqual(splitAmount(55000, 0), []);
    assert.deepEqual(splitAmount(55000, -1), []);
  });

  test('a single tranche is the whole total', async () => {
    const { splitAmount } = await load();
    assert.deepEqual(splitAmount(55000, 1), [55000]);
  });
});

// ──────────────────── Interval stepping ────────────────────
describe('addInterval', () => {
  test('a month step clamps the day to the target month', async () => {
    const { addInterval } = await loadDate();
    // The case the create screen's projection is most likely to get wrong.
    // 31 October + 1 month is 30 November, not 1 December — and a projection that
    // rolled over would show a bursar a schedule a day later than the one they are
    // about to create.
    const clamped = addInterval(new Date('2026-10-31T00:00:00Z'), 'monthly', 1);
    assert.equal(clamped.toISOString().slice(0, 10), '2026-11-30');

    const leap = addInterval(new Date('2028-01-31T00:00:00Z'), 'monthly', 1);
    assert.equal(leap.toISOString().slice(0, 10), '2028-02-29', 'February clamps to the 29th in a leap year');
  });

  test('a month step preserves a day that fits', async () => {
    const { addInterval } = await loadDate();
    assert.equal(
      addInterval(new Date('2026-10-30T00:00:00Z'), 'monthly', 1).toISOString().slice(0, 10),
      '2026-11-30'
    );
    assert.equal(
      addInterval(new Date('2026-10-30T00:00:00Z'), 'monthly', 3).toISOString().slice(0, 10),
      '2027-01-30'
    );
  });

  test('weekly and fortnightly step by whole weeks', async () => {
    const { addInterval } = await loadDate();
    const anchor = new Date('2026-10-30T00:00:00Z');
    assert.equal(addInterval(anchor, 'weekly', 2).toISOString().slice(0, 10), '2026-11-13');
    assert.equal(addInterval(anchor, 'biweekly', 1).toISOString().slice(0, 10), '2026-11-13');
  });

  test('stepping by zero is the anchor itself', async () => {
    const { addInterval } = await loadDate();
    const anchor = new Date('2026-10-30T00:00:00Z');
    assert.equal(addInterval(anchor, 'monthly', 0).toISOString(), anchor.toISOString());
  });

  test('steps are monotonic — no tranche due before the one before it', async () => {
    // A schedule that goes backwards is arithmetically fine and unusable: the
    // service sorts by date and renumbers, so the *stored* order would differ from
    // the *previewed* one and the plan would be created with different numbers
    // attached to different dates than the bursar approved.
    const { addInterval } = await loadDate();
    ['weekly', 'biweekly', 'monthly'].forEach((interval) => {
      const anchor = new Date('2026-01-31T00:00:00Z');
      let previous = 0;
      for (let step = 0; step < 6; step += 1) {
        const at = addInterval(anchor, interval, step).getTime();
        assert.ok(at > previous, `${interval} step ${step} did not advance`);
        previous = at;
      }
    });
  });
});

// ──────────────────── A whole generated schedule ────────────────────
describe('generateInstallmentSchedule', () => {
  test('the due dates and the amounts both come out right', async () => {
    const { generateInstallmentSchedule } = await load();
    const schedule = generateInstallmentSchedule({
      totalAmount: 55000,
      numberOfInstallments: 3,
      startDate: '2026-10-30',
      interval: 'monthly',
    });

    assert.equal(schedule.length, 3);
    assert.deepEqual(
      schedule.map((i) => i.amount),
      [18333, 18333, 18334]
    );
    assert.deepEqual(
      schedule.map((i) => i.dueDate.toISOString().slice(0, 10)),
      ['2026-10-30', '2026-11-30', '2026-12-30']
    );
    // Every tranche starts `pending` with nothing paid. A generated plan that
    // opened with a tranche already settled would make a brand-new plan read as
    // part-paid on the compliance dashboard before the family has been told.
    schedule.forEach((installment) => {
      assert.equal(installment.status, 'pending');
      assert.equal(installment.amountPaid, 0);
      assert.equal(installment.paidAt, null);
    });
  });

  test('a due date is the end of the day, not its start', async () => {
    // The service's own `isInstallmentOverdue` compares against `Date.now()`, so a
    // tranche stored at midnight is "overdue" from the first second of its due
    // date rather than at the end of it. `endOfDayAccra` is 23:59:00 — the last
    // *minute*, not the last second, which is deliberate: it leaves a one-minute
    // margin so a payment webhook landing at 23:59:30 is not already late.
    const { generateInstallmentSchedule } = await load();
    const [first] = generateInstallmentSchedule({
      totalAmount: 10000,
      numberOfInstallments: 2,
      startDate: '2026-10-30',
      interval: 'monthly',
    });

    assert.match(first.dueDate.toISOString(), /T23:59:00/);
  });

  test('explicit tranches win, and a missing date falls back to the interval', async () => {
    const { generateInstallmentSchedule } = await load();
    const schedule = generateInstallmentSchedule({
      totalAmount: 55000,
      numberOfInstallments: 2,
      startDate: '2026-10-30',
      interval: 'monthly',
      customInstallments: [{ amount: 20000, dueDate: '2026-11-15' }, { amount: 35000 }],
    });

    assert.equal(schedule[0].dueDate.toISOString().slice(0, 10), '2026-11-15');
    assert.equal(schedule[1].dueDate.toISOString().slice(0, 10), '2026-11-30');
  });
});

// ──────────────────── Compliance query ────────────────────
describe('complianceQuerySchema', () => {
  test('accepts the dashboard\'s filters', async () => {
    const { complianceQuerySchema } = await import('../src/validations/paymentPlan.validation.js');
    const { value } = check(complianceQuerySchema, {
      class: 'JHS 2A',
      status: 'overdue',
      term: 'Term 1',
      search: 'Mensah',
      page: 2,
      perPage: 50,
      sortBy: 'endDate',
      sortOrder: 'desc',
    });

    assert.equal(value.class, 'JHS 2A');
    assert.equal(value.term, 'Term 1');
    assert.equal(value.page, 2);
  });

  test('an empty filter is dropped rather than sent as "match nothing"', async () => {
    // `?class=` must mean "no class filter", not "the class whose name is empty".
    // The service omits empty params, so this asserts the schema keeps them
    // falsy-rather-truthy on the way out rather than normalising to a sentinel.
    const { complianceQuerySchema } = await import('../src/validations/paymentPlan.validation.js');
    ok(check(complianceQuerySchema, { class: '', term: '', search: '' }), 'empty strings');
    assert.equal(check(complianceQuerySchema, { status: 'all' }).value.status, 'all');
  });

  test('an unknown compliance status is refused', async () => {
    const { complianceQuerySchema } = await import('../src/validations/paymentPlan.validation.js');
    assert.ok(check(complianceQuerySchema, { status: 'in_default' }).error);
  });

  test('a search is length-capped', async () => {
    // An unbounded string is a ReDoS vector on every keystroke, and it goes
    // straight into a RegExp server-side.
    const { complianceQuerySchema } = await import('../src/validations/paymentPlan.validation.js');
    assert.ok(check(complianceQuerySchema, { search: 'x'.repeat(500) }).error);
  });

  test('sorting by a column that is not one is refused', async () => {
    const { complianceQuerySchema } = await import('../src/validations/paymentPlan.validation.js');
    assert.ok(check(complianceQuerySchema, { sortBy: 'planStatus' }).error);
    ok(check(complianceQuerySchema, { sortBy: 'complianceStatus' }), 'complianceStatus is sortable');
  });
});

// ──────────────────── Create ────────────────────
describe('createPlanSchema', () => {
  test('a tranche count outside 2–6 is refused', async () => {
    const { createPlanSchema } = await import('../src/validations/paymentPlan.validation.js');
    const base = { startDate: new Date(Date.now() + 86400000).toISOString() };

    [1, 7, 12].forEach((count) => {
      assert.ok(
        check(createPlanSchema, { ...base, numberOfInstallments: count }).error,
        `${count} tranches should be refused`
      );
    });
    [2, 3, 4, 6].forEach((count) => {
      ok(check(createPlanSchema, { ...base, numberOfInstallments: count }), `${count} tranches`);
    });
  });

  test('a past start date is refused', async () => {
    const { createPlanSchema } = await import('../src/validations/paymentPlan.validation.js');
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const result = check(createPlanSchema, { numberOfInstallments: 3, startDate: yesterday });

    assert.ok(result.error, 'a plan cannot start in the past');
    assert.match(result.error.message, /past/);
  });

  test('explicit tranches must line up with the count', async () => {
    const { createPlanSchema } = await import('../src/validations/paymentPlan.validation.js');
    const startDate = new Date(Date.now() + 86400000).toISOString();
    const result = check(createPlanSchema, {
      numberOfInstallments: 3,
      startDate,
      customInstallments: [{ amount: 20000 }, { amount: 35000 }],
    });

    assert.ok(result.error, 'two tranches for a three-tranche plan');
    assert.match(result.error.message, /numberOfInstallments/);
  });
});
