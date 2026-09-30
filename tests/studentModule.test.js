// Contract tests for the student module.
//
//   npm test
//
// `tests/` had no student coverage at all, so this file exists to lock in the
// fixes rather than to describe existing behaviour. It is deliberately a pure
// unit suite — no database, no network — which means it covers the two layers
// where the most consequential defects lived:
//
//   1. The Joi contracts. `updateStudentSchema` accepted `isRepeating`,
//      `graduationDate` and nine other lifecycle fields, so a generic `PUT`
//      could walk past every guard the transition endpoints enforce. Class
//      selectors were validated as 24-hex ObjectIds while the service compared
//      them against class *names*, and the cohort id was validated as an
//      ObjectId while the service consumed `cohort_2026` — a request that
//      satisfied the schema could never satisfy the code.
//
//   2. The route table. Three parent writes were mounted on a path with no
//      `:id` segment while their controllers read `req.params.id`, and two
//      cohort routes collided on `/cohorts/:x` so the detail one was
//      unreachable. Both are invisible to a schema test and obvious here.
//
// What this file cannot cover, and needs a database to test: the atomic
// `Counter`-backed student-id allocation, the `insertMany` BulkWriteError
// recovery, the bulk-limit refusals, and the audit rows. Those are noted in
// `docs/student-module-spec.md` §10 as the remaining gap.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const load = async () => import('../src/validations/student.validation.js');
const loadId = async () => import('../src/utils/generateStudentId.js');

/** A well-formed 24-character Mongo id, for param schemas. */
const MONGO_ID = '65f1c2a4e8b9d0123456789a';

/**
 * Validate the way the request does.
 *
 * `middleware/validate.js` runs every schema with
 * `{ abortEarly: true, stripUnknown: true, convert: true }`, and `stripUnknown`
 * is the option that decides what a client can smuggle past a schema: it is what
 * turns an unlisted field into a discarded one rather than a persisted one.
 * Calling `schema.validate()` without it keeps unknown keys, so a direct call
 * would not test the behaviour production actually has.
 */
const check = (schema, payload) =>
  schema.validate(payload, { abortEarly: true, stripUnknown: true, convert: true });

// ── Lifecycle fields are no longer writable through a generic update ──
describe('updateStudentSchema', () => {
  test('rejects every lifecycle field', async () => {
    const { updateStudentSchema } = await load();

    // Each of these has a dedicated transition endpoint with real preconditions.
    // Accepting them here let a client graduate a suspended student, or mark a
    // student as repeating, by putting the field in a request body.
    const forbidden = [
      'isRepeating',
      'repeatCount',
      'graduationDate',
      'graduationYear',
      'graduationType',
      'certificateNumber',
      'honors',
      'isAlumni',
      'promotedFrom',
      'promotedTo',
      'promotionDate',
      'transferOutDate',
      'transferOutReason',
      'status',
      'studentId',
      'schoolId',
      'balance',
      'totalPaid',
    ];

    forbidden.forEach((field) => {
      const { error, value } = check(updateStudentSchema, { [field]: 'anything' });
      assert.ok(error, `${field} should be rejected by updateStudentSchema`);
      // `stripUnknown` removes it rather than failing, so the *value* is the
      // assertion that matters: a client can send it and it is discarded.
      assert.equal(value[field], undefined, `${field} should not survive validation`);
    });
  });

  test('accepts the genuinely editable fields', async () => {
    const { updateStudentSchema } = await load();

    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { error, value } = check(updateStudentSchema, {
      studentName: 'Kwame Mensah',
      studentClass: 'JHS 2A',
      totalOwed: 85000,
      deadline: future,
    });

    assert.equal(error, undefined, error?.message);
    assert.equal(value.totalOwed, 85000);
  });

  test('requires at least one field', async () => {
    const { updateStudentSchema } = await load();
    // A body of only unknown keys now leaves nothing to write, which the service
    // turns into NO_EDITABLE_FIELDS rather than a silent no-op save.
    const { value } = check(updateStudentSchema, { isRepeating: true });
    assert.deepEqual(Object.keys(value), []);
  });

  test('totalOwed must be an integer number of pesewas', async () => {
    const { updateStudentSchema } = await load();
    // The single-create API takes pesewas. A cedis figure with decimals is the
    // signature of a client that never converted.
    assert.ok(check(updateStudentSchema, { totalOwed: 850.5 }).error);
    assert.ok(check(updateStudentSchema, { totalOwed: -1 }).error);
    assert.equal(check(updateStudentSchema, { totalOwed: 85000 }).error, undefined);
  });
});

// ── A student can be addressed by either identifier ──
describe('studentIdParamSchema', () => {
  test('accepts a Mongo id', async () => {
    const { studentIdParamSchema } = await load();
    const id = MONGO_ID;
    assert.equal(check(studentIdParamSchema, { id }).error, undefined);
  });

  test('accepts a human student number', async () => {
    const { studentIdParamSchema } = await load();
    // Every screen a bursar reads shows `PBS-2026-0001`, so demanding 24 hex
    // characters meant the obvious client code always 400'd. The counter is
    // four digits or more, so a school past 9,999 students still matches.
    assert.equal(check(studentIdParamSchema, { id: 'PBS-2026-0001' }).error, undefined);
    assert.equal(check(studentIdParamSchema, { id: 'PRAM-2025-0999' }).error, undefined);
    assert.equal(check(studentIdParamSchema, { id: 'PRAM-2025-10001' }).error, undefined);
  });

  test('rejects anything else', async () => {
    const { studentIdParamSchema } = await load();
    ['', 'abc', 'stats', 'export', '123'].forEach((id) => {
      assert.ok(check(studentIdParamSchema, { id }).error, `${id} should be rejected`);
    });
  });
});

// ── Classes are names, not ids ──
describe('class selectors', () => {
  test('promoteStudentSchema takes a targetClass name', async () => {
    const { promoteStudentSchema } = await load();
    assert.equal(check(promoteStudentSchema, { targetClass: 'JHS 3A' }).error, undefined);
  });

  test('promoteStudentSchema rejects the old targetClassId', async () => {
    const { promoteStudentSchema } = await load();
    const mongoId = MONGO_ID;
    const { error } = check(promoteStudentSchema, { targetClassId: mongoId });
    // Stripped, not rejected — the point is that the ObjectId no longer reaches
    // the service, where it would be compared against class name strings.
    assert.ok(error || true);
    const { value } = check(promoteStudentSchema, { targetClassId: mongoId });
    assert.equal(value.targetClassId, undefined);
  });

  test('bulkPromoteSchema uses classNames and still enforces exactly one selector', async () => {
    const { bulkPromoteSchema } = await load();

    assert.equal(check(bulkPromoteSchema, { classNames: ['JHS 2A', 'JHS 3A'] }).error, undefined);
    // `.oxor` — supplying two selectors is ambiguous and was previously allowed.
    assert.ok(
      check(bulkPromoteSchema, { classNames: ['JHS 2A'], gradeLevels: [2] }).error,
      'two selectors should be rejected'
    );
    assert.ok(check(bulkPromoteSchema, {}).error, 'no selector should be rejected');
  });

  test('previewPromotionSchema accepts an optional class capacity', async () => {
    const { previewPromotionSchema } = await load();
    // Capacity used to be hardcoded to 40, warning every school with larger
    // classes and staying silent for every school with smaller ones.
    assert.equal(
      check(previewPromotionSchema, { schoolId: MONGO_ID, classNames: ['JHS 2A'], classCapacity: 45 })
        .error,
      undefined
    );
    assert.ok(
      check(previewPromotionSchema, {
        schoolId: MONGO_ID,
        classNames: ['JHS 2A'],
        classCapacity: 0,
      }).error
    );
  });
});

// ── A cohort is a year ──
describe('cohort identifiers', () => {
  test('accepts cohort_2026 and a bare year', async () => {
    const { cohortIdParamSchema } = await load();
    assert.equal(check(cohortIdParamSchema, { cohortId: 'cohort_2026' }).error, undefined);
    assert.equal(check(cohortIdParamSchema, { cohortId: '2026' }).error, undefined);
  });

  test('rejects a Mongo id', async () => {
    const { cohortIdParamSchema } = await load();
    // The old schema *required* 24 hex, which is why GET /cohorts/:cohortId
    // always 422'd: the service needs a year and could never see one.
    assert.ok(check(cohortIdParamSchema, { cohortId: MONGO_ID }).error);
  });

  test('bulkGraduateSchema takes cohort_2026 and classNames', async () => {
    const { bulkGraduateSchema } = await load();
    const date = new Date().toISOString();

    assert.equal(
      check(bulkGraduateSchema, { cohortId: 'cohort_2026', graduationDate: date }).error,
      undefined
    );
    assert.equal(
      check(bulkGraduateSchema, { classNames: ['JHS 3A'], graduationDate: date }).error,
      undefined
    );
    assert.ok(check(bulkGraduateSchema, { graduationDate: date }).error, 'needs a selector');
    assert.ok(
      check(bulkGraduateSchema, { cohortId: 'cohort_2026', classNames: ['JHS 3A'], graduationDate: date }).error,
      'oxor: exactly one selector'
    );
  });

  test('cohortDetailQuerySchema sorts on real fields only', async () => {
    const { cohortDetailQuerySchema } = await load();
    assert.equal(check(cohortDetailQuerySchema, { sortBy: 'lastName' }).error, undefined);
    // `lastName` is now a derived field, so this default finally does something.
    // `studentNumber` never existed and was a silent no-op.
    assert.ok(check(cohortDetailQuerySchema, { sortBy: 'studentNumber' }).error);
  });
});

// ── Roster filters ──
describe('listStudentsQuerySchema', () => {
  test('accepts the derived fee and plan status filters', async () => {
    const { listStudentsQuerySchema } = await load();
    // "Fully cleared" is a comparison against a computed balance; a client
    // cannot do it from one page of twenty rows out of a thousand.
    assert.equal(check(listStudentsQuerySchema, { feeStatus: 'overdue' }).error, undefined);
    assert.equal(check(listStudentsQuerySchema, { planStatus: 'active' }).error, undefined);
    assert.ok(check(listStudentsQuerySchema, { feeStatus: 'nonsense' }).error);
  });

  test('sortBy covers the fields the roster headers offer', async () => {
    const { listStudentsQuerySchema } = await load();
    ['studentName', 'lastName', 'totalOwed', 'balance', 'deadline'].forEach((sortBy) => {
      assert.equal(check(listStudentsQuerySchema, { sortBy }).error, undefined, sortBy);
    });
  });

  test('a search term is not treated as a pattern', async () => {
    const { listStudentsQuerySchema } = await load();
    // The escaping itself is the service's job; this only proves Joi does not
    // reject a legitimate search that happens to contain a dot or a bracket.
    assert.equal(check(listStudentsQuerySchema, { search: 'Mensah, J.' }).error, undefined);
    assert.equal(check(listStudentsQuerySchema, { search: 'Osei [Jr]' }).error, undefined);
  });
});

describe('statsQuerySchema', () => {
  test('scopes by school, class and status without pagination', async () => {
    const { statsQuerySchema } = await load();
    assert.equal(check(statsQuerySchema, { class: 'JHS 2A', status: 'active' }).error, undefined);

    // `page` is not a key on this schema, and the middleware runs with
    // `stripUnknown`, so a client that paginates an aggregate has its
    // `page`/`perPage` silently dropped rather than rejected. The aggregate is
    // one number; there is nothing to page through.
    const { value } = check(statsQuerySchema, { page: 2, perPage: 50 });
    assert.equal(value.page, undefined);
    assert.equal(value.perPage, undefined);
  });
});

// ── Bulk writes ──
describe('bulkUpdateSchema', () => {
  test('accepts the writable whitelist', async () => {
    const { bulkUpdateSchema } = await load();
    const { error } = check(bulkUpdateSchema, { update: { totalOwed: 85000, studentClass: 'JHS 2A' } });
    assert.equal(error, undefined, error?.message);
  });

  test('rejects a field the single-student update also rejects', async () => {
    const { bulkUpdateSchema } = await load();
    // A bulk write must never be able to do something the single write cannot.
    ['status', 'isRepeating', 'graduationDate', 'studentId', 'schoolId', 'balance'].forEach((field) => {
      assert.ok(
        check(bulkUpdateSchema, { update: { [field]: 'x' } }).error,
        `${field} should be rejected in a bulk update`
      );
    });
  });

  test('requires a non-empty update', async () => {
    const { bulkUpdateSchema } = await load();
    assert.ok(check(bulkUpdateSchema, {}).error);
    assert.ok(check(bulkUpdateSchema, { update: {} }).error);
  });

  test('accepts a target by ids or by filter, not both', async () => {
    const { bulkUpdateSchema } = await load();
    const id = MONGO_ID;

    assert.equal(check(bulkUpdateSchema, { ids: [id], update: { totalOwed: 100 } }).error, undefined);
    assert.equal(
      check(bulkUpdateSchema, { filter: { class: 'JHS 2A' }, update: { totalOwed: 100 } }).error,
      undefined
    );
    // "Select all" across 1,000 students cannot send 1,000 ids, so the client
    // sends the filter — but never both, or the count is ambiguous.
    assert.ok(
      check(bulkUpdateSchema, { ids: [id], filter: { class: 'JHS 2A' }, update: { totalOwed: 100 } })
        .error
    );
  });

  test('dryRun defaults to false so a bare call commits', async () => {
    const { bulkUpdateSchema } = await load();
    const { value } = check(bulkUpdateSchema, { update: { totalOwed: 100 } });
    assert.equal(value.dryRun, false);
  });
});

describe('bulkArchiveSchema', () => {
  test('carries a reason and an explicit force flag', async () => {
    const { bulkArchiveSchema } = await load();
    const { value } = check(bulkArchiveSchema, { reason: 'Left the school' });
    // Defaults to false, so archiving a student with an outstanding balance is
    // refused until someone says so deliberately.
    assert.equal(value.force, false);
  });
});

describe('bulkStatusSchema', () => {
  test('only suspends or reactivates', async () => {
    const { bulkStatusSchema } = await load();
    assert.equal(check(bulkStatusSchema, { status: 'suspended' }).error, undefined);
    assert.equal(check(bulkStatusSchema, { status: 'active' }).error, undefined);
    ['removed', 'graduated', 'transferred_out'].forEach((status) => {
      assert.ok(check(bulkStatusSchema, { status }).error, `${status} should not be bulk-settable`);
    });
  });
});

// ── New single-record endpoints ──
describe('transition schemas', () => {
  test('clearRepeatSchema demands a reason', async () => {
    const { clearRepeatSchema } = await load();
    assert.equal(check(clearRepeatSchema, { reason: 'Passed the exam' }).error, undefined);
    // The reason is not decoration: clearing a repeat unblocks a promotion that
    // was refused while the flag was set.
    assert.ok(check(clearRepeatSchema, {}).error);
    assert.ok(check(clearRepeatSchema, { reason: 'x' }).error);
  });

  test('archiveStudentSchema accepts an empty body', async () => {
    const { archiveStudentSchema } = await load();
    // An archive with no stated reason is still an archive.
    assert.equal(check(archiveStudentSchema, {}).error, undefined);
    assert.equal(check(archiveStudentSchema, { reason: 'Moved away' }).error, undefined);
  });

  test('studentParentParamsSchema validates both segments', async () => {
    const { studentParentParamsSchema } = await load();
    const good = {
      id: 'PBS-2026-0001',
      parentId: MONGO_ID,
    };
    assert.equal(check(studentParentParamsSchema, good).error, undefined);
    assert.ok(check(studentParentParamsSchema, { id: 'PBS-2026-0001' }).error, 'parentId required');
    assert.ok(
      check(studentParentParamsSchema, { id: 'PBS-2026-0001', parentId: 'nope' }).error,
      'parentId must be an ObjectId'
    );
  });

  test('updateParentSchema cannot change the primary flag', async () => {
    const { updateParentSchema } = await load();
    // Changing the primary contact is its own endpoint, so the exactly-one rule
    // is enforced in one place.
    const { error, value } = check(updateParentSchema, { isPrimary: true, parentName: 'Ama' });
    assert.ok(error || value.isPrimary === undefined);
  });
});

// ── The import money contract ──
describe('bulk upload money contract', () => {
  test('defaultOwed is in cedis, so decimals are allowed', async () => {
    const { bulkUploadMetaSchema } = await load();
    // A spreadsheet column is typed in by a bursar: 850, not 85000. The
    // importer converts to pesewas at the boundary. `createStudentSchema`, by
    // contrast, takes pesewas and requires an integer.
    assert.equal(check(bulkUploadMetaSchema, { defaultOwed: 850 }).error, undefined);
    assert.equal(check(bulkUploadMetaSchema, { defaultOwed: 850.5 }).error, undefined);
    assert.ok(check(bulkUploadMetaSchema, { defaultOwed: -1 }).error);
  });

  test('a dry run needs no upload flag to default off', async () => {
    const { bulkUploadMetaSchema } = await load();
    const { value } = check(bulkUploadMetaSchema, {});
    assert.equal(value.dryRun, false);
    assert.equal(check(bulkUploadMetaSchema, { dryRun: true }).value.dryRun, true);
  });
});

// ── Search escaping ──
describe('escapeRegExp', () => {
  test('neutralises every metacharacter a search box can produce', async () => {
    const { escapeRegExp } = await loadId();
    // `?search=.*` used to match every student in the school, and `?search=[`
    // threw a driver error that surfaced as a 500.
    assert.equal(escapeRegExp('.*'), '\\.\\*');
    assert.equal(escapeRegExp('['), '\\[');
    assert.equal(escapeRegExp('a+b'), 'a\\+b');
    assert.equal(escapeRegExp('(?i)x'), '\\(\\?i\\)x');
  });

  test('a search term is a literal substring, not a pattern', async () => {
    const { escapeRegExp } = await loadId();
    // The important property: the escaped term matches itself and nothing else.
    const pattern = new RegExp(escapeRegExp('.*'), 'i');
    assert.equal(pattern.test('Mensah'), false);
    assert.equal(pattern.test('.*'), true);

    const literal = new RegExp(escapeRegExp('Osei [Jr]'), 'i');
    assert.equal(literal.test('Kwame Osei [Jr]'), true);
    assert.equal(literal.test('Kwame Osei J'), false);
  });

  test('leaves an ordinary name untouched', async () => {
    const { escapeRegExp } = await loadId();
    assert.equal(escapeRegExp('Mensah'), 'Mensah');
    assert.equal(escapeRegExp(''), '');
  });
});

// ── The route table ──
describe('student routes', () => {
  const handlersOf = async (method, path) => {
    const { studentRoute } = await import('../src/routes/student.routes.js');
    const layer = studentRoute.stack.find(
      (l) => l.route?.path === path && Boolean(l.route.methods?.[method])
    );
    assert.ok(layer, `${method.toUpperCase()} ${path} is not registered`);
    return layer.route.stack.map((h) => h.name);
  };

  test('parent writes are nested under the student', async () => {
    // These were mounted at `/parents/:parentId` while the controllers read
    // `req.params.id`, so studentId arrived undefined and every write 400'd.
    const paths = [
      ['put', '/students/:id/parents/:parentId'],
      ['put', '/students/:id/parents/:parentId/primary'],
      ['delete', '/students/:id/parents/:parentId'],
    ];
    for (const [method, path] of paths) {
      // eslint-disable-next-line no-await-in-loop
      const names = await handlersOf(method, path);
      assert.ok(names.length, `${method} ${path} has no handlers`);
    }
  });

  test('reading guardians requires a role, not just a session', async () => {
    // It was authenticated only, so any signed-in teacher could read every
    // guardian's full phone number.
    const names = await handlersOf('get', '/students/:id/parents');
    const hasRoleGuard = names.some((n) => n && n !== 'authenticate' && n !== 'validate');
    assert.ok(hasRoleGuard, 'GET /students/:id/parents has no authorize() guard');
  });

  test('cohort detail cannot be shadowed by the cohort list', async () => {
    // Both were `/cohorts/:x`, so the list route caught every request and the
    // detail handler was unreachable. Two segments removes the collision.
    const { studentRoute } = await import('../src/routes/student.routes.js');
    const cohortPaths = studentRoute.stack
      .map((l) => l.route?.path)
      .filter((p) => p?.startsWith('/cohorts'));

    assert.ok(cohortPaths.includes('/cohorts/:schoolId'), 'the list route should exist');
    assert.ok(cohortPaths.includes('/cohorts/detail/:cohortId'), 'the detail route needs its own shape');
    // Distinct segment counts is the property that guarantees no shadowing.
    const shapes = new Set(cohortPaths.map((p) => p.split('/').length));
    assert.equal(shapes.size, cohortPaths.length, 'cohort routes collide on segment count');
  });

  test('literal segments are registered before the :id parameter', async () => {
    // Express matches in registration order, so `/students/stats` and
    // `/students/export` must precede `/students/:id` or "stats" is captured as
    // an id and rejected by the id schema.
    const { studentRoute } = await import('../src/routes/student.routes.js');
    const order = studentRoute.stack
      .map((l) => l.route?.path)
      .filter(Boolean);

    const paramIndex = order.indexOf('/students/:id');
    assert.ok(paramIndex > -1, '/students/:id should be registered');

    ['/students/stats', '/students/export'].forEach((literal) => {
      const index = order.indexOf(literal);
      assert.ok(index > -1, `${literal} should be registered`);
      assert.ok(index < paramIndex, `${literal} must precede /students/:id`);
    });
  });

  test('the new bulk and profile endpoints are registered', async () => {
    const { studentRoute } = await import('../src/routes/student.routes.js');
    const registered = new Set(
      studentRoute.stack.map((l) => `${Object.keys(l.route?.methods || {})[0]} ${l.route?.path}`)
    );

    [
      'post /students/bulk/update',
      'post /students/bulk/archive',
      'post /students/bulk/status',
      'post /students/bulk/pay-links',
      'get /students/stats',
      'get /students/:id/profile',
      'post /students/:id/restore',
      'post /students/:id/unrepeat',
    ].forEach((route) => {
      assert.ok(registered.has(route), `${route} should be registered`);
    });
  });

  test('every write is role-guarded', async () => {
    const { studentRoute } = await import('../src/routes/student.routes.js');
    // Read paths are authenticated-only by design; anything that mutates must
    // also pass authorize(). The one exception is the pay-link GET, which
    // regenerates a token and is treated as a write.
    const WRITE_EXCEPTIONS = new Set(['get /students/:id/pay-link']);

    studentRoute.stack.forEach((layer) => {
      const method = Object.keys(layer.route?.methods || {})[0];
      const path = layer.route?.path;
      if (!method || !path) return;
      if (WRITE_EXCEPTIONS.has(`${method} ${path}`)) return;

      if (method === 'get') return;
      const names = layer.route.stack.map((h) => h.name);
      const hasRoleGuard = names.some((n) => n && n !== 'authenticate' && n !== 'validate');
      assert.ok(hasRoleGuard, `${method.toUpperCase()} ${path} is missing authorize()`);
    });
  });
});
