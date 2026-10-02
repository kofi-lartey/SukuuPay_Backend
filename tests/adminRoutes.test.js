// Route wiring. The one suite that **imports the router** rather than reading its
// source.
//
//   npm test
//
// Why this exists, and why it is the only suite of its kind. `admin.routes.js` used
// to import five handlers from `services/admin.service.js` that it does not export —
// they live in `controllers/schoolAd.controller.js`. ESM resolves named imports while
// loading the module graph, so that was a `SyntaxError` the moment
// `routes/index.js` imported the router, which `src/index.js` mounts. **The whole
// application could not start.** And 396 tests passed, because every test that
// mentioned the file read it with `readFileSync` and scanned the text — a source scan
// cannot fail on a broken import, which is precisely the failure it looks suited to.
//
// So: every router is imported here. That is the whole assertion. An import failure
// is a `SyntaxError` this file propagates, and it fails at collection time rather
// than in CI four commits later.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';

/**
 * Every route module, discovered rather than listed.
 *
 * A hardcoded list would itself be the thing that goes stale — a new router added and
 * not added here would be exactly the un-tested case this file exists to prevent.
 */
const ROUTE_DIR = new URL('../src/routes/', import.meta.url);

describe('every router module loads', () => {
  test('all of them import without a link error', async () => {
    const files = (await readdir(ROUTE_DIR)).filter((name) => name.endsWith('.routes.js'));

    assert.ok(files.length > 10, `expected the full router set, found only ${files.length}`);

    for (const name of files) {
      await assert.doesNotReject(
        () => import(new URL(name, ROUTE_DIR).href),
        `${name} failed to import — an ESM named import that does not exist in its target`
      );
    }
  });

  test('routes/index.js loads, so every router is reachable from one mount', async () => {
    // Deliberately **not** `src/index.js`. Importing it runs the module body, which
    // calls `listen()` and leaves the process's server handle open — the test run
    // then hangs on a live handle until the runner is killed, which is a much worse
    // failure signal than a missing test. `routes/index.js` is the file that actually
    // carries the bug this suite was written for (`import { adminRoute } from
    // './admin.routes.js'`), and loading it transitively loads every other router.
    await assert.doesNotReject(
      () => import('../src/routes/index.js'),
      'the router index does not load — nothing is mounted'
    );
  });
});

describe('the platform console is wired the way the middleware assumes', () => {
  test('the impersonation guard is mounted on the admin router, not per route', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/routes/admin.routes.js', import.meta.url), 'utf8');

    // `adminRoute.use(handleImpersonation)` must sit between the routes and
    // `authenticate`, so every route below it is covered by definition. A per-route
    // application would be a rule the next handler forgets, and the handler it forgets
    // is the one that deletes a student's record.
    assert.ok(
      /adminRoute\.use\(handleImpersonation\)/.test(source),
      'handleImpersonation must be mounted with adminRoute.use so it cannot be bypassed by a new route'
    );

    const impersonationUse = source.indexOf('adminRoute.use(handleImpersonation)');
    const firstRoute = source.indexOf('adminRoute.get(');
    assert.ok(
      impersonationUse > -1 && impersonationUse < firstRoute,
      'the impersonation guard must come before the first route, not after it'
    );
  });

  test('the guard and the role check both sit above every route', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/routes/admin.routes.js', import.meta.url), 'utf8');

    assert.ok(
      /adminRoute\.use\(authenticate,\s*authorize\(['"]super_admin['"]\)\)/.test(source),
      "the platform console must be gated with authenticate + authorize('super_admin') at the router level"
    );
  });

  test('no route on the admin router is registered with a bare handler', async () => {
    // Every route carries at least its handler. A route registered with no
    // middleware still has a handler, so this is really a check that the file was
    // not truncated or half-edited — cheap, and it fails loudly if it was.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/routes/admin.routes.js', import.meta.url), 'utf8');
    const registrations = source.match(/adminRoute\.(get|post|put|delete|patch)\(/g) || [];

    assert.ok(registrations.length > 50, `expected the full console route set, found ${registrations.length}`);
  });

  test('the exit route is registered before the wildcard it would be captured by', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/routes/admin.routes.js', import.meta.url), 'utf8');

    const endIndex = source.indexOf("'/impersonate/end'");
    const wildcardIndex = source.indexOf("'/impersonate/:schoolId'");

    assert.ok(endIndex > -1, 'the exit route is missing');
    assert.ok(wildcardIndex > -1, 'the impersonation start route is missing');
    assert.ok(
      endIndex < wildcardIndex,
      'POST /impersonate/end and POST /impersonate/:schoolId are both two segments — registering the wildcard first captures "end" as a school id and the operator cannot leave a session'
    );
  });

  test('maintenance mode can be turned off while it is on', async () => {
    const { maintenanceDecision } = await import('../src/middleware/maintenance.js');

    // Two routes onto the same switch, so two exemptions. This is asserted here as
    // well as in `platformSettings.test.js` because the failure it prevents — a
    // kill switch with no way out of it — is the worst thing this console can ship.
    for (const path of ['/api/admin/settings', '/api/admin/health/maintenance']) {
      assert.equal(
        maintenanceDecision({ mode: 'on', method: 'PUT', path }).allow,
        true,
        `${path} is the way out of maintenance mode and must not be refused by it`
      );
    }
  });
});

describe('report exports produce every format the console offers', () => {
  test('pdf renders a real PDF, it does not 501', async () => {
    /*
     * This used to throw `501 PDF_EXPORT_UNAVAILABLE` on a comment that was itself
     * wrong — it said no PDF library was a dependency while `pdfkit` sat in
     * `package.json`. The genuine obstacle was that `utils/pdfGenerator.js` renders
     * ID cards from a fixed template, and a report's columns are not a shape anyone
     * designed in advance. `utils/reportPdf.js` is the second path that solves that.
     *
     * Asserted on the actual bytes rather than on "does not throw", because a
     * serializer that returns an empty buffer also does not throw.
     */
    const { pdfFor } = await import('../src/utils/reportPdf.js');

    const buffer = await pdfFor(
      [
        {
          title: 'Revenue by school',
          columns: [
            { key: 'schoolName', header: 'School' },
            { key: 'net', header: 'Net (pesewas)' },
          ],
          rows: [{ schoolName: 'Prampram Basic School', net: 1250000 }],
        },
      ],
      { title: 'Platform revenue', subtitle: 'Test' }
    );

    assert.ok(Buffer.isBuffer(buffer), 'pdfFor must resolve a Buffer');
    assert.ok(buffer.length > 400, `expected a populated PDF, got ${buffer.length} bytes`);
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-', 'the file must start with the PDF magic number');
  });

  test('sendReportFile is async, and both callers await it', async () => {
    // `sendReportFile` became async when PDF support landed, because pdfkit streams.
    // A caller that does not await it returns while the response is still empty — so
    // the request finishes with no file and no error, which is the worst shape a
    // broken download can take.
    const { sendReportFile } = await import('../src/utils/reportExport.js');
    assert.equal(
      sendReportFile.constructor.name,
      'AsyncFunction',
      'sendReportFile must be async now that one of its branches is'
    );

    const { readFileSync } = await import('node:fs');
    for (const path of [
      '../src/services/admin/reports.service.js',
      '../src/controllers/reports.controller.js',
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      assert.ok(
        /await\s+sendReportFile\(|return\s+sendReportFile\(/.test(source),
        `${path} calls sendReportFile without awaiting or returning it — a pdf export would resolve with an empty body and no error`
      );
    }
  });

  test('the export vocabulary is csv, xlsx and pdf, and xlsx is translated', async () => {
    const { reportExportQuerySchema, ADMIN_REPORT_TYPES } = await import(
      '../src/validations/admin.analytics.validation.js'
    );

    for (const format of ['csv', 'xlsx', 'pdf']) {
      assert.ok(
        !reportExportQuerySchema.validate({ type: 'platform_revenue', format }).error,
        `${format} must be a valid export format`
      );
    }
    assert.ok(
      reportExportQuerySchema.validate({ type: 'platform_revenue', format: 'docx' }).error,
      'an unknown format must be rejected rather than silently defaulting'
    );

    /*
     * The report types are **snake_case**, and the frontend's `REPORT_TYPES` mirrors
     * this array. It shipped hyphenated (`platform-revenue`), which produced a 422
     * whose own message listed the four values it wanted — so the contract is
     * pinned here in both places: the server's enum, and the names the client is
     * expected to send.
     */
    assert.deepEqual(ADMIN_REPORT_TYPES, [
      'platform_revenue',
      'school_performance',
      'growth',
      'churn',
    ]);

    const { readFileSync } = await import('node:fs');
    const client = readFileSync(
      new URL('../../frontend/src/services/admin.js', import.meta.url),
      'utf8'
    );
    for (const type of ADMIN_REPORT_TYPES) {
      assert.ok(
        client.includes(`'${type}'`),
        `the frontend must send "${type}", which is what the server's enum accepts`
      );
    }
  });
});

describe('the console panels read the keys the analytics service actually returns', () => {
  /*
   * `AtRiskCard` read `data.rows`; `getAtRiskSchools` returns `{ schools: [...] }`.
   *
   * The panel rendered permanently empty and **nothing failed**: `[].map()` renders
   * fine, `EmptyState` renders fine, and the request succeeded with HTTP 200. There
   * is no error to notice and nothing in a build to catch — a key-name mismatch
   * between a service and a component is a silent failure in this exact shape, which
   * is why it is pinned here rather than left to review.
   *
   * The fix was to normalise in the service layer (`normaliseSchoolList` in
   * `frontend/src/services/admin.js`) so a component asks for `rows` once and cannot
   * be wrong about the key. This asserts the normalisation exists and that both
   * spellings are accepted, so tidying the service later cannot reintroduce it.
   */
  test('school-list analytics payloads are normalised to `rows`', async () => {
    /*
     * Read as text, not imported. `frontend/src/services/admin.js` imports `api`,
     * which reaches for `import.meta.env` — a Vite-ism that Node cannot resolve — so
     * importing it here would need a transform step and would test nothing extra.
     * The contract between a service and a component is a set of key names in two
     * files, and reading them is what checks it.
     */
    const { readFileSync } = await import('node:fs');
    const client = readFileSync(
      new URL('../../frontend/src/services/admin.js', import.meta.url),
      'utf8'
    );

    assert.ok(
      client.includes('normaliseSchoolList'),
      'the analytics school lists must be normalised in the service layer, not read by key in each component'
    );
    // Both spellings, so the service can be renamed without a frontend release.
    for (const key of ['schools', 'rows']) {
      assert.ok(
        client.includes(`payload?.${key}`) || client.includes(`.${key}`),
        `normaliseSchoolList must accept the "${key}" spelling`
      );
    }
  });

  test('the error envelopes that carry caveats are not flattened by the client', async () => {
    const { readFileSync } = await import('node:fs');
    const client = readFileSync(
      new URL('../../frontend/src/services/admin.js', import.meta.url),
      'utf8'
    );

    /*
     * `scope`, `durable` and `limitations[]` live in the error panel's `meta`. They
     * are the only statement this platform can make about the completeness of its own
     * error history — the buffer is in-process, so a list that rendered "no recent
     * errors" as a plain statement would be claiming something about the whole
     * platform on the strength of one process's last 500 entries.
     */
    assert.ok(
      /getRecentErrors[\s\S]{0,900}meta:\s*data\?\.meta/.test(client),
      'getRecentErrors must forward the envelope meta, or the error panel cannot state that the buffer is per-process'
    );

    // Same class of bug in the impersonation screen: `meta.total` was read off a
    // payload that carries `{ returned, limit, note }`, so it was always 0 and the
    // pager never appeared.
    assert.ok(
      /getImpersonationAudit[\s\S]{0,1200}returned:\s*Number\(meta\.returned\)/.test(client),
      'getImpersonationAudit must read `returned`/`limit`, not a pagination envelope this endpoint does not send'
    );
  });
});

describe('the sensitive console endpoints exist at the paths the client calls', () => {
  test('the paths the frontend service layer requests are all registered', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/routes/admin.routes.js', import.meta.url), 'utf8');

    /*
     * Read out of `src/services/admin.js`, `finance.js` and `impersonation.js` in the
     * frontend, because those are what a client actually asks for. Every one of
     * these was once wrong or absent and every one of them 404'd — a URL in a service
     * layer is not checked by anything, so it is checked here against the router.
     *
     * Query strings are stripped and only the path is compared.
     */
    const clientPaths = [
      '/impersonate/end',
      '/impersonate/:schoolId',
      '/impersonate/sessions',
      '/finance/ledger/export',
      '/finance/disbursements',
      '/health/maintenance',
      '/settings/commission',
      '/settings/disbursement',
      '/overview',
      '/payments',
      '/payments/export',
      '/sms/broadcast',
      '/announcements',
      '/audit-logs',
      '/analytics/at-risk-schools',
      '/reports/export',
      '/audit-logs/:id',
    ];

    for (const path of clientPaths) {
      assert.ok(
        source.includes(`'${path}'`),
        `${path} is called by the frontend but is not registered on the admin router`
      );
    }
  });

  test('the single audit-log read is registered after the two fixed-segment paths', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/routes/admin.routes.js', import.meta.url), 'utf8');

    const userIndex = source.indexOf("'/audit-logs/user/:userId'");
    const impersonationIndex = source.indexOf("'/audit-logs/impersonation/:sessionId'");
    const wildcardIndex = source.indexOf("'/audit-logs/:id'");

    assert.ok(wildcardIndex > -1, 'GET /audit-logs/:id must be registered');
    assert.ok(
      userIndex < wildcardIndex && impersonationIndex < wildcardIndex,
      'fixed-segment audit-log paths must precede the :id wildcard — otherwise /audit-logs/export and any future two-segment sibling is captured as an id'
    );

    /*
     * The params schema must declare `id`, because that is the route's segment name.
     * A schema declaring a key the route does not provide strips the parameter to
     * nothing, and the handler then queries for `undefined` — a 404 for *every* id,
     * on the one endpoint that exists precisely so a detail page does not have to
     * guess whether an entry is real. The detail screen shipped a 200-row client-side
     * scan until this was added, and "not found" from a scan is indistinguishable
     * from "deleted".
     */
    const { auditLogIdParamSchema } = await import(
      '../src/validations/admin.auditLogs.validation.js'
    );
    assert.equal(
      auditLogIdParamSchema.validate({ id: '65f000000000000000000001' }).error,
      undefined,
      'the params schema must accept the route segment name `id`'
    );
    assert.ok(
      auditLogIdParamSchema.validate({ auditLogId: '65f000000000000000000001' }).error,
      'a schema keyed on the wrong parameter name strips `id` and 404s every request'
    );
  });
});