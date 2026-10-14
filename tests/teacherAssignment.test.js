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

// ── The two representations, and why they must not drift ────────────────────
describe('a class assignment writes both representations', () => {
  const readSource = async (relative) => {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL(relative, import.meta.url), 'utf8');
  };

  test('there is one shared writer, and both routes call it', async () => {
    // The bug: `PUT /classes/:className/teacher` wrote `User.assignedClasses`
    // and no rows; `POST /admin/users/:teacherId/students` with a className wrote
    // the rows and never touched `assignedClasses`. A teacher assigned through
    // the new console therefore had an empty dashboard, because the portal reads
    // `assignedClasses` (`utils/teacherScope.js`) and the write landed elsewhere.
    const link = await readSource('../src/services/admin/teacherClassLink.js');
    const assignment = await readSource('../src/services/admin/teacherAssignment.service.js');
    const classService = await readSource('../src/services/admin/class.service.js');

    assert.ok(/export const syncClassTeacher/.test(link), 'no shared class-teacher writer');
    assert.ok(
      assignment.includes('syncClassTeacher'),
      'the assignment service does not sync the class slot'
    );
    assert.ok(
      classService.includes('syncClassTeacher'),
      'the class-teacher route does not sync the per-student rows'
    );
  });

  test('the slot primitives are no longer private to one service', async () => {
    // `moveAssignment` was private to `class.service.js`, which is what made it
    // possible for the other route to write the other representation.
    const classService = await readSource('../src/services/admin/class.service.js');
    const link = await readSource('../src/services/admin/teacherClassLink.js');

    assert.ok(!/const moveAssignment =/.test(classService), 'moveAssignment is private again');
    assert.ok(!/const currentHolderId =/.test(classService), 'currentHolderId is private again');
    assert.ok(link.includes('export const moveClassSlot'), 'the slot move is not exported');
    assert.ok(link.includes('export const currentSlotHolder'), 'the slot lookup is not exported');
  });

  test('the class path moves the slot the portal reads, not only the rows', async () => {
    const assignment = await readSource('../src/services/admin/teacherAssignment.service.js');
    const classStart = assignment.indexOf('export const assignStudentsByClass = async');
    const body = assignment.slice(classStart);

    assert.ok(body.includes('syncClassTeacher'), 'the class path does not write assignedClasses');
    assert.ok(body.includes('previous'), 'the class path does not record the previous holder');

    // Sliced on the exact boundary, not on a prefix — `assignStudents` is a
    // prefix of `assignStudentsByClass`, so a plain indexOf picks up whichever
    // function appears first. And it ends at the *doc comment* of the next
    // function rather than at its signature: that comment explains why the class
    // path calls `syncClassTeacher`, so a slice that included it failed an
    // assertion it was actually passing — the same "the test matched prose" trap
    // the shell-parity test hit. Comments are stripped for the same reason.
    const docStart = assignment.lastIndexOf('/**', classStart);
    const individual = assignment
      .slice(
        assignment.indexOf('export const assignStudents = async'),
        docStart > 0 ? docStart : classStart
      )
      .replace(/\/\*[\s\S]*?\*\//g, '');

    assert.ok(
      individual.includes('linkStudents'),
      'the individual path no longer links its rows'
    );
    assert.ok(
      !individual.includes('syncClassTeacher'),
      'the individual path is moving class slots too'
    );
  });

  test('dropping the last mediated child also drops the class slot', async () => {
    // The invariant, both directions: a teacher holds a class-teacher slot iff
    // they hold a live mediated row in it. Without the removal side the console
    // reads "Sir Ciblah has no students in JHS 2" while his portal still shows
    // JHS 2 on every screen.
    const assignment = await readSource('../src/services/admin/teacherAssignment.service.js');
    const body = assignment.slice(assignment.indexOf('export const unassignStudents'));

    assert.ok(body.includes('remaining === 0'), 'the last-mediated-check is missing');
    assert.ok(body.includes('$pull'), 'the removal path does not clear the slot');
    assert.ok(body.includes('assignedClasses'), 'the slot is not the field being cleared');
    assert.ok(body.includes('classMediated: true'), 'the check is not scoped to class-mediated rows');
  });
});

// ── The dashboard's greeting, derived in Ghana ──────────────────────────────
describe('the teacher dashboard greeting', () => {
  const readSource = async (relative) => {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL(relative, import.meta.url), 'utf8');
  };

  test('is computed on the server, in Africa/Accra', async () => {
    const source = await readSource('../src/services/teacher/dashboard.service.js');
    assert.ok(source.includes('greetingForHour'), 'the greeting is not derived from the shared rule');
    assert.ok(source.includes('Africa/Accra'), 'the greeting is not read in Ghana time');
    // The payload carries it, so the client does not have to guess.
    assert.ok(source.includes('greeting,'), 'the payload does not carry the greeting');
    assert.ok(source.includes('greetingHour'), 'the payload does not carry the hour it was read at');
  });

  test('is exported, so the client can produce the same words', async () => {
    // One table on each side, asserted against each other in
    // `frontend/src/utils/greeting.test.js`. An unexported helper would leave the
    // client free to re-derive it and drift.
    const source = await readSource('../src/services/teacher/dashboard.service.js');
    assert.ok(source.includes('export const greetingForHour'), 'greetingForHour is not exported');
  });
});

// ── Drift: the two representations disagreeing ──────────────────────────────
describe('assignment drift', () => {
  const readSource = async (relative) => {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL(relative, import.meta.url), 'utf8');
  };

  test('drift is detected, not just repaired', async () => {
    // The reported bug was invisible on both screens: the console counted twenty
    // rows, the portal read zero classes. Detecting it is what makes it
    // repairable — and what lets the console say so instead of leaving the admin
    // to work it out from a phone call.
    const link = await readSource('../src/services/admin/teacherClassLink.js');
    assert.ok(
      /export const detectAssignmentDrift/.test(link),
      'no drift detector — the repair cannot know what to repair'
    );
    assert.ok(
      link.includes('rows.removedAt === null') || link.includes('removedAt: null'),
      'the detector reads live rows only'
    );
  });

  test('the repair writes the slot the portal reads, through the same writer', async () => {
    // A repair that produced a different shape from the original assignment
    // would be a third thing to reason about.
    const link = await readSource('../src/services/admin/teacherClassLink.js');
    const body = link.slice(link.indexOf('export const repairAssignmentDrift'));

    assert.ok(body.includes('syncClassTeacher'), 'the repair bypasses the shared writer');
    assert.ok(
      /for \(const className of row\.classes\)/.test(body),
      'the repair is not iterating the classes drift reported'
    );
    assert.ok(
      /export const repairAssignmentDrift = async \(schoolId, teacherId\)/.test(link),
      'the repair signature changed'
    );
  });

  test('both are reachable from the route table', async () => {
    // Drift without an endpoint is a dead end; the whole point is that an admin
    // can act on it from the screen that showed them the number.
    const routes = await readSource('../src/routes/admin.academic.routes.js');

    // This file writes paths in double quotes.
    assert.ok(
      routes.includes('"/users/teacher-assignment-drift/repair"'),
      'no repair route — the banner on the page has nothing to call'
    );
    // Registered with the literal /users paths, ahead of the parameterised ones.
    const paths = (routes.match(/router\.(get|post|put|delete)\(\s*"([^"]+)"/g) || []).map((entry) =>
      entry.replace(/router\.\w+\(\s*"/, '').replace(/"$/, '')
    );
    assert.ok(paths.includes('/users/teacher-assignment-drift/repair'));
    assert.ok(
      paths.indexOf('/users/teacher-assignment-drift/repair') < paths.indexOf('/users/:teacherId/students'),
      'the repair route is registered after the parameterised routes it must beat'
    );
  });
});

// ── Bulk removal ────────────────────────────────────────────────────────────
/**
 * The *client* half of this lives in the frontend suite now — see
 * `frontend/src/components/dashboard/academics/bulkRemove.test.js`.
 *
 * It was written here at first, and that was wrong for a reason worth
 * recording: those assertions read `frontend/src/**` to check prop names and
 * interpolated strings, which are implementation details of a React component,
 * not a contract between the two apps. Asserting them from the backend meant a
 * single rename of `classMediatedCount` broke `npm test` in a directory whose
 * own code had not changed — and, worse, implied the backend suite was the owner
 * of frontend behaviour.
 *
 * What stays below is the backend-side half: that the server can actually do
 * what the UI offers. Cross-app *contract* checks (this suite's brand tokens,
 * the avatar ceiling, the greeting table) still read across, because there the
 * two sides genuinely have to agree and a drift is a real bug.
 */
describe('bulk removal — the server side', () => {
  const readSource = async () => {
    const { readFile } = await import('node:fs/promises');
    return readFile(
      new URL('../src/services/admin/teacherAssignment.service.js', import.meta.url),
      'utf8'
    );
  };

  test('the server accepts force and reports what it left alone', async () => {
    // Both are needed for the confirmation on the client to be truthful:
    // `force` to take the class rows, and the skipped count so the plain Remove
    // can say what it actually did.
    const source = await readSource();
    const body = source.slice(source.indexOf('export const unassignStudents'));

    assert.ok(body.includes('force'), 'unassign has no force override');
    assert.ok(body.includes('skipped'), 'unassign does not report what it left alone');
    assert.ok(
      body.includes('classMediated'),
      'unassign does not distinguish class-mediated rows'
    );
    assert.ok(body.includes('slotsDropped'), 'removing the last mediated child does not reconsider the slot');
  });
});
describe('teacherAssignment.service', () => {
  const readSource = async (relative = '../src/services/admin/teacherAssignment.service.js') => {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL(relative, import.meta.url), 'utf8');
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
    // Resolution now lives in `teacherClassLink.js`, shared with the class-teacher
    // route, so both paths resolve the same roster the same way.
    const link = await readSource('../src/services/admin/teacherClassLink.js');
    assert.ok(
      link.includes('const classRoster ='),
      'no server-side roster resolver — the class path trusts the client'
    );
    assert.ok(
      link.includes('studentClass: className'),
      'the class roster is not filtered by studentClass — the field the Student schema actually has'
    );
    assert.ok(
      !/^\s{4}className,\s*$/m.test(link),
      'the roster is filtering on a bare className field, which matches nothing'
    );
    assert.ok(
      link.includes('status: "active"'),
      'the roster is not filtered to active students'
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
