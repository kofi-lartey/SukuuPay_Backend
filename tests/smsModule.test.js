// Contract tests for the SMS reminders module.
//
//   npm test
//
// A pure unit suite — no database, no network — covering the two layers where
// the consequential defects in a messaging module live:
//
//   1. The Joi contracts. The dangerous failure here is not a malformed request
//      being rejected; it is a *well-formed* one that costs a school money. A
//      schema that accepts `minBalance: 0` for `all_owing` invites a broadcast to
//      every settled parent; one that accepts a negative `overdueDays` labels
//      everyone overdue. Both are silent, both are billed, and neither shows up
//      as a validation error.
//
//   2. The route table. Two of these routes are literal siblings of a
//      parameterised one — `/sms/jobs/drain` beside `/sms/jobs/:jobId`, and
//      `/sms/templates/preview` beside `/sms/templates/:templateId`. Express
//      matches in registration order, so a literal declared after its parameter
//      is unreachable and the word "drain" is captured as a job id. That class of
//      bug is invisible to a schema test and obvious here.
//
// What this file cannot cover, and needs a database to test: the atomic
// `$inc`-with-`$gte` credit charge, the job worker's batch loop, the snapshot
// round trip, and the DLR refund. Those need MongoDB and a mocked gateway; they
// are the remaining gap, and the parts this file does cover are the ones a
// schema regression would break silently.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const load = async () => import('../src/validations/sms.validation.js');

/** A well-formed 24-character Mongo id. */
const MONGO_ID = '65f1c2a4e8b9d0123456789a';

/**
 * Validate the way the request does.
 *
 * `middleware/validate.js` runs with `{ abortEarly: true, stripUnknown: true,
 * convert: true }`. `stripUnknown` is what decides whether a client can smuggle
 * a field past a schema, so a direct `validate()` call without it would not test
 * what production actually does.
 */
const check = (schema, payload) =>
  schema.validate(payload, { abortEarly: true, stripUnknown: true, convert: true });

const ok = (result, label) =>
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);

// ──────────────────── Audience ────────────────────
describe('audience validation', () => {
  test('class without a class name is rejected', async () => {
    const { previewAudienceSchema } = await load();
    const result = check(previewAudienceSchema, { audience: { type: 'class' } });

    assert.ok(result.error, 'a class audience with no class should be rejected');
    assert.match(result.error.message, /class/i);
  });

  test('students without ids is rejected', async () => {
    const { previewAudienceSchema } = await load();
    const result = check(previewAudienceSchema, { audience: { type: 'students' } });

    assert.ok(result.error, 'a students audience with no ids should be rejected');
    assert.match(result.error.message, /studentIds/);
  });

  test('a class audience carrying the class is accepted', async () => {
    const { previewAudienceSchema } = await load();
    ok(check(previewAudienceSchema, { audience: { type: 'class', class: 'JHS 2A' } }), 'class audience');
  });

  test('several classes are one audience, not a validation error', async () => {
    const { previewAudienceSchema } = await load();
    const result = check(previewAudienceSchema, { audience: { type: 'class', class: ['JHS 2A', 'JHS 3B'] } });
    ok(result, 'two classes');
    assert.deepEqual(result.value.audience.class, ['JHS 2A', 'JHS 3B']);
  });

  test('an owing rule with a zero balance floor is rejected', async () => {
    const { previewAudienceSchema } = await load();
    // The one that matters. `all_owing` with `minBalance: 0` is a broadcast to
    // every parent who has already paid — billed, and the exact complaint this
    // module is supposed to make impossible.
    ['all_owing', 'overdue', 'installment_due_soon', 'at_risk'].forEach((type) => {
      const result = check(previewAudienceSchema, { audience: { type, minBalance: 0 } });
      assert.ok(result.error, `${type} with minBalance 0 should be rejected`);
      assert.match(result.error.message, /minBalance/);
    });
  });

  test('at_risk accepts a due-soon window', async () => {
    const { previewAudienceSchema } = await load();
    // The compliance dashboard's "chase everyone at risk" button is this rule, and
    // the window is the one thing a bursar needs to be able to widen — 3 days to
    // this week, 14 to next fortnight.
    ok(
      check(previewAudienceSchema, { audience: { type: 'at_risk', minBalance: 1, dueSoonDays: 14 } }),
      'at_risk with a 14-day window'
    );
    assert.ok(
      check(previewAudienceSchema, { audience: { type: 'at_risk', dueSoonDays: 0 } }).error,
      'a zero-day window would make the tranche branch match only today'
    );
  });

  test('whole school requires the zero-balance opt-in', async () => {
    const { previewAudienceSchema } = await load();
    assert.ok(
      check(previewAudienceSchema, { audience: { type: 'all', minBalance: 1 } }).error,
      'type "all" with a positive floor contradicts itself'
    );
    ok(
      check(previewAudienceSchema, { audience: { type: 'all', includeZeroBalance: true } }),
      'type "all" with the opt-in'
    );
  });

  test('negative day windows are rejected', async () => {
    const { previewAudienceSchema } = await load();
    // `overdueDays: -1` makes every student overdue, including those who just
    // enrolled. A grace period of -1 does the same for a different reason.
    assert.ok(check(previewAudienceSchema, { audience: { type: 'overdue', overdueDays: -1 } }).error);
    assert.ok(check(previewAudienceSchema, { audience: { type: 'overdue', gracePeriodDays: -5 } }).error);
    assert.ok(
      check(previewAudienceSchema, { audience: { type: 'installment_due_soon', dueSoonDays: 0 } }).error
    );
  });

  test('the defaults are the ones the copy promises', async () => {
    const { previewAudienceSchema } = await load();
    const { value } = check(previewAudienceSchema, { audience: { type: 'overdue' } });

    // 30 days is Ghana's statutory grace period under the 1998 Act, and 48 hours
    // is the "exclude recent payers" window the design's own copy states. If
    // these defaults change, the sentence "Past statutory 30-day grace period"
    // on the audience card becomes false.
    assert.equal(value.audience.minBalance, 1, 'a settled parent must not be messaged by default');
    assert.equal(value.audience.overdueDays, 30);
    assert.equal(value.audience.gracePeriodDays, 30);
    assert.equal(value.audience.recentPaymentWindowHours, 48);
    assert.equal(value.audience.excludeRecentPayers, false, 'off by default; the UI opts in');
  });
});

// ──────────────────── Bulk send ────────────────────
describe('bulkSendSchema', () => {
  test('a body and a templateId together are rejected', async () => {
    const { bulkSendSchema } = await load();
    const result = check(bulkSendSchema, {
      audience: { type: 'all_owing' },
      body: 'Hello {parentName}',
      templateId: MONGO_ID,
    });

    assert.ok(result.error, 'sending both is ambiguous — which text goes out?');
    assert.match(result.error.message, /not both/);
  });

  test('neither a body nor a templateId is rejected', async () => {
    const { bulkSendSchema } = await load();
    assert.ok(check(bulkSendSchema, { audience: { type: 'all_owing' } }).error);
  });

  test('a whole-school broadcast needs explicit confirmation', async () => {
    const { bulkSendSchema } = await load();
    const body = 'Dear {parentName}';

    assert.ok(
      check(bulkSendSchema, {
        audience: { type: 'all', includeZeroBalance: true },
        body,
      }).error,
      'type "all" without confirmBroadcast should be rejected'
    );

    ok(
      check(bulkSendSchema, {
        audience: { type: 'all', includeZeroBalance: true },
        body,
        confirmBroadcast: true,
      }),
      'type "all" confirmed'
    );
  });

  test('an ordinary overdue broadcast does not need confirmation', async () => {
    const { bulkSendSchema } = await load();
    // A confirmation dialog on every routine overdue run trains a bursar to
    // click through it, which defeats the dialog on the whole-school case.
    ok(
      check(bulkSendSchema, { audience: { type: 'overdue' }, body: 'Dear {parentName}' }),
      'overdue broadcast'
    );
  });

  test('scheduling is bounded to a fortnight', async () => {
    const { bulkSendSchema } = await load();
    const at = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();

    // The whole feature hinges on this: with `.max('now', { offset })` — which
    // looks correct and silently compares against *now* on `date` — every one of
    // these is rejected and "Schedule for later" never works. So the near cases
    // are asserted as accepted, not only the far one as refused.
    ok(
      check(bulkSendSchema, { audience: { type: 'overdue' }, body: 'x', scheduledAt: at(1) }),
      'an hour out'
    );
    ok(
      check(bulkSendSchema, { audience: { type: 'overdue' }, body: 'x', scheduledAt: at(24 * 13) }),
      '13 days out'
    );
    assert.ok(
      check(bulkSendSchema, { audience: { type: 'overdue' }, body: 'x', scheduledAt: at(24 * 15) }).error,
      '15 days out should be refused — the quoted balance would be stale'
    );
  });

  test('a past schedule is refused', async () => {
    const { bulkSendSchema } = await load();
    assert.ok(
      check(bulkSendSchema, {
        audience: { type: 'overdue' },
        body: 'x',
        scheduledAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      }).error
    );
  });

  test('an unknown category is refused', async () => {
    const { bulkSendSchema } = await load();
    assert.ok(
      check(bulkSendSchema, {
        audience: { type: 'overdue' },
        body: 'x',
        category: 'scare_the_parents',
      }).error
    );
  });
});

// ──────────────────── Single send ────────────────────
describe('sendSmsSchema', () => {
  test('recipient "all" with a schedule is refused', async () => {
    const { sendSmsSchema } = await load();
    // Multi-recipient is a broadcast. A deferred one would hold a credit
    // reservation that nothing releases, so the schema refuses the combination
    // rather than the service discovering it after the charge.
    const result = check(sendSmsSchema, {
      recipient: 'all',
      body: 'Hello',
      scheduledAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    });

    assert.ok(result.error);
    assert.match(result.error.message, /bulk/);
  });

  test('parentId and primary_indexed require their companion field', async () => {
    const { sendSmsSchema } = await load();
    assert.ok(check(sendSmsSchema, { recipient: 'parentId', body: 'x' }).error);
    assert.ok(check(sendSmsSchema, { recipient: 'primary_indexed', body: 'x' }).error);
    ok(check(sendSmsSchema, { recipient: 'parentId', parentId: MONGO_ID, body: 'x' }), 'parentId + id');
    ok(check(sendSmsSchema, { recipient: 'primary_indexed', recipientIndex: 1, body: 'x' }), 'indexed');
  });

  test('an explicit number must look like a phone number', async () => {
    const { sendSmsSchema } = await load();
    assert.ok(check(sendSmsSchema, { body: 'x', to: 'call me' }).error);
    ok(check(sendSmsSchema, { body: 'x', to: '0244123456' }), 'local format');
    ok(check(sendSmsSchema, { body: 'x', to: '+233244123456' }), 'E.164');
  });
});

// ──────────────────── Templates ────────────────────
describe('createTemplateSchema', () => {
  test('a template with no name or body is refused', async () => {
    const { createTemplateSchema } = await load();
    assert.ok(check(createTemplateSchema, { body: 'Hello {parentName}' }).error);
    assert.ok(check(createTemplateSchema, { name: 'Term 1' }).error);
  });

  test('an unlisted token cannot be smuggled past as a requiredToken', async () => {
    const { createTemplateSchema } = await load();
    // `requiredTokens` is copied into the model's enum-validated array. A value
    // outside the vocabulary has to be refused here or it reaches the collection
    // as a token the composer cannot render.
    assert.ok(
      check(createTemplateSchema, {
        name: 'x',
        body: 'Hello',
        requiredTokens: ['notAToken'],
      }).error
    );
    ok(
      check(createTemplateSchema, { name: 'x', body: 'Hello', requiredTokens: ['balance'] }),
      'balance is a real token'
    );
  });

  test('the body is a usable object schema, not a re-wrapped one', async () => {
    // `Joi.object(anotherSchema)` throws "Object schema cannot be a joi schema" at
    // import time, which takes the whole route file down. Importing is the test.
    const { createTemplateSchema } = await load();
    ok(check(createTemplateSchema, { name: 'x', body: 'Hello' }), 'minimal template');
  });
});

// ──────────────────── Query schemas ────────────────────
describe('history and job queries', () => {
  test('a reversed date range is refused', async () => {
    const { listMessagesQuerySchema, listJobsQuerySchema } = await load();
    const range = { from: '2026-02-01', to: '2026-01-01' };

    assert.ok(check(listMessagesQuerySchema, range).error);
    assert.ok(check(listJobsQuerySchema, range).error);
  });

  test('an unbounded perPage is refused', async () => {
    const { listMessagesQuerySchema } = await load();
    // Without a cap, `?perPage=100000` is a full-collection load behind a
    // paginated endpoint. Note Joi returns the *input* alongside the error, so
    // this asserts the error rather than inspecting `value` — checking that a
    // rejected value came back clamped would pass for a schema that silently
    // accepted 100,000.
    const result = check(listMessagesQuerySchema, { perPage: 100000 });
    assert.ok(result.error, 'perPage=100000 should be refused');
  });

  test('test sends are excluded from history by default', async () => {
    const { listMessagesQuerySchema } = await load();
    // A school's own phone in its delivery statistics makes its rate meaningless.
    assert.equal(check(listMessagesQuerySchema, {}).value.includeTest, false);
    assert.equal(check(listMessagesQuerySchema, { includeTest: true }).value.includeTest, true);
  });
});

// ──────────────────── Route table ────────────────────
describe('sms routes', () => {
  test('every documented endpoint is registered', async () => {
    const { smsRoute } = await import('../src/routes/sms.routes.js');
    const registered = new Set(
      // Express stores methods lowercased, so they are uppercased here to read
      // like the routes they are asserting against.
      smsRoute.stack.map((layer) => {
        const method = Object.keys(layer.route?.methods || {})[0];
        return method ? `${method.toUpperCase()} ${layer.route.path}` : null;
      })
    );

    const expected = [
      'GET /sms/credits/:schoolId',
      'POST /sms/credits/top-up',
      'GET /sms/preview/:studentId',
      'POST /sms/audience/preview',
      'POST /sms/send/:studentId',
      'POST /sms/bulk',
      'GET /sms/jobs',
      'GET /sms/jobs/:jobId',
      'POST /sms/jobs/drain',
      'POST /sms/jobs/:jobId/cancel',
      'POST /sms/jobs/:jobId/process',
      'GET /sms/messages',
      'GET /sms/templates',
      'POST /sms/templates',
      'POST /sms/templates/preview',
      'PATCH /sms/templates/:templateId',
      'DELETE /sms/templates/:templateId',
    ];

    expected.forEach((route) => {
      assert.ok(registered.has(route), `${route} should be registered`);
    });
  });

  test('literal paths are registered before their parameterised siblings', async () => {
    // Express matches in order. `/sms/jobs/drain` declared after
    // `/sms/jobs/:jobId` is unreachable — "drain" is captured as a job id and
    // rejected by the id schema. Same for `/sms/templates/preview` against
    // `/sms/templates/:templateId`.
    const { smsRoute } = await import('../src/routes/sms.routes.js');
    const order = smsRoute.stack.map((layer) => layer.route?.path).filter(Boolean);

    const pairs = [
      { literal: '/sms/jobs/drain', parameterised: '/sms/jobs/:jobId' },
      { literal: '/sms/templates/preview', parameterised: '/sms/templates/:templateId' },
    ];

    pairs.forEach(({ literal, parameterised }) => {
      const literalIndex = order.indexOf(literal);
      const parameterIndex = order.indexOf(parameterised);

      assert.ok(literalIndex > -1, `${literal} should be registered`);
      assert.ok(parameterIndex > -1, `${parameterised} should be registered`);
      assert.ok(
        literalIndex < parameterIndex,
        `${literal} must precede ${parameterised} or it is unreachable`
      );
    });
  });

  test('every write is behind a role guard', async () => {
    // A teacher can read the history but must not be able to spend a school's
    // credit talking to its parents. The read/write split is the one thing here
    // that is a policy decision rather than a consequence of the code, so it is
    // asserted over the whole table rather than on the routes that happen to
    // matter today.
    const { smsRoute } = await import('../src/routes/sms.routes.js');

    const roleGuarded = (layer) => {
      const names = layer.route.stack.map((handler) => handler.name);
      return names.some((name) => name && name !== 'authenticate' && name !== 'validate');
    };

    let writes = 0;
    smsRoute.stack.forEach((layer) => {
      const method = Object.keys(layer.route?.methods || {})[0];
      if (!method || method === 'get') return;
      writes += 1;
      assert.ok(
        roleGuarded(layer),
        `${method.toUpperCase()} ${layer.route.path} has no authorize() in its chain`
      );
    });

    assert.ok(writes >= 8, `expected the write surface to still be present, found ${writes}`);
  });

  test('the queue drain and manual trigger are guarded', async () => {
    // Both are scheduler entry points with no school scope, and both spend credit.
    // A school admin triggering a drain would let one school occupy the worker
    // ahead of every other.
    const { smsRoute } = await import('../src/routes/sms.routes.js');

    ['/sms/jobs/drain', '/sms/jobs/:jobId/process'].forEach((path) => {
      const layer = smsRoute.stack.find((entry) => entry.route?.path === path);
      assert.ok(layer, `${path} should be registered`);
      const names = layer.route.stack.map((handler) => handler.name);
      assert.ok(
        names.some((name) => name && name !== 'authenticate' && name !== 'validate'),
        `${path} has no authorize() in its chain`
      );
    });
  });
});
