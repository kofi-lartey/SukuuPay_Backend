// Regression suite for the join flow: school-code onboarding for roles that
// cannot register a school, and the school_admin approval that releases them.
//
//   npm test
//
// The behaviour this exists to protect:
//
//   1. An `accountant` or `teacher` signing up has nothing to
//      configure — the school already exists. They used to be walked into the
//      five-step setup wizard (Step 1 is where the join panel lived, behind the
//      same stepper, stepper bar and step-2-to-5 buttons) and every one of those
//      steps ends in a 403 on a school they do not own. `SCHOOL_JOIN_ROLES` is
//      what splits them out, and `onboardingBlock` turns it into the `flow` and
//      `nextRoute` the client routes on.
//
//   2. The approval queue used to admit an `accountant` as a decision-maker,
//      both in the service and (implicitly) at the route, where nothing named a
//      role at all. The requirement is that a `school_admin` approves — the
//      person who owns the school's SukuuPay account — so the gate now says so
//      on the route, where the rest of the admin gates live.
//
// Pure unit tests: no database, no network. The route gates are exercised by
// driving their middleware stack directly, which is what makes a role check
// assertable without a request cycle.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SCHOOL_JOIN_ROLES, ROLES, USER_ROLES } from '../src/config/constants.js';

// ── Which roles join by code ────────────────────────────────────────────────
describe('SCHOOL_JOIN_ROLES', () => {
  test('is exactly the two roles that cannot register a school', () => {
    // The split is exhaustive and deliberate: every other self-signup role
    // (`school_admin`) provisions, and `super_admin` is platform staff who
    // belong to no school at all. A role added to the model later is *not*
    // silently swept into the join flow — it lands in the wizard branch, which
    // is the safe side to be wrong on.
    assert.deepEqual([...SCHOOL_JOIN_ROLES].sort(), ['accountant', 'teacher']);
  });

  test('does not include the roles that own a school', () => {
    for (const privileged of [ROLES.SUPER_ADMIN, ROLES.SCHOOL_ADMIN]) {
      assert.equal(
        SCHOOL_JOIN_ROLES.includes(privileged),
        false,
        `${privileged} must not be diverted into the join flow`
      );
    }
  });

  test('every member is a real role on the model', () => {
    // A constant naming a role the User schema would reject is configuration
    // that can never match, which is worse than no configuration.
    for (const role of SCHOOL_JOIN_ROLES) {
      assert.ok(USER_ROLES.includes(role), `${role} is not in USER_ROLES`);
    }
  });
});

// ── The approval routes say who may decide ──────────────────────────────────
/**
 * Walks a route's middleware stack the way Express would, with a caller of the
 * given role, and reports the first refusal.
 *
 * `authenticate` is skipped rather than satisfied: it answers 401 for a request
 * with no bearer token, which is a *different* refusal from the role check and
 * must not be mistaken for one. That it guards the route at all is asserted
 * separately, as the existing school-routes suite already does. The controller
 * is identified as the last layer and skipped too — it needs a database, and
 * reaching it is exactly the "this caller was allowed through" signal these
 * tests want.
 *
 * `params` and `body` carry values valid for the route under test, so the
 * `validate` layers pass for the right reason rather than 422-ing first. A route
 * validates a different shape, so the caller supplies them.
 *
 * @returns {{ status: number, code?: string }|null} the first refusal, or null
 *   if every middleware in front of the controller let the caller pass.
 */
const gateFor = (routeLayer, role, overrides = {}) => {
  const stack = routeLayer.route.stack;
  const controller = stack[stack.length - 1].handle;

  const req = {
    user: { role, _id: 'caller', schoolId: 'sch1' },
    params: { requestId: '507f1f77bcf86cd799439011' },
    body: { decision: 'approved', note: '' },
    ...overrides,
  };

  for (const entry of stack.slice(0, -1)) {
    if (entry.name === 'authenticate') continue;

    const answer = { status: 200 };
    const res = {
      status(code) {
        answer.status = code;
        return this;
      },
      json(body) {
        answer.code = body?.code;
        answer.message = body?.message;
        return this;
      },
    };

    entry.handle(req, res, () => {});
    if (answer.status >= 400) return { status: answer.status, code: answer.code };
  }

  assert.equal(typeof controller, 'function', 'the route must end in a controller');
  return null;
};

const joinRequestRoutes = async () => {
  const { schoolRoute } = await import('../src/routes/school.routes.js');
  return {
    list: schoolRoute.stack.find(
      (layer) => layer.route?.path === '/schools/join-requests' && layer.route.methods.get
    ),
    decide: schoolRoute.stack.find(
      (layer) =>
        layer.route?.path === '/schools/join-requests/:requestId' && layer.route.methods.put
    ),
  };
};

describe('the approval queue route', () => {
  for (const [name, key] of [
    ['listing requests', 'list'],
    ['deciding one', 'decide'],
  ]) {
    test(`${name} requires a school admin`, async () => {
      const routes = await joinRequestRoutes();
      assert.ok(routes[key], `${key} route is not mounted`);

      // The refusal that matters. A teacher or an accountant who guesses the
      // path must not be able to read — never mind approve — who is waiting to
      // get into somebody else's school.
      for (const excluded of [ROLES.TEACHER, ROLES.ACCOUNTANT, ROLES.VIEWER]) {
        const refusal = gateFor(routes[key], excluded);
        assert.ok(refusal, `${excluded} was allowed through`);
        assert.equal(refusal.status, 403, `${excluded} should be refused with 403`);
      }

      // And the role the whole feature exists for gets past the gate.
      assert.equal(gateFor(routes[key], ROLES.SCHOOL_ADMIN), null);
      // The platform owner acts across every tenant, so they are not refused
      // either — their `schoolId` is null, which is why `requireSchool` is what
      // stops them rather than the role list.
      assert.equal(gateFor(routes[key], ROLES.SUPER_ADMIN), null);
    });

    test(`${name} still requires a school to be in scope`, async () => {
      // The role check must not have replaced `requireSchool`: an admin whose
      // own school is missing should get the provisioning 409 that names the
      // step that fixes it, not a 403 about a resource they were allowed to
      // reach.
      const routes = await joinRequestRoutes();
      const names = routes[key].route.stack.map((entry) => entry.name);
      assert.ok(names.includes('requireSchool'), 'requireSchool is missing');
    });
  }

  test('asking to join is not admin-gated', async () => {
    // The complement, and the reason the feature works at all: `POST /schools/join`
    // is made by exactly the people who cannot approve anything. Gating it on
    // `school_admin` would make the pending state unreachable.
    const { schoolRoute } = await import('../src/routes/school.routes.js');
    const layer = schoolRoute.stack.find(
      (l) => l.route?.path === '/schools/join' && l.route.methods.post
    );
    assert.ok(layer, 'POST /schools/join is not mounted');

    // A body that passes `joinSchoolSchema`, so the walk reaches the controller
    // for the right reason rather than stopping at validation.
    const req = { body: { schoolCode: 'ABC123' }, params: {} };

    assert.equal(gateFor(layer, ROLES.TEACHER, req), null, 'a teacher must be able to submit a school code');
    assert.equal(gateFor(layer, ROLES.ACCOUNTANT, req), null);
    assert.equal(gateFor(layer, ROLES.VIEWER, req), null);
  });
});

// ── Where a linked account is sent ──────────────────────────────────────────
describe('landingRouteFor — the destination a linked account is given', () => {
  const load = async () => import('../src/controllers/authController.js');

  test('a teacher is sent to the teacher portal, not the school console', async () => {
    // The bug, stated once: `Login.jsx` navigated to `?next`, or to `/dashboard`
    // when there was nothing to honour, and nobody asked the role. So the one
    // role the product ships a full portal for — register, marks, timetable —
    // was dropped into a finance console whose rail is other people's work.
    const { landingRouteFor } = await load();
    assert.equal(landingRouteFor(ROLES.TEACHER), '/teacher');
  });

  test('every other role keeps the school console', async () => {
    const { landingRouteFor } = await load();
    for (const role of [ROLES.SCHOOL_ADMIN, ROLES.ACCOUNTANT, ROLES.VIEWER, ROLES.SUPER_ADMIN]) {
      assert.equal(landingRouteFor(role), '/dashboard', `${role} belongs on the school console`);
    }
  });

  test('the path it names is a route the client actually has', async () => {
    // `/teacher` is `TEACHER_ROUTES.dashboard`. Two copies of the same string
    // will drift, and the one that loses redirects a teacher to a 404 — so the
    // client's copy is read here rather than trusted.
    const { landingRouteFor } = await load();
    const { readFile } = await import('node:fs/promises');
    const constants = await readFile(new URL('../../frontend/src/utils/constants.js', import.meta.url), 'utf8');
    const teacherPortal = constants.match(/TEACHER_ROUTES\s*=\s*\{[\s\S]*?dashboard:\s*'([^']+)'/)?.[1];

    assert.ok(teacherPortal, 'TEACHER_ROUTES.dashboard not found in the client constants');
    assert.equal(
      landingRouteFor(ROLES.TEACHER),
      teacherPortal,
      'the server names a teacher portal the client does not route'
    );
  });
});

// ── The route the server names for a joining account ────────────────────────
describe('the join flow is a screen, not a wizard step', () => {
  test('the server reports a route of its own for joining accounts', async () => {
    // Read from the source the way `platformSettings.test.js` reads the
    // provisioning call: `onboardingBlock` cannot be called here without a
    // database, but the literal it hands the client is the contract the client
    // routes on, so it is worth pinning.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../src/controllers/authController.js', import.meta.url),
      'utf8'
    );

    assert.ok(
      source.includes("'/onboarding/join-school'"),
      'onboardingBlock must name the join screen — the client has no other source for it'
    );
    assert.ok(
      source.includes("SCHOOL_JOIN_ROLES"),
      'onboardingBlock must branch on the join roles'
    );
    assert.ok(
      source.includes('flow: \'join\''),
      'the flow must be reported so the client can keep the two trees apart'
    );
  });

  test('the same constant is used by the join-request service guard', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../src/services/school.service.js', import.meta.url),
      'utf8'
    );

    // Both functions must agree on who decides, or the route-level gate becomes
    // the only thing standing between an accountant and another school's
    // applicant list.
    for (const fn of ['listJoinRequests', 'decideJoinRequest']) {
      const body = source.slice(source.indexOf(`export const ${fn}`));
      assert.ok(
        /role !== "super_admin" && user\.role !== "school_admin"/.test(body),
        `${fn} must admit only a school admin (or the platform owner)`
      );
    }
  });
});
