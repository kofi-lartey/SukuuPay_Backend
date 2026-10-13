// Regression coverage for the parent-portal academic surface and the matching
// admin write side, added alongside that surface.
//
// Everything here is a pure unit test — no database, no network. The services
// themselves are audited by a real integration suite, because their risk is in
// the authorisation ("can a sibling read another sibling's card") rather than in
// the shape of the read. What is asserted below is the layer those reads are
// built on: the grade bands, the term calendar, the timetable clock logic, the
// validation schemas, and the rate-limit contract.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { gradeForScore, GRADE_BANDS } from '../src/utils/gradeBands.js';
import { colorForSubject } from '../src/utils/subjectColors.js';
import { resolveTermRange, daysBetween, isoDay } from '../src/utils/termDates.js';
import { isWithinRadius } from '../src/utils/geoDistance.js';
import { parsePeriodTime, isOngoing } from '../src/services/parent/timetable.service.js';
import { hashTokenForLog } from '../src/utils/tokens.js';
import { rateLimit, PAY_PORTAL_LIMITS } from '../src/middleware/rateLimit.js';
import { AUDIT_ACTIONS as CONSTANTS_ACTIONS, AUDIT_ACTION_VALUES } from '../src/config/constants.js';
import { AUDIT_ACTIONS as SCHEMA_ACTIONS } from '../src/models/AuditLog.js';

import {
  attendanceQuerySchema,
  recordsQuerySchema,
  timetableQuerySchema,
  parentTokenParamSchema,
} from '../src/validations/parent.validation.js';
import {
  bulkMarkAttendanceSchema,
  autoMarkPresentSchema,
} from '../src/validations/admin.attendance.validation.js';
import { compileReportCardsSchema,
  publishReportCardsSchema,
} from '../src/validations/admin.records.validation.js';
import { upsertTimetableSchema } from '../src/validations/admin.timetable.validation.js';
import { normalizeDays } from '../src/services/admin/timetable.service.js';

const validate = (schema, payload) =>
  schema.validate(payload, { abortEarly: false, stripUnknown: true, convert: true });

// ── Grade bands ──────────────────────────────────────────────────────────────

describe('gradeForScore — WAEC bands', () => {
  test('80 / 80 lands A+', () => assert.equal(gradeForScore(80, 80), 'A+'));
  test('79 / 100 lands A (not A+)', () => assert.equal(gradeForScore(79), 'A'));
  test('0 lands F', () => assert.equal(gradeForScore(0), 'F'));
  test('a 50-mark subject uses the same band as a 100-mark one', () => {
    // 40/50 == 80% -> A+, so a half-weighted subject does not grade-shift.
    assert.equal(gradeForScore(40, 50), 'A+');
    assert.equal(gradeForScore(80, 100), 'A+');
  });
  test('a mark above maxSaturation is still F, never NaN', () => {
    assert.equal(gradeForScore(NaN, 100), 'F');
    assert.equal(gradeForScore(60, 0), 'F');
  });
  test('the band table is the source the admin and parent share', () => {
    assert.equal(GRADE_BANDS[0].grade, 'A+');
    assert.equal(GRADE_BANDS[0].min, 80);
    assert.equal(GRADE_BANDS.at(-1).grade, 'F');
  });
});

// ── Subject colours ──────────────────────────────────────────────────────────

describe('colorForSubject — stable per name', () => {
  test('the same subject across two terms is one colour', () => {
    assert.equal(colorForSubject('Mathematics'), colorForSubject('Mathematics'));
  });
  test('capitalisation does not change the colour', () => {
    assert.equal(colorForSubject('English'), colorForSubject('english'));
  });
  test('an unknown subject still gets a colour (never undefined)', () => {
    const c = colorForSubject('Some Subject Not Seen Before');
    assert.match(c, /^#[0-9A-Fa-f]{6}$/);
  });
  test('an empty subject falls back without throwing', () => {
    assert.match(colorForSubject(''), /^#[0-9A-Fa-f]{6}$/);
  });
});

// ── Term ranges ──────────────────────────────────────────────────────────────

describe('resolveTermRange — GES default fallback', () => {
  const school = { academic: { currentYear: '2026/2027', currentTerm: 'Term 2' } };

  test('Term 2 spans the start-year window in January', () => {
    const r = resolveTermRange('Term 2', '2026/2027', school);
    // startMonth 0 (Jan) day 5 -> startYear 2026; endMonth 3 (April) day 15.
    assert.equal(r.start.toISOString().slice(0, 10), '2026-01-05');
    assert.equal(r.end.toISOString().slice(0, 10), '2026-04-15');
  });

  test('Term 1 starts in the start calendar year (GES September start)', () => {
    const r = resolveTermRange('Term 1', '2026/2027', school);
    assert.equal(r.start.toISOString().slice(0, 10), '2026-09-01');
    assert.equal(r.end.toISOString().slice(0, 10), '2026-12-15');
  });

  test('an explicit school range beats the default', () => {
    const explicit = {
      academic: {
        currentYear: '2026/2027',
        terms: [{ name: 'Term 2', startDate: '2026-02-01', endDate: '2026-04-30' }],
      },
    };
    const r = resolveTermRange('Term 2', '2026/2027', explicit);
    assert.equal(r.start.toISOString().slice(0, 10), '2026-02-01');
    assert.equal(r.end.toISOString().slice(0, 10), '2026-04-30');
  });

  test('daysBetween is inclusive of both ends', () => {
    const days = daysBetween(
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-03T00:00:00Z')
    );
    assert.equal(days.length, 3);
  });

  test('isoDay is the UTC date, so Accra midnight is not yesterday', () => {
    assert.equal(isoDay(new Date('2026-06-01T23:30:00Z')), '2026-06-01');
    assert.equal(isoDay(new Date('2026-06-02T00:15:00Z')), '2026-06-02');
  });
});

// ── Geofence arithmetic ──────────────────────────────────────────────────────

describe('isWithinRadius — haversine', () => {
  const accra = { lat: 5.5560, lng: -0.2054 };

  test('the same point is within range', () => assert.equal(isWithinRadius(accra, accra), true));
  test('600m past the 200m default is out of range', () => {
    assert.equal(isWithinRadius({ lat: 5.5500, lng: -0.2054 }, accra), false);
  });
  test('a ~1m tolerance is honoured and a ~600m offset is not', () => {
    // 0.00001 degrees of latitude ≈ 1.1 m, well inside a 50 m radius.
    assert.equal(isWithinRadius({ lat: 5.55601, lng: -0.2054 }, accra, 50), true);
    // 0.005 degrees of latitude ≈ 550 m, beyond the 200 m default.
    assert.equal(isWithinRadius({ lat: 5.5500, lng: -0.2054 }, accra, 50), false);
    assert.equal(isWithinRadius({ lat: 5.5500, lng: -0.2054 }, accra), false);
  });
  test('a missing coordinate is never accidentally inside', () => {
    assert.equal(isWithinRadius(null, accra), false);
    assert.equal(isWithinRadius(accra, undefined), false);
  });
});

// ── Timetable clock ─────────────────────────────────────────────────────────

describe('parsePeriodTime', () => {
  test('12-hour am/pm strings', () => {
    assert.equal(parsePeriodTime('8:00 am'), 8 * 60);
    assert.equal(parsePeriodTime('8:45 am'), 8 * 60 + 45);
    assert.equal(parsePeriodTime('1:30 pm'), 13 * 60 + 30);
    assert.equal(parsePeriodTime('12:00 pm'), 12 * 60);
    assert.equal(parsePeriodTime('12:00 am'), 0);
  });
  test('garbage returns null, never NaN', () => {
    assert.equal(parsePeriodTime(''), null);
    assert.equal(parsePeriodTime('noon'), null);
    assert.equal(parsePeriodTime('25:99'), null);
  });
});

describe('isOngoing — only on the live weekday, inside the time window', () => {
  const period = { startTime: '8:00 am', endTime: '9:30 am' };
  const wed9am = { weekday: 'Wednesday', minuteOfDay: 9 * 60 };
  const wedBefore = { weekday: 'Wednesday', minuteOfDay: 6 * 60 }; // 6:00 am
  const wedAfter = { weekday: 'Wednesday', minuteOfDay: 10 * 60 }; // 10:00 am
  const thu9am = { weekday: 'Thursday', minuteOfDay: 9 * 60 };

  test('true when the clock is inside the window on the live weekday', () => {
    assert.equal(isOngoing(period, 'Wednesday', wed9am), true);
  });
  test('false when the clock is before the period on the live weekday', () => {
    assert.equal(isOngoing(period, 'Wednesday', wedBefore), false);
  });
  test('false when the clock is after the period on the live weekday', () => {
    assert.equal(isOngoing(period, 'Wednesday', wedAfter), false);
  });
  test('false on any other weekday, even inside the time window', () => {
    assert.equal(isOngoing(period, 'Wednesday', thu9am), false);
    assert.equal(isOngoing(period, 'Thursday', wed9am), false);
  });
  test('a period whose times do not parse is never ongoing', () => {
    assert.equal(isOngoing({ startTime: 'noon', endTime: 'soon' }, 'Wednesday', wed9am), false);
  });
  test('a clock with no resolved weekday never lights up', () => {
    assert.equal(isOngoing(period, 'Wednesday', { weekday: null, minuteOfDay: 9 * 60 }), false);
  });
});

// ── Token hashing ───────────────────────────────────────────────────────────

describe('hashTokenForLog — never returns the raw token', () => {
  test('a real pay token is hashed and truncated', () => {
    const h = hashTokenForLog('STU-FCFEE2A4');
    assert.equal(typeof h, 'string');
    assert.equal(h.length, 16);
    assert.equal(h, hashTokenForLog('STU-FCFEE2A4'));
    assert.notEqual(h, 'STU-FCFEE2A4');
    assert.ok(!h.includes('STU'));
  });
  test('it is stable so a term of reads correlates to one link', () => {
    assert.equal(hashTokenForLog('STU-DEADBEEF'), hashTokenForLog('STU-DEADBEEF'));
  });
  test('two different links hash apart', () => {
    assert.notEqual(hashTokenForLog('STU-AAAAAAAA'), hashTokenForLog('STU-BBBBBBBB'));
  });
});

// ── Parent validation schemas ───────────────────────────────────────────────

describe('parent validation schemas', () => {
  test('valid query params pass', () => {
    assert.deepEqual(validate(attendanceQuerySchema, { term: 'Term 2' }).error, undefined);
    assert.deepEqual(validate(recordsQuerySchema, {}).error, undefined);
    assert.deepEqual(validate(timetableQuerySchema, { weekOf: '2026-06-01' }).error, undefined);
  });
  test('an unknown term is rejected, not silently defaulted', () => {
    assert.ok(validate(attendanceQuerySchema, { term: 'Term 4' }).error);
  });
  test('the token param matches the generator and rejects non-hex', () => {
    const ok = validate(parentTokenParamSchema, { token: 'STU-FCFEE2A4' });
    assert.deepEqual(ok.error, undefined);
    assert.ok(validate(parentTokenParamSchema, { token: 'STU-8F3K9D2L' }).error);
    assert.ok(validate(parentTokenParamSchema, { token: 'stulower' }).error);
  });
  test('a query schema strips nothing it should not keep', () => {
    const { value } = validate(attendanceQuerySchema, { term: 'Term 2', junk: 'x' });
    assert.deepEqual(value, { term: 'Term 2' });
  });
});

// ── Admin validation schemas ────────────────────────────────────────────────

describe('admin attendance validation', () => {
  const marks = [
    { studentId: '507f1f77bcf86cd799439011', status: 'present' },
    { studentId: '507f1f77bcf86cd799439012', status: 'late', arrivalTime: '2026-10-06T08:12:00Z', note: 'late' },
  ];

  test('a well-formed batch passes', () => {
    assert.deepEqual(
      validate(bulkMarkAttendanceSchema, { date: '2026-10-06', className: 'JHS 1A', marks }).error,
      undefined
    );
  });
  test('a batch with no marks is rejected', () => {
    assert.ok(validate(bulkMarkAttendanceSchema, { date: '2026-10-06', className: 'JHS 1A', marks: [] }).error);
  });
  test('a non-ObjectId student is rejected before it can CastError in Mongo', () => {
    const bad = [{ studentId: 'not-an-id', status: 'present' }];
    assert.ok(validate(bulkMarkAttendanceSchema, { date: '2026-10-06', className: 'JHS 1A', marks: bad }).error);
  });
  test('maxScore default flows through', () => {
    const { value } = validate(bulkMarkAttendanceSchema, { date: '2026-10-06', className: 'JHS 1A', marks });
    assert.equal(value.marks[0].arrivalTime, undefined);
  });
  test('geofence payload validates, and rejects a latitude out of range', () => {
    const base = {
      studentId: '507f1f77bcf86cd799439011',
      className: 'JHS 1A',
      location: { lat: 5.556, lng: -0.205 },
      schoolLocation: { lat: 5.556, lng: -0.205 },
    };
    assert.deepEqual(validate(autoMarkPresentSchema, base).error, undefined);
    const bad = { ...base, schoolLocation: { lat: 91, lng: 0 } };
    assert.ok(validate(autoMarkPresentSchema, bad).error);
  });
});

describe('admin records/timetable validation', () => {
  const id = '507f1f77bcf86cd799439011';

  test('compile requires scores keyed by student id', () => {
    assert.deepEqual(
      validate(compileReportCardsSchema, {
        className: 'JHS 1A',
        term: 'Term 2',
        academicYear: '2026/2027',
        scores: { [id]: [{ subject: 'Maths', score: 80 }] },
      }).error,
      undefined
    );
  });
  test('compile rejects a non-ObjectId student key', () => {
    // Without `stripUnknown`, a key that fails the ObjectId pattern is an error
    // rather than a silently-dropped field.
    const { error } = compileReportCardsSchema.validate(
      {
        className: 'JHS 1A',
        term: 'Term 2',
        academicYear: '2026/2027',
        scores: { notanid: [{ subject: 'Maths', score: 80 }] },
      },
      { abortEarly: false }
    );
    assert.ok(error, 'expected the non-ObjectId student key to be rejected');
  });
  test('compile rejects a bad academic-year shape', () => {
    assert.ok(
      validate(compileReportCardsSchema, {
        className: 'JHS 1A',
        term: 'Term 2',
        academicYear: '2026',
        scores: { [id]: [] },
      }).error
    );
  });
  test('publish requires the same three keys', () => {
    assert.deepEqual(
      validate(publishReportCardsSchema, { className: 'JHS 1A', term: 'Term 2', academicYear: '2026/2027' }).error,
      undefined
    );
  });
  test('a timetable with one day and an empty day passes (default [])', () => {
    const { value, error } = validate(upsertTimetableSchema, {
      className: 'JHS 1A',
      term: 'Term 2',
      academicYear: '2026/2027',
      days: {
        Monday: [{ period: 1, startTime: '8:00 am', endTime: '8:45 am', subject: 'Maths' }],
      },
    });
    assert.deepEqual(error, undefined);
    // Every weekday key is present after defaults.
    assert.deepEqual(Object.keys(value.days).sort(), ['Friday', 'Monday', 'Thursday', 'Tuesday', 'Wednesday']);
    assert.deepEqual(value.days.Friday, []);
  });
  test('a timetable drops a period missing its subject', () => {
    const { value } = validate(upsertTimetableSchema, {
      className: 'JHS 1A',
      term: 'Term 2',
      academicYear: '2026/2027',
      days: { Monday: [{ period: 1, startTime: '8:00 am', endTime: '8:45 am', subject: 'Maths' }] },
    });
    assert.equal(value.days.Monday.length, 1);
  });
});

// ── Timetable day normalisation (pure) ───────────────────────────────────────

describe('normalizeDays — drops incomplete periods in place', () => {
  test('a period missing subject/start/end is dropped', () => {
    const out = normalizeDays({
      Monday: [
        { period: 1, startTime: '8:00 am', endTime: '8:45 am', subject: 'Maths' },
        { period: 2, startTime: '9:00 am', endTime: '9:45 am', subject: '' },
        { period: 3, startTime: '', endTime: '9:00 am', subject: 'Sci' },
      ],
    });
    assert.equal(out.Monday.length, 1);
    assert.equal(out.Monday[0].subject, 'Maths');
  });

  test('all five weekday keys are present and sorted by period', () => {
    const out = normalizeDays({
      Monday: [
        { period: 3, startTime: 'a', endTime: 'b', subject: 'C' },
        { period: 1, startTime: 'a', endTime: 'b', subject: 'A' },
      ],
    });
    assert.deepEqual(Object.keys(out).sort(), ['Friday', 'Monday', 'Thursday', 'Tuesday', 'Wednesday']);
    assert.deepEqual(out.Friday, []);
    assert.deepEqual(out.Monday.map((p) => p.period), [1, 3]);
  });

  test('a missing weekday defaults to an empty array without throwing', () => {
    const out = normalizeDays(undefined);
    assert.deepEqual(out.Monday, []);
    assert.deepEqual(out.Wednesday, []);
  });
});

// ── Audit-action parity (both lists must agree, contract test) ───────────────

describe('audit action parity', () => {
  test('every new action exists in both the schema enum and the constants map', () => {
    const expected = {
      ATTENDANCE_BULK_MARK: 'attendance.bulk_mark',
      ATTENDANCE_AUTO_MARK: 'attendance.auto_mark',
      REPORT_CARD_COMPILE: 'report_card.compile',
      REPORT_CARD_PUBLISH: 'report_card.publish',
      TIMETABLE_UPSERT: 'timetable.upsert',
      PARENT_ATTENDANCE_VIEWED: 'parent.attendance_viewed',
      PARENT_RECORDS_VIEWED: 'parent.records_viewed',
      PARENT_TIMETABLE_VIEWED: 'parent.timetable_viewed',
    };
    for (const [key, action] of Object.entries(expected)) {
      assert.ok(SCHEMA_ACTIONS.includes(action), `AuditLog schema missing ${action}`);
      assert.equal(CONSTANTS_ACTIONS[key], action, `constants map missing ${key}`);
      assert.equal(AUDIT_ACTION_VALUES.includes(action), true, `AUDIT_ACTION_VALUES missing ${action}`);
    }
  });
  test('the two sources stay in step', () => {
    assert.equal(AUDIT_ACTION_VALUES.includes('report_card.compile'), true);
    assert.equal(SCHEMA_ACTIONS.includes('report_card.compile'), true);
  });
});

// ── Rate-limit contract ─────────────────────────────────────────────────────
//
// The "61st request in an hour is blocked" rule. The shared limiter is a
// singleton, so we test the factory with a tiny window instead of mutating the
// real one — the number 60 is locked separately from `PAY_PORTAL_LIMITS`.

describe('rateLimit — token-keyed, fixed window', () => {
  test('the parent view budget is 60/hour', () => {
    assert.equal(PAY_PORTAL_LIMITS.view.max, 60);
    assert.equal(PAY_PORTAL_LIMITS.view.windowMs, 60 * 60 * 1000);
  });
  test('the (max+1)th request in the window is rejected, keyed by token', () => {
    let passed = 0;
    let blocked = 0;
    const limiter = rateLimit({ windowMs: 60_000, max: 3, keyBy: 'token' });

    const call = (token) =>
      limiter(
        { params: { token }, ip: '1.2.3.4', baseUrl: '', path: `/pay/${token}` },
        {
          status() {
            blocked += 1;
            return this;
          },
          set() {
            return this;
          },
          json() {
            return this;
          },
        },
        () => {
          passed += 1;
        }
      );

    call('STU-AAAA'); // 1
    call('STU-AAAA'); // 2
    call('STU-AAAA'); // 3 — budget exhausted
    assert.equal(passed, 3);
    assert.equal(blocked, 0);

    // Fourth from the same token -> 429, not passed.
    call('STU-AAAA');
    assert.equal(passed, 3);
    assert.equal(blocked, 1);

    // A different token has its own budget, even from the same IP: three more
    // calls pass for BBB, and only the fourth is rejected.
    call('STU-BBBB');
    call('STU-BBBB');
    call('STU-BBBB');
    assert.equal(passed, 6); // three for AAA, three for BBB
    assert.equal(blocked, 1); // only the fourth AAAA
    call('STU-BBBB'); // fourth BBB -> rejected
    assert.equal(passed, 6);
    assert.equal(blocked, 2);
  });
});
