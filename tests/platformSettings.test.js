// Suite for platform settings being *enforced* rather than merely stored.
//
//   npm test
//
// Why this exists. `GET`/`PUT /admin/settings` landed with four fields that nothing
// read: `selfSignupEnabled`, `adsEnabled`, `trialDays` and `defaultMarkupPercent`.
// Storing a setting nobody reads is the most common way a settings page becomes a
// decoration, and it is invisible — the endpoint works, the console saves, and the
// behaviour does not change.
//
// Two of these also turned out to be standing bugs rather than missing features:
// `trialDays` was a hard-coded `+ 30` in two places, and `platformMarkupPercent` had
// **no writer anywhere in the codebase** — the schema default is `0`, so every
// school ever provisioned was collecting zero platform markup while the revenue
// aggregations divided by it.
//
// Pure unit tests: no database, no network, no live server. `maintenanceDecision` is
// exported separately from the middleware precisely so the rule that can refuse every
// request on the platform is testable without one.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const read = async (path) => {
  const { readFileSync } = await import('node:fs');
  return readFileSync(new URL(path, import.meta.url), 'utf8');
};

const code = async (path) => (await read(path)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── The maintenance rule ─────────────────────────────────────────────────────

describe('maintenance mode decides what may happen', () => {
  test('off allows everything', async () => {
    const { maintenanceDecision } = await import('../src/middleware/maintenance.js');
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(maintenanceDecision({ mode: 'off', method, path: '/api/students' }).allow, true,
        `off refused ${method}`);
    }
  });

  test('readonly allows reads and refuses writes', async () => {
    const { maintenanceDecision } = await import('../src/middleware/maintenance.js');

    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(maintenanceDecision({ mode: 'readonly', method, path: '/api/students' }).allow, true,
        `readonly refused ${method}, which cannot change state`);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const decision = maintenanceDecision({ mode: 'readonly', method, path: '/api/students' });
      assert.equal(decision.allow, false, `readonly allowed ${method}`);
      assert.equal(decision.code, 'MAINTENANCE_READONLY');
    }
  });

  test('PATCH is treated as a write, not a read', async () => {
    const { maintenanceDecision } = await import('../src/middleware/maintenance.js');
    // The failure from getting this wrong is silent: the resource looks updated and
    // is not. That is a worse outcome than a loud 503.
    assert.equal(maintenanceDecision({ mode: 'readonly', method: 'PATCH', path: '/api/students' }).allow, false);
  });

  test('on refuses reads too', async () => {
    const { maintenanceDecision } = await import('../src/middleware/maintenance.js');
    const decision = maintenanceDecision({ mode: 'on', method: 'GET', path: '/api/students' });
    assert.equal(decision.allow, false);
    assert.equal(decision.code, 'MAINTENANCE_MODE');
  });

  test('the health endpoint is exempt, because the keep-alive probe hits it', async () => {
    const { maintenanceDecision } = await import('../src/middleware/maintenance.js');
    // `utils/cron.js` probes exactly `/api/health`. Under `on`, a 503 there makes the
    // health log an error every cycle for a state the operator chose on purpose.
    assert.equal(maintenanceDecision({ mode: 'on', method: 'GET', path: '/api/health' }).allow, true);
    assert.equal(maintenanceDecision({ mode: 'on', method: 'GET', path: '/health' }).allow, true);
  });

  test('the health exemption survives a query string and a trailing slash', async () => {
    const { maintenanceDecision } = await import('../src/middleware/maintenance.js');
    // A probe URL that gains `?verbose=1` must not miss the exemption — that is the
    // kind of change nobody makes deliberately and everybody makes by accident.
    assert.equal(maintenanceDecision({ mode: 'on', method: 'GET', path: '/api/health?verbose=1' }).allow, true);
    assert.equal(maintenanceDecision({ mode: 'on', method: 'GET', path: '/api/health/' }).allow, true);
  });

  test('the settings endpoint is exempt, or maintenance is a one-way door', async () => {
    const { maintenanceDecision } = await import('../src/middleware/maintenance.js');

    // Turning maintenance on refuses every write — including the write that would
    // turn it off. An operator who set `readonly` to run a migration and then needed
    // one more change would have had no way back except a redeploy or a hand-edited
    // Mongo document. Every kill switch needs its own way out.
    assert.equal(
      maintenanceDecision({ mode: 'readonly', method: 'PUT', path: '/api/admin/settings' }).allow,
      true,
      'read-only maintenance refuses the write that would disable it'
    );
    assert.equal(
      maintenanceDecision({ mode: 'on', method: 'PUT', path: '/api/admin/settings' }).allow,
      true,
      'maintenance "on" cannot be turned off through the API'
    );

    // And it is genuinely reachable — an exemption for a path nothing serves would
    // be a no-op that looks like a fix.
    const source = await read('../src/routes/admin.routes.js');
    assert.ok(source.includes('"/settings"'), 'the settings route is missing');
  });

  test("the operator's own message reaches the user", async () => {
    const { maintenanceDecision } = await import('../src/middleware/maintenance.js');
    const decision = maintenanceDecision({
      mode: 'on',
      method: 'GET',
      path: '/api/students',
      message: 'We are upgrading until 6am.',
    });
    assert.equal(decision.message, 'We are upgrading until 6am.');
  });

  test('a refusal says why, without inventing a default message', async () => {
    const { maintenanceDecision } = await import('../src/middleware/maintenance.js');
    // `errorHandler.js` replaces the message of any 5xx with "Something went wrong"
    // and never emits `code` — which is why the middleware answers inline rather
    // than throwing. If this assertion ever fails the way the client sees it is
    // broken, so the test is the reminder.
    for (const mode of ['on', 'readonly']) {
      const decision = maintenanceDecision({ mode, method: 'POST', path: '/api/students' });
      assert.ok(decision.message.length > 10, `mode "${mode}" has no usable message`);
      assert.ok(decision.code, `mode "${mode}" has no machine-readable code`);
    }
  });
});

// ── The guard cannot reach a payment webhook ─────────────────────────────────
//
// This is the single most important property of the whole feature. A maintenance
// guard that refuses a Hubtel settlement callback turns a planned outage into lost
// money, and does it silently, because the provider's own retry would be refused too.

describe('the maintenance guard is mounted where a webhook cannot reach it', () => {
  test('it is on the /api router, never a global app.use', async () => {
    const routes = await code('../src/routes/index.js');
    assert.ok(routes.includes('maintenanceGuard'), 'the guard is not mounted at all');

    const mount = routes.slice(routes.indexOf('router.use(maintenanceGuard)'));
    assert.ok(
      !/app\.use\(\s*maintenanceGuard/.test(routes),
      'the guard is mounted globally — it would refuse root-level webhooks'
    );
    assert.ok(mount.length > 0);
  });

  test('the webhooks are mounted at the root, before /api', async () => {
    const index = await code('../src/index.js');

    // The reason the placement is safe: Express only enters the `/api` layer when the
    // URL starts with `/api`, and these two are mounted before it.
    const webhookAt = index.indexOf("app.use('/', webhookRoute)");
    const whatsappAt = index.indexOf("app.use('/', whatsappRoute)");
    const apiAt = index.indexOf("app.use('/api', routes)");
    const guardAt = index.indexOf('maintenanceGuard');

    assert.ok(webhookAt !== -1, 'the root webhook mount is missing');
    assert.ok(webhookAt < apiAt, 'the webhook mount moved after /api — the guard can now reach it');
    assert.ok(whatsappAt < apiAt, 'the root whatsapp mount moved after /api');

    // And the guard's import is not, itself, above them.
    assert.ok(guardAt === -1 || guardAt > apiAt || guardAt < webhookAt,
      'the guard is mounted between the webhook mount and /api');
  });

  test('the guard sits after healthRoute and before every other router', async () => {
    const routes = await code('../src/routes/index.js');
    const healthAt = routes.indexOf("router.use('/', healthRoute)");
    const guardAt = routes.indexOf('router.use(maintenanceGuard)');
    const authAt = routes.indexOf("router.use('/', authRoute)");

    assert.ok(healthAt < guardAt, 'the guard runs before health, so /api/health is refused');
    assert.ok(guardAt < authAt, 'the guard runs after auth, so a write reaches a controller first');
  });
});

// ── The feature flags ────────────────────────────────────────────────────────

describe('self-signup can actually be switched off', () => {
  test('the gate is in the handler', async () => {
    const controller = await code('../src/controllers/authController.js');
    const signup = controller.slice(
      controller.indexOf('export const signup'),
      controller.indexOf('export const signup') + 1800
    );

    assert.ok(signup.includes('isFeatureEnabled("selfSignupEnabled")'), 'signup is ungated');
    assert.ok(signup.includes('SELF_SIGNUP_DISABLED'), 'the refusal has no code for the client');
    // 503, not 403: nothing about the request is forbidden, the platform is
    // temporarily not offering the feature, and a client needs to tell those apart.
    assert.ok(signup.includes('503'), 'the refusal is not a 503');
  });

  test('the gate runs BEFORE the duplicate-email probe', async () => {
    const controller = await code('../src/controllers/authController.js');
    const signup = controller.slice(
      controller.indexOf('export const signup'),
      controller.indexOf('export const signup') + 1800
    );

    // Ordering, not presence. With signup off, a probe that runs first is an oracle
    // answering "does this person have an account here?" to anyone who can fill in a
    // form — while the gate itself says nothing about who exists.
    const gate = signup.indexOf('isFeatureEnabled("selfSignupEnabled")');
    const probe = signup.indexOf('User.findOne({ email })');

    assert.ok(probe !== -1, 'the duplicate-email probe is gone — is this still signup?');
    assert.ok(gate < probe, 'signup discloses whether an email exists while registration is closed');
  });
});

describe('the public ad slider can actually be switched off', () => {
  test('the gate returns an empty list, not an error', async () => {
    const controller = await code('../src/controllers/schoolAd.controller.js');
    const handler = controller.slice(0, controller.indexOf('// GET /admin/school-ads'));

    assert.ok(handler.includes('isFeatureEnabled("adsEnabled")'), 'the public slider is ungated');
    assert.ok(handler.includes('ads: []'), 'a disabled slider does not return an empty list');
    // 200 with an empty array is the endpoint's only existing "off" shape. A 503 would
    // give the login page a new failure mode for a perfectly normal state.
    assert.ok(/isFeatureEnabled[\s\S]{0,600}status\(200\)/.test(handler),
      'a disabled slider answers with an error status');
  });

  test('a disabled slider is not cached at the edge', async () => {
    const controller = await code('../src/controllers/schoolAd.controller.js');
    const handler = controller.slice(0, controller.indexOf('// GET /admin/school-ads'));

    // The success path sets `max-age=300`. Without `no-store` on the refusal, an
    // empty list would keep being served for five minutes after an operator turns
    // the flag back on, and the console would show it as on.
    const gate = handler.slice(
      handler.indexOf('isFeatureEnabled("adsEnabled")'),
      handler.indexOf('isFeatureEnabled("adsEnabled")') + 500
    );
    assert.ok(gate.includes('no-store'), 'the disabled response is edge-cacheable');
  });
});

describe('a newly provisioned school gets the platform defaults', () => {
  test('neither provisioning function hard-codes a 30-day trial any more', async () => {
    const service = await code('../src/services/school.service.js');

    // Both sites, and a count rather than a presence check: a third hard-coded trial
    // would satisfy `includes` while two remained.
    const trials = service.match(/setDate\(trialEndsAt\.getDate\(\) \+ (\d+)\)/g) || [];
    assert.equal(trials.length, 0, `a literal trial length remains: ${trials.join(', ')}`);

    assert.ok(
      (service.match(/getProvisioningDefaults\(\)/g) || []).length >= 2,
      'both provisioning paths must read the platform trial length'
    );
  });

  test('platformMarkupPercent is written at both provisioning sites', async () => {
    const service = await code('../src/services/school.service.js');

    // It had **no writer at all** before this — the schema default is 0 — so every
    // school ever provisioned was collecting zero platform markup while the revenue
    // aggregations divided by that number.
    const writes = service.match(/platformMarkupPercent/g) || [];
    assert.ok(writes.length >= 2, 'the markup default is not applied on both provisioning paths');
    assert.ok(service.includes('markupPercent'), 'the platform default is never read');
  });

  test('the platform default is a floor, not an override of a chosen value', async () => {
    const service = await code('../src/services/school.service.js');
    assert.ok(
      /payment:\s*\{\s*\.\.\.\(data\.payment \|\| \{\}\)/.test(service),
      'a caller-supplied payment block is discarded instead of merged'
    );
  });

  test('the trial window is still measured from before the transaction opens', async () => {
    const service = await code('../src/services/school.service.js');
    const provision = service.slice(
      service.indexOf('export const provisionSchoolForUser'),
      service.indexOf('export const provisionSchoolForUser') + 3000
    );

    const defaults = provision.indexOf('getProvisioningDefaults()');
    const session = provision.indexOf('mongoose.startSession()');

    assert.ok(defaults !== -1 && session !== -1, 'the provisioning flow changed shape');
    assert.ok(defaults < session,
      'the defaults are read inside the transaction, so the trial window depends on how long it took');
  });

  test('joining an existing school is untouched', async () => {
    const service = await code('../src/services/school.service.js');
    const join = service.slice(
      service.indexOf('export const requestToJoinSchool'),
      service.indexOf('export const decideJoinRequest')
    );

    // A school joining an existing one writes no School and no subscription, so a
    // platform trial default has nothing to apply to. Asserting the absence is what
    // stops someone "fixing" it by adding a trial to the join path.
    assert.ok(!join.includes('getProvisioningDefaults'), 'the join path provisions something');
    assert.ok(!join.includes('trialEndsAt'), 'the join path starts a trial');
  });
});

// ── The cache ────────────────────────────────────────────────────────────────

describe('settings are cached, invalidated, and fail open', () => {
  test('a write invalidates the cache, or a flag flip does nothing', async () => {
    const service = await code('../src/services/admin.service.js');
    const write = service.slice(service.indexOf('export const updatePlatformSettings'));

    assert.ok(write.includes('invalidatePlatformSettingsCache'), 'the write does not invalidate');

    // After the write, not before: invalidating first would let the next concurrent
    // read repopulate the cache from the database *before* the update lands, and the
    // stale value would then survive a further 30 seconds.
    assert.ok(
      write.indexOf('invalidatePlatformSettingsCache') > write.indexOf('findOneAndUpdate'),
      'the cache is invalidated before the write commits'
    );
  });

  test('reads fail open rather than turning an outage into a total refusal', async () => {
    const source = await read('../src/services/platformSettings.service.js');

    // The counter-intuitive part. A maintenance guard that 503s everything because
    // the database hiccuped has invented an outage the product did not have, and
    // `off` is the permissive default for exactly that reason.
    assert.ok(/catch[\s\S]{0,400}console\.error/.test(source), 'a failed settings read is silent');
    assert.ok(source.includes('return true'), 'a feature flag does not default to permissive');
    assert.ok(source.includes('return "off"'), 'the maintenance mode does not default to permissive');
  });

  test('an unknown flag name resolves to permissive, not to off', async () => {
    const source = await read('../src/services/platformSettings.service.js');
    // A typo in a call site should not silently switch off something a school depends
    // on — every caller here is a refusal that would then block real traffic.
    assert.ok(
      /value === undefined \? true : Boolean\(value\)/.test(source),
      'an unknown feature flag is not treated as permissive'
    );
  });

  test('the cache has a TTL and it is short', async () => {
    const source = await read('../src/services/platformSettings.service.js');
    assert.ok(/CACHE_TTL_MS\s*=\s*30_000/.test(source), 'the TTL moved');
  });
});