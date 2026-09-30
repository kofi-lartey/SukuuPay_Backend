// Regression suite for the Ghana Post GPS picker and the map picker.
//
//   npm test
//
// The field these cover used to be `Joi.string().max(200)`, which accepted
// anything. A digital address is not a free-text note: it identifies a 5m x 5m
// square, it is quoted to couriers and by Ghana Post, and it is printed on
// receipts. A transposed digit in the last group still *looks* valid, which is
// exactly why the format is now enforced rather than suggested.
//
// Pure unit tests: no database, no network, no live server.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const load = async () => import('../src/utils/ghanaPostGps.js');

// ── Format ──
// GA-183-8164: 2 letters (region + district), 3 digits (post office zone),
// 4 digits (unique address within the zone).
describe('digital address format', () => {
  test('accepts the canonical dashed form', async () => {
    const { isValidDigitalAddress } = await load();
    assert.equal(isValidDigitalAddress('GA-183-8164'), true);
    assert.equal(isValidDigitalAddress('AK-039-5028'), true);
    assert.equal(isValidDigitalAddress('GA-376-2513'), true);
  });

  test('accepts the undashed spelling', async () => {
    // Legacy rows and pasted values both use this form; rejecting it would strand
    // schools that already have a valid address on record.
    const { isValidDigitalAddress } = await load();
    assert.equal(isValidDigitalAddress('GA1838164'), true);
    assert.equal(isValidDigitalAddress('AK0395028'), true);
  });

  test('is case insensitive and tolerates stray spacing', async () => {
    const { isValidDigitalAddress } = await load();
    assert.equal(isValidDigitalAddress('ga-183-8164'), true);
    // Pasting from a PDF or a chat usually brings the spaces along too.
    assert.equal(isValidDigitalAddress('  GA - 183 - 8164  '), true);
    assert.equal(isValidDigitalAddress('GA 183 8164'), true);
  });

  test('rejects a wrong-length group', async () => {
    // These are the typos the segmented picker exists to prevent.
    const { isValidDigitalAddress } = await load();
    for (const bad of ['GA-18-8164', 'GA-183-816', 'GA-1838-164', 'GA-183-81644']) {
      assert.equal(isValidDigitalAddress(bad), false, `${bad} should be rejected`);
    }
  });

  test('rejects a single-letter or three-letter area code', async () => {
    const { isValidDigitalAddress } = await load();
    assert.equal(isValidDigitalAddress('G-183-8164'), false);
    assert.equal(isValidDigitalAddress('GAA-183-8164'), false);
  });

  test('rejects non-numeric groups', async () => {
    const { isValidDigitalAddress } = await load();
    assert.equal(isValidDigitalAddress('GA-1X3-8164'), false);
    assert.equal(isValidDigitalAddress('GA-183-81A4'), false);
  });

  test('rejects values that are not addresses at all', async () => {
    const { isValidDigitalAddress } = await load();
    for (const bad of ['', '   ', 'Accra', 'GA-123-4567-8901', '12 Independence Avenue', null, undefined, 42]) {
      assert.equal(isValidDigitalAddress(bad), false, `${JSON.stringify(bad)} should be rejected`);
    }
  });
});

// ── Normalisation ──
describe('normaliseDigitalAddress', () => {
  test('stores one canonical spelling', async () => {
    // Everything downstream should only ever see `GA-183-8164`.
    const { normaliseDigitalAddress } = await load();
    assert.equal(normaliseDigitalAddress('ga1838164'), 'GA-183-8164');
    assert.equal(normaliseDigitalAddress('  Ga - 183 - 8164 '), 'GA-183-8164');
    assert.equal(normaliseDigitalAddress('GA-183-8164'), 'GA-183-8164');
  });

  test('returns null rather than a half-corrected value', async () => {
    // Truncating a bad input to something address-shaped would file a school
    // under the wrong square of land. Refusing is the only safe answer.
    const { normaliseDigitalAddress } = await load();
    assert.equal(normaliseDigitalAddress('GA-183-816'), null);
    assert.equal(normaliseDigitalAddress('nonsense'), null);
  });

  test('parses into the three picker segments', async () => {
    const { parseDigitalAddress } = await load();
    assert.deepEqual(parseDigitalAddress('GA-183-8164'), {
      areaCode: 'GA',
      postalCode: '183',
      uniqueAddress: '8164',
    });
    assert.equal(parseDigitalAddress('GA1838164').areaCode, 'GA');
    assert.equal(parseDigitalAddress('rubbish'), null);
  });

  test('composes only when all three segments are the right shape', async () => {
    const { composeDigitalAddress } = await load();
    assert.equal(
      composeDigitalAddress({ areaCode: 'ga', postalCode: '183', uniqueAddress: '8164' }),
      'GA-183-8164'
    );
    // A partially typed address must never reach form state, or `toPayload`
    // would send a truncated address the server rejects on save.
    assert.equal(composeDigitalAddress({ areaCode: 'GA', postalCode: '183', uniqueAddress: '' }), null);
    assert.equal(composeDigitalAddress({ areaCode: 'G', postalCode: '183', uniqueAddress: '8164' }), null);
    assert.equal(composeDigitalAddress({ areaCode: '', postalCode: '', uniqueAddress: '' }), null);
  });

  test('area code suggestions are well-formed and unique', async () => {
    // Rendered as datalist options; a malformed or duplicated entry would show up
    // as a broken suggestion in the picker.
    const { AREA_CODE_SUGGESTIONS } = await load();
    assert.ok(AREA_CODE_SUGGESTIONS.length > 0);
    const seen = new Set();
    for (const entry of AREA_CODE_SUGGESTIONS) {
      assert.match(entry.code, /^[A-Z]{2}$/, `bad code ${entry.code}`);
      assert.ok(entry.district, `missing district for ${entry.code}`);
      assert.ok(entry.region, `missing region for ${entry.code}`);
      assert.equal(seen.has(entry.code), false, `duplicate code ${entry.code}`);
      seen.add(entry.code);
    }
  });
});

// ── The shared Joi rule ──
// Imported at module scope, not inside the `describe` callback: node:test does
// not await a `describe` body, so a top-level `await` there is a syntax error.
const { gpsAddressValidator } = await import('../src/validations/gpsAddress.validation.js');

describe('gpsAddressValidator', () => {
  const run = (value) =>
    gpsAddressValidator.validate(value, { abortEarly: true, stripUnknown: true, convert: true });

  test('normalises on the way through', async () => {
    // Two endpoints write this field, so the value must arrive in one form.
    assert.equal(run('ga1838164').value, 'GA-183-8164');
    assert.equal(run('  GA - 183 - 8164 ').value, 'GA-183-8164');
    assert.equal(run('GA 183 8164').value, 'GA-183-8164');
  });

  test('allows empty', async () => {
    // The field is optional, and an absent address is honest where a guessed one
    // is not. Rejecting "" would make the optional field mandatory.
    assert.equal(run('').error, undefined);
    assert.equal(run('   ').error, undefined);
  });

  test('rejects a malformed address with a message naming the format', async () => {
    const { error } = run('GA-123-4567-8901');
    assert.ok(error, 'expected a rejection');
    assert.match(error.message, /GA-183-8164/, 'the message should show the expected shape');
  });

  test('is reachable from both school write paths', async () => {
    // `PUT /schools/:schoolId` and `PUT /settings/:schoolId` both write
    // `School.gpsAddress`. If only one were strict, the looser one becomes the
    // way a typo reaches the database.
    const { updateSchoolSchema, provisionMySchoolSchema } = await import(
      '../src/validations/school.validation.js'
    );
    const { updateSettingsSchema } = await import('../src/validations/settings.validation.js');

    const bad = 'GA-123-4567-8901';
    for (const [name, schema] of [
      ['updateSchool', updateSchoolSchema],
      ['provisionMySchool', provisionMySchoolSchema],
      ['updateSettings', updateSettingsSchema],
    ]) {
      const { error } = schema.validate({ gpsAddress: bad }, { abortEarly: true, convert: true });
      assert.ok(error, `${name} should reject a malformed gpsAddress`);
    }
  });

  test('an existing valid address still passes the update path', async () => {
    // Guards against the strictness being introduced in a way that strands
    // schools whose address is already on record.
    const { updateSchoolSchema } = await import('../src/validations/school.validation.js');
    const { error } = updateSchoolSchema.validate(
      { gpsAddress: 'GA-376-2513' },
      { abortEarly: true, convert: true }
    );
    assert.equal(error, undefined, error?.message);
  });
});

// ── Coordinates ──
describe('location on the school schemas', () => {
  const loadSchemas = async () => {
    const { updateSchoolSchema, provisionMySchoolSchema } = await import(
      '../src/validations/school.validation.js'
    );
    return { updateSchoolSchema, provisionMySchoolSchema };
  };

  test('accepts a coordinate pair as dotted keys', async () => {
    // Dotted because that is the only form a Joi schema can take for a nested
    // path; `updateSchool` reassembles them into `school.location`.
    const { updateSchoolSchema } = await loadSchemas();
    const { error } = updateSchoolSchema.validate(
      {
        'location.latitude': 5.6037,
        'location.longitude': -0.187,
        'location.source': 'map_pin',
      },
      { abortEarly: true, convert: true }
    );
    assert.equal(error, undefined, error?.message);
  });

  test('rejects a latitude outside the globe', async () => {
    const { updateSchoolSchema } = await loadSchemas();
    const { error } = updateSchoolSchema.validate(
      { 'location.latitude': 95, 'location.longitude': 0 },
      { abortEarly: true, convert: true }
    );
    assert.ok(error, 'latitude 95 must be rejected');
  });

  test('rejects a longitude outside the globe', async () => {
    const { updateSchoolSchema } = await loadSchemas();
    const { error } = updateSchoolSchema.validate(
      { 'location.latitude': 0, 'location.longitude': 200 },
      { abortEarly: true, convert: true }
    );
    assert.ok(error, 'longitude 200 must be rejected');
  });

  test('accepts the exact edge values', async () => {
    const { updateSchoolSchema } = await loadSchemas();
    for (const [lat, lng] of [[90, 180], [-90, -180]]) {
      const { error } = updateSchoolSchema.validate(
        { 'location.latitude': lat, 'location.longitude': lng },
        { abortEarly: true, convert: true }
      );
      assert.equal(error, undefined, `${lat},${lng} should be accepted`);
    }
  });

  test('rejects an unrecognised source', async () => {
    // `source` records how the pin was set so a pin dropped by eye is not
    // presented with the confidence of one read off a device.
    const { updateSchoolSchema } = await loadSchemas();
    const { error } = updateSchoolSchema.validate(
      { 'location.latitude': 5.6, 'location.longitude': -0.2, 'location.source': 'guesswork' },
      { abortEarly: true, convert: true }
    );
    assert.ok(error, 'an unknown source must be rejected');
  });

  test('accepts every documented source', async () => {
    const { updateSchoolSchema } = await loadSchemas();
    for (const source of ['gps_address', 'map_pin', 'device', 'manual']) {
      const { error } = updateSchoolSchema.validate(
        { 'location.latitude': 5.6, 'location.longitude': -0.2, 'location.source': source },
        { abortEarly: true, convert: true }
      );
      assert.equal(error, undefined, `${source} should be accepted`);
    }
  });

  test('leaves coordinates optional', async () => {
    const { provisionMySchoolSchema } = await loadSchemas();
    const { error } = provisionMySchoolSchema.validate(
      {
        name: 'Prampram Basic & JHS',
        type: 'private',
        phone: '0241234567',
        email: 'office@prampram.edu.gh',
        address: '12 Independence Avenue',
        city: 'Accra',
        region: 'Greater Accra',
      },
      { abortEarly: true, convert: true }
    );
    assert.equal(error, undefined, error?.message);
  });

  test('will not invent a literal "location.latitude" property', async () => {
    // `School` has no such top-level field, so writing the dotted key straight
    // onto the document would create one and the real pin would never be read.
    // This asserts the schema and the model's shape agree.
    //
    // Note the assertion is on the *nested* paths, not on `path('location')`.
    // `location` is declared as a plain object with no explicit type or `_id`,
    // so Mongoose flattens it: `schema.path('location')` is undefined while
    // `schema.path('location.latitude')` resolves. Testing the nested paths is
    // what actually proves the subdocument exists.
    const { School } = await import('../src/models/schoolModel.js');
    assert.ok(School.schema.path('location.latitude'), 'School.location must have a latitude');
    assert.ok(School.schema.path('location.longitude'), 'School.location must have a longitude');
    assert.ok(School.schema.path('location.source'), 'School.location must record its source');
    assert.ok(School.schema.path('location.updatedAt'), 'School.location must record its freshness');
    assert.equal(
      School.schema.path('location.latitude').instance,
      'Number',
      'latitude should be stored as a number, not a string'
    );
    // The allowed sources must match the validator's list, or one of the two
    // silently rejects a value the other accepts.
    assert.deepEqual(
      School.schema.path('location.source').enumValues.filter(Boolean).sort(),
      ['device', 'gps_address', 'manual', 'map_pin']
    );
  });

  test('coordinates are not a top-level School field', async () => {
    const { School } = await import('../src/models/schoolModel.js');
    assert.equal(School.schema.path('latitude'), undefined);
    assert.equal(School.schema.path('longitude'), undefined);
  });
});
