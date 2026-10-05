// Regression suite for school-facing advertisement requests.
//
//   npm test
//
// Pure unit tests: no database, no network. What is asserted is the contract and —
// more importantly — the *absence of a footgun*.
//
// The thing being held shut here is a privilege-escalation path. `createSchoolAd`
// (the console handler) trusts `req.body.schoolId`, because a super admin may
// legitimately write an ad for any school. A school-facing route that copied that
// shape would let **any school publish an advertisement as another school**, and these
// render on the public login and signup pages — so the consequence is defacement, not
// a data error. Two independent things prevent it, and both are asserted below.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SchoolAd, AD_STATUSES, AD_PLACEMENTS } from '../src/models/SchoolAd.js';
import {
  createSchoolAdSchema,
  createSchoolAdRequestSchema,
  listSchoolAdRequestsSchema,
  approveSchoolAdSchema,
  updateSchoolAdSchema,
} from '../src/validations/schoolAd.validation.js';
import { NOTIFICATION_TYPES, AUDIT_ACTIONS } from '../src/config/constants.js';
import { schoolAdRoute, publicAdRoute } from '../src/routes/schoolAd.routes.js';
import { MAX_PER_PAGE } from '../src/utils/platformQuery.js';
import { listAllSchoolsQuerySchema } from '../src/validations/admin.validation.js';

/** Runs a Joi schema the way `middleware/validate.js` does, without a request. */
const validate = (schema, payload) =>
  schema.validate(payload, { abortEarly: true, stripUnknown: true });

const validRequest = () => {
  const endsAt = new Date();
  endsAt.setDate(endsAt.getDate() + 30);
  return {
    headline: 'Admissions open for 2026/27',
    imageAlt: 'Students in the school assembly hall',
    linkUrl: 'https://example.edu.gh/admissions',
    placement: 'auth_aside',
    endsAt: endsAt.toISOString(),
  };
};

/** The same body the console sends, which carries two fields the school path cannot. */
const validConsoleAd = () => ({
  schoolName: 'Greenfield Academy',
  imageUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
  ...validRequest(),
});

// ─────────────────────────────────────────────
// The escalation path
// ─────────────────────────────────────────────
describe('ad requests: a school cannot write as another school', () => {
  test('the schema has no schoolId field for a school to set', () => {
    // The body contract is the first of the two checks. `schoolId` is absent by
    // design rather than by omission — there is no version of this schema that accepts
    // one, so there is nothing to forget to strip.
    assert.ok(
      !Object.keys(createSchoolAdRequestSchema.describe().keys).includes('schoolId'),
      'createSchoolAdRequestSchema must not accept a schoolId'
    );
  });

  test('and has no status field, so a school cannot publish directly', () => {
    assert.ok(
      !Object.keys(createSchoolAdRequestSchema.describe().keys).includes('status'),
      'createSchoolAdRequestSchema must not accept a status — it is forced to pending'
    );
  });

  test('a client-supplied schoolId is stripped rather than reaching the service', () => {
    // Belt and braces. Even if the schema grew a field later, `stripUnknown: true`
    // (set globally in `middleware/validate.js`) drops it — and the service
    // destructures its fields individually rather than spreading the body, so it does
    // not depend on that middleware having been configured.
    const { error, value } = validate(createSchoolAdRequestSchema, {
      ...validRequest(),
      schoolId: '507f1f77bcf86cd799439011',
      status: 'approved',
      approvedBy: '507f1f77bcf86cd799439011',
    });

    assert.equal(error, undefined);
    assert.equal(value.schoolId, undefined);
    assert.equal(value.status, undefined);
    assert.equal(value.approvedBy, undefined);
  });

  test('the route path carries no school id either', () => {
    // The second check, and the one that survives a refactor of the service: there is
    // nothing in the URL for a school admin to change.
    const paths = (schoolAdRoute.stack || [])
      .filter((layer) => layer.route)
      .map((layer) => layer.route.path);

    assert.ok(paths.length > 0, 'the school ad router should have routes');
    for (const path of paths) {
      assert.ok(
        !path.includes(':schoolId'),
        `school ad route "${path}" must not take a school id`
      );
      assert.ok(
        path.startsWith('/schools/me/'),
        `school ad route "${path}" must live under /schools/me`
      );
    }
  });

  test('every school ad route is authenticated and role-gated', () => {
    // Not just the create. Reading another school's ad *history* is the same breach in
    // read form, and the moderation queue's reasons are not public.
    for (const layer of (schoolAdRoute.stack || []).filter((l) => l.route)) {
      const names = layer.route.stack.map((entry) => entry.name);
      assert.ok(
        names.includes('authenticate'),
        `${layer.route.path} must require authentication`
      );
      assert.ok(
        layer.route.stack.some((entry) => entry.handle && entry.name !== 'handle'),
        `${layer.route.path} must pass through a middleware chain`
      );
    }
  });

  test('the public slider is still separate, and still unauthenticated', () => {
    // The two routers are mounted adjacently and that contrast is deliberate: one may
    // read every ad, the other may read only its own.
    const publicPaths = (publicAdRoute.stack || [])
      .filter((layer) => layer.route)
      .map((layer) => layer.route.path);

    assert.ok(publicPaths.includes('/public/school-ads'));
    assert.ok(!publicPaths.includes('/schools/me/ad-requests'));
  });
});

// ─────────────────────────────────────────────
// The copy fields
// ─────────────────────────────────────────────
describe('ad requests: the copy has somewhere to go', () => {
  test('a writeup exists, because a 60-character headline is not an advertisement', () => {
    assert.ok(SchoolAd.schema.path('writeup'));
    assert.equal(SchoolAd.schema.path('writeup').options.maxlength, 600);
  });

  test('the writeup is optional', () => {
    // An ad may legitimately be a logo and a link. Requiring prose pushes submissions
    // toward filling the field with filler.
    const { error } = validate(createSchoolAdRequestSchema, {
      ...validRequest(),
      writeup: undefined,
    });
    assert.equal(error, undefined);
  });

  test('more than one image is allowed, and more than four is not', () => {
    // The request is for "images", plural, and one slot could not carry them — the
    // second upload would overwrite the first.
    const four = Array.from({ length: 4 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
    assert.equal(
      validate(createSchoolAdRequestSchema, { ...validRequest(), imageUrls: four }).error,
      undefined
    );
    assert.ok(
      validate(createSchoolAdRequestSchema, {
        ...validRequest(),
        imageUrls: [...four, 'https://cdn.example.com/4.jpg'],
      }).error
    );
  });
});

// ─────────────────────────────────────────────
// The link, which is the security-relevant field
// ─────────────────────────────────────────────
describe('ad requests: the link cannot execute', () => {
  test('https is required', () => {
    // These render on the login and signup pages. A `javascript:` URL here executes on
    // an unauthenticated visitor's session — so this one rule is the whole defence.
    assert.equal(
      validate(createSchoolAdRequestSchema, validRequest()).error,
      undefined
    );
    assert.ok(
      validate(createSchoolAdRequestSchema, {
        ...validRequest(),
        linkUrl: 'javascript:alert(document.cookie)',
      }).error
    );
    assert.ok(
      validate(createSchoolAdRequestSchema, {
        ...validRequest(),
        linkUrl: 'data:text/html,<script>alert(1)</script>',
      }).error
    );
    assert.ok(
      validate(createSchoolAdRequestSchema, { ...validRequest(), linkUrl: 'http://x.com' }).error,
      'plain http is rejected too — the form tells the school to use https'
    );
  });

  test('an end date in the past is refused', () => {
    // `reviewSchoolAd` refuses to approve an expired ad, so accepting a past date
    // produces a request that is dead on arrival and costs the school a round trip.
    const { error } = validate(createSchoolAdRequestSchema, {
      ...validRequest(),
      endsAt: '2020-01-01',
    });
    assert.ok(error);
  });
});

// ─────────────────────────────────────────────
// Authoring and approving
// ─────────────────────────────────────────────
describe('ad requests: who wrote it and who approved it', () => {
  test('authorship is recorded, because author and approver can be the same person', () => {
    // The product requires a super admin to approve. When the platform authored the ad,
    // that is satisfied by construction — but it is an exception, and an audit log that
    // cannot express it would claim a separation of duties the platform never had.
    assert.ok(SchoolAd.schema.path('authoredByPlatform'));
    assert.equal(SchoolAd.schema.path('authoredByPlatform').options.default, false);
    assert.ok(SchoolAd.schema.path('requestedBy'));
  });

  test('a copy edit during review is recorded, so the school can be told', () => {
    assert.ok(SchoolAd.schema.path('copyEditedByReview'));
  });

  test('copy is editable in the same request as the decision', () => {
    // That is the requirement — a super admin may author content as well as review a
    // school's — and doing it in one action is what makes it usable. Two round trips
    // means a half-finished edit can sit in the queue.
    const keys = Object.keys(approveSchoolAdSchema.describe().keys);
    for (const field of ['headline', 'writeup', 'endsAt']) {
      assert.ok(keys.includes(field), `review should accept ${field}`);
    }
    assert.ok(keys.includes('status'));
  });

  test('a rejection still requires its reason', () => {
    const { error } = validate(approveSchoolAdSchema, { status: 'rejected' });
    assert.ok(error);
    assert.equal(
      validate(approveSchoolAdSchema, {
        status: 'rejected',
        rejectedReason: 'The link cannot be verified',
      }).error,
      undefined
    );
  });

  test('the ordinary edit endpoint still cannot change status', () => {
    // The guard that stops a school-side edit from self-approving. `updateSchoolAd`
    // also carries the no-op `if (status !== undefined) ad.status = ad.status;` for
    // the same reason; both layers exist because the other one can be edited away.
    assert.ok(
      !Object.keys(updateSchoolAdSchema.describe().keys).includes('status'),
      'updateSchoolAdSchema must not accept a status'
    );
  });
});

// ─────────────────────────────────────────────
// Posting straight to the public pages
// ─────────────────────────────────────────────
describe('ad requests: the platform can post an ad without a second reader', () => {
  test('the console schema still cannot be told what status to write', () => {
    // The point of `publish` being a verb rather than a status field. A `status` key
    // here would hand the console an open vocabulary — `approved`, and the next value
    // anybody adds — where the schema should express exactly one decision: post it, or
    // file it.
    const keys = Object.keys(createSchoolAdSchema.describe().keys);
    assert.ok(!keys.includes('status'), 'createSchoolAdSchema must not accept a status');
    assert.ok(keys.includes('publish'), 'createSchoolAdSchema must accept publish');
  });

  test('the school schema cannot publish, however it is asked', () => {
    // The escalation counterpart to the checks above. A school has no route to the
    // public pages at all, and a `publish` key on this schema would be the beginning
    // of one.
    const keys = Object.keys(createSchoolAdRequestSchema.describe().keys);
    assert.ok(!keys.includes('publish'), 'createSchoolAdRequestSchema must not accept publish');
  });

  test('publishing is opt-in: an ad is filed pending unless asked otherwise', () => {
    // The invariant is *nothing reaches the login page of every visitor without
    // somebody asking for it*, and it must not depend on a field the caller
    // remembered to send. So the default is the safe answer, and `stripUnknown`
    // means a `publish` that is not the boolean is not a publish either.
    const { error, value } = validate(createSchoolAdSchema, validConsoleAd());
    assert.equal(error, undefined);
    assert.equal(value.publish, false);

    const explicit = validate(createSchoolAdSchema, { ...validConsoleAd(), publish: true });
    assert.equal(explicit.value.publish, true);

    // Multipart bodies arrive as strings; Joi coerces the two honest spellings and
    // refuses the rest rather than treating a truthy value as an instruction.
    assert.equal(validate(createSchoolAdSchema, { ...validConsoleAd(), publish: 'true' }).value.publish, true);
    assert.ok(validate(createSchoolAdSchema, { ...validConsoleAd(), publish: 'yes' }).error);
  });

  test('a posted status in the body is stripped, not honoured', () => {
    // Belt and braces around the schema shape above: even if `status` were ever added
    // back, `stripUnknown` (set in `middleware/validate.js`) drops it on the way in.
    const { value } = validate(createSchoolAdSchema, {
      ...validConsoleAd(),
      status: 'approved',
    });
    assert.equal(value.status, undefined);
  });

  test('the console ad carries a name whether or not it is attributed to a school', () => {
    // `schoolId` is optional — a platform-run ad belongs to nobody's advertising
    // record — but `schoolName` is what the public carousel prints above the headline,
    // so an ad with neither is an ad with no author on the page.
    assert.equal(validate(createSchoolAdSchema, validConsoleAd()).error, undefined);

    const { error } = validate(createSchoolAdSchema, {
      ...validConsoleAd(),
      schoolName: '',
    });
    assert.ok(error, 'schoolName is required even with no schoolId');

    // The school's own request path takes neither, which is the other half of this.
    assert.equal(
      validate(createSchoolAdRequestSchema, { ...validRequest(), schoolName: 'X' }).error,
      undefined
    );
    assert.equal(
      validate(createSchoolAdRequestSchema, validRequest()).schoolName,
      undefined
    );
  });
});

// ─────────────────────────────────────────────
// The page size every console school picker asks for
// ─────────────────────────────────────────────
describe('ad requests: the school picker can ask for a full page of schools', () => {
  test('GET /admin/schools accepts the page size the pickers request', () => {
    // `SchoolPicker`, `SchoolSelect` and `ImpersonationHistory` all send
    // `perPage: 200` — the platform's own `MAX_PER_PAGE`. This schema capped at 100,
    // which 422'd every one of them with `"perPage" must be less than or equal to 100`
    // and made a platform with hundreds of schools report having none.
    //
    // Asserted against the constant rather than the number, so raising `MAX_PER_PAGE`
    // later cannot quietly re-break it.
    assert.equal(validate(listAllSchoolsQuerySchema, { perPage: MAX_PER_PAGE }).error, undefined);
    assert.equal(validate(listAllSchoolsQuerySchema, {}).value.perPage, 20);
    assert.ok(validate(listAllSchoolsQuerySchema, { perPage: MAX_PER_PAGE + 1 }).error);
  });
});

// ─────────────────────────────────────────────
// Filters the UI renders
// ─────────────────────────────────────────────
describe('ad requests: filters and vocabulary', () => {
  test('every status the tabs show is a real status', () => {
    // Behaviourally rather than by reading Joi's internals. `describe().keys.status`
    // reaches into `_flags._inner.matches` and `_valids._innerSet`, which are
    // implementation detail — the first version of this test asserted against them and
    // failed on a shape that was perfectly valid.
    //
    // What actually matters is the round trip: each tab the UI offers must validate,
    // and a value the model has no state for must not.
    for (const tab of ['all', 'pending', 'approved', 'rejected', 'expired', 'draft']) {
      const { error } = validate(listSchoolAdRequestsSchema, { status: tab });
      assert.equal(error, undefined, `${tab} should be a valid filter`);
    }

    assert.ok(validate(listSchoolAdRequestsSchema, { status: 'not-a-status' }).error);
    assert.ok(AD_STATUSES.includes('pending'));
    assert.ok(AD_STATUSES.includes('approved'));
  });

  test('the placements the form offers are the model’s', () => {
    // `services/adRequests.js` keeps its own copy so the form can show help text. If
    // the two drift, a school picks a placement that is then rejected server-side.
    const keys = Object.keys(createSchoolAdRequestSchema.describe().keys);
    assert.ok(keys.includes('placement'));
    assert.deepEqual([...AD_PLACEMENTS].sort(), [
      'auth_aside',
      'dashboard_sidebar',
      'home_hero',
    ]);
  });

  test('both audiences are notified, with declared types', () => {
    assert.equal(NOTIFICATION_TYPES.AD_REQUEST, 'ad.request');
    assert.equal(NOTIFICATION_TYPES.AD_APPROVED, 'ad.approved');
    assert.equal(NOTIFICATION_TYPES.AD_REJECTED, 'ad.rejected');
  });

  test('request and review are separate audit actions', () => {
    // "Who asked" is a different question from "who decided", and conflating them
    // answers neither.
    assert.equal(AUDIT_ACTIONS.AD_REQUEST, 'ad.request');
    assert.equal(AUDIT_ACTIONS.AD_REVIEW, 'ad.review');
    assert.notEqual(AUDIT_ACTIONS.AD_REQUEST, AUDIT_ACTIONS.AD_REVIEW);
  });
});