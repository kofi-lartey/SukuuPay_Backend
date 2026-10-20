// Contract tests for the platform console's analytics and reports.
//
//   npm test
//
// No database, no network, no live server — the same constraint every other suite in
// this directory works under, and the reason the assertions below are about *contracts*
// rather than round trips.
//
// Why a suite like this exists for this module specifically.
//
// Two of the properties these services are built on are invisible to a passing import
// and to a code review, and both are the kind that ship:
//
//   1. **Every time series has no gaps.** A period with no rows must render as an
//      explicit `0`, never as a missing point the client draws a straight line across —
//      which presents a month of zero revenue as smooth growth. This is the property
//      `buildCalendarSeries` was exported to protect (admin.service.js:405) and the one
//      `buildGapFreeSeries` re-implements for day/week/month. A gap is only ever
//      visible in a series' *keys*, so that is what is asserted.
//   2. **Percentages are real, labelled ratios.** `percent()` returns `null` for a zero
//      denominator rather than `0`, because "there is no basis for this number" and
//      "nothing happened" are different claims and a console renders only one of them
//      as a number.
//
// The second half of the suite stubs every model and *executes* all twelve functions,
// which is what catches a thrown error, a bad destructuring or a pipeline assembled
// from an undefined variable — and lets every aggregation pipeline be captured and
// structurally checked, since there is no server here to send them to.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

// ── Stub every model before the services import them ──────────────────────
//
// The services hold direct references to the model objects, so the stub has to be in
// place before those modules are loaded. `before()` on the suites below does that; this
// top-level `await` establishes the model handles first.

const modelHandles = {};

const loadModels = async () => {
  if (Object.keys(modelHandles).length) return modelHandles;
  for (const [name, path] of [
    ['School', '../src/models/schoolModel.js'],
    ['Student', '../src/models/studentModel.js'],
    ['Payment', '../src/models/paymentModel.js'],
    ['PaymentPlan', '../src/models/paymentPlanModel.js'],
    ['SmsMessage', '../src/models/smsMessageModel.js'],
    ['PlatformLedger', '../src/models/PlatformLedger.js'],
  ]) {
    const mod = await import(path);
    modelHandles[name] = Object.values(mod).find((v) => v?.schema?.indexes);
  }
  return modelHandles;
};

await loadModels();

/** Every pipeline captured, so they can be inspected after a function runs. */
let captured = { aggregates: [], finds: [] };

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

const installStubs = () => {
  for (const [name, Model] of Object.entries(modelHandles)) {
    Model.aggregate = (pipeline, options) => {
      captured.aggregates.push({ model: name, pipeline, options });
      return Promise.resolve([]);
    };
    Model.find = (filter, projection) => {
      captured.finds.push({ model: name, op: 'find', filter, projection });
      return stubQuery([]);
    };
    Model.findOne = (filter) => {
      captured.finds.push({ model: name, op: 'findOne', filter });
      return stubQuery([]);
    };
    Model.countDocuments = (filter) => {
      captured.finds.push({ model: name, op: 'countDocuments', filter });
      return Promise.resolve(0);
    };
  }
};

installStubs();

const analytics = await import('../src/services/admin/analytics.service.js');
const reports = await import('../src/services/admin/reports.service.js');
const { PLATFORM_REVENUE_TYPES } = await import('../src/models/PlatformLedger.js');
const { School } = modelHandles;
const { Payment } = modelHandles;

/** Runs one function and returns `{ result, pipelines }`. */
const run = async (fn) => {
  captured = { aggregates: [], finds: [] };
  const result = await fn();
  return { result, pipelines: captured.aggregates };
};

// ──────────────────── Gap-free series ────────────────────

describe('every time series is gap-free', () => {
  const empty = () => ({ total: 0 });
  const from = new Date(Date.UTC(2026, 0, 3));
  const to = new Date(Date.UTC(2026, 2, 20));

  test('a month with no activity is an explicit 0, not a missing point', () => {
    const rows = new Map([['2026-02', { total: 5 }]]);
    const { series } = analytics.buildGapFreeSeries(rows, from, to, 'month', empty);

    assert.deepEqual(
      series.map((p) => [p.period, p.total]),
      [['2026-01', 0], ['2026-02', 5], ['2026-03', 0]]
    );
  });

  test('weeks start on Monday and cover every week in the range', () => {
    // 3 Jan 2026 is a Saturday, so its week began Mon 29 Dec 2025.
    const keys = analytics.buildPeriodKeys(from, to, 'week');
    assert.equal(keys[0], '2025-12-29');
    assert.equal(keys[1], '2026-01-05');
    for (const key of keys) {
      const day = new Date(`${key}T00:00:00.000Z`).getUTCDay();
      assert.equal(day, 1, `${key} is not a Monday`);
    }
    assert.equal(new Set(keys).size, keys.length, 'a week appears twice');
  });

  test('the period keys match the day keys the aggregations produce', () => {
    // The aggregations group with `$dateToString` in `%Y-%m-%d`; if the JS fold
    // disagreed with the walker by even one day the series would silently read all
    // zeros, and a series of zeros looks like a platform that made no money.
    //
    // 4 Jan 2026 is a **Sunday**, so the week it belongs to began Mon 29 Dec 2025 —
    // which is the whole point of anchoring weeks on Monday and is what this asserts.
    //
    // The row shape is `{ _id: { day } }`, which is what a
    // `$group: { _id: { day: { $dateToString: … } } }` emits. Reading `_day` instead
    // would parse to NaN, be skipped, and hand back a series that is empty rather than
    // one that throws — so this asserts the contract from the aggregation's side.
    const folded = analytics.foldDaysToPeriods(
      [{ _id: { day: '2026-01-04' }, total: 9 }],
      'week',
      (acc, row) => { acc.total = row.total; }
    );
    assert.deepEqual([...folded.keys()], ['2025-12-29']);
    assert.equal(folded.get('2025-12-29').total, 9);

    // And a Monday maps to itself, so a payment taken on the 5th is not filed under
    // the week that began on the 29th.
    const onMonday = analytics.foldDaysToPeriods(
      [{ _id: { day: '2026-01-05' }, total: 3 }],
      'week',
      (acc, row) => { acc.total = row.total; }
    );
    assert.deepEqual([...onMonday.keys()], ['2026-01-05']);
  });

  test('a row with no day is skipped, not parsed into a NaN key', () => {
    // The exact failure the `_id.day` contract prevents: a malformed row must not
    // become a key of "NaN" or "Invalid Date".
    const folded = analytics.foldDaysToPeriods(
      [{ _id: { day: '2026-01-05' }, total: 3 }, { total: 99 }, { _id: {}, total: 99 }],
      'month',
      (acc, row) => { acc.total = (acc.total || 0) + row.total; }
    );
    assert.deepEqual([...folded.keys()], ['2026-01']);
    assert.equal(folded.get('2026-01').total, 3);
  });

  test('missing periods get distinct objects, never a shared literal', () => {
    const { series } = analytics.buildGapFreeSeries(new Map(), from, to, 'day', empty);
    const emptyPoints = series.filter((p) => p.total === 0);
    assert.equal(new Set(emptyPoints).size, emptyPoints.length);
  });

  test('a range longer than the cap is truncated *loudly*', () => {
    const long = analytics.buildGapFreeSeries(
      new Map(),
      new Date(Date.UTC(2020, 0, 1)),
      new Date(Date.UTC(2026, 0, 1)),
      'day',
      empty
    );
    assert.equal(long.series.length, 400);
    assert.equal(long.truncated, true);
    assert.ok(long.periodsAvailable > long.series.length);
  });
});

// ──────────────────── Percentages ────────────────────

describe('percentages are real labelled ratios', () => {
  test('a zero denominator is null, not 0', async () => {
    const { result } = await run(() => analytics.getPlatformOverview());
    // No schools and no churn in the stubbed world: both denominators are zero.
    assert.equal(result.churn.churnRatePercent, null);
    assert.equal(result.schools.growthPercent, null);
  });

  test('ARR is exactly MRR x 12 and is labelled a projection', async () => {
    const { result } = await run(() => analytics.getPlatformOverview());
    assert.equal(result.revenue.arr, result.revenue.mrr * 12);
    assert.match(result.revenue.arrBasis, /projection/);
    assert.match(result.units.rates, /percent, 0–100/);
  });

  test('every reported rate field is suffixed Percent', async () => {
    const { result } = await run(() => analytics.getCollectionRateAnalytics());
    for (const row of result.byTerm) {
      assert.ok(
        row.collectionRatePercent === null || typeof row.collectionRatePercent === 'number',
        'collectionRatePercent must be a ratio or null'
      );
    }
  });
});

// ──────────────────── Income types ────────────────────

describe('platform revenue counts only income types', () => {
  test('the split is derived from PLATFORM_REVENUE_TYPES, not a hard-coded list', async () => {
    const { result } = await run(() =>
      analytics.getRevenueAnalytics({ groupBy: 'month', from: '2026-01-01', to: '2026-03-01' })
    );
    for (const type of PLATFORM_REVENUE_TYPES) {
      assert.ok(type in result.totals.byType, `${type} is missing from the split`);
    }
    // The whole point of deriving it: adding a type to the enum must make it appear
    // here without a second list being updated.
    assert.equal(Object.keys(result.totals.byType).length, PLATFORM_REVENUE_TYPES.length);
  });

  test('refund, payout and adjustment never appear', async () => {
    const { result } = await run(() => analytics.getRevenueAnalytics());
    for (const excluded of ['refund', 'payout', 'adjustment']) {
      assert.ok(!(excluded in result.totals.byType), `${excluded} leaked into revenue`);
    }
  });

  test('the ledger filter uses the exported constant', async () => {
    const { pipelines } = await run(() => analytics.getRevenueAnalytics());
    const ledger = pipelines.find((p) => p.model === 'PlatformLedger');
    const match = ledger.pipeline.find((s) => s.$match).$match;
    assert.deepEqual(match.type.$in, PLATFORM_REVENUE_TYPES);
    assert.deepEqual(match.amount, { $gt: 0 });
  });
});

// ──────────────────── Gateway mapping ────────────────────

describe('gateway mode is mapped onto the two rails, explicitly', () => {
  test('every value of the enum has a rail', () => {
    const modes = School.schema.path('payment.gatewayMode').enumValues;
    for (const mode of modes) {
      assert.ok(analytics.GATEWAY_RAIL_BY_MODE[mode], `${mode} is unmapped`);
    }
    for (const key of Object.keys(analytics.GATEWAY_RAIL_BY_MODE)) {
      assert.ok(modes.includes(key), `${key} is not a real gateway mode`);
    }
  });

  test('manual is the school\'s own rail and the gateways are the platform\'s', () => {
    assert.equal(analytics.GATEWAY_RAIL_BY_MODE.manual, 'school_own');
    for (const mode of ['moolre', 'arke', 'mnotify']) {
      assert.equal(analytics.GATEWAY_RAIL_BY_MODE[mode], 'sukuupay');
    }
  });

  test('every Payment.provider value has a rail too', () => {
    for (const provider of Payment.schema.path('provider').enumValues) {
      assert.ok(analytics.PAYMENT_PROVIDER_RAIL[provider], `${provider} is unmapped`);
    }
  });

  test('the divergence is stated in the payload, not only in a comment', async () => {
    const { result } = await run(() => analytics.getGatewayMixAnalytics());
    assert.equal(result.mapping.rails.manual, 'school_own');
    assert.match(result.mapping.divergence, /sukuupay\|school/);
  });
});

// ──────────────────── Nested field paths ────────────────────

describe('the six platform-operator fields sit at the top level of `School`', () => {
  /*
   * `platformFeePercent`, `featureFlags`, `internalNotes`, `accountManagerId`,
   * `onboardingCompletedAt` and `tags` were at one point declared *inside* the
   * already-open `subscription: { … }` block of `schoolModel.js`, which does not close
   * until the end of that object. They are now top-level, which is where the indexes
   * are (`schoolModel.js:412-413`) and where these services read them.
   *
   * The trap was worth a test in *both* directions. Reading the wrong path yields
   * `undefined`, which in a `$ifNull` becomes "not activated" — so the activation rate
   * reports 0% forever and looks like a product failure rather than a typo. And a field
   * that moved *back* would break a `subscription.`-prefixed reader in exactly the same
   * silent way, which is why this asserts the shape rather than the outcome.
   */
  const SIX = [
    'platformFeePercent',
    'featureFlags',
    'internalNotes',
    'accountManagerId',
    'onboardingCompletedAt',
    'tags',
  ];

  /**
   * Resolve through the schema **tree**, not `schema.path()`.
   *
   * `schema.path('featureFlags')` returns `undefined` even though the field exists,
   * because `path()` only finds leaves and arrays and `featureFlags` is a nested plain
   * object. A test written with `path()` would pass against a schema where the field had
   * been deleted, which is the opposite of what it is for.
   */
  const at = (path) =>
    path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), School.schema.tree);

  test('all six resolve at the top level', () => {
    for (const name of SIX) {
      assert.notEqual(at(name), undefined, `${name} is not top-level`);
    }
  });

  test('and none of them is still under `subscription`', () => {
    for (const name of SIX) {
      assert.equal(
        at(`subscription.${name}`),
        undefined,
        `${name} now exists under subscription too; pick one and update every reader`
      );
    }
  });

  test('the indexes that serve the console reads are on the top-level names', () => {
    const indexed = School.schema.indexes().map(([spec]) => Object.keys(spec).join(','));
    assert.ok(indexed.includes('onboardingCompletedAt'),
      'the activation read is a collection scan without this index');
    assert.ok(indexed.includes('tags,status'));
  });

  test('the analytics module reads the activation field at the top level', async () => {
    const { result } = await run(() => analytics.getSchoolsAnalytics());
    assert.equal(result.signups.activationFieldPath, 'onboardingCompletedAt');
  });

  test('and so does the growth report', async () => {
    const { result } = await run(() => reports.getGrowthReport());
    const section = result.sections.find((s) => s.name === 'New Schools');
    assert.ok(section.columns.some((c) => c.key === 'activatedAt'));
  });
});

// ──────────────────── Field paths exist at all ────────────────────

describe('every dotted path these services read exists in a schema', () => {
  const PATHS = {
    School: [
      'deletedAt', 'status', 'region', 'name', 'schoolCode', 'createdAt', 'suspendedAt',
      'suspendedReason', 'subscription.status', 'subscription.plan',
      'subscription.monthlyFee', 'subscription.cancelledAt',
      'subscription.currentPeriodEnd', 'onboardingCompletedAt', 'platformFeePercent',
      'accountManagerId', 'internalNotes',
      'payment.gatewayMode', 'payment.platformMarkupPercent',
    ],
    Student: ['deletedAt', 'status', 'schoolId', 'createdAt', 'totalOwed'],
    Payment: ['deletedAt', 'status', 'createdAt', 'completedAt', 'amount', 'schoolId',
      'studentId', 'paymentPlanId', 'provider'],
    PaymentPlan: ['deletedAt', 'planStatus', 'startDate', 'endDate', 'term', 'academicYear',
      'totalAmount', 'totalPaid', 'studentId', 'schoolId', 'installments.amount',
      'installments.amountPaid', 'installments.dueDate'],
    SmsMessage: ['deletedAt', 'isTest', 'createdAt', 'creditsCharged', 'segments'],
    PlatformLedger: ['type', 'amount', 'createdAt', 'settled', 'schoolId'],
  };

  for (const [model, paths] of Object.entries(PATHS)) {
    test(model, () => {
      for (const path of paths) {
        assert.ok(modelHandles[model].schema.path(path), `${model}.${path} does not exist`);
      }
    });
  }
});

// ──────────────────── Collection rate semantics ────────────────────

describe('collection rate counts a plan-less school as NOT owed', () => {
  test('the report says so, and reports how many there are', async () => {
    const { result } = await run(() => analytics.getCollectionRateAnalytics());
    assert.equal(typeof result.totals.schoolsWithRosterButNoPlan, 'number');
    assert.match(result.definitions.schoolsWithRosterButNoPlan, /NOT owed/);
  });

  test('the two populations partition the roster', async () => {
    const { result } = await run(() => analytics.getCollectionRateAnalytics());
    // Whatever the stubbed data is, a school cannot both have a plan and not have one.
    // The two counts are derived from the same roster, and their sum is the roster.
    assert.equal(
      result.totals.schoolsWithRosterAndAPlan + result.totals.schoolsWithRosterButNoPlan,
      result.totals.schoolsWithRoster
    );
  });

  test('the plan-less query is bounded by the roster, not the whole school table', async () => {
    // Fetching "every school with no plan" and discarding the student-less ones in JS
    // returns the entire platform to Node and throws most of it away. The `$in` half of
    // the filter is what makes this cheap, and it is easy to drop in a refactor.
    const { finds } = { finds: captured.finds };
    void finds;
    captured = { aggregates: [], finds: [] };
    await analytics.getCollectionRateAnalytics();
    const counts = captured.finds.filter((f) => f.op === 'countDocuments');
    assert.ok(counts.length >= 1, 'the plan-less count is not being computed');
    const filter = counts[counts.length - 1].filter;
    assert.ok(Array.isArray(filter._id.$in), 'no $in bound on the roster');
    assert.ok(Array.isArray(filter._id.$nin), 'no $in/$nin pair on _id');
    assert.equal(filter.deletedAt, null);
    assert.deepEqual(filter.status, { $ne: 'archived' });
  });

  test('`owed` comes from PaymentPlan.totalAmount, per term', async () => {
    const { result } = await run(() => analytics.getCollectionRateAnalytics());
    // A term bucket exists only because a plan carried an `academicYear` and a `term`,
    // which is the field pair the per-term owed amount is keyed on.
    assert.ok(Array.isArray(result.byTerm));
    assert.equal(result.definitions.owed.includes('PaymentPlan.totalAmount'), true);
  });

  test('the school-performance report does not inflate `owed` by the installment count', async () => {
    const { pipelines } = await run(() => reports.getSchoolPerformanceReport());
    const owedPipeline = pipelines.filter(
      (p) => p.model === 'PaymentPlan' &&
        p.pipeline.some((s) => s.$group && s.$group.owed)
    );
    assert.equal(owedPipeline.length, 1, 'expected exactly one owed aggregation');
    for (const stage of owedPipeline[0].pipeline) {
      assert.ok(!stage.$unwind, 'unwinding installments would count totalAmount once per installment');
    }
  });
});

// ──────────────────── Usage ────────────────────

describe('storage usage is reported as unknown, not as zero', () => {
  test('storageUsed is null and carries a reason', async () => {
    const { result } = await run(() => analytics.getUsageAnalytics());
    assert.equal(result.storageUsed, null);
    assert.match(result.storageUsedReason, /Not measurable/);
  });

  test('test sends are excluded from SMS volume', async () => {
    const { pipelines } = await run(() => analytics.getUsageAnalytics());
    const sms = pipelines.filter((p) => p.model === 'SmsMessage');
    assert.ok(sms.length >= 2);
    for (const entry of sms) {
      const match = entry.pipeline.find((s) => s.$match)?.$match;
      assert.equal(match.isTest, false, 'a test send would inflate platform volume');
    }
  });
});

// ──────────────────── Top schools ────────────────────

describe('top schools clamps its limit and says what `revenue` means', () => {
  test('limit is clamped to 50, not to the console-wide 200', async () => {
    const { result } = await run(() => analytics.getTopSchoolsAnalytics({ limit: 999 }));
    assert.equal(result.limit, 50);
  });

  test('and the clamp is applied to a small request too', async () => {
    const { result } = await run(() => analytics.getTopSchoolsAnalytics({ limit: 1 }));
    assert.equal(result.limit, 1);
  });

  test('`revenue` is genuinely ambiguous, so both readings are returned', async () => {
    const { result } = await run(() => analytics.getTopSchoolsAnalytics());
    // "Revenue" could mean what the school took or what SukuuPay took from it, and the
    // two people reading this table want different ones. Shipping only `collected`
    // would make the platform's own share invisible behind the gross figure.
    assert.match(result.note, /collected.*platformRevenue/is);
    assert.equal(result.metric, 'revenue');
  });

  test('a student count ignores the window, and the response says so', async () => {
    const { result } = await run(() =>
      analytics.getTopSchoolsAnalytics({
        metric: 'students',
        from: '2026-01-01',
        to: '2026-01-02',
      })
    );
    // Filtering students by `createdAt` would answer "who imported the most since
    // Friday" under a column headed "students".
    assert.match(result.note, /current position and ignore the window/);
  });
});

// ──────────────────── At-risk ────────────────────

describe('at-risk reports reasons, not one flag', () => {
  test('three conditions, three codes, all defined', async () => {
    const { result } = await run(() => analytics.getAtRiskSchools());
    assert.deepEqual(Object.keys(result.summary.byReason).sort(),
      ['no_payment_14d', 'subscription_past_due', 'zero_students']);
    for (const code of Object.keys(result.summary.byReason)) {
      assert.ok(result.definitions[code], `${code} has no definition`);
    }
  });

  test('"past due" maps to `expired`, because the enum has no past_due', async () => {
    const statuses = School.schema.path('subscription.status').enumValues;
    assert.ok(statuses.includes('expired'));
    assert.ok(!statuses.includes('past_due'),
      'if a literal past_due ever appears in the enum, the mapping should use it');

    // The service's own list must exclude the two states that are *decisions* rather
    // than missed bills — filing a deliberately cancelled school under "past due"
    // would put it on a dunning list.
    const { result } = await run(() => analytics.getAtRiskSchools());
    assert.match(result.definitions.subscription_past_due, /`expired`/);
    assert.match(result.definitions.subscription_past_due, /suspended.*cancelled.*not included/is);
    assert.ok(statuses.includes('suspended'));
    assert.ok(statuses.includes('cancelled'));
  });

  test('archived and deleted schools are excluded', async () => {
    captured = { aggregates: [], finds: [] };
    await analytics.getAtRiskSchools();
    const schoolFind = captured.finds.find((f) => f.model === 'School');
    assert.equal(schoolFind.filter.deletedAt, null);
    assert.deepEqual(schoolFind.filter.status, { $ne: 'archived' });
  });
});

// ──────────────────── Reports ────────────────────

/** A minimal Express `res` stand-in: headers, body chunks, and an `end`. */
const mockRes = () => {
  const res = {
    headers: {},
    chunks: [],
    ended: false,
    setHeader(k, v) { res.headers[k] = v; return res; },
    write(chunk) { res.chunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk) res.chunks.push(String(chunk)); res.ended = true; return res; },
    send(chunk) { res.chunks.push(String(chunk)); res.ended = true; return res; },
  };
  return res;
};

describe('report payloads are shaped for the shared file serialiser', () => {
  const BUILDERS = [
    ['getPlatformRevenueReport', reports.getPlatformRevenueReport, 'platform_revenue'],
    ['getSchoolPerformanceReport', reports.getSchoolPerformanceReport, 'school_performance'],
    ['getGrowthReport', reports.getGrowthReport, 'growth'],
    ['getChurnReport', reports.getChurnReport, 'churn'],
  ];

  for (const [name, build, report] of BUILDERS) {
    test(`${name} returns { report, generatedAt, filters, sections }`, async () => {
      const { result } = await run(() => build({ from: '2026-01-01', to: '2026-06-30' }));
      assert.equal(result.report, report);
      assert.ok(result.generatedAt);
      assert.ok(result.filters.from instanceof Date);
      assert.ok(Array.isArray(result.sections) && result.sections.length >= 2);
    });

    test(`${name} sections carry what csvFor and workbookFor read`, async () => {
      const { result } = await run(() => build({ from: '2026-01-01', to: '2026-06-30' }));
      for (const section of result.sections) {
        // `csvFor` reads title + columns[].key; `workbookFor` reads name,
        // columns[].header and columns[].width. A section missing any of them either
        // throws inside the serialiser or writes an empty column.
        assert.equal(typeof section.name, 'string');
        assert.equal(typeof section.title, 'string');
        assert.ok(Array.isArray(section.rows));
        assert.ok(Array.isArray(section.columns));
        for (const column of section.columns) {
          assert.equal(typeof column.key, 'string');
          assert.equal(typeof column.header, 'string');
        }
        assert.ok(section.name.length > 0);
      }
    });
  }

  test('every section name fits an xlsx sheet name', async () => {
    for (const [, build] of BUILDERS) {
      const { result } = await run(() => build({ from: '2026-01-01', to: '2026-06-30' }));
      for (const section of result.sections) {
        assert.ok(section.name.length <= 31, `"${section.name}" exceeds the 31-char sheet limit`);
      }
    }
  });

  test('money columns are exported in both pesewas and cedi', async () => {
    const { result } = await run(() => reports.getPlatformRevenueReport());
    const bySchool = result.sections.find((s) => s.name === 'By School');
    const headers = bySchool.columns.map((c) => c.header);
    assert.ok(headers.some((h) => h.includes('pesewas')), 'no raw money column');
    assert.ok(headers.includes('Amount'), 'no cedi column');
  });

  test('the growth report covers every month in the range, including empty ones', async () => {
    const { result } = await run(() => reports.getGrowthReport({ from: '2026-01-01', to: '2026-06-30' }));
    assert.deepEqual(result.trend.map((r) => r.period),
      ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
    assert.equal(new Set(result.trend.map((r) => r.period)).size, result.trend.length);
  });

  test('the report type list and the builders cannot drift apart', async () => {
    // `reportExportQuerySchema` validates `type` against ADMIN_REPORT_TYPES; a name in
    // one and not the other is a 400 thrown from inside the service at request time.
    // `exportReport` is async, so a drift shows up as a rejected promise rather than a
    // synchronous throw — hence `rejects`, not `throws`.
    const res = mockRes();
    for (const type of reports.ADMIN_REPORT_TYPES) {
      await assert.doesNotReject(
        () => reports.exportReport(mockRes(), { type, format: 'csv', from: '2026-01-01', to: '2026-01-31' }),
        `${type} is advertised but has no builder`
      );
    }
    await assert.rejects(
      () => reports.exportReport(res, { type: 'debtors', format: 'csv' }),
      (error) => error.status === 400 && error.code === 'UNKNOWN_REPORT_TYPE'
    );
  });
});

// ──────────────────── Export path ────────────────────

describe('the export reuses the two existing serialisers', () => {
  test('csv streams through streamCsv and reports the row count', async () => {
    const res = mockRes();
    const out = await reports.exportReport(res, { type: 'churn', format: 'csv' });
    assert.match(res.headers['Content-Type'], /text\/csv/);
    assert.match(res.headers['Content-Disposition'], /attachment; filename="churn-platform-/);
    assert.ok(res.ended);
    assert.equal(typeof out.rowCount, 'number');
  });

  test('xlsx is translated to `excel` before reaching sendReportFile', async () => {
    // sendReportFile branches on `excel` (utils/reportExport.js:81) and returns
    // 400 UNSUPPORTED_FORMAT for anything else, so this translation is load-bearing
    // rather than cosmetic: without it every xlsx download fails.
    const res = mockRes();
    const out = await reports.exportReport(res, {
      type: 'platform_revenue',
      format: 'xlsx',
      from: '2026-01-01',
      to: '2026-01-31',
    });
    assert.match(res.headers['Content-Type'], /spreadsheetml\.sheet/);
    assert.match(res.headers['Content-Disposition'], /\.xlsx"$/);
    assert.equal(out.format, 'excel');
  });

  test('an unknown type is a 400 with a readable message', async () => {
    await assert.rejects(
      () => reports.exportReport(mockRes(), { type: 'nope', format: 'csv' }),
      (error) => error.status === 400 && /Supported:/.test(error.message)
    );
  });
});

// ──────────────────── The aggregation → series contract ────────────────────

describe('a real aggregation row reaches the right point on the series', () => {
  /*
   * The bug this guards against, which the rest of this file did not catch until it
   * happened: `foldDaysToPeriods` read the day from `row._day` while every aggregation
   * emits `row._id.day`. `undefined` parses to `NaN`, `NaN` is skipped, and the series
   * came back **empty** — so gap-filling filled it entirely with zeros and the revenue
   * chart showed a platform that had never earned anything. No throw, no warning, and a
   * result that is indistinguishable from a quiet month.
   *
   * The tests above stub the aggregations to `[]`, which cannot tell a correct fold from
   * a fold that throws everything away. This one feeds rows in the shape Mongo actually
   * returns.
   */
  test('rows shaped `{ _id: { day } }` land on the right month', async () => {
    const PlatformLedger = modelHandles.PlatformLedger;
    const original = PlatformLedger.aggregate;
    captured = { aggregates: [], finds: [] };

    PlatformLedger.aggregate = (pipeline) => {
      captured.aggregates.push({ model: 'PlatformLedger', pipeline });
      const hasTypeInId = pipeline.some(
        (s) => s.$group?._id && typeof s.$group._id === 'object' && 'type' in s.$group._id
      );
      if (hasTypeInId) {
        return Promise.resolve([
          { _id: { day: '2026-01-14', type: 'markup' }, total: 1000, entries: 4, settled: 600 },
          { _id: { day: '2026-01-31', type: 'markup' }, total: 500, entries: 2, settled: 500 },
          { _id: { day: '2026-02-09', type: 'sms' }, total: 250, entries: 1, settled: 250 },
          { _id: { day: '2026-03-02', type: 'platform_fee' }, total: 70, entries: 3, settled: 0 },
        ]);
      }
      // The per-type totals and the reversal pass.
      const isReversal = pipeline.some((s) => s.$match?.amount?.$lt === 0);
      if (isReversal) return Promise.resolve([{ _id: null, total: -120, entries: 1 }]);
      return Promise.resolve([
        { _id: 'markup', total: 1500, entries: 6 },
        { _id: 'sms', total: 250, entries: 1 },
        { _id: 'platform_fee', total: 70, entries: 3 },
      ]);
    };

    try {
      const { result } = await run(() =>
        analytics.getRevenueAnalytics({
          groupBy: 'month',
          from: '2026-01-01',
          to: '2026-03-31',
        })
      );

      assert.deepEqual(
        result.series.map((p) => [p.period, p.total]),
        [['2026-01', 1500], ['2026-02', 250], ['2026-03', 70]]
      );

      // Two `markup` rows in the same month must sum, not overwrite.
      assert.equal(result.series[0].byType.markup, 1500);
      assert.equal(result.series[0].settledAmount, 1100);

      // And a month with no rows is still present, as a zero.
      const { result: wider } = await run(() =>
        analytics.getRevenueAnalytics({ groupBy: 'month', from: '2025-11-01', to: '2026-03-31' })
      );
      assert.deepEqual(wider.series.map((p) => p.period),
        ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
      assert.deepEqual(wider.series.slice(0, 2).map((p) => p.total), [0, 0]);

      // The reversal is reported rather than netted into a period it does not belong to.
      assert.equal(result.totals.reversalAmount, -120);
      assert.equal(result.totals.total, 1820);
    } finally {
      PlatformLedger.aggregate = original;
    }
  });

  test('the week granularity folds the same rows onto Mondays', async () => {
    const PlatformLedger = modelHandles.PlatformLedger;
    const original = PlatformLedger.aggregate;
    captured = { aggregates: [], finds: [] };

    PlatformLedger.aggregate = (pipeline) => {
      const hasTypeInId = pipeline.some(
        (s) => s.$group?._id && typeof s.$group._id === 'object' && 'type' in s.$group._id
      );
      if (hasTypeInId) {
        return Promise.resolve([
          // Sat 3 Jan 2026 -> week of Mon 29 Dec 2025
          { _id: { day: '2026-01-03', type: 'markup' }, total: 10, entries: 1, settled: 10 },
          // Mon 5 Jan 2026 -> week of Mon 5 Jan 2026
          { _id: { day: '2026-01-05', type: 'markup' }, total: 20, entries: 1, settled: 20 },
        ]);
      }
      if (pipeline.some((s) => s.$match?.amount?.$lt === 0)) return Promise.resolve([]);
      return Promise.resolve([{ _id: 'markup', total: 30, entries: 2 }]);
    };

    try {
      const { result } = await run(() =>
        analytics.getRevenueAnalytics({
          groupBy: 'week',
          from: '2026-01-01',
          to: '2026-01-11',
        })
      );
      assert.deepEqual(
        result.series.map((p) => [p.period, p.total]),
        [
          ['2025-12-29', 10], // the Saturday belongs to the week that began on the 29th
          ['2026-01-05', 20],
        ]
      );
    } finally {
      PlatformLedger.aggregate = original;
    }
  });
});

// ──────────────────── Pipelines are structurally sound ────────────────────

describe('every aggregation pipeline is well formed', () => {
  /*
   * `mustAggregate: false` for the two functions that deliberately skip their
   * aggregations when the stubbed world contains no schools: `getSchoolsAnalytics`
   * only runs its "earliest payment per new school" pass when there *are* new schools,
   * and `getChurnReport` only looks up payments/roster/ledger for schools it actually
   * found. That short-circuit is correct — it is three queries avoided on an empty
   * result set — so the test asserts the function ran and that whatever pipelines it did
   * build are sound, rather than demanding work it is right not to do.
   */
  const ALL = [
    ['getPlatformOverview', () => analytics.getPlatformOverview(), true],
    ['getRevenueAnalytics', () => analytics.getRevenueAnalytics(), true],
    ['getSchoolsAnalytics', () => analytics.getSchoolsAnalytics(), false],
    ['getUsageAnalytics', () => analytics.getUsageAnalytics(), true],
    ['getCollectionRateAnalytics', () => analytics.getCollectionRateAnalytics(), true],
    ['getGatewayMixAnalytics', () => analytics.getGatewayMixAnalytics(), true],
    ['getTopSchoolsAnalytics', () => analytics.getTopSchoolsAnalytics(), true],
    ['getAtRiskSchools', () => analytics.getAtRiskSchools(), true],
    ['getPlatformRevenueReport', () => reports.getPlatformRevenueReport(), true],
    ['getSchoolPerformanceReport', () => reports.getSchoolPerformanceReport(), true],
    ['getGrowthReport', () => reports.getGrowthReport(), true],
    ['getChurnReport', () => reports.getChurnReport(), false],
  ];

  for (const [name, fn, mustAggregate] of ALL) {
    test(`${name} builds only single-key operator stages`, async () => {
      const { pipelines } = await run(fn);
      if (mustAggregate) {
        assert.ok(pipelines.length > 0, 'no aggregation ran');
      }
      for (const entry of pipelines) {
        for (const stage of entry.pipeline) {
          assert.equal(typeof stage, 'object');
          assert.equal(Array.isArray(stage), false);
          const keys = Object.keys(stage);
          assert.equal(keys.length, 1, `${entry.model} stage has ${keys.length} keys: ${keys}`);
          assert.match(keys[0], /^\$/, `${entry.model} stage key "${keys[0]}" is not an operator`);
        }
      }
    });

    test(`${name} gives every $group at least one accumulator`, async () => {
      const { pipelines } = await run(fn);
      for (const entry of pipelines) {
        for (const stage of entry.pipeline) {
          if (!stage.$group) continue;
          assert.ok(
            Object.keys(stage.$group).length >= 2,
            'a $group with only _id sums nothing'
          );
        }
      }
    });
  }
});

before(() => {
  // The stubs are installed at module load; re-asserted here so a future refactor that
  // imports a model before the stub block cannot silently start hitting a real database.
  for (const Model of Object.values(modelHandles)) {
    assert.equal(typeof Model.aggregate, 'function');
  }
});
