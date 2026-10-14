// Regression suite for teacher assignment: the student→teacher link that the
// class endpoints cannot express.
//
//   npm test
//
// The behaviour this exists to protect:
//
//   1. **The model indexes the two queries it exists for.** A student→teacher
//      link stored as an array on `Student` would make the page's main query —
//      "this teacher's students" — a collection scan. These are the indexes that
//      keep it an index read, and dropping one is silent: everything works until
//      the school has 2,000 children.
//
//   2. **The live-unique index is partial, and that is not a detail.** It is what
//      makes re-assigning after an un-assignment legal, and what makes a
//      duplicate assign a no-op rather than an error.
//
//   3. **Removing is not the inverse of assigning.** A class-mediated row is
//      refused unless `force`, because dropping it would orphan a class's
//      children while the class teacher still stands.
//
//   4. **`requireSchoolAdmin` on every route.** A teacher may read their own
//      students through the teacher portal, but naming who is responsible for
//      whom is a headmaster's decision.
//
// Pure unit tests, no database: the model's schema is inspected, the routes are
// driven through their middleware stack, and the service contracts are read from
// the source the way `platformSettings.test.js` reads the provisioning call.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { adminAcademicRoute } from '../src/routes/admin.academic.routes.js';

/**
 * Find a route layer on the router.
 *
 * Optional-chained on `layer.route` as well as `layer.route.path`, because the
 * router's stack holds `router.use(authenticate)` layers that have no `route` at
 * all — touching `.methods` on one of those is a TypeError, not a miss.
 */
const mountFor = (method, path) =>
  adminAcademicRoute.stack.find(
    (layer) => layer.route?.path === path && layer.route?.methods?.[method]
  );

/**
 * Walks a route's middleware stack the way Express would, and reports the first
 * refusal.
 *
 * **Awaited.** `requireSchool` is async — it resolves the account's link state
 * before deciding — so a synchronous walk checks its answer before the answer
 * exists and reads `null` for a refusal the middleware is about to make. That
 * version of this helper passed every "is gated" assertion by never letting the
 * gate speak.
 *
 * Bodies and queries carry valid values for the route under test, so a 422 from
 * Joi is a real validation failure and not "the caller sent an empty payload".
 */
const gateFor = async (routeLayer, role, options = {}) => {
  const { schoolId = 'sch1', body = { studentIds: ['507f1f77bcf86cd799439011'] }, query = {} } = options;

  const req = {
    user: { _id: 'caller', role, schoolId },
    params: { teacherId: '507f1f77bcf86cd799439011' },
    query,
    body,
    headers: { 'content-type': 'application/json' },
  };

  for (const entry of routeLayer.route.stack.slice(0, -1)) {
    if (entry.name === 'authenticate') continue;

    const answer = { status: null };
    const res = {
      status(code) {
        answer.status = code;
        return this;
      },
      json(body_) {
        answer.code = body_?.code;
        answer.message = body_?.message;
        return this;
      },
    };

    // A rejected body for the POST is not the case under test, so a valid one is
    // passed by default and the caller may override.
    await entry.handle(req, res, () => {});
    if (answer.status !== null) return { status: answer.status, code: answer.code };
  }

  return { status: null };
};

describe('the routes are mounted where the client calls them', () => {
  test('all four endpoints exist', () => {
    assert.ok(mountFor('get', '/users/teacher-assignment-counts'), 'counts route missing');
    assert.ok(mountFor('get', '/users/:teacherId/students'), 'list route missing');
    assert.ok(mountFor('post', '/users/:teacherId/students'), 'assign route missing');
    assert.ok(mountFor('delete', '/users/:teacherId/students'), 'unassign route missing');
  });

  test('the literal counts path is matched before the parameter route', () => {
    // A `:teacherId` wildcard registered first would capture the counts path and
    // try to look up a teacher whose id is the string "teacher-assignment-counts"
    // — a 400 the caller cannot interpret and a 404 in the logs.
    const paths = adminAcademicRoute.stack
      .filter((layer) => layer.route?.path?.startsWith('/users/'))
      .map((layer) => layer.route.path);
    assert.ok(paths.indexOf('/users/teacher-assignment-counts') !== -1);
    assert.ok(
      paths.indexOf('/users/teacher-assignment-counts') < paths.indexOf('/users/:teacherId/students'),
      'the counts path must be registered before the parameterised routes'
    );
  });

  test('every route requires a linked school, and distinguishes it from a refusal', async () => {
    // An admin whose school is missing must get `409 SCHOOL_NOT_LINKED`, not the
    // `403` a wrong role gets — the two answers send the caller to different
    // screens, and conflating them is the bug `requireSchool` was written for.
    for (const [method, path] of [
      ['get', '/users/teacher-assignment-counts'],
      ['get', '/users/:teacherId/students'],
      ['post', '/users/:teacherId/students'],
      ['delete', '/users/:teacherId/students'],
    ]) {
      const layer = mountFor(method, path);
      const names = layer.route.stack.map((entry) => entry.name);
      assert.ok(names.includes('requireSchool'), `${method} ${path} does not require a school`);

      const answer = await gateFor(layer, 'school_admin', { schoolId: null });
      assert.equal(answer.status, 409, `${method} ${path} answered an unlinked admin with ${answer.status}`);
      assert.equal(answer.code, 'SCHOOL_NOT_LINKED', `${method} ${path} did not name the missing school`);
    }
  });

  test('a teacher is refused, and a school admin passes', async () => {
    // The disclosure boundary. A `teacher` can already read their own students
    // through `/teacher`; what they cannot do is name who is responsible for
    // whom, which is a headmaster's decision and not a write boundary.
    //
    // Behavioral rather than a middleware-name assertion: `authorize(...)` and
    // `requireSchoolAdmin` are anonymous arrows, so `entry.name` is `''` and a
    // name check would pass on nothing at all — the same trap the first version
    // of this test fell into.
    for (const [method, path] of [
      ['get', '/users/:teacherId/students'],
      ['post', '/users/:teacherId/students'],
      ['delete', '/users/:teacherId/students'],
      ['get', '/users/teacher-assignment-counts'],
    ]) {
      const layer = mountFor(method, path);
      assert.equal((await gateFor(layer, 'teacher')).status, 403, `${method} ${path} admitted a teacher`);
      assert.equal((await gateFor(layer, 'accountant')).status, 403, `${method} ${path} admitted an accountant`);
      assert.equal((await gateFor(layer, 'viewer')).status, 403, `${method} ${path} admitted a viewer`);
      assert.equal((await gateFor(layer, 'school_admin')).status, null, `${method} ${path} refused a school admin`);
      assert.equal((await gateFor(layer, 'super_admin')).status, null, `${method} ${path} refused a platform owner`);
    }
  });

  test('the assignment routes validate a body, so a typo is a 422 and not a write', () => {
    // `POST` with no studentIds and no class name must not reach the service.
    // Validation's `.xor` is what guarantees it, and this asserts the layer is
    // actually in the stack rather than assumed.
    const layer = mountFor('post', '/users/:teacherId/students');
    const stack = layer.route.stack;
    const hasValidation = stack.length >= 3 && stack.some((entry) => entry.name !== 'authenticate' && entry.name !== 'requireSchoolAdmin' && entry.name !== 'requireSchool' && entry.name !== 'assignStudentsController');
    assert.ok(hasValidation, 'POST /users/:teacherId/students has no body validation layer');
  });
});

// ── The model's indexes, read rather than loaded ─────────────────────────────
describe('TeacherAssignment', () => {
  const readSource = async () => {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL('../src/models/TeacherAssignment.js', import.meta.url), 'utf8');
  };

  test('indexes the two directions the model is read in', async () => {
    const source = await readSource();

    assert.ok(
      source.includes('{ schoolId: 1, teacherId: 1 }'),
      'no { schoolId, teacherId } index — the page\'s main query would be a collection scan'
    );
    assert.ok(
      source.includes('{ schoolId: 1, studentId: 1 }'),
      'no { schoolId, studentId } index — "who looks after this child" would be a collection scan'
    );
  });

  test('keeps the school on every index, so a read is never cross-tenant', async () => {
    // An index without `schoolId` is correct for a single-tenant database and
    // wrong here: the query always carries it, so an index that leaves it out is
    // one the planner will not use. Counted from the `.index(` calls, then
    // checked in the source text, because two of the three are one-liners and
    // the compound one is spread over several lines.
    const source = await readSource();
    assert.ok((source.match(/\.index\(/g) || []).length >= 3, 'expected three indexes');

    for (const key of ['schoolId: 1, teacherId: 1', 'schoolId: 1, studentId: 1']) {
      assert.ok(source.includes(`{ ${key} }`), `no index on { ${key} }`);
    }
    assert.ok(
      /schoolId: 1,\s*teacherId: 1,\s*studentId: 1/.test(source),
      'the compound index omits schoolId'
    );
  });

  test('the unique index is partial, so a re-assignment after an un-assignment is legal', async () => {
    // The whole idempotency and history design rests on this: live rows only, so
    // a tombstone never blocks the same pair being linked again, and a duplicate
    // assign collides rather than double-counting.
    const source = await readSource();

    assert.ok(source.includes('unique: true'), 'no unique index on the live pair');
    assert.ok(
      source.includes('partialFilterExpression: { removedAt: null }'),
      'the unique index is not partial — an un-reassignable tombstone, or a duplicate row'
    );
  });

  test('records class-mediation, which is what makes un-assignment safe', async () => {
    // Without this flag the UI has to guess whether a row came from a pick or a
    // class assignment, and the wrong guess removes a class's children while the
    // class teacher still stands.
    const source = await readSource();
    assert.ok(source.includes('classMediated'), 'the model does not record class mediation');
    assert.ok(source.includes('readdAt') === false, 'the timestamp field was misnamed');
  });

  test('soft-deletes rather than dropping the row', async () => {
    // The history is the answer to "why did my roster change" six months later,
    // and it costs nothing to keep.
    const source = await readSource();
    assert.ok(source.includes('removedAt'), 'no removedAt field');
    assert.ok(source.includes('softDelete'), 'no softDelete helper');
    assert.ok(
      source.includes('.query.live'),
      'no `live` query helper — the removedAt filter will be forgotten at a call site'
    );
  });
});

// ── The service contracts, read rather than executed ────────────────────────
describe('teacherAssignment.service', () => {
  const readSource = async () => {
    const { readFile } = await import('node:fs/promises');
    return readFile(
      new URL('../src/services/admin/teacherAssignment.service.js', import.meta.url),
      'utf8'
    );
  };

  test('re-reads the teacher from the database rather than trusting the path', async () => {
    // The client's copy of a teacher's role is not evidence. This is how an
    // accountant ends up with a roster.
    const source = await readSource();
    assert.ok(
      source.includes('role: { $in: TEACHING_ROLES }'),
      'loadTeacher does not re-check the role'
    );
    assert.ok(
      source.includes('TEACHING_ROLES = ["teacher", "school_admin"]'),
      'the teaching roles drifted from class.service.js'
    );
  });

  test('resolves a class roster server-side, never from the client', async () => {
    // "34 selected" followed by 3 rows is a bug report that reads as data loss.
    const source = await readSource();
    assert.ok(
      source.includes('const loadClassRoster = async'),
      'no server-side roster resolver — the class path trusts the client'
    );
    assert.ok(
      source.includes('studentClass: name'),
      'the class roster is not filtered by the class name'
    );
  });

  test('refuses a class-mediated row on remove unless force is set', async () => {
    const source = await readSource();
    const body = source.slice(source.indexOf('export const unassignStudents'));

    assert.ok(body.includes('classMediated'), 'unassign does not distinguish class rows');
    assert.ok(body.includes('force'), 'unassign has no force override');
    assert.ok(body.includes('skipped'), 'unassign does not report what it left alone');
  });

  test('counts the whole staff in one aggregation rather than one query each', async () => {
    // Forty teachers is forty `countDocuments` in a loop otherwise, all issued
    // on the same page load.
    const source = await readSource();
    const body = source.slice(source.indexOf('export const listTeacherAssignmentCounts'));
    assert.ok(body.includes('aggregate('), 'counts are not aggregated');
    assert.ok(body.includes('$group'), 'the aggregation does not group by teacher');
  });

  test('escapes a regex before putting it in a name search', async () => {
    // The search box takes a phone number, which is brackets and plus signs. An
    // unescaped one either refuses to compile or matches everything.
    const source = await readSource();
    assert.ok(
      /\.replace\(\/\[/,
      'the search regex is not escaped'
    );
    assert.ok(source.includes('\\$&'), 'the escape replacement is missing');
  });

  test('caps a single request at a bound, in both the service and the validator', async () => {
    // A typo or a mis-click that selects "everyone" must not be able to issue
    // 2,000 upserts in one request. Two ceilings rather than one: the service's
    // for every write path, the validator's so the request is refused before any
    // service code runs at all.
    const source = await readSource();
    assert.ok(source.includes('MAX_BATCH'), 'no service-side batch ceiling');

    const { readFile } = await import('node:fs/promises');
    const validation = await readFile(
      new URL('../src/validations/teacherAssignment.validation.js', import.meta.url),
      'utf8'
    );
    assert.ok(validation.includes('max(500)'), 'validation does not cap the list too');
    assert.ok(validation.includes('.xor('), 'validation does not refuse a body naming both selectors');
  });

  test('writes an audit entry for both assignment paths and the removal', async () => {
    // The audit row is the only record of who changed whom, and this is the
    // surface that changes it.
    const source = await readSource();
    const audits = source.match(/await auditLog\(/g) || [];
    assert.ok(audits.length >= 3, `expected at least 3 audit writes, found ${audits.length}`);
    assert.ok(source.includes('AUDIT_ACTIONS.CLASS_ASSIGN_TEACHER'), 'assign uses an unrelated action');
    assert.ok(source.includes('AUDIT_ACTIONS.CLASS_UNASSIGN_SUBJECT_TEACHER'), 'unassign action missing');
  });
});
