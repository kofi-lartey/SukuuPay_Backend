// Run with `npm test` from `Backend/`.
//
// ## An ad the console published must be live, and nothing else may be
//
// `liveAdsQuery` is the only definition of "live" now. It used to have a rival: an
// `isLive(ad)` helper that spelled the same rule in JavaScript and had already fallen
// behind — the query carried `deletedAt: null` and the helper did not. Two definitions
// is one more than there should be, and the one that gets reached for by a new caller
// is the one nobody keeps in step.
//
// The test is written as a **filter**, not as an equality check on a query object,
// because the property that matters is which documents a given ad matches. Asserting the
// shape of the query would let every field change meaning; asserting membership cannot.
//
// ## Why this exists
//
// A super admin posts a creative and it does not appear on the login page. Every part of
// that chain had a reason to be wrong — the feature flag, the placement, the status, the
// window, `deletedAt`, and the client's own https-and-alt-text filter — and the console
// says "created" for all of them. So the rule that decides whether a posted creative is
// visible gets one place and one test, and the console's own output is checked against
// it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { readFileSync } from 'node:fs';

import { createSchoolAdSchema } from '../src/validations/schoolAd.validation.js';
import { liveAdsQuery, isLive, visibilityReason } from '../src/controllers/schoolAd.controller.js';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const PLACEMENT = 'auth_aside';

const days = (n) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

/** The exact body `AdminAdCreate` sends. Joi-coerced, then read as the controller reads it. */
const consoleBody = (overrides = {}) => {
  const { value, error } = createSchoolAdSchema.validate(
    {
      schoolName: 'Greenfield Academy',
      headline: 'Admissions open for 2026/27',
      writeup: 'Fees, subjects and how to apply.',
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1757000000/sukuuPay/ads/a.webp',
      imageAlt: 'Students in the science laboratory',
      linkUrl: 'https://greenfield.edu.gh/admissions',
      placement: PLACEMENT,
      endsAt: days(60).toISOString(),
      publish: 'true',
      ...overrides,
    },
    { abortEarly: true, stripUnknown: true }
  );
  assert.equal(error, undefined, `the console body must be valid: ${error?.message}`);
  return value;
};

/** The document the controller writes for that body, with nothing added. */
const persisted = (overrides = {}) => {
  const { publish, ...rest } = consoleBody(overrides);
  const goLive = publish === true;
  return {
    ...rest,
    schoolId: null,
    status: goLive ? 'approved' : 'pending',
    approvedBy: goLive ? new mongoose.Types.ObjectId() : null,
    approvedAt: goLive ? NOW : null,
    authoredByPlatform: true,
    startsAt: null,
    deletedAt: null,
    sortWeight: 0,
    // Real `Date`s, because a persisted document has them and both the query matcher and
    // `isLive` compare against a `Date`. A Joi output string compared with `>` against a
    // `Date` is a comparison JavaScript performs by coercing one side to a string, which
    // would pass or fail for reasons that have nothing to do with the date window.
    endsAt: new Date(rest.endsAt),
  };
};

/** Mongo's match for one query term, limited to the operators these queries use. */
const matchesTerm = (doc, term) => {
  for (const [field, condition] of Object.entries(term)) {
    if (field === '$or') {
      if (!condition.some((branch) => matchesTerm(doc, branch))) return false;
      continue;
    }
    const value = doc[field];
    if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
      for (const [op, operand] of Object.entries(condition)) {
        if (op === '$gt' && !(value > operand)) return false;
        if (op === '$lte' && !(value <= operand)) return false;
        if (op === '$in' && !operand.includes(value)) return false;
      }
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
};

const isVisible = (doc, query = liveAdsQuery(PLACEMENT, NOW)) => matchesTerm(doc, query);

describe('a creative the console posts is live', () => {
  test('published straight through, it matches the public query', () => {
    const doc = persisted();
    assert.equal(doc.status, 'approved');
    assert.ok(
      isVisible(doc),
      'a posted creative must be returned by the query the login page uses'
    );
  });

  test('and isLive agrees with the query about every document-level field', () => {
    // The two definitions, held to each other. A disagreement means the next caller to
    // use the wrong one gets a different answer from the login page.
    //
    // Placement is deliberately **not** in this list. `isLive(ad)` answers "is this ad
    // currently running?", which is a property of the document; placement is a property
    // of *the query* — the same ad is live and belongs on the home hero rather than the
    // auth aside. So the two differ on a placement variant by design, and comparing them
    // on one would be asserting that a correct design is a defect.
    const query = liveAdsQuery(PLACEMENT, NOW);
    const cases = [
      persisted(),
      persisted({ publish: false }),
      { ...persisted(), status: 'rejected' },
      { ...persisted(), endsAt: days(-1) },
      { ...persisted(), startsAt: days(3) },
      { ...persisted(), deletedAt: days(-1) },
    ];

    for (const doc of cases) {
      assert.equal(
        isVisible(doc, query),
        isLive(doc, NOW),
        `isLive and liveAdsQuery disagree about ${JSON.stringify({
          status: doc.status,
          endsAt: doc.endsAt,
          startsAt: doc.startsAt,
          deletedAt: doc.deletedAt,
        })}`
      );
    }
  });
});

describe('nothing that should be hidden is served', () => {
  test('a creative filed but not posted stays hidden', () => {
    // `publish` absent or false is the schema default, so a caller that forgets the flag
    // cannot accidentally put an ad on the login page of every visitor.
    const filed = persisted({ publish: false });
    assert.equal(filed.status, 'pending');
    assert.ok(!isVisible(filed), 'a pending creative must not be public');
  });

  test('the other placements are not shown on the auth aside', () => {
    for (const placement of ['home_hero', 'dashboard_sidebar']) {
      assert.ok(
        !isVisible(persisted({ placement })),
        `${placement} must not render in the auth aside`
      );
    }
  });

  test('a window that has closed is hidden', () => {
    // Half-open: `endsAt > now`, so the last second of the run still renders and the
    // next one does not. An expired ad needs no cleanup to stop being served.
    //
    // `endsAt` is set on the **persisted document** rather than through the schema: the
    // schema refuses a past date, which is correct for a request and useless here,
    // because an ad's window closes by the clock moving rather than by anyone editing
    // it. The subject under test is the query, and the query must survive a document
    // that has aged.
    assert.ok(isVisible(persisted({ endsAt: days(1).toISOString() })));
    assert.ok(!isVisible({ ...persisted(), endsAt: days(-1) }));
    assert.ok(!isVisible({ ...persisted(), endsAt: NOW }), 'endsAt == now is over');
  });

  test('a scheduled start is respected', () => {
    const future = { ...persisted(), startsAt: days(3) };
    const past = { ...persisted(), startsAt: days(-3) };

    assert.ok(!isVisible(future), 'a creative that has not started must not be public');
    assert.ok(isVisible(past), 'a creative whose start has passed must be public');
  });

  test('a soft-deleted creative is never served', () => {
    // The rule the old `isLive` helper was missing.
    const softDeleted = { ...persisted(), deletedAt: days(-1) };
    assert.ok(!isVisible(softDeleted));
    assert.equal(isLive(softDeleted, NOW), false);
  });

  test('only approved is served', () => {
    for (const status of ['draft', 'pending', 'rejected', 'expired']) {
      assert.ok(!isVisible({ ...persisted(), status }), `${status} must not be public`);
    }
  });
});

describe('the console is told why a creative is not showing', () => {
  // `visibility.reason` on each queue row, computed from `isLive`'s rule. Without it the
  // only symptom of a hidden creative is an empty login panel, which reads as a broken
  // feature rather than as a row whose window has closed.
  test('a live creative has no reason', () => {
    assert.equal(visibilityReason(persisted(), NOW), null);
  });

  test('every hidden state names itself in operator words', () => {
    const cases = [
      [{ ...persisted(), deletedAt: days(-1) }, 'deleted'],
      [{ ...persisted(), status: 'draft' }, 'draft'],
      [{ ...persisted(), status: 'pending' }, 'approval'],
      [{ ...persisted(), status: 'rejected' }, 'rejected'],
      [{ ...persisted(), endsAt: days(-1) }, 'run has ended'],
      [{ ...persisted(), startsAt: days(3) }, 'start later'],
    ];

    for (const [doc, mustMention] of cases) {
      const reason = visibilityReason(doc, NOW);
      assert.ok(reason, `${JSON.stringify({ status: doc.status })} should give a reason`);
      assert.match(
        reason.toLowerCase(),
        new RegExp(mustMention, 'i'),
        `expected the reason to mention "${mustMention}", got "${reason}"`
      );
      assert.equal(isLive(doc, NOW), false, 'a row with a reason must not be live');
    }
  });

  test('a reason is given exactly when the ad is not live', () => {
    // The two must not disagree, or the console contradicts itself.
    const docs = [
      persisted(),
      persisted({ publish: false }),
      { ...persisted(), status: 'draft' },
      { ...persisted(), endsAt: days(-1) },
      { ...persisted(), startsAt: days(2) },
      { ...persisted(), deletedAt: days(-1) },
    ];

    for (const doc of docs) {
      assert.equal(
        visibilityReason(doc, NOW) === null,
        isLive(doc, NOW),
        'a reason and "not live" must be the same statement'
      );
    }
  });
});

describe('the placement the login page asks for', () => {
  test('the auth aside defaults to auth_aside', () => {
    // `listSchoolAdsQuerySchema.placement` has no default on purpose — the shared schema
    // would then hide every other placement from the moderation queue — so
    // `listPublicSchoolAds` applies its own fallback. Both the fallback and what the
    // carousel requests have to be the same string, and this pins the server half.
    const source = readFileSync(
      new URL('../src/controllers/schoolAd.controller.js', import.meta.url),
      'utf8'
    );
    assert.match(source, /req\.query\.placement \|\| "auth_aside"/);
    assert.equal(PLACEMENT, 'auth_aside');
  });

  test('the carousel requests the same placement the console form defaults to', () => {
    const frontend = new URL('../../frontend/src/', import.meta.url);

    // The default is written in three places and must not drift: the carousel's prop, the
    // service's parameter, and the console form's initial state. Each was `auth_aside`
    // independently, which is exactly why a rename is a three-file change.
    const carousel = readFileSync(new URL('components/auth/SchoolAdCarousel.jsx', frontend), 'utf8');
    const service = readFileSync(new URL('services/schoolAds.js', frontend), 'utf8');
    const aside = readFileSync(new URL('components/auth/OnboardingAside.jsx', frontend), 'utf8');

    assert.match(carousel, /placement = 'auth_aside'/);
    assert.match(service, /placement = 'auth_aside'\)/);
    assert.match(aside, /SchoolAdSlot placement="auth_aside"/);
  });
});

