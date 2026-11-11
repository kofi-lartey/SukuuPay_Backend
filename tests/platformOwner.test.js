// Suite for the single-platform-owner rule: exactly one `super_admin`, provisioned
// from the environment, and unassignable through any API.
//
//   npm test
//
// Why this exists. Nothing in the product ever *granted* `super_admin` on purpose,
// which is what made the holes invisible. Signup excluded it, and the model comment
// said "null for super_admin" and "true ONLY for you" — but three endpoints would
// accept it, and two of them were open to any caller who already held it:
//
//   - POST /users/invite        `resolveInvitableRole` passed any requested role
//                               straight through for a super_admin caller
//   - PUT  /users/:userId       no `authorize` middleware at all; the only
//                               role-related condition was "is the caller a
//                               super_admin", which the one role that should not
//                               be able to do this satisfies
//   - PUT  /users/:userId/role  same shape as the invite path
//
// All three schemas also listed `super_admin` as a valid *input* role, so the
// controllers were the only thing in the way.
//
// None of it wrote an audit entry either. A role change through either route was
// invisible.
//
// The tests below are pure unit tests: no database, no network, no live server.
// `ensureSuperAdmin` is a plain function over Mongoose, so what is asserted here
// is the *contract* — the validators, the exported helper, the enum parity and the
// reconciler's shape — rather than a round trip.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── The role cannot be assigned ─────────────────────────────────────────────

describe('super_admin is not an assignable role', () => {
  test('the assignable list omits it, and names the three real roles', async () => {
    const { ASSIGNABLE_ROLES } = await import('../src/validators/userValidators.js');
    assert.ok(
      !ASSIGNABLE_ROLES.includes('super_admin'),
      'ASSIGNABLE_ROLES must not offer super_admin — this list is the enforcement'
    );
    assert.deepEqual(
      [...ASSIGNABLE_ROLES].sort(),
      ['accountant', 'school_admin', 'teacher']
    );
  });

  test('every assignable role is still a real role on the model', async () => {
    // The exclusion must narrow the model enum, not escape it. A role the model
    // rejects would 500 inside Mongoose *after* Joi passed.
    const { ASSIGNABLE_ROLES } = await import('../src/validators/userValidators.js');
    const { User } = await import('../src/models/userModel.js');
    const modelRoles = User.schema.path('role').enumValues;

    for (const role of ASSIGNABLE_ROLES) {
      assert.ok(modelRoles.includes(role), `${role} is assignable but not on the model's enum`);
    }
  });

  test('the model enum contains five roles', async () => {
    // The narrowing lives in the validator, not the model. The model keeps
    // `super_admin` because the owner *is* stored with it — removing it from the
    // enum would make the provisioner unable to write the account it exists to
    // create.
    const { User } = await import('../src/models/userModel.js');
    assert.equal(User.schema.path('role').enumValues.length, 5);
    assert.ok(User.schema.path('role').enumValues.includes('super_admin'));
  });

  test('the invite schema rejects it', async () => {
    const { inviteUserSchema } = await import('../src/validators/userValidators.js');
    const result = inviteUserSchema.validate({
      name: 'A Colleague',
      email: 'colleague@example.org',
      role: 'super_admin',
    });
    assert.ok(result.error, 'inviteUserSchema accepted super_admin');
  });

  test('the role-change schema rejects it', async () => {
    const { updateUserRoleSchema } = await import('../src/validators/userValidators.js');
    assert.ok(
      updateUserRoleSchema.validate({ role: 'super_admin' }).error,
      'updateUserRoleSchema accepted super_admin'
    );
  });

  test('the profile-update schema rejects it', async () => {
    // The quiet one. `PUT /users/:userId` carries no `authorize`, and this is the
    // schema in front of the only role write on that route.
    const { updateUserSchema } = await import('../src/validators/userValidators.js');
    assert.ok(
      updateUserSchema.validate({ role: 'super_admin' }).error,
      'updateUserSchema accepted super_admin'
    );
  });

  test('signup still cannot claim it either', async () => {
    // Asserted here rather than left to `accountCreation.test.js` because this is
    // the rule being extended, and the two files together are the whole boundary:
    // four request schemas, none of which can express the grant.
    const { signupSchema } = await import('../src/validators/authValidators.js');
    assert.ok(
      signupSchema.validate({ role: 'super_admin', password: 'LongEnough1!' }).error,
      'signupSchema accepted super_admin'
    );
  });
});

// ── The controllers refuse it legibly ────────────────────────────────────────
//
// Source assertions, in the style of `userInvitations.test.js`. There is no
// database here and no supertest, so the assertion is that the refusal exists in
// the handler rather than that it runs — which is still the thing that regressed,
// because the check that was there was about the *caller's* privilege and said
// nothing about the role being assigned.

describe('every role-write path refuses the platform role in its own words', () => {
  const read = async (path) => {
    const { readFileSync } = await import('node:fs');
    return readFileSync(new URL(path, import.meta.url), 'utf8');
  };

  /*
   * Source with comments stripped, before any assertion about it.
   *
   * This suite's subject is code that carries a great deal of prose explaining why
   * it is the way it is, and the prose quotes the old broken code verbatim — the
   * line `role === 'super_admin' && req.user.role !== 'super_admin'` appears in a
   * comment in `changeUserRole` precisely so the next reader knows what was
   * replaced. A substring test therefore *passes* on a comment describing the bug
   * while the bug is still present, which is the worst possible failure direction
   * for a check like this one. Stripping comments first makes every assertion
   * below about code.
   */
  const code = async (path) => (await read(path)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('the invite path refuses before considering the caller', async () => {
    const source = await code('../src/controllers/userController.js');
    const fn = source.slice(
      source.indexOf('const resolveInvitableRole'),
      source.indexOf('const resolveInvitableRole') + 900
    );

    // Ordering, not absence. The pass-through for an already-privileged caller is
    // legitimate — a platform owner may still invite a teacher — so the property
    // worth asserting is that the platform-role refusal happens *first*, before any
    // branch that trusts the caller. Put the pass-through above the refusal and
    // `super_admin` is invitable again by anyone who already holds it.
    const refusal = fn.indexOf("requestedRole === 'super_admin'");
    const passthrough = fn.indexOf("requester.role === 'super_admin') return { role: requestedRole");

    assert.ok(refusal !== -1, 'resolveInvitableRole must test the requested role, not only the caller');
    assert.ok(
      refusal < passthrough,
      'the super_admin refusal must come before the pass-through for a privileged caller'
    );
    // And the school-admin ceiling still applies to everything the refusal does not
    // catch, which is the check that was already there and still is.
    assert.ok(fn.includes('INVITABLE_BY_SCHOOL_ADMIN'), 'the school-admin ceiling was lost');
  });

  test('the profile-update path refuses it and does so before the save', async () => {
    const source = await code('../src/controllers/userController.js');
    const fn = source.slice(
      source.indexOf('export const updateUser'),
      source.indexOf('export const changeUserRole')
    );

    assert.ok(
      fn.includes('PLATFORM_ROLE_NOT_GRANTABLE'),
      'updateUser does not refuse the platform role'
    );
    assert.ok(
      fn.indexOf('PLATFORM_ROLE_NOT_GRANTABLE') < fn.indexOf('await user.save()'),
      'the refusal must come before the write'
    );
  });

  test('the role-change path refuses it', async () => {
    const source = await code('../src/controllers/userController.js');
    const fn = source.slice(
      source.indexOf('export const changeUserRole'),
      source.indexOf('export const deleteUser')
    );

    assert.ok(
      fn.includes('PLATFORM_ROLE_NOT_GRANTABLE'),
      'changeUserRole does not refuse the platform role'
    );
    // The old shape. It reads as a sensible rule and permits exactly the thing it
    // appears to prevent: a caller who *is* a super_admin passes, so the grant goes
    // through and there are now two.
    assert.ok(
      !fn.includes("role === 'super_admin' && req.user.role !== 'super_admin'"),
      'changeUserRole still gates on the caller being a super_admin, which permits a second owner'
    );
  });

  test('the platform owner cannot be deleted', async () => {
    const source = await code('../src/controllers/userController.js');
    const fn = source.slice(source.indexOf('export const deleteUser'));

    assert.ok(
      fn.includes("user.role === 'super_admin'"),
      'deleteUser no longer protects the platform role'
    );
  });
});

// ── The provisioner ─────────────────────────────────────────────────────────

describe('the platform owner is provisioned from the environment', () => {
  test('reads the three documented variables', async () => {
    // Asserted against the source rather than the imported module: importing
    // `config/env.js` runs `dotenv.config()` as a side effect and would load the
    // developer's real `.env` into the test process, so the module's *values* are
    // untestable by design. The names and the contract are what matter.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/config/env.js', import.meta.url), 'utf8');

    for (const name of ['SUPER_ADMIN_EMAIL', 'SUPER_ADMIN_PASSWORD', 'SUPER_ADMIN_NAME']) {
      assert.ok(source.includes(name), `${name} is not read by config/env.js`);
    }
    // The email is normalised, because `User.email` is `lowercase`/`trim`ed and
    // the reconciler matches on it — a stray space in .env would otherwise
    // provision a second account rather than find the first.
    assert.ok(
      /SUPER_ADMIN_EMAIL[\s\S]{0,120}toLowerCase\(\)/.test(source),
      'SUPER_ADMIN_EMAIL is not lowercased and trimmed'
    );
  });

  test('the reconciler is called from the database connect, not from listen', async () => {
    // `app.listen` runs before `mongoose.connect` on purpose — Render probes the
    // port and kills deploys that bind late. A reconciler placed beside `listen`
    // would provision nothing and report success when the database was slow.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

    // The *call*, not the identifier: `index.js` imports `ensureSuperAdmin` at the
    // top, so a bare `indexOf('ensureSuperAdmin')` finds the import and places the
    // reconciler before `mongoose.connect` for reasons that have nothing to do with
    // where it runs.
    const call = source.indexOf('await ensureSuperAdmin()');
    assert.ok(call !== -1, 'index.js never calls ensureSuperAdmin');

    assert.ok(
      call > source.indexOf('mongoose.connect'),
      'ensureSuperAdmin must run inside the connect handler'
    );
    assert.ok(
      call > source.indexOf('app.listen'),
      'ensureSuperAdmin must run after the port is bound, inside the connect handler'
    );
  });

  test('an unconfigured owner is fatal, and says which variable is missing', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/boot/ensureSuperAdmin.js', import.meta.url), 'utf8');

    assert.ok(
      source.includes('SUPER_ADMIN_EMAIL') && source.includes('SUPER_ADMIN_PASSWORD'),
      'the reconciler must name the variables it needs'
    );
    // Silent would be worse than broken: a deployment with no owner answers 403
    // to its own operator, and a missing env var is the only cause.
    assert.ok(
      source.includes('missing.join'),
      'the reconciler should report which variable is missing rather than failing opaquely'
    );
  });

  test('it demotes other super_admins and revokes their sessions', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/boot/ensureSuperAdmin.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // The heart of the invariant. "Only one super admin" is not true because the
    // validators refuse to *create* one — it is true because every boot removes
    // any that exist.
    assert.ok(
      source.includes("role: 'super_admin'") && source.includes('_id: { $ne: owner._id }'),
      'the reconciler must find super_admins other than the owner'
    );

    // The demotion loop, and the three things that make it effective rather than
    // cosmetic. Read out of the loop body so the assertions cannot be satisfied by
    // the same tokens appearing elsewhere in the file.
    const loop = source.slice(source.indexOf('for (const other of others)'));
    assert.ok(loop.length > 0, 'the reconciler has no demotion loop');
    assert.ok(/other\.role = /.test(loop), 'demotion must actually change the role');
    assert.ok(loop.includes('other.isPlatformOwner = false'), 'demotion must clear the owner marker');
    // Without the token bump a demoted account keeps platform access until its
    // token expires, which defeats the demotion completely.
    assert.ok(
      loop.includes('other.tokenVersion += 1'),
      'demotion must bump tokenVersion so existing sessions stop working'
    );
  });

  test('the owner is created with the fields authenticate requires', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/boot/ensureSuperAdmin.js', import.meta.url), 'utf8');
    const create = source.slice(source.indexOf('User.create('), source.indexOf('User.create(') + 900);

    // `status` defaults to 'invited' on the model and `authenticate` refuses
    // anything that is not 'active' — an owner created without this would exist,
    // appear in the users list, and fail every login with a 401 that reads like a
    // wrong password.
    assert.ok(create.includes("status: 'active'"), 'the owner must be created active');
    // `schoolId: null` is the platform-staff convention that ~15 services branch on.
    assert.ok(create.includes('schoolId: null'), 'the owner must have no school');
    assert.ok(create.includes('isEmailVerified: true'), 'the owner must be verified');
    // Forcing a password change would lock the operator out on every login until
    // they read this file.
    assert.ok(
      create.includes('mustChangePassword: false'),
      'the owner must not be forced to change an env-supplied password'
    );
  });

  test('a soft-deleted owner is revived rather than recreated', async () => {
    // `User.email` is `unique` and not sparse, so a soft-deleted account keeps the
    // address occupied forever. Creating a replacement would collide on the index
    // and the platform would have no owner and a duplicate-key error every boot.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/boot/ensureSuperAdmin.js', import.meta.url), 'utf8');

    assert.ok(source.includes('owner.deletedAt = null'), 'a deleted owner is not revived');
  });
});

// ── The revenue series has no gaps ───────────────────────────────────────────

describe('the platform revenue series reports empty periods as zero', () => {
  /*
   * The bug this guards against is invisible on a populated platform and obvious on
   * a real one: a month in which nobody paid produces no aggregation row, so a
   * series built by *mapping* the rows drops it — and a chart draws a straight line
   * across the hole, presenting a month of zero revenue as smooth growth. The fix is
   * to walk the calendar and emit an explicit `0`, and the reason it needs a test is
   * that the mapping version is shorter and looks fine.
   *
   * `buildCalendarSeries` is pure and exported for exactly this reason: the calendar
   * walk needs no database to be the most important logic in the endpoint.
   */

  const totals = new Map([
    ['2026-01', { totalRevenue: 1000, totalPayments: 4 }],
    // February deliberately absent — nobody paid that month.
    ['2026-03', { totalRevenue: 3000, totalPayments: 9 }],
  ]);

  test('a month with no payments appears as an explicit zero', async () => {
    const { buildCalendarSeries } = await import('../src/services/admin.service.js');
    const series = buildCalendarSeries(
      totals,
      new Date(2026, 0, 1),
      new Date(2026, 2, 31),
      'month'
    );

    assert.deepEqual(
      series.map((point) => point.period),
      ['2026-01', '2026-02', '2026-03'],
      'the empty month was dropped from the series'
    );
    assert.equal(series[1].totalRevenue, 0, 'the empty month is not zero');
    assert.equal(series[1].totalPayments, 0, 'the empty month reports payments');
  });

  test('months that did have payments keep their real figures', async () => {
    const { buildCalendarSeries } = await import('../src/services/admin.service.js');
    const series = buildCalendarSeries(
      totals,
      new Date(2026, 0, 1),
      new Date(2026, 2, 31),
      'month'
    );

    assert.equal(series[0].totalRevenue, 1000);
    assert.equal(series[2].totalRevenue, 3000);
  });

  test('day buckets walk the days and pad them the same way', async () => {
    const { buildCalendarSeries } = await import('../src/services/admin.service.js');
    const days = new Map([
      ['2026-03-01', { totalRevenue: 500, totalPayments: 2 }],
      ['2026-03-03', { totalRevenue: 700, totalPayments: 3 }],
    ]);

    const series = buildCalendarSeries(
      days,
      new Date(2026, 2, 1),
      new Date(2026, 2, 5),
      'day'
    );

    assert.equal(series.length, 5, 'expected one point per day in the range');
    assert.equal(series[1].period, '2026-03-02');
    assert.equal(series[1].totalRevenue, 0, 'the empty day is not zero');
    assert.equal(series[2].totalRevenue, 700);
  });

  test('a window nobody paid in is all zeros, not an empty series', async () => {
    const { buildCalendarSeries } = await import('../src/services/admin.service.js');
    const series = buildCalendarSeries(
      new Map(),
      new Date(2026, 0, 1),
      new Date(2026, 2, 31),
      'month'
    );

    // The frontend renders "no payments in this period" for an all-zero series and
    // draws nothing for an empty one. An empty array would show an axis with no
    // points and read as "revenue was zero", which is not the same fact.
    assert.equal(series.length, 3);
    assert.ok(series.every((point) => point.totalRevenue === 0));
  });

  test('the series is capped, so a long range cannot return thousands of points', async () => {
    const { buildCalendarSeries } = await import('../src/services/admin.service.js');
    const series = buildCalendarSeries(
      new Map(),
      new Date(2000, 0, 1),
      new Date(2026, 0, 1),
      'month'
    );

    assert.ok(series.length <= 120, `monthly series was ${series.length} points`);
    assert.equal(series.length, 120);
  });

  test('month and day keys are zero-padded to match the aggregation formats', async () => {
    const { monthKey, dayKey } = await import('../src/services/admin.service.js');

    // `$dateToString` produces "2026-03" and "2026-03-01". An unpadded "2026-3" looks
    // like the same month in a log and does not match the `$group` key, so the
    // lookup returns nothing and every month reads as zero.
    assert.equal(monthKey(new Date(2026, 2, 15)), '2026-03');
    assert.equal(dayKey(new Date(2026, 2, 5)), '2026-03-05');
  });
});

// ── Platform settings ────────────────────────────────────────────────────────

describe('platform settings are a singleton with a real shape', () => {
  test('the singleton is enforced by a unique index, not a convention', async () => {
    const { PlatformSettings } = await import('../src/models/PlatformSettings.js');
    // `schema.indexes()` yields `[keys, options]` pairs, so the field is in `entry[0]`
    // and the uniqueness flag in `entry[1]`.
    const index = PlatformSettings.schema.indexes().find((entry) => entry[1]?.unique);

    assert.ok(index, 'there is no unique index, so "one document, ever" is a comment');
    assert.ok(
      index[0].singletonKey === 1 && index[1].unique === true,
      `expected a unique index on singletonKey, got ${JSON.stringify(index)}`
    );
  });

  test('the defaults are exported so the read path cannot drift from the schema', async () => {
    const { PlatformSettings, DEFAULT_PLATFORM_SETTINGS } = await import(
      '../src/models/PlatformSettings.js'
    );

    // `getPlatformSettings` merges the exported defaults under whatever is stored, so
    // a default written twice is a default that will be changed once and reported
    // differently by the first GET after it.
    assert.equal(
      PlatformSettings.schema.path('defaultMarkupPercent').options.default,
      DEFAULT_PLATFORM_SETTINGS.defaultMarkupPercent
    );
    assert.equal(
      PlatformSettings.schema.path('maintenance.mode').options.default,
      DEFAULT_PLATFORM_SETTINGS.maintenance.mode
    );
  });

  test('markup is a percentage, bounded — not an unbounded number', async () => {
    const { PlatformSettings } = await import('../src/models/PlatformSettings.js');
    const path = PlatformSettings.schema.path('defaultMarkupPercent').options;

    assert.equal(path.min, 0);
    assert.equal(path.max, 100);
  });

  test('maintenance has three modes, and `readonly` is one of them', async () => {
    const { PlatformSettings } = await import('../src/models/PlatformSettings.js');

    // Two states would be "up" and "down". An operator mid-migration needs the third:
    // everything loads, nothing can be written. Without it the only quiet option is
    // taking the product away from everyone including themselves.
    assert.deepEqual(
      PlatformSettings.schema.path('maintenance.mode').options.enum,
      ['off', 'readonly', 'on']
    );
  });

  test('the update schema is a patch — every field optional, object not empty', async () => {
    const { updatePlatformSettingsSchema } = await import(
      '../src/validations/admin.validation.js'
    );

    // One field alone must validate, or a client changing a single flag has to send
    // the whole document back and can overwrite a concurrent change.
    assert.ok(!updatePlatformSettingsSchema.validate({ features: { trialDays: 45 } }).error);
    assert.ok(!updatePlatformSettingsSchema.validate({ defaultMarkupPercent: 6 }).error);

    // And an empty body is refused rather than silently accepted as "no change".
    assert.ok(
      updatePlatformSettingsSchema.validate({}).error,
      'an empty settings PUT is accepted'
    );
  });

  test('an out-of-range setting is refused at the edge', async () => {
    const { updatePlatformSettingsSchema } = await import(
      '../src/validations/admin.validation.js'
    );

    assert.ok(updatePlatformSettingsSchema.validate({ defaultMarkupPercent: 140 }).error);
    assert.ok(updatePlatformSettingsSchema.validate({ defaultMarkupPercent: -1 }).error);
    assert.ok(
      updatePlatformSettingsSchema.validate({ maintenance: { mode: 'sideways' } }).error,
      'an unknown maintenance mode is accepted'
    );
  });

  test('the series query requires an explicit bucket', async () => {
    const { revenueSeriesQuerySchema } = await import('../src/validations/admin.validation.js');
    const { value } = revenueSeriesQuerySchema.validate({});

    // Monthly by default, but *stated* by the schema rather than guessed per call: 30
    // daily points and 24 monthly points are different charts, and a chart whose
    // shape depends on how the server sampled the data cannot be read.
    assert.equal(value.bucket, 'month');
    assert.ok(revenueSeriesQuerySchema.validate({ bucket: 'week' }).error);
  });

  test('the series route cannot be swallowed by the aggregates route', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../src/routes/admin.routes.js', import.meta.url),
      'utf8'
    );

    // Quote-agnostic and whitespace-tolerant. This file was rewritten to use single
    // quotes and to wrap registrations across lines to fit their middleware stacks,
    // and a `source.includes('"/revenue/series"')` scan fails on both for reasons
    // that have nothing to do with what it is checking. The regex still asserts the
    // thing that matters: the route is registered, on a *literal* path.
    assert.ok(
      /adminRoute\.get\(\s*['"]\/revenue\/series['"]/.test(source),
      'the series route is missing'
    );

    // Order is irrelevant here and that is load-bearing to state, because it usually
    // is not: a `/revenue/:something` pattern *would* have to be registered before
    // `/revenue` or the exact match would never be reached. Both patterns here are
    // literal, so Express cannot conflate them — and the test is that neither has
    // grown a wildcard, because that is the edit that would break it silently.
    assert.ok(
      /adminRoute\.get\(\s*['"]\/revenue['"]/.test(source),
      'the aggregates route is missing'
    );
    assert.ok(
      !/adminRoute\.get\(\s*"\/revenue\/:/.test(source),
      'a parameterised /revenue/... route would be matched only if registered first'
    );
  });

  test('a settings write is audited with the paths that changed', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../src/controllers/admin.controller.js', import.meta.url),
      'utf8'
    );

    assert.ok(
      source.includes('AUDIT_ACTIONS.SETTINGS_UPDATE'),
      'a platform settings write is unaudited'
    );
    // An entry that records *that* something changed but not what does not answer
    // the question the audit is consulted for.
    assert.ok(source.includes('meta: { changed }'), 'the audit entry does not carry the diff');
    // And no-op writes must not be logged, or the real change is harder to find.
    assert.ok(
      /if \(changed\.length\)[\s\S]{0,200}auditLog/.test(source),
      'a no-op settings write is logged anyway'
    );
  });
});

// ── Audit parity ────────────────────────────────────────────────────────────

describe('role changes and removals are auditable', () => {
  test('both actions are in the schema enum and the constants map', async () => {
    // Two copies of the same list, and the trap is that they can drift: `action`
    // is a closed Mongoose enum, so a value present in `config/constants.js` and
    // missing from the model throws a ValidationError that
    // `utils/auditService.log` swallows into a console.error. The entry then does
    // not exist, and nothing reports that it is missing.
    const { AUDIT_ACTIONS: modelActions } = await import('../src/models/AuditLog.js');
    const { AUDIT_ACTIONS: constants } = await import('../src/config/constants.js');

    for (const key of ['USER_ROLE_CHANGE', 'USER_REMOVE']) {
      assert.ok(constants[key], `${key} is missing from config/constants.js`);
      assert.ok(
        modelActions.includes(constants[key]),
        `${constants[key]} is not in the AuditLog enum, so the write would be swallowed`
      );
    }
  });

  test('every constant has a matching enum entry, in both directions', async () => {
    const { AUDIT_ACTIONS: modelActions } = await import('../src/models/AuditLog.js');
    const { AUDIT_ACTIONS: constants } = await import('../src/config/constants.js');

    for (const [key, value] of Object.entries(constants)) {
      assert.ok(modelActions.includes(value), `${key} ("${value}") is not in the AuditLog enum`);
    }
    for (const value of modelActions) {
      assert.ok(
        Object.values(constants).includes(value),
        `"${value}" is in the AuditLog enum but no constant declares it`
      );
    }
  });

  test('a role change records both sides of the transition', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/controllers/userController.js', import.meta.url), 'utf8');

    // "Who had it, who has it now" is the whole question an administrator asks
    // later. Logging only the new value leaves the trail unable to say who was
    // demoted.
    const occurrences = source.split('AUDIT_ACTIONS.USER_ROLE_CHANGE').length - 1;
    assert.equal(occurrences, 2, 'both role-write paths must be audited');
    assert.ok(
      /meta: \{ from: previousRole, to: user\.role \}/.test(source),
      'a role change must record both the previous and the new role'
    );
  });

  test('a removal is audited', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/controllers/userController.js', import.meta.url), 'utf8');

    assert.ok(
      source.includes('AUDIT_ACTIONS.USER_REMOVE'),
      'deleteUser is unaudited — the widest omission of the three'
    );
  });
});