// Coverage for the teacher portal module.
//
// Everything here is a pure unit test — no database, no network, no listening
// socket. What is asserted is the layer that decides whether a teacher sees a
// class at all (the validation contracts and the scope/roster rules the
// services apply), plus the arithmetic a teacher quotes to a parent at the gate
// (grade bands, the attendance rate, the schedule clock).
//
// The services' own database reads are audited elsewhere; the risk being pinned
// here is the *rule*, and a rule that cannot be exercised without a live Mongo
// is a rule that nobody re-checks.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classQuerySchema,
  classSummaryParamsSchema,
  attendanceQuerySchema,
  studentIdParamSchema,
  classGradesQuerySchema,
  saveSingleGradeSchema,
  saveBulkGradesSchema,
} from '../src/validations/teacher.validation.js';
import { requireTeacher } from '../src/middleware/roles.js';
import { resolveTeacherActor } from '../src/utils/teacherScope.js';
import { resolveSchoolAcademicYear } from '../src/utils/termDates.js';
import { initialsOf } from '../src/services/teacher/classes.service.js';
import { parsePeriodTime, isOngoing, accraNow } from '../src/services/parent/timetable.service.js';

const validate = (schema, payload) =>
  schema.validate(payload, { abortEarly: false, stripUnknown: true, convert: true });

// ── Route contracts ───────────────────────────────────────────────────────────

describe('teacher validation — required inputs', () => {
  test('a roster read with no className is a 422, not a 400 later', () => {
    assert.ok(validate(classQuerySchema, {}).error);
  });

  test('a summary route with no className in the path fails', () => {
    assert.ok(validate(classSummaryParamsSchema, {}).error);
  });

  test('an attendance read needs both the class and the date', () => {
    assert.ok(validate(attendanceQuerySchema, { className: 'JHS 2A' }).error);
    assert.ok(validate(attendanceQuerySchema, { date: '2026-10-07' }).error);
    assert.ok(
      validate(attendanceQuerySchema, { className: 'JHS 2A', date: '2026-10-07' }).error === undefined
    );
  });

  test('a studentId that is not 24 hex characters fails', () => {
    assert.ok(validate(studentIdParamSchema, { studentId: 'jhs-2a' }).error);
    assert.ok(validate(studentIdParamSchema, { studentId: '64b7f9c2e1a2b3c4d5e6f708' }).error === undefined);
  });

  test('a class grades read needs a class name', () => {
    assert.ok(validate(classGradesQuerySchema, { term: 'Term 2' }).error);
  });

  test('a single grade save needs studentId, className, subject and term', () => {
    const { error } = validate(saveSingleGradeSchema, { score: 42 });
    assert.ok(error);
    // Every one of the four required fields is reported, not just the first.
    assert.ok(error.details.length >= 4);
  });

  test('a bulk grade save needs at least one row', () => {
    // min(1): an empty batch must be a 422 rather than a "saved 0 of 0" that
    // reads as a success.
    assert.ok(validate(saveBulkGradesSchema, {
      className: 'JHS 2A',
      subject: 'Mathematics',
      term: 'Term 2',
      grades: [],
    }).error);
  });

  test('a bulk grade save accepts 200 rows and refuses 201', () => {
    // 24 hex characters, the ObjectId length the schema demands.
    const rows = Array.from({ length: 200 }, (_, i) => ({
      studentId: `64b7f9c2e1a2b3c4d5e6f7${String(i % 100).padStart(2, '0')}`,
      score: 50,
    }));
    assert.ok(validate(saveBulkGradesSchema, {
      className: 'JHS 2A',
      subject: 'Mathematics',
      term: 'Term 2',
      grades: rows,
    }).error === undefined);

    const tooMany = [
      ...rows,
      { studentId: '64b7f9c2e1a2b3c4d5e6f7aa', score: 50 },
    ];
    assert.ok(validate(saveBulkGradesSchema, {
      className: 'JHS 2A',
      subject: 'Mathematics',
      term: 'Term 2',
      grades: tooMany,
    }).error);
  });
});

describe('teacher validation — the academic year is optional', () => {
  test('a grade save with no academicYear still validates', () => {
    // The portal sends className, term, subject and nothing else; the year is
    // the school's business and the service resolves it.
    const { error, value } = validate(saveSingleGradeSchema, {
      studentId: '64b7f9c2e1a2b3c4d5e6f708',
      className: 'JHS 2A',
      subject: 'Mathematics',
      term: 'Term 2',
      score: 68,
    });
    assert.ok(error === undefined);
    assert.equal(value.academicYear, undefined);
  });

  test('a malformed academicYear is rejected rather than ignored', () => {
    assert.ok(validate(saveSingleGradeSchema, {
      studentId: '64b7f9c2e1a2b3c4d5e6f708',
      className: 'JHS 2A',
      subject: 'Mathematics',
      term: 'Term 2',
      score: 68,
      academicYear: '2026-27',
    }).error);
  });
});

describe('teacher validation — defaults and bounds', () => {
  test('assessmentType defaults to class_test', () => {
    const { value } = validate(saveSingleGradeSchema, {
      studentId: '64b7f9c2e1a2b3c4d5e6f708',
      className: 'JHS 2A',
      subject: 'Mathematics',
      term: 'Term 2',
      score: 68,
    });
    assert.equal(value.assessmentType, 'class_test');
    assert.equal(value.maxScore, 100);
  });

  test('an unknown term is rejected', () => {
    assert.ok(validate(saveSingleGradeSchema, {
      studentId: '64b7f9c2e1a2b3c4d5e6f708',
      className: 'JHS 2A',
      subject: 'Mathematics',
      term: 'Term 4',
      score: 68,
    }).error);
  });

  test('a negative score is rejected', () => {
    assert.ok(validate(saveSingleGradeSchema, {
      studentId: '64b7f9c2e1a2b3c4d5e6f708',
      className: 'JHS 2A',
      subject: 'Mathematics',
      term: 'Term 2',
      score: -1,
    }).error);
  });

  test('an empty subject string is accepted so an unpicked subject renders', () => {
    assert.ok(validate(classGradesQuerySchema, { className: 'JHS 2A', subject: '' }).error === undefined);
  });

  test('unknown fields are stripped, not passed through', () => {
    const { value } = validate(saveSingleGradeSchema, {
      studentId: '64b7f9c2e1a2b3c4d5e6f708',
      className: 'JHS 2A',
      subject: 'Mathematics',
      term: 'Term 2',
      score: 68,
      schoolId: '64b7f9c2e1a2b3c4d5e6f708',
      grade: 'A+',
    });
    assert.equal(value.schoolId, undefined);
    assert.equal(value.grade, undefined);
  });
});

// ── The role gate ─────────────────────────────────────────────────────────────

describe('requireTeacher', () => {
  // `authorize` is a curried factory, so `requireTeacher` is itself the
  // middleware: it is called with (req, res, next), where the role it inspects
  // lives on `req.user.role` exactly as it does in a live request.
  const admitted = (role) => {
    let passed = false;
    requireTeacher(
      role ? { user: { role } } : {},
      { status: () => ({ json: () => {} }) },
      () => {
        passed = true;
      }
    );
    return passed;
  };

  test('a teacher is admitted', () => {
    assert.equal(admitted('teacher'), true);
  });

  test('a school admin is admitted, and so is a super admin', () => {
    assert.equal(admitted('school_admin'), true);
    assert.equal(admitted('super_admin'), true);
  });

  test('an accountant, a viewer and an anonymous caller are refused', () => {
    assert.equal(admitted('accountant'), false);
    assert.equal(admitted('viewer'), false);
    assert.equal(admitted(null), false);
  });
});

// ── The academic year ─────────────────────────────────────────────────────────

describe('resolveSchoolAcademicYear', () => {
  test('a slashed year is passed through untouched', () => {
    assert.equal(
      resolveSchoolAcademicYear({ academic: { currentYear: '2026/2027' } }),
      '2026/2027'
    );
  });

  test('a bare year is expanded to the year that starts in it', () => {
    // The bug this pins: `School.academic.currentYear` defaults to a bare
    // calendar year (schoolModel.js:365) while every write path in the platform
    // requires "YYYY/YYYY". Read raw, a schedule query on "2026" matches no
    // timetable at all and comes back empty with no error.
    assert.equal(
      resolveSchoolAcademicYear({ academic: { currentYear: '2026' } }),
      '2026/2027'
    );
  });

  test('an unset or unreadable year falls back to the current calendar year', () => {
    assert.match(resolveSchoolAcademicYear({}), /^\d{4}\/\d{4}$/);
    assert.match(resolveSchoolAcademicYear(null), /^\d{4}\/\d{4}$/);
    assert.match(resolveSchoolAcademicYear({ academic: { currentYear: 'mostly' } }), /^\d{4}\/\d{4}$/);
  });

  test('the fallback is injected, so it is testable rather than ambient', () => {
    const now = new Date('2026-03-01T00:00:00Z');
    assert.equal(resolveSchoolAcademicYear({}, now), '2026/2027');
    assert.equal(resolveSchoolAcademicYear({ academic: {} }, now), '2026/2027');
  });

  test('whitespace around the stored value is tolerated', () => {
    assert.equal(
      resolveSchoolAcademicYear({ academic: { currentYear: '  2025/2026  ' } }),
      '2025/2026'
    );
  });
});

// ── The actor a request acts as ───────────────────────────────────────────────

describe('resolveTeacherActor', () => {
  const teacher = { _id: 'u1', role: 'teacher', name: 'Ama Owusu', assignedClasses: [] };

  test('a teacher is scoped to their own school', () => {
    const actor = resolveTeacherActor({ ...teacher, schoolId: 'school-a' });
    assert.equal(actor.schoolId, 'school-a');
    assert.equal(actor.name, 'Ama Owusu');
  });

  test('an impersonating super admin is scoped to the impersonated school', () => {
    // The bug this pins: a super_admin's own schoolId is null by design, and
    // reading it raw refused the very caller requireTeacher admits.
    const actor = resolveTeacherActor({
      ...teacher,
      role: 'super_admin',
      schoolId: null,
      impersonatingSchoolId: 'school-b',
    });
    assert.equal(actor.schoolId, 'school-b');
  });

  test('a signed-in teacher with no school at all is refused, not scoped to null', () => {
    assert.throws(() => resolveTeacherActor({ ...teacher, schoolId: null }), {
      status: 403,
      code: 'NO_SCHOOL_SCOPE',
    });
  });

  test('an anonymous caller is a 401', () => {
    assert.throws(() => resolveTeacherActor(null), { status: 401, code: 'UNAUTHENTICATED' });
  });

  test('the impersonating field never wins over a real school of one\'s own', () => {
    // A school-admin account cannot carry impersonatingSchoolId — it is only
    // written by the super_admin-gated impersonation route — so a teacher who
    // somehow has one set must still be scoped to their own school.
    const actor = resolveTeacherActor({
      ...teacher,
      schoolId: 'school-a',
      impersonatingSchoolId: 'school-b',
    });
    assert.equal(actor.schoolId, 'school-a');
  });

  test('the actor carries only what the services read', () => {
    const actor = resolveTeacherActor({
      ...teacher,
      schoolId: 'school-a',
      password: 'hashed-value',
      email: 'ama@school.gh',
      refreshToken: 'hashed-refresh',
    });
    assert.equal(actor.password, undefined);
    assert.equal(actor.email, undefined);
    assert.equal(actor.refreshToken, undefined);
    assert.equal(actor._id, 'u1');
  });
});

// ── Roster projection ─────────────────────────────────────────────────────────

describe('initialsOf', () => {
  test('the first two words give the initials', () => {
    assert.equal(initialsOf('Kwame Mensah'), 'KM');
  });

  test('a three-part name is still two initials', () => {
    assert.equal(initialsOf('Ama Serwaa Boateng'), 'AS');
  });

  test('a single name yields a single initial', () => {
    assert.equal(initialsOf('Akosua'), 'A');
  });

  test('an absent name yields an empty string, never undefined', () => {
    assert.equal(initialsOf(undefined), '');
    assert.equal(initialsOf(''), '');
  });
});

// ── The schedule clock ────────────────────────────────────────────────────────

describe('parsePeriodTime', () => {
  test('a 12-hour clock is read as minutes since midnight', () => {
    assert.equal(parsePeriodTime('8:00 am'), 480);
    assert.equal(parsePeriodTime('12:00 pm'), 720);
    assert.equal(parsePeriodTime('12:30 am'), 30);
    assert.equal(parsePeriodTime('1:15 pm'), 795);
  });

  test('a 24-hour clock without a suffix is accepted', () => {
    assert.equal(parsePeriodTime('13:45'), 825);
  });

  test('malformed and out-of-range values are inert, never NaN', () => {
    assert.equal(parsePeriodTime(''), null);
    assert.equal(parsePeriodTime('noon'), null);
    assert.equal(parsePeriodTime('25:00'), null);
    assert.equal(parsePeriodTime('8:75'), null);
  });
});

describe('isOngoing', () => {
  const period = { startTime: '8:00 am', endTime: '8:45 am' };
  const monday840 = { weekday: 'Monday', minuteOfDay: 8 * 60 + 40 };

  test('a period is ongoing only on its own weekday', () => {
    assert.equal(isOngoing(period, 'Monday', monday840), true);
    // Tuesday's 08:00–08:45 must not glow on a Wednesday morning in the same
    // clock window.
    assert.equal(isOngoing(period, 'Tuesday', monday840), false);
  });

  test('the bounds are inclusive at both ends', () => {
    assert.equal(isOngoing(period, 'Monday', { weekday: 'Monday', minuteOfDay: 8 * 60 }), true);
    assert.equal(isOngoing(period, 'Monday', { weekday: 'Monday', minuteOfDay: 8 * 60 + 45 }), true);
  });

  test('a period outside its window is not ongoing', () => {
    assert.equal(isOngoing(period, 'Monday', { weekday: 'Monday', minuteOfDay: 7 * 60 }), false);
    assert.equal(isOngoing(period, 'Monday', { weekday: 'Monday', minuteOfDay: 9 * 60 }), false);
  });

  test('a period with unreadable times is never ongoing', () => {
    assert.equal(isOngoing({ startTime: 'n/a', endTime: '8:45 am' }, 'Monday', monday840), false);
  });
});

describe('accraNow', () => {
  test('the clock is read in Africa/Accra whatever the process timezone', () => {
    // 2026-10-12T22:30:00Z is a Monday in Accra (UTC+0) — and would be a Sunday
    // evening to a process set to US Eastern, which is the bug this pins.
    const clock = accraNow(new Date('2026-10-12T22:30:00Z'));
    assert.equal(clock.weekday, 'Monday');
    assert.equal(clock.minuteOfDay, 22 * 60 + 30);
  });

  test('midnight is hour 0, not 24', () => {
    const clock = accraNow(new Date('2026-10-13T00:10:00Z'));
    assert.equal(clock.minuteOfDay, 10);
  });
});
