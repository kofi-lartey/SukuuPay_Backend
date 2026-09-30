// Regression suite for self-service school provisioning during onboarding.
//
//   npm test
//
// The bug this exists to prevent: `POST /auth/signup` collected a school name,
// classification and region, and the shared `validate` middleware ran Joi with
// `stripUnknown: true` against a schema that had no `school` key — so the whole
// object was silently deleted. The account was created with `schoolId: null`,
// and Step 1 of onboarding rendered a terminal "contact support" card, because
// `POST /schools` (the only route that creates a School) was gated on
// `authorize("super_admin")`. Every self-service signup dead-ended and nothing
// in the test suite noticed.
//
// Pure unit tests: no database, no network, no live server.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── The link-state rule ──
// One definition, consumed by `/auth/me`, `requireSchool` and the provisioning
// service. If these drift, the client is back to guessing.
describe('resolveAccountLinkState', () => {
  const resolve = async (...args) => {
    const { resolveAccountLinkState } = await import('../src/utils/accountLink.js');
    return resolveAccountLinkState(...args);
  };

  test('an anonymous request is not linked', async () => {
    const state = await resolve(null);
    assert.equal(state.linked, false);
    assert.equal(state.reason, 'ANONYMOUS');
  });

  test('platform staff are linked without a school', async () => {
    // `super_admin` belongs to no school by design. Routing them into
    // provisioning would ask the founder to invent a school to use the platform.
    const state = await resolve({ role: 'super_admin', schoolId: null });
    assert.equal(state.linked, true, 'platform staff must not be diverted to provisioning');
    assert.equal(state.reason, 'PLATFORM_STAFF');
    assert.equal(state.schoolId, null);
  });

  test('an account with no schoolId is unlinked', async () => {
    const state = await resolve({ role: 'school_admin', schoolId: null });
    assert.equal(state.linked, false);
    assert.equal(state.reason, 'UNLINKED');
  });

  test('a real schoolId is linked', async () => {
    const state = await resolve({ role: 'school_admin', schoolId: 'abc123' });
    assert.equal(state.linked, true);
    assert.equal(state.reason, 'LINKED');
    assert.equal(state.schoolId, 'abc123');
  });

  test('a schoolId pointing at a deleted school is not linked', async () => {
    // Dangling reference. Treated as "unlinked" because every downstream step
    // would otherwise fail against a soft-deleted school.
    const state = await resolve(
      { role: 'school_admin', schoolId: 'abc123' },
      async () => false
    );
    assert.equal(state.linked, false);
    assert.equal(state.reason, 'DANGLING');
    assert.equal(state.schoolId, null);
  });

  test('an existence check that passes keeps the account linked', async () => {
    const state = await resolve({ role: 'school_admin', schoolId: 'abc123' }, async () => true);
    assert.equal(state.linked, true);
    assert.equal(state.reason, 'LINKED');
  });
});

// ── Signup classification → School.type ──
// The signup form offers `senior_high` and `university`; the School enum has
// neither. Unmapped, a bursar fills in every field and then gets a 422 about an
// enum they never saw, on the last step of onboarding.
describe('school type mapping', () => {
  const load = async () => import('../src/utils/schoolTypeMapping.js');

  test('accepts every value in the School enum unchanged', async () => {
    const { toSchoolType, SCHOOL_TYPES } = await load();
    for (const type of SCHOOL_TYPES) {
      assert.equal(toSchoolType(type), type, `${type} should pass through`);
    }
  });

  test('maps the signup-only classifications onto the enum', async () => {
    const { toSchoolType } = await load();
    assert.equal(toSchoolType('senior_high'), 'public');
    assert.equal(toSchoolType('university'), 'private');
  });

  test('is case and whitespace insensitive', async () => {
    const { toSchoolType } = await load();
    assert.equal(toSchoolType('  Senior_High '), 'public');
    assert.equal(toSchoolType('INTERNATIONAL'), 'international');
  });

  test('rejects a value that is in neither vocabulary', async () => {
    // Returning a default here would silently file a school under the wrong
    // category, so `null` is the honest answer and the caller must reject it.
    const { toSchoolType } = await load();
    for (const bad of ['witchcraft_academy', '', '   ', null, undefined, 42, {}]) {
      assert.equal(toSchoolType(bad), null, `${JSON.stringify(bad)} should not map`);
    }
  });

  test('flags the mappings that lose meaning', async () => {
    // The UI shows a note for these, so the lossy step is visible rather than a
    // silent rewrite of what the bursar chose.
    const { isLossyClassification } = await load();
    assert.equal(isLossyClassification('senior_high'), true);
    assert.equal(isLossyClassification('university'), true);
    assert.equal(isLossyClassification('private'), false);
    assert.equal(isLossyClassification('public'), false);
    assert.equal(isLossyClassification('nonsense'), false);
  });
});

// ── Provisioning validation ──
describe('provisionMySchoolSchema', () => {
  const load = async () => import('../src/validations/school.validation.js');

  const valid = {
    name: 'Prampram Basic & JHS',
    type: 'private',
    phone: '0241234567',
    email: 'office@prampram.edu.gh',
    address: '12 Independence Avenue',
    city: 'Accra',
    region: 'Greater Accra',
  };

  const run = async (schema, body) => {
    const { error, value } = schema.validate(body, { abortEarly: true, stripUnknown: true, convert: true });
    return { error, value };
  };

  test('accepts a complete profile', async () => {
    const { provisionMySchoolSchema } = await load();
    const { error } = await run(provisionMySchoolSchema, valid);
    assert.equal(error, undefined, error?.message);
  });

  test('normalises a signup classification into a stored type', async () => {
    const { provisionMySchoolSchema } = await load();
    const { error, value } = await run(provisionMySchoolSchema, { ...valid, type: 'senior_high' });
    assert.equal(error, undefined, error?.message);
    assert.equal(value.type, 'public', 'the value the School model stores');
  });

  test('normalises a local phone to the 233 form', async () => {
    // Mirrors `validateGhanaPhone`, which the School model relies on.
    const { provisionMySchoolSchema } = await load();
    const { value } = await run(provisionMySchoolSchema, { ...valid, phone: '0241234567' });
    assert.equal(value.phone, '233241234567');
  });

  test('rejects a required field that is missing', async () => {
    const { provisionMySchoolSchema } = await load();
    for (const key of ['name', 'type', 'phone', 'email', 'address', 'city', 'region']) {
      const body = { ...valid };
      delete body[key];
      const { error } = await run(provisionMySchoolSchema, body);
      assert.ok(error, `expected ${key} to be required`);
    }
  });

  test('rejects a non-Ghana phone', async () => {
    const { provisionMySchoolSchema } = await load();
    const { error } = await run(provisionMySchoolSchema, { ...valid, phone: '+1 415 555 0100' });
    assert.ok(error, 'a US number must not be accepted');
  });

  test('rejects an unknown region', async () => {
    const { provisionMySchoolSchema } = await load();
    const { error } = await run(provisionMySchoolSchema, { ...valid, region: 'Wakanda' });
    assert.ok(error);
  });

  test('strips keys the schema does not declare', async () => {
    // Same `stripUnknown` behaviour the whole codebase relies on: a client
    // cannot set `status`, `subscription` or `stats` by including them.
    const { provisionMySchoolSchema } = await load();
    const { value } = await run(provisionMySchoolSchema, {
      ...valid,
      status: 'active',
      subscription: { plan: 'enterprise' },
      createdBy: 'someone-else',
    });
    assert.equal(value.status, undefined);
    assert.equal(value.subscription, undefined);
    assert.equal(value.createdBy, undefined);
  });

  test('a partial update can still omit the phone', async () => {
    // Regression guard for the `.required()` added to `phoneValidator`. Step 1
    // in edit mode, and the school settings screen, both PATCH one field at a
    // time; if `.optional()` stopped winning over the base `required`, every
    // partial update would start 422ing.
    const { updateSchoolSchema } = await load();
    const { error } = await run(updateSchoolSchema, { motto: 'Knowledge and Service' });
    assert.equal(error, undefined, error?.message);
  });

  test('a partial update still validates the phone when it is sent', async () => {
    const { updateSchoolSchema } = await load();
    const { error } = await run(updateSchoolSchema, { phone: '+1 415 555 0100' });
    assert.ok(error, 'an invalid phone must still be rejected on update');
  });
});

// ── Signup keeps the school intent ──
describe('signupSchema', () => {
  test('no longer strips the school the user described', async () => {
    // The regression in one assertion. `signupSchema` had no `school` key, so
    // `stripUnknown` deleted the whole nested object before the controller ran,
    // and the bursar was asked for these details a second time on a dead-end
    // screen.
    const { signupSchema } = await import('../src/validators/authValidators.js');
    const { error, value } = signupSchema.validate(
      {
        name: 'Dr. Kwame Mensah',
        email: 'bursar@school.edu.gh',
        phone: '233244567890',
        password: 'MockPass123',
        school: { name: 'Prampram Basic & JHS', classification: 'senior_high', region: 'Greater Accra' },
      },
      { abortEarly: true, stripUnknown: true, convert: true }
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(value.school.name, 'Prampram Basic & JHS');
    assert.equal(value.school.classification, 'senior_high');
    assert.equal(value.school.region, 'Greater Accra');
  });

  test('school remains optional', async () => {
    const { signupSchema } = await import('../src/validators/authValidators.js');
    const { error } = signupSchema.validate(
      { name: 'Dr. Kwame Mensah', email: 'b@school.edu.gh', phone: '233244567890', password: 'MockPass123' },
      { abortEarly: true, stripUnknown: true }
    );
    assert.equal(error, undefined, error?.message);
  });

  test('rejects an unknown key inside the school object', async () => {
    // `.unknown(false)`: a client must not be able to smuggle extra fields into
    // the intent record.
    const { signupSchema } = await import('../src/validators/authValidators.js');
    const { error } = signupSchema.validate(
      {
        name: 'Dr. Kwame Mensah',
        email: 'b@school.edu.gh',
        phone: '233244567890',
        password: 'MockPass123',
        school: { name: 'X School', status: 'active' },
      },
      { abortEarly: true, stripUnknown: true }
    );
    assert.ok(error, 'expected the stray key to be rejected');
  });
});

// ── The routes are actually mounted ──
describe('school routes', () => {
  test('the self-service endpoints are registered', async () => {
    // Guards against a route that exists in a controller but was never wired,
    // which is exactly how `POST /schools/me` would have looked fine in review
    // and 404 in production.
    const { schoolRoute } = await import('../src/routes/school.routes.js');
    const mounted = schoolRoute.stack
      .filter((layer) => layer.route)
      .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

    for (const expected of [
      'POST /schools/me',
      'POST /schools/join',
      'GET /schools/join-requests',
      'PUT /schools/join-requests/:requestId',
    ]) {
      assert.ok(mounted.includes(expected), `${expected} is not mounted`);
    }
  });

  test('POST /schools/me does not require an existing school', async () => {
    // `requireSchool` would make the endpoint unreachable: it exists precisely
    // for accounts that do not have one.
    const { schoolRoute } = await import('../src/routes/school.routes.js');
    const layer = schoolRoute.stack.find(
      (l) => l.route?.path === '/schools/me' && l.route.methods.post
    );
    assert.ok(layer, 'POST /schools/me not found');
    const handlerNames = layer.route.stack.map((l) => l.name);
    assert.equal(
      handlerNames.includes('requireSchool'),
      false,
      'requireSchool must not guard the provisioning endpoint'
    );
    assert.ok(handlerNames.includes('authenticate'), 'the endpoint must still be authenticated');
  });

  test('PUT /schools/:schoolId does require an existing school', async () => {
    // The complement: an unlinked bursar must get 409 SCHOOL_NOT_LINKED rather
    // than the 403 "You do not have access to this school", which is actively
    // misleading for someone who owns nothing yet.
    const { schoolRoute } = await import('../src/routes/school.routes.js');
    const layer = schoolRoute.stack.find(
      (l) => l.route?.path === '/schools/:schoolId' && l.route.methods.put
    );
    assert.ok(layer, 'PUT /schools/:schoolId not found');
    const names = layer.route.stack.map((l) => l.name);
    assert.ok(names.includes('requireSchool'), 'requireSchool is missing from the update route');
  });
});

// ── The service functions the routes depend on ──
describe('school service exports', () => {
  test('the provisioning and join functions exist', async () => {
    const svc = await import('../src/services/school.service.js');
    for (const name of [
      'provisionSchoolForUser',
      'requestToJoinSchool',
      'listJoinRequests',
      'decideJoinRequest',
    ]) {
      assert.equal(typeof svc[name], 'function', `${name} is not exported`);
    }
  });
});
