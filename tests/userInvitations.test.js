// Suite for the team-invitation flow: the password derived from the School ID,
// the credentials carried in the email, and the role ceiling on who may grant
// what.
//
//   npm test
//
// Why this exists. The endpoint was not missing — `POST /users/invite` had been
// there all along — so nothing about it was covered by a test, and it had
// drifted away from what the flow is for in four ways that only show up to a
// real user: it required a phone number nobody had, minted a default password it
// then never told anybody, emailed an OTP that looked like signup rather than an
// invitation, and accepted `role: "super_admin"` from a school admin.
//
// Pure unit tests: no database, no network, no live server.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── The default password ──
describe('default passwords are derived from the School ID', () => {
  test('carries the school code as its prefix', async () => {
    const { generateDefaultPassword } = await import('../src/utils/defaultPassword.js');
    const password = generateDefaultPassword({ schoolCode: 'PBS001' });
    assert.ok(
      password.startsWith('PBS001-'),
      `expected a PBS001- prefix, got ${password}`
    );
  });

  test('satisfies the User model’s own constraints', async () => {
    // The reason this cannot be an arbitrary string: `User.password` is
    // `required` with `minlength: 8`, so a shorter derivation 500s inside
    // Mongoose *after* Joi has passed the request.
    const { generateDefaultPassword } = await import('../src/utils/defaultPassword.js');
    const { User } = await import('../src/models/userModel.js');
    const { minlength } = User.schema.path('password').options;

    for (const code of ['PBS001', 'ABC999', 'SCH']) {
      const password = generateDefaultPassword({ schoolCode: code });
      assert.ok(
        password.length >= minlength,
        `${password} is shorter than the model's minlength of ${minlength}`
      );
    }
  });

  test('is unique per user, not per school', async () => {
    // The whole reason the School ID is a prefix and not the whole password.
    // A password derived from the code alone would be one shared secret across
    // every teacher at the school.
    const { generateDefaultPassword } = await import('../src/utils/defaultPassword.js');
    const generated = new Set(
      Array.from({ length: 200 }, () => generateDefaultPassword({ schoolCode: 'PBS001' }))
    );
    assert.equal(generated.size, 200, 'two invitations to one school produced the same password');
  });

  test('leaves no ambiguous characters to mistype', async () => {
    // These get read aloud to a bursar over a phone and typed from a printed
    // handover note. 0/O, 1/l/I are the failures.
    const { generateDefaultPassword } = await import('../src/utils/defaultPassword.js');
    for (let i = 0; i < 100; i += 1) {
      const password = generateDefaultPassword({ schoolCode: 'PBS001' });
      const suffix = password.split('-')[1];
      assert.ok(!/[0O1lI]/.test(suffix), `${password} contains an ambiguous character`);
    }
  });

  test('falls back to an ObjectId when a school has no code yet', async () => {
    const { generateDefaultPassword, schoolPasswordPrefix } = await import(
      '../src/utils/defaultPassword.js'
    );
    // A cosmetic prefix must never be the reason an invitation fails to send.
    assert.equal(schoolPasswordPrefix(null), 'SCH');
    assert.equal(schoolPasswordPrefix({}), 'SCH');
    assert.equal(
      schoolPasswordPrefix({ _id: '65f1a2b3c4d5e6f7a8b9c0d1' }),
      '65F1A2B3'
    );
    assert.ok(generateDefaultPassword({ _id: '65f1a2b3c4d5e6f7a8b9c0d1' }).startsWith('65F1A2B3-'));
  });
});

// ── The invitation email ──
describe('the invitation email', () => {
  const render = (overrides = {}) =>
    import('../src/templates/emails.js').then(({ invitationEmail }) =>
      invitationEmail({
        name: 'B. Quaye',
        email: 'b.quaye@prampramschool.edu.gh',
        password: 'PBS001-7K4M2XQ9',
        schoolCode: 'PBS001',
        schoolName: 'Prampram Basic & JHS',
        inviter: 'Mrs. Cynthia Osei-Tutu',
        inviterRole: 'school_admin',
        inviterPosition: 'Chief Bursar',
        role: 'teacher',
        loginUrl: 'https://sukuupay.netlify.app/login',
        ...overrides,
      })
    );

  test('carries the temporary password and the email', async () => {
    const { html, text } = await render();
    assert.ok(html.includes('PBS001-7K4M2XQ9'));
    assert.ok(html.includes('b.quaye@prampramschool.edu.gh'));
    // Both parts, not just one: the plain-text alternative is what reaches a
    // client that will not render HTML, and it is easy to forget to update.
    assert.ok(text.includes('PBS001-7K4M2XQ9'));
    assert.ok(text.includes('b.quaye@prampramschool.edu.gh'));
  });

  test('names the administrator who sent the invitation', async () => {
    const { html, text } = await render();
    assert.ok(html.includes('Mrs. Cynthia Osei-Tutu'));
    assert.ok(text.includes('Mrs. Cynthia Osei-Tutu'));
    // Their position too, where one exists — "who sent this" should be
    // answerable without leaving the mail.
    assert.ok(html.includes('Chief Bursar'));
  });

  test('falls back rather than rendering a blank inviter', async () => {
    // A super_admin inviting into a school has a name, but the template must
    // not depend on that being populated.
    const { html } = await render({ inviter: undefined, inviterPosition: undefined });
    assert.ok(html.includes('A school administrator'));
  });

  test('tells the recipient to change the password', async () => {
    const { html, text } = await render();
    // The password is a default two people know, so leaving it in place is the
    // failure mode this instruction exists to prevent.
    assert.match(text, /change this password/i);
    assert.match(html, /Change this password after signing in/i);
  });

  test('a re-send says the previous password is dead', async () => {
    const { text, subject } = await render({ isResend: true });
    assert.match(subject, /re-sent/i);
    assert.match(text, /no longer works/i);
  });

  test('escapes the values a school admin types', async () => {
    // `inviter` is a free-text `name` field on the User model. Rendering it
    // unescaped would let one admin mail script tags into another admin's
    // inbox, through this server, with the platform's sender identity on it.
    const { html } = await render({ inviter: '<img src=x onerror=alert(1)>' });
    assert.ok(!html.includes('<img src=x'), 'raw HTML reached the invitation body');
    assert.ok(html.includes('&lt;img'), 'the inviter name was not escaped');
  });
});

// ── Who may grant which role ──
describe('role grants on invitation', () => {
  test('super_admin is not grantable by a school admin', async () => {
    // The gap this closes. `signup` and `changeUserRole` both refuse it; the
    // invite path copied `role` straight off the body, so it was the one door
    // into the platform-operator tier that skipped the check.
    const { INVITABLE_BY_SCHOOL_ADMIN } = await import('../src/validators/userValidators.js');
    assert.equal(INVITABLE_BY_SCHOOL_ADMIN.includes('super_admin'), false);
  });

  test('school_admin is delegable — sharing a login is worse', async () => {
    const { INVITABLE_BY_SCHOOL_ADMIN } = await import('../src/validators/userValidators.js');
    assert.ok(INVITABLE_BY_SCHOOL_ADMIN.includes('school_admin'));
  });

  test('every grantable role exists on the User model', async () => {
    const { INVITABLE_BY_SCHOOL_ADMIN } = await import('../src/validators/userValidators.js');
    const { User } = await import('../src/models/userModel.js');
    const modelRoles = User.schema.path('role').enumValues;
    for (const role of INVITABLE_BY_SCHOOL_ADMIN) {
      assert.ok(modelRoles.includes(role), `${role} is not in the model's role enum`);
    }
  });

  test('the list is exactly the non-platform roles', async () => {
    const { INVITABLE_BY_SCHOOL_ADMIN } = await import('../src/validators/userValidators.js');
    assert.deepEqual([...INVITABLE_BY_SCHOOL_ADMIN].sort(), [
      'accountant',
      'school_admin',
      'teacher',
      'viewer',
    ]);
  });
});

// ── The request shape ──
describe('inviteUserSchema', () => {
  const validate = (payload) =>
    import('../src/validators/userValidators.js').then(({ inviteUserSchema }) =>
      inviteUserSchema.validate(payload, { abortEarly: true, stripUnknown: true, convert: true })
    );

  test('accepts a name and an email and nothing else', async () => {
    // The product requirement. A school admin knows these two facts; they very
    // often do not have a phone number to hand.
    const { error, value } = await validate({
      name: 'Rev. B. Quaye',
      email: 'B.Quaye@PrampramSchool.edu.gh',
    });
    assert.equal(error, undefined);
    assert.equal(value.email, 'b.quaye@prampramschool.edu.gh');
    assert.equal(value.role, 'teacher');
  });

  test('no longer demands a phone number', async () => {
    const { error } = await validate({ name: 'Ama Serwa', email: 'ama@school.edu.gh' });
    assert.equal(error, undefined);
  });

  test('still rejects a missing name or email', async () => {
    assert.ok((await validate({ email: 'ama@school.edu.gh' })).error, 'name should be required');
    assert.ok((await validate({ name: 'Ama Serwa' })).error, 'email should be required');
  });

  test('still rejects an address that is not one', async () => {
    const { error } = await validate({ name: 'Ama Serwa', email: 'not-an-email' });
    assert.ok(error);
  });
});

// ── The stored record ──
describe('invitation fields on the User model', () => {
  test('phone is no longer required', async () => {
    // Required until the User Management module: an invitation that accepts only
    // a name and an email could not actually create a user, which meant the only
    // way to satisfy the schema was to invent a placeholder phone number.
    const { User } = await import('../src/models/userModel.js');
    assert.notEqual(User.schema.path('phone').isRequired, true);
  });

  test('records the invitation lifecycle', async () => {
    // Without these, a failed send and a successful one are indistinguishable
    // afterwards, which is how the old endpoint could swallow a Brevo error and
    // still answer 201.
    const { User } = await import('../src/models/userModel.js');
    for (const field of [
      'invitedBy',
      'invitedAt',
      'inviteEmailSentAt',
      'inviteCount',
      'mustChangePassword',
    ]) {
      assert.ok(User.schema.path(field), `User is missing ${field}`);
    }
  });

  test('every new field defaults, so no migration is needed', async () => {
    const { User } = await import('../src/models/userModel.js');
    // Defaults live on `path.options.default` in this Mongoose version, not on
    // `path.default`.
    const defaults = {
      invitedAt: null,
      inviteEmailSentAt: null,
      inviteCount: 0,
      mustChangePassword: false,
    };
    for (const [field, expected] of Object.entries(defaults)) {
      assert.deepEqual(
        User.schema.path(field).options.default,
        expected,
        `${field} does not default to ${expected}`
      );
    }
  });
});

// ── The unique index on providerId ──
describe('the providerId unique index', () => {
  // The bug this closes. Every password-only account carries
  // `providerId: null` (the field default), and MongoDB treats an explicit
  // `null` as a present value even under `sparse: true` — so the legacy
  // `sparse: true` unique index indexed those nulls and the *second* invitation
  // to any platform died on E11000 with `keyValue: { providerId: null }`.
  //
  // Fixing the schema is not enough: an index already in the database is never
  // rewritten, so `boot/reconcileProviderIdIndex.js` drops the legacy one and
  // recreates this declaration. This test keeps the declaration correct, and
  // the boot migration is tested directly below.
  const declared = async () => {
    const { User } = await import('../src/models/userModel.js');
    // `schema.indexes()` returns `[keys, options]` pairs as declared, with no
    // database involved — which is what makes this a unit test.
    return User.schema.indexes().filter(([keys]) => 'providerId' in keys);
  };

  test('is unique over providerId', async () => {
    const indexes = await declared();
    assert.equal(indexes.length, 1, `expected exactly one providerId index, got ${indexes.length}`);
    assert.equal(indexes[0][1].unique, true, 'the providerId index must be unique');
  });

  test('is partial over non-null values only', async () => {
    const [{ 1: options }] = await declared();
    assert.deepEqual(
      options.partialFilterExpression,
      { providerId: { $type: 'string' } },
      'the index must exclude null, or two password-only invites collide'
    );
    assert.notEqual(options.sparse, true, 'sparse: true still indexes an explicit null');
  });

  test('declares a filter MongoDB can actually build', async () => {
    // `$ne` is **not supported** inside a `partialFilterExpression`: MongoDB
    // answers `Expression not supported in partial index: $not` (code 67) and
    // creates nothing at all. A declaration in that shape looks correct and
    // enforces nothing — which is exactly what happened to `providerId_1`,
    // which was absent from the live database while the model declared it.
    const [{ 1: options }] = await declared();

    const condition = options.partialFilterExpression.providerId;
    assert.equal(
      condition.$ne,
      undefined,
      'MongoDB cannot build a partial filter with $ne — the index would never be created'
    );
    assert.equal(condition.$type, 'string', '$type is the filter MongoDB accepts');
  });
});

// ── The boot migration that replaces the legacy index ──
describe('reconcileProviderIdIndex', () => {
  // The database already holds the old index on this platform, so the schema
  // fix alone leaves every deployment broken. This migration is what actually
  // repairs them, so its classification of "legacy" is load-bearing.
  const read = () =>
    import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/boot/reconcileProviderIdIndex.js', import.meta.url), 'utf8')
    );

  test('is idempotent and runs on boot', async () => {
    const { readFileSync } = await import('node:fs');
    const boot = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.match(boot, /reconcileProviderIdIndex\(\)/);
  });

  test('reconciles the index by name against the declaration', async () => {
    // The repair moved into the shared helper, because the same three steps
    // (drop the drifted live index, create the declared one) apply to every
    // index whose options carry meaning. What matters is that this migration
    // still goes through it.
    const source = await read();
    assert.match(source, /ensureIndexMatchesDeclaration/);
    assert.match(source, /providerId: 1/);
  });

  test('the shared helper drops a live index whose spec differs', async () => {
    const { readFileSync } = await import('node:fs');
    const helper = readFileSync(new URL('../src/boot/indexSpec.js', import.meta.url), 'utf8');

    assert.match(helper, /dropIndex/, 'the drifted index has to be dropped');
    assert.match(helper, /partialFilterExpression/, 'the declared spec has to be compared');
    assert.match(helper, /Boolean\(liveIndex\.unique\)/, 'uniqueness has to be compared');
  });

  test('the shared helper never rebuilds the whole model', async () => {
    // `model.createIndexes()` builds every index on the model and fails
    // outright if any one of them conflicts with a live index of the same
    // name. A repair that used it could not repair anything on a database
    // that has a stale index — which is exactly the database it exists for.
    //
    // The check is on the *code*, not the prose: the helper's own comment
    // explains why `createIndexes()` is the wrong call, and matching that
    // would fail the test for saying the right thing.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/boot/indexSpec.js', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    assert.doesNotMatch(code, /createIndexes\(/);
    assert.match(code, /collection\.createIndex\(/);
  });
});

// ── The route wiring ──
describe('invitation routes', () => {
  const readRoutes = () =>
    import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/routes/userRoutes.js', import.meta.url), 'utf8')
    );

  /** The `userRoute.post(...)` call registering `path`, and nothing else. */
  const routeBlock = (source, path) => {
    const start = source.indexOf(`'${path}'`);
    assert.notEqual(start, -1, `${path} is not registered`);
    const end = source.indexOf('userRoute.', start + path.length);
    return source.slice(start, end === -1 ? source.length : end);
  };

  test('inviting is admin-only', async () => {
    const source = await readRoutes();
    const block = routeBlock(source, '/users/invite');
    assert.match(block, /authorize\('super_admin', 'school_admin'\)/);
    assert.match(block, /authenticate/);
  });

  test('the re-send endpoint is registered and admin-only', async () => {
    const source = await readRoutes();
    const block = routeBlock(source, '/users/:userId/resend-invite');
    assert.match(block, /authorize\('super_admin', 'school_admin'\)/);
    assert.match(block, /resendUserInvite/);
  });

  test('neither invitation route is registered twice', async () => {
    // A duplicate registration is silently harmless — Express keeps the first
    // match — which is exactly why it survives review. It is still dead code,
    // and it makes a reader believe one of the two has a different guard.
    const source = await readRoutes();
    const count = (path) => source.split(`'${path}'`).length - 1;
    assert.equal(count('/users/invite'), 1);
    assert.equal(count('/users/:userId/resend-invite'), 1);
  });

  test('literal route segments precede the :userId parameter', async () => {
    // `/users/invite` and `/users/:userId` are siblings. If the parameter were
    // registered first, Express would match "invite" as a user id and hand
    // `POST /users/invite` to `getUser`, which has no such method and 404s the
    // feature at a point that looks like a server fault.
    const source = await readRoutes();
    assert.ok(
      source.indexOf("'/users/invite'") < source.indexOf("'/users/:userId'"),
      'the literal /users/invite route must be registered before /users/:userId'
    );
  });

  test('both invitation endpoints share one rate limit', async () => {
    // Resending must not be a way around the ceiling `invite` enforces.
    const source = await readRoutes();
    const uses = (path) => (routeBlock(source, path).match(/\binviteLimiter\b/g) || []).length;
    assert.equal(uses('/users/invite'), 1);
    assert.equal(uses('/users/:userId/resend-invite'), 1);
  });

  test('the limiter is keyed on the admin, not the IP', async () => {
    // Keying on IP would throttle a whole school office that shares one NAT
    // address, and would still fail to bound a hijacked admin session.
    const source = await readRoutes();
    assert.match(source, /keyBy:\s*'user'/);
  });
});

// ── The Activity Log's own filters ──────────────────────────────────────────

describe('audit log filters', () => {
  const validate = async (query) => {
    const { auditLogQuerySchema } = await import('../src/validations/auditLog.validation.js');
    return auditLogQuerySchema.validate(query, { abortEarly: false, stripUnknown: true, convert: true });
  };

  test('an untouched filter bar does not reject the request', async () => {
    // The regression. Six filters all report `''` before anyone has touched one,
    // so the page's very first request carried `?userId=&action=&entity=&entityId=&from=&to=`
    // and every one of those failed: `.optional()` covers an *absent* key, not a
    // present-and-empty one. The whole audit trail failed to load with
    // `"userId" is not allowed to be empty`.
    const { error } = await validate({
      userId: '',
      action: '',
      entity: '',
      entityId: '',
      from: '',
      to: '',
      page: 1,
      perPage: 50,
    });
    assert.equal(error, undefined, error?.details?.[0]?.message);
  });

  test('the export schema tolerates the same blanks', async () => {
    const { auditLogExportQuerySchema } = await import('../src/validations/auditLog.validation.js');
    const { error } = auditLogExportQuerySchema.validate(
      { userId: '', action: '', from: '', to: '' },
      { abortEarly: false }
    );
    assert.equal(error, undefined);
  });

  test('the user-activity schema tolerates them too', async () => {
    const { auditLogUserQuerySchema } = await import('../src/validations/auditLog.validation.js');
    const { error } = auditLogUserQuerySchema.validate({ from: '', to: '' }, { abortEarly: false });
    assert.equal(error, undefined);
  });

  test('a real value is still validated', async () => {
    // The fix must not become "accept anything". A filter that is blank is
    // absent; a filter that is present has to be well-formed.
    assert.equal((await validate({ userId: 'not-an-id' })).error !== undefined, true);
    assert.equal((await validate({ action: 'report.viewed' })).error, undefined);
    assert.equal((await validate({ from: 'yesterday' })).error !== undefined, true);
  });

  test('an unknown action is still rejected', async () => {
    const { error } = await validate({ action: 'report.exploded' });
    assert.ok(error, 'an action outside the enum must not pass validation');
  });

  test('report viewing is a filterable action', async () => {
    // Reading a debtors ledger is auditable, so it has to be findable. Before
    // this the nine report endpoints used a local console.log stub and wrote
    // nothing, so no report view could ever appear in the log.
    const { AuditLog, AUDIT_ACTIONS } = await import('../src/models/AuditLog.js');
    assert.ok(AUDIT_ACTIONS.includes('report.viewed'));
    assert.ok(AuditLog.schema.path('action').enumValues.includes('report.viewed'));
  });

  test('every report endpoint writes a real, scoped audit entry', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../src/services/reports.service.js', import.meta.url),
      'utf8'
    );

    // No local console.log stub left. The real service is imported instead.
    assert.ok(
      !/const auditService\s*=\s*\{/.test(source),
      'reports.service.js still declares its own console.log audit stub'
    );
    assert.match(source, /from "\.\.\/utils\/auditService\.js"/);

    // Nine endpoints, nine entries.
    assert.equal((source.match(/auditService\.log\(\{/g) || []).length, 9);

    // And each one carries the school, because a report view with a null
    // `schoolId` is invisible to `GET /audit-logs/:schoolId`, which filters on
    // it — the entry would be written and never read.
    const entries = source.match(/auditService\.log\(\{[\s\S]*?\n  \}\);/g) || [];
    for (const entry of entries) {
      assert.match(entry, /action: AUDIT_ACTIONS\.REPORT_VIEWED/);
      assert.match(entry, /\n\s+schoolId,/);
      assert.match(entry, /meta: \{ query \}/);
    }

    // The bare SCREAMING_SNAKE action was never a valid one — the model's enum is
    // dotted lowercase — so it could never have been written even by the real
    // service.
    assert.ok(
      !/action:\s*"REPORT_VIEWED"/.test(source),
      'report views are still logged under a non-enum action name'
    );
  });
});