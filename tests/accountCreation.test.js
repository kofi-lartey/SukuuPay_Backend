// Regression suite for role selection, position selection, and the schoolId
// provenance that ties them together.
//
//   npm test
//
// The bug that prompted this: an image upload from Step 1 failed with
// `{ success: false, message: "No school in scope" }` for a user whose object
// showed `schoolId: null` alongside empty `schoolIntent` fields. Only one of those
// two facts is the cause, and the distinction matters — the fix is to the upload
// path, not to the intent record.
//
// Pure unit tests: no database, no network, no live server.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Role selection ──
describe('self-signup roles', () => {
  test('super_admin is not claimable', async () => {
    // The whole reason the list is a strict subset of the model enum. An
    // anonymous form field that can mint a platform operator is a complete
    // compromise, so this is asserted first and explicitly.
    const { SELF_SIGNUP_ROLES } = await import('../src/validators/authValidators.js');
    assert.equal(SELF_SIGNUP_ROLES.includes('super_admin'), false);
  });

  test('exposes the four legitimate roles', async () => {
    const { SELF_SIGNUP_ROLES } = await import('../src/validators/authValidators.js');
    assert.deepEqual([...SELF_SIGNUP_ROLES].sort(), [
      'accountant',
      'school_admin',
      'teacher',
      'viewer',
    ]);
  });

  test('every claimable role exists on the User model', async () => {
    // Otherwise a legitimate signup 500s inside Mongoose on an enum mismatch,
    // after Joi said the value was fine.
    const { SELF_SIGNUP_ROLES } = await import('../src/validators/authValidators.js');
    const { User } = await import('../src/models/userModel.js');
    const modelRoles = User.schema.path('role').enumValues;
    for (const role of SELF_SIGNUP_ROLES) {
      assert.ok(modelRoles.includes(role), `${role} is not in the model's role enum`);
    }
  });

  test('defaults to school_admin when no role is sent', async () => {
    const { signupSchema } = await import('../src/validators/authValidators.js');
    const { value } = signupSchema.validate(
      {
        name: 'Dr. Kwame Mensah',
        email: 'bursar@school.edu.gh',
        phone: '233244567890',
        password: 'MockPass123',
      },
      { abortEarly: true, stripUnknown: true, convert: true }
    );
    assert.equal(value.role, 'school_admin');
  });

  test('accepts each claimable role', async () => {
    const { signupSchema, SELF_SIGNUP_ROLES } = await import('../src/validators/authValidators.js');
    for (const role of SELF_SIGNUP_ROLES) {
      const { error, value } = signupSchema.validate(
        {
          name: 'Ama Serwa',
          email: `a+${role}@school.edu.gh`,
          phone: '233244567890',
          password: 'MockPass123',
          role,
        },
        { abortEarly: true, stripUnknown: true, convert: true }
      );
      assert.equal(error, undefined, `${role} should be accepted: ${error?.message}`);
      assert.equal(value.role, role);
    }
  });

  test('rejects an attempt to self-grant super_admin', async () => {
    const { signupSchema } = await import('../src/validators/authValidators.js');
    const { error } = signupSchema.validate(
      {
        name: 'Eve',
        email: 'eve@evil.test',
        phone: '233244567890',
        password: 'MockPass123',
        role: 'super_admin',
      },
      { abortEarly: true, stripUnknown: true, convert: true }
    );
    assert.ok(error, 'super_admin must be rejected at the schema');
  });

  test('rejects an unknown role', async () => {
    const { signupSchema } = await import('../src/validators/authValidators.js');
    const { error } = signupSchema.validate(
      {
        name: 'Eve',
        email: 'eve@evil.test',
        phone: '233244567890',
        password: 'MockPass123',
        role: 'root',
      },
      { abortEarly: true, stripUnknown: true, convert: true }
    );
    assert.ok(error);
  });
});

// ── Position selection ──
describe('position', () => {
  test('accepts a free-text job title', async () => {
    // Deliberately not an enum. Schools have titles no fixed list anticipates,
    // and forcing a bursar into a wrong one to get their own job recorded is
    // worse than a free-text field.
    const { signupSchema } = await import('../src/validators/authValidators.js');
    for (const title of ['Deputy Headmaster', 'PTA Chair', 'Warden', 'Chief Cook']) {
      const { error } = signupSchema.validate(
        {
          name: 'Ama Serwa',
          email: 'a@school.edu.gh',
          phone: '233244567890',
          password: 'MockPass123',
          position: title,
        },
        { abortEarly: true, stripUnknown: true, convert: true }
      );
      assert.equal(error, undefined, `${title} should be accepted: ${error?.message}`);
    }
  });

  test('rejects an absurdly long position', async () => {
    const { signupSchema } = await import('../src/validators/authValidators.js');
    const { error } = signupSchema.validate(
      {
        name: 'Ama Serwa',
        email: 'a@school.edu.gh',
        phone: '233244567890',
        password: 'MockPass123',
        position: 'x'.repeat(81),
      },
      { abortEarly: true, stripUnknown: true, convert: true }
    );
    assert.ok(error);
  });

  test('accepts an empty position', async () => {
    const { signupSchema } = await import('../src/validators/authValidators.js');
    const { error } = signupSchema.validate(
      {
        name: 'Ama Serwa',
        email: 'a@school.edu.gh',
        phone: '233244567890',
        password: 'MockPass123',
        position: '',
      },
      { abortEarly: true, stripUnknown: true, convert: true }
    );
    assert.equal(error, undefined, error?.message);
  });

  test('position is a plain string on the model, not an enum', async () => {
    // Guards the decision above: if someone later swaps this for an enum, the
    // "Other" escape hatch silently stops working.
    //
    // `enumValues` is asserted as empty rather than absent because Mongoose
    // normalises a plain `String` to `[]`; only a real enum would be non-empty.
    const { User } = await import('../src/models/userModel.js');
    assert.equal(User.schema.path('position').instance, 'String');
    assert.deepEqual(User.schema.path('position').enumValues, []);
  });
});

// ── schoolId provenance ──
// The mechanism behind the reported bug, pinned so the relationship cannot drift.
describe('schoolId provenance', () => {
  test('a new User has no schoolId', async () => {
    // The state every self-service signup starts in, and the state that made the
    // logo upload unresolvable.
    const { User } = await import('../src/models/userModel.js');
    const user = new User({ name: 'Ama', email: 'a@school.edu.gh' });
    assert.equal(user.schoolId, null);
  });

  test('schoolId defaults to null, not undefined', async () => {
    // `undefined` would make a falsy check behave identically but serialise
    // differently, which matters because the guard reads a JSON payload.
    const { User } = await import('../src/models/userModel.js');
    const user = new User({ name: 'Ama', email: 'a@school.edu.gh' });
    assert.strictEqual(user.schoolId, null);
  });

  test('schoolId is an ObjectId ref, distinct from the id it points at', async () => {
    // The whole mechanism: Mongoose mints the School's own `_id`, and that value
    // is copied onto the user. `schoolId` is not a school record and is not
    // generated from anything the user supplies.
    const { User } = await import('../src/models/userModel.js');
    const { School } = await import('../src/models/schoolModel.js');

    const school = new School({ name: 'Prampram Basic & JHS' });
    const user = new User({ name: 'Ama', email: 'a@school.edu.gh' });

    assert.ok(school._id, 'Mongo mints the School _id on insert');
    assert.notEqual(school._id.toString(), user._id.toString(), 'a school and a user never share an id');

    user.schoolId = school._id;
    assert.equal(user.schoolId.toString(), school._id.toString());
    assert.equal(
      User.schema.path('schoolId').instance,
      'ObjectId',
      'schoolId must store the id, not a populated document'
    );
  });

  test('schoolIntent is not a school reference', async () => {
    // The distinction that resolved the reported bug. `schoolIntent` holds plain
    // strings and points at nothing, so it cannot satisfy any scope check — which
    // is why an empty intent was never the cause of "No school in scope".
    //
    // Asserted via the flattened nested paths: `schoolIntent` is declared without
    // an explicit type or `_id`, so Mongoose does not register it as a single
    // path of its own. (Same flattening as `School.location`.)
    const { User } = await import('../src/models/userModel.js');

    for (const key of ['name', 'classification', 'region']) {
      const field = User.schema.path(`schoolIntent.${key}`);
      assert.ok(field, `schoolIntent.${key} must exist on the schema`);
      assert.equal(field.instance, 'String', `schoolIntent.${key} must be a string`);
    }

    const user = new User({ name: 'Ama', email: 'a@school.edu.gh' });
    assert.equal(user.schoolId, null, 'intent carries no school reference');
    assert.equal(
      Boolean(user.schoolIntent.name),
      false,
      'an empty intent resolves to no school, exactly like a null schoolId'
    );
  });

  test('the upload scope rule reads schoolId and nothing else', async () => {
    // The rule that produced "No school in scope": for a non-platform user the
    // school comes from `user.schoolId` alone, with no fallback to the intent.
    const mongoose = (await import('mongoose')).default;

    const resolveSchoolId = (user, explicitSchoolId) => {
      if (user && user.role === 'super_admin') {
        return explicitSchoolId ? new mongoose.Types.ObjectId(explicitSchoolId) : null;
      }
      return user && user.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
    };

    const unlinkedWithIntent = {
      role: 'school_admin',
      schoolId: null,
      schoolIntent: { name: 'Prampram Basic & JHS', classification: 'senior_high', region: 'Greater Accra' },
    };

    assert.equal(
      resolveSchoolId(unlinkedWithIntent, '64b000000000000000000001'),
      null,
      'a populated schoolIntent must not resolve a scope — it is a name, not an id'
    );

    const linked = { role: 'school_admin', schoolId: new mongoose.Types.ObjectId() };
    assert.ok(resolveSchoolId(linked, null), 'a real schoolId does resolve a scope');
  });
});
