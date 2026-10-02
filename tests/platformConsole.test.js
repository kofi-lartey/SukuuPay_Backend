// Suite for the platform-owner console's guarantees: the impersonation boundary, the
// audit-action enum parity, the financial models' sign and idempotency rules, and the
// platform settings singleton.
//
//   npm test
//
// Why this exists. Every rule below is enforced in exactly one place and is invisible
// once that place is correct — which is what makes each of them worth a test rather
// than a comment:
//
//   - **Impersonation read-only.** `middleware/impersonation.js` refuses every write
//     by default and allows a short list. An allowlist that accidentally grew an entry
//     would let a platform owner delete a student's record while wearing that
//     school's identity, and nothing else would ever notice.
//   - **`isWriteAllowed` normalises the path.** It compares against the mount-relative
//     route, so a regression that compared the full `/api/admin/...` path would refuse
//     the one write that must always work — ending the impersonation itself.
//   - **Audit enum parity.** `AUDIT_ACTION_VALUES` in `config/constants.js` is the
//     validation filter; the array in `models/AuditLog.js` is the schema enum. A value
//     in one and not the other is a Mongoose ValidationError that
//     `utils/auditService.log` swallows into a `console.error` — so the entry silently
//     does not exist. This exact drift happened once already (see the comment above
//     `AUDIT_ACTIONS` in `AuditLog.js`).
//   - **Ledger signs.** A refund is a negative `PlatformLedger` entry, not an edit to
//     the positive one. If the sign convention is ever "helpfully" normalised, a refund
//     becomes a second sale.
//   - **One batch per window.** The unique index on
//     `{schoolId, periodStart, periodEnd}` is the only backstop against paying a
//     school twice for the same window.
//
// Pure unit tests: no database, no network, no live server. What is asserted is the
// *contract* — the exported rule, the enum parity, the schema bounds — rather than a
// round trip. Everything DB-backed needs a real run before release.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ─── The impersonation boundary ──────────────────────────────────────────────

describe('impersonation blocks writes by default', () => {
  test('every mutating method is refused outside the allowlist', async () => {
    const { isWriteAllowed } = await import('../src/middleware/impersonation.js');

    // A representative route from each dangerous area. If any of these ever becomes
    // writable, the impersonation has become a second school admin account.
    const forbidden = [
      '/schools/65f00000000000000000001/suspend',
      '/schools/65f00000000000000000001/markup',
      '/schools/65f00000000000000000001/gateway-mode',
      '/schools/65f00000000000000000001/feature-flags',
      '/schools/65f00000000000000000001',
      '/users/65f00000000000000000002/role',
      '/users/65f00000000000000000002/status',
      '/finance/disbursements/65f00000000000000000003/approve',
      '/payments/65f00000000000000000004/refund',
      '/announcements',
      '/sms/broadcast',
      '/health/maintenance-mode',
    ];

    for (const path of forbidden) {
      assert.equal(isWriteAllowed({ method: 'POST', baseUrl: '/api/admin', originalUrl: path }), false,
        `POST ${path} must be refused while impersonating`);
      assert.equal(isWriteAllowed({ method: 'DELETE', baseUrl: '/api/admin', originalUrl: path }), false,
        `DELETE ${path} must be refused while impersonating`);
    }
  });

  test('PATCH is refused too — the guard must not defer the decision to a new verb', async () => {
    const { isWriteAllowed } = await import('../src/middleware/impersonation.js');
    assert.equal(
      isWriteAllowed({ method: 'PATCH', baseUrl: '/api/admin', originalUrl: '/schools/65f00000000000000000001' }),
      false,
      'PATCH is a write; the console does not use it today and the guard must not assume that stays true'
    );
  });

  test('ending the impersonation is the one write always allowed', async () => {
    const { isWriteAllowed } = await import('../src/middleware/impersonation.js');
    assert.equal(
      isWriteAllowed({ method: 'POST', baseUrl: '/api/admin', originalUrl: '/impersonate/end' }),
      true,
      'An operator must always be able to leave; otherwise a session can outlast its usefulness with no exit'
    );
  });

  test('the allowlist holds nothing but the exit', async () => {
    // Every other read-only endpoint on this router is a GET, and the middleware only
    // blocks write methods — so there was never a reason to list them. Listing them
    // is how `/health` (a prefix) swept in `POST /health/maintenance-mode`, the one
    // call that takes the whole platform quiet.
    const { IMPERSONATION_WRITE_ALLOWLIST } = await import('../src/middleware/impersonation.js');
    assert.deepEqual(IMPERSONATION_WRITE_ALLOWLIST, ['/impersonate/end'],
      'a new entry is a decision about a specific endpoint, not a prefix to add casually');
  });

  test('the query string cannot change the match', async () => {
    const { isWriteAllowed } = await import('../src/middleware/impersonation.js');
    assert.equal(
      isWriteAllowed({
        method: 'POST',
        baseUrl: '/api/admin',
        originalUrl: '/impersonate/end?schoolId=65f00000000000000000001&force=true',
      }),
      true,
      'Parameters must not be able to opt a route back in'
    );
    assert.equal(
      isWriteAllowed({
        method: 'POST',
        baseUrl: '/api/admin',
        originalUrl: '/schools/65f00000000000000000001/suspend?next=/impersonate/end',
      }),
      false,
      'A "next" parameter must not be able to smuggle a path into the comparison'
    );
  });

  test('a trailing slash is the same route, not an unlisted one', async () => {
    const { isWriteAllowed } = await import('../src/middleware/impersonation.js');
    assert.equal(
      isWriteAllowed({ method: 'POST', baseUrl: '/api/admin', originalUrl: '/impersonate/end/' }),
      true,
      'Express matches these to the same handler; the guard must agree or it would refuse the exit'
    );
  });

  test('the allowlist is mount-relative, not hard-coded to /api/admin', async () => {
    const { isWriteAllowed } = await import('../src/middleware/impersonation.js');
    // The same router is mounted twice in this codebase (see routes/index.js and
    // index.js), so an allowlist written against one absolute prefix breaks on the
    // other — and it would break on the *exit* route.
    assert.equal(
      isWriteAllowed({ method: 'POST', baseUrl: '/api/v1/admin', originalUrl: '/api/v1/admin/impersonate/end' }),
      true
    );
  });

  test('nothing impersonating is a no-op — the guard never blocks a clean operator', async () => {
    // `handleImpersonation` exits before any query when the field is unset. Asserted
    // structurally rather than by invoking the middleware: the property is that it
    // reads `impersonatingSchoolId` first and returns `next()` on falsy.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/middleware/impersonation.js', import.meta.url), 'utf8');
    const firstBranch = source.indexOf('if (!user?.impersonatingSchoolId)');
    const sessionLookup = source.indexOf('ImpersonationSession.findOne');
    assert.ok(firstBranch > -1, 'the no-impersonation branch must exist');
    assert.ok(firstBranch < sessionLookup,
      'the no-impersonation branch must come before the session lookup, or every clean request costs a database round trip');
  });
});

// ─── Audit action enum parity ────────────────────────────────────────────────

describe('audit actions stay in step with the schema enum', () => {
  test('every AUDIT_ACTIONS value is a valid AuditLog.action', async () => {
    const { AUDIT_ACTIONS, AUDIT_ACTION_VALUES } = await import('../src/config/constants.js');
    const { AUDIT_ACTIONS: SCHEMA_ACTIONS } = await import('../src/models/AuditLog.js');

    for (const action of AUDIT_ACTION_VALUES) {
      assert.ok(SCHEMA_ACTIONS.includes(action),
        `${action} is offered to callers but is not on the model's enum — the write would fail a Mongoose ValidationError and be swallowed into a console.error`);
    }
    assert.equal(AUDIT_ACTION_VALUES.length, Object.keys(AUDIT_ACTIONS).length);
  });

  test('every schema enum value is reachable from the constants map', async () => {
    const { AUDIT_ACTION_VALUES } = await import('../src/config/constants.js');
    const { AUDIT_ACTIONS: SCHEMA_ACTIONS } = await import('../src/models/AuditLog.js');

    for (const action of SCHEMA_ACTIONS) {
      assert.ok(AUDIT_ACTION_VALUES.includes(action),
        `${action} exists on the model but not in constants.js — the audit-log filter dropdown cannot offer it`);
    }
  });

  test('the platform console has its own namespaced actions', async () => {
    const { AUDIT_ACTION_VALUES } = await import('../src/config/constants.js');
    for (const action of [
      'admin.impersonate_start',
      'admin.impersonate_end',
      'admin.disbursement_approve',
      'admin.payment_refund',
      'admin.export',
      'health.check',
    ]) {
      assert.ok(AUDIT_ACTION_VALUES.includes(action), `${action} is missing`);
    }
  });
});

// ─── ImpersonationSession ────────────────────────────────────────────────────

describe('an impersonation session is a durable record, not a field', () => {
  test('the model carries the fields the audit questions need', async () => {
    const { ImpersonationSession } = await import('../src/models/ImpersonationSession.js');
    const paths = ImpersonationSession.schema.paths;

    for (const field of [
      'superAdminId',
      'schoolId',
      'startedAt',
      'endedAt',
      'reason',
      'ipAddress',
      'userAgent',
      'actionsCount',
    ]) {
      assert.ok(paths[field], `${field} must exist — it answers a question that gets asked after the session`);
    }
  });

  test('reason is required with a floor, because "testing" is not a reason', async () => {
    const { ImpersonationSession } = await import('../src/models/ImpersonationSession.js');
    const reason = ImpersonationSession.schema.path('reason');

    assert.equal(reason.options.required, true);
    assert.equal(reason.options.minlength, 10);
    assert.equal(reason.options.maxlength, 500);
  });

  test('endedAt is a nullable timestamp, not an isActive boolean', async () => {
    const { ImpersonationSession } = await import('../src/models/ImpersonationSession.js');
    // The reason it is not a boolean: "when did it end, and for how long was the
    // door open" is the question an audit asks, and a flag answers neither.
    assert.equal(ImpersonationSession.schema.path('endedAt').instance, 'Date');
    assert.equal(ImpersonationSession.schema.path('endedAt').options.default, null);
    assert.equal(ImpersonationSession.schema.path('isActive'), undefined,
      'there is no isActive on this model; endedAt === null is the live-session test');
  });

  test('the User carries the pointer, and the pointer is a field rather than a token claim', async () => {
    const { User } = await import('../src/models/userModel.js');
    const impersonating = User.schema.path('impersonatingSchoolId');

    assert.ok(impersonating, 'User.impersonatingSchoolId must exist');
    assert.equal(impersonating.options.default, null);
    assert.ok(User.schema.path('impersonationSessionId'), 'User.impersonationSessionId must exist');
  });
});

// ─── PlatformLedger ──────────────────────────────────────────────────────────

describe('the platform ledger is signed and append-only', () => {
  test('a refund is a ledger type and is excluded from revenue', async () => {
    const { PLATFORM_REVENUE_TYPES } = await import('../src/models/PlatformLedger.js');

    assert.ok(PLATFORM_REVENUE_TYPES.includes('markup'));
    assert.ok(PLATFORM_REVENUE_TYPES.includes('platform_fee'));
    assert.ok(PLATFORM_REVENUE_TYPES.includes('subscription'));
    // Negative already, and it reverses something already counted — including it
    // would net it against revenue and silently restate a prior month.
    assert.ok(!PLATFORM_REVENUE_TYPES.includes('refund'));
    // Not income: it is what was forwarded to a school.
    assert.ok(!PLATFORM_REVENUE_TYPES.includes('payout'));
  });

  test('amount must be a non-zero integer — the sign is the direction', async () => {
    const { PlatformLedger } = await import('../src/models/PlatformLedger.js');
    const amount = PlatformLedger.schema.path('amount');

    const check = amount.options.validate.validator;
    assert.equal(check(-5000), true, 'a negative amount is a reversal and must be valid');
    assert.equal(check(5000), true);
    assert.equal(check(0), false, 'zero is not an entry; it is the absence of one');
    assert.equal(check(50.5), false, 'pesewas are integers');
  });

  test('the model has no update or delete path in the schema', async () => {
    const { PlatformLedger } = await import('../src/models/PlatformLedger.js');
    // The property is enforced by convention in the services, but it is asserted here
    // so that adding one is a deliberate act that fails a test.
    assert.equal(PlatformLedger.schema.path('amount').options.immutable, undefined,
      'amount is intentionally mutable at the schema level only so a *new* entry can be written; immutability of history is the services\' job');
    assert.equal(PlatformLedger.schema.path('updatedAt'), undefined,
      'updatedAt is absent by design (timestamps: { updatedAt: false }) — an append-only collection has nothing to update');
  });
});

// ─── DisbursementBatch ───────────────────────────────────────────────────────

describe('a school cannot be paid twice for one window', () => {
  test('the unique index is the last line of defence', async () => {
    const { DisbursementBatch } = await import('../src/models/DisbursementBatch.js');
    const compound = DisbursementBatch.schema.indexes().find(
      ([fields]) =>
        fields.schoolId === 1 && fields.periodStart === 1 && fields.periodEnd === 1
    );

    assert.ok(compound, 'the {schoolId, periodStart, periodEnd} index must exist');
    assert.equal(compound[1].unique, true,
      'without unique:true this index documents the intent and enforces nothing');
  });

  test('batchNumber is unique — a school cannot find its own payout without it', async () => {
    const { DisbursementBatch } = await import('../src/models/DisbursementBatch.js');
    assert.equal(DisbursementBatch.schema.path('batchNumber').options.unique, true);
  });

  test('paid is the only settled state, and failed stays open', async () => {
    const { OPEN_DISBURSEMENT_STATUSES, SETTLED_DISBURSEMENT_STATUSES, DisbursementBatch } =
      await import('../src/models/DisbursementBatch.js');

    const allowed = DisbursementBatch.schema.path('status').enumValues;
    for (const status of [...OPEN_DISBURSEMENT_STATUSES, ...SETTLED_DISBURSEMENT_STATUSES]) {
      assert.ok(allowed.includes(status), `${status} is used by the services but not on the model enum`);
    }

    // A failed batch is money that has NOT reached the school. Excluding it would
    // mean a payout that broke on Monday is quietly omitted from every subsequent
    // run and nothing anywhere says so.
    assert.ok(OPEN_DISBURSEMENT_STATUSES.includes('failed'),
      'failed batches must remain open so a run can retry them');
    assert.ok(!SETTLED_DISBURSEMENT_STATUSES.includes('failed'));
    assert.ok(!OPEN_DISBURSEMENT_STATUSES.includes('cancelled'), 'cancelled is the one terminal state left out');
  });
});

// ─── PlatformSettings ────────────────────────────────────────────────────────

describe('platform settings stay a singleton that defaults in code', () => {
  test('the defaults and the nested-branch list agree', async () => {
    const { DEFAULT_PLATFORM_SETTINGS, NESTED_PLATFORM_SETTINGS_BRANCHES } =
      await import('../src/models/PlatformSettings.js');

    for (const branch of NESTED_PLATFORM_SETTINGS_BRANCHES) {
      assert.ok(DEFAULT_PLATFORM_SETTINGS[branch],
        `${branch} is merged per-branch by both readers, so it must exist in the defaults or the merge writes undefined over it`);
    }
  });

  test('every nested branch appears in both readers\' merge list', async () => {
    // Both `admin.service.js` and `platformSettings.service.js` merge by branch. A
    // branch added to the defaults and missed in one reader is a settings value that
    // reads as `undefined` on some requests and a real number on others.
    const { readFileSync } = await import('node:fs');
    for (const path of [
      '../src/services/admin.service.js',
      '../src/services/platformSettings.service.js',
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      assert.ok(source.includes('NESTED_PLATFORM_SETTINGS_BRANCHES'),
        `${path} must merge the shared branch list rather than naming branches by hand`);
    }
  });

  test('auto-approve is off by default', async () => {
    const { DEFAULT_PLATFORM_SETTINGS } = await import('../src/models/PlatformSettings.js');
    assert.equal(DEFAULT_PLATFORM_SETTINGS.disbursement.autoApprove, false,
      'it is the difference between a payout run needing one human click and money leaving the platform unattended');
  });

  test('the platform fee is capped far below the markup cap', async () => {
    const { DEFAULT_PLATFORM_SETTINGS } = await import('../src/models/PlatformSettings.js');
    const { PlatformSettings } = await import('../src/models/PlatformSettings.js');
    const markupMax = PlatformSettings.schema.path('defaultMarkupPercent').options.max;
    const feeMax = PlatformSettings.schema.path('defaultPlatformFeePercent').options.max;

    assert.ok(feeMax < markupMax,
      'a platform fee is a percentage of a school\'s whole collected volume; the same cap as a per-payment markup would permit billing a tenant everything they collect');
  });

  test('money fields are integers in pesewas', async () => {
    const { PlatformSettings, DEFAULT_PLATFORM_SETTINGS } =
      await import('../src/models/PlatformSettings.js');

    assert.equal(PlatformSettings.schema.path('defaultMonthlyFee').options.min, 0);
    assert.equal(PlatformSettings.schema.path('sms.ratePesewas').options.min, 0);
    assert.equal(PlatformSettings.schema.path('sms.ratePesewas').instance, 'Number');
    // 15000 pesewas is GHS 150.00. A cedi-denominated default sitting among integer
    // pesewas fields is off by 100 and invisible until a school is billed.
    assert.equal(DEFAULT_PLATFORM_SETTINGS.defaultMonthlyFee, 15000);
    assert.equal(DEFAULT_PLATFORM_SETTINGS.sms.ratePesewas, 25);
  });
});

// ─── School and User additions ───────────────────────────────────────────────

describe('the per-school platform fields have safe defaults', () => {
  test('money-making flags are off until a tenant is opted in', async () => {
    const { School } = await import('../src/models/schoolModel.js');
    const s = School.schema;

    assert.equal(s.path('featureFlags.whatsapp').options.default, false,
      'WhatsApp costs per conversation; a tenant must be opted in, never in by omission');
    assert.equal(s.path('featureFlags.apiAccess').options.default, false,
      'API access costs per call and grants an integration nobody asked for');
    // These two the product already offers every school, so a school gains no new
    // capability the day this field appears.
    assert.equal(s.path('featureFlags.installments').options.default, true);
    assert.equal(s.path('featureFlags.idCards').options.default, true);
  });

  test('every platform-set field is top level, not nested under subscription', async () => {
    const { School } = await import('../src/models/schoolModel.js');
    const s = School.schema;

    for (const field of [
      'platformFeePercent',
      'featureFlags.whatsapp',
      'internalNotes',
      'accountManagerId',
      'onboardingCompletedAt',
      'tags',
    ]) {
      assert.ok(s.path(field), `${field} must exist at the top level`);
    }

    // The specific regression: a block of platform-owned fields pasted inside the
    // open `subscription: { … }` object. Everything still *worked* — Mongoose nests
    // inline objects without complaining — and every reader of
    // `school.platformFeePercent` got `undefined`, which coerces to 0 in an
    // aggregation and reads as "this school pays no platform fee". A silent
    // mis-nesting is worse than a missing field, because a missing field is a crash.
    assert.equal(s.path('subscription.platformFeePercent'), undefined,
      'platformFeePercent must not live under subscription — it would read as part of what the school bought');
    assert.equal(s.path('subscription.featureFlags'), undefined);
    assert.equal(s.path('subscription.internalNotes'), undefined);
    assert.equal(s.path('subscription.tags'), undefined);
  });

  test('internalNotes defaults empty and no school console reads it', async () => {
    const { School } = await import('../src/models/schoolModel.js');
    assert.equal(School.schema.path('internalNotes').options.default, '');
    assert.equal(School.schema.path('internalNotes').options.maxlength, 2000);

    const { readFileSync } = await import('node:fs');
    const schoolService = readFileSync(
      new URL('../src/services/school.service.js', import.meta.url), 'utf8'
    );
    assert.ok(!schoolService.includes('internalNotes'),
      'a school-scoped service must never read internalNotes — those notes are written for the platform only');
  });

  test('platformFeePercent starts at zero, not at the platform default', async () => {
    const { School } = await import('../src/models/schoolModel.js');
    assert.equal(School.schema.path('platformFeePercent').options.default, 0,
      'an unset platform fee must mean "we are not charging you"; defaulting it to the settings value would silently start billing schools the day the field lands');
  });
});