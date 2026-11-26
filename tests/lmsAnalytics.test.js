// Coverage for the LMS analytics aggregation (Growth plan).
//
// Pure unit test — no database, no network. The Mongoose models are singletons
// the service holds direct references to, so the stubs are installed on the
// model objects before the service module is imported (the pattern used by
// adminAnalytics.test.js). `find`/`countDocuments` apply the real filter with a
// small Mongo matcher, so visibility ($and/$or), campus scoping, the published
// status and the graded+released rule are exercised for real rather than
// assumed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal Mongo-filter matcher ────────────────────────────────────────────
// Supports exactly the operators the service emits: $and, $or, $in, $ne, $gte,
// $lte, null equality and plain equality (string-compared so ObjectId-shaped
// strings match).
const getPath = (doc, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), doc);

const matchOp = (val, op) => {
  if (op !== null && typeof op === 'object' && !Array.isArray(op)) {
    for (const [k, cond] of Object.entries(op)) {
      if (k === '$in') {
        if (!cond.some((c) => String(c) === String(val))) return false;
      } else if (k === '$ne') {
        if (String(val) === String(cond)) return false;
      } else if (k === '$gte') {
        if (!(val != null && new Date(val) >= new Date(cond))) return false;
      } else if (k === '$lte') {
        if (!(val != null && new Date(val) <= new Date(cond))) return false;
      } else {
        return false;
      }
    }
    return true;
  }
  return String(val) === String(op);
};

const matches = (doc, filter) => {
  for (const [key, cond] of Object.entries(filter || {})) {
    if (key === '$and') {
      if (!cond.every((f) => matches(doc, f))) return false;
    } else if (key === '$or') {
      if (!cond.some((f) => matches(doc, f))) return false;
    } else if (cond === null) {
      const val = getPath(doc, key);
      if (val !== null && val !== undefined) return false;
    } else if (!matchOp(getPath(doc, key), cond)) {
      return false;
    }
  }
  return true;
};

// ── Stub the models before the service imports them ─────────────────────────
const chainable = (rows) => {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    skip: () => chain,
    lean: () => Promise.resolve(rows),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
};

const { Assessment, Submission } = await import('../src/models/LMS.js');
const { Student } = await import('../src/models/studentModel.js');
const { School } = await import('../src/models/schoolModel.js');
const { TeacherAssignment } = await import('../src/models/TeacherAssignment.js');

// Valid 24-hex ObjectIds — loadTeacherScope builds `new ObjectId(schoolId)`
// before querying, so the ids must be castable.
const oid = (n) => n.toString(16).padStart(24, '0');

const SCHOOL_ID = oid(1);
const CAMPUS_A = oid(2);
const CAMPUS_B = oid(3);
const A1 = oid(11);
const A2 = oid(12);
const A3 = oid(13);

// Each test sets these; the stubs read them live.
let assessmentRows = [];
let submissionRows = [];
let studentRows = [];
let schoolDoc = {
  academic: { classes: ['JHS 2A'], currentTerm: '', currentYear: '2026/2027', terms: [] },
};

Assessment.find = (filter) => Promise.resolve(assessmentRows.filter((a) => matches(a, filter)));
Submission.find = (filter) => Promise.resolve(submissionRows.filter((s) => matches(s, filter)));
Student.countDocuments = (filter) =>
  Promise.resolve(studentRows.filter((s) => matches(s, filter)).length);
Student.aggregate = () => Promise.resolve([]);
School.findById = () => chainable(schoolDoc);
TeacherAssignment.find = () => chainable([]);

const lms = await import('../src/services/lms.service.js');

const adminUser = { _id: oid(100), role: 'school_admin', schoolId: SCHOOL_ID, assignedClasses: [] };

const run = (overrides = {}) =>
  lms.getLmsAnalytics({
    schoolId: SCHOOL_ID,
    teacherId: oid(100),
    isAdmin: true,
    campusId: null,
    className: undefined,
    subject: undefined,
    term: undefined,
    academicYear: undefined,
    user: adminUser,
    ...overrides,
  });

const reset = () => {
  assessmentRows = [];
  submissionRows = [];
  studentRows = [];
  schoolDoc = {
    academic: { classes: ['JHS 2A'], currentTerm: '', currentYear: '2026/2027', terms: [] },
  };
};

// A published assessment with a single question worth `points`.
const assessment = (id, points, extra = {}) => ({
  _id: id,
  schoolId: SCHOOL_ID,
  status: 'published',
  className: 'JHS 2A',
  subject: 'Mathematics',
  sharingScope: 'school',
  campusId: null,
  title: `Assessment ${id}`,
  questions: [{ type: 'multiple_choice', points }],
  createdAt: new Date('2026-09-10T00:00:00Z'),
  ...extra,
});

const submission = (id, assessmentId, totalScore, extra = {}) => ({
  _id: id,
  schoolId: SCHOOL_ID,
  assessmentId,
  studentId: `student-${id}`,
  status: 'graded',
  resultsReleased: true,
  totalScore,
  campusId: null,
  sharingScope: 'school',
  ...extra,
});

const student = (id, extra = {}) => ({
  _id: id,
  schoolId: SCHOOL_ID,
  studentClass: 'JHS 2A',
  deletedAt: null,
  status: 'active',
  ...extra,
});

// ── The scored set: graded + released only ──────────────────────────────────

describe('getLmsAnalytics — graded+released only', () => {
  test('an unreleased (resultsReleased:false) submission is excluded from the average', () => {
    reset();
    assessmentRows = [assessment(A1, 100)];
    studentRows = [student(oid(201)), student(oid(202))];
    submissionRows = [
      submission(oid(301), A1, 90, { resultsReleased: true, status: 'graded' }),
      // High score but unreleased — must not move the average.
      submission(oid(302), A1, 100, { resultsReleased: false, status: 'graded' }),
    ];

    return run().then((r) => {
      assert.equal(r.gradedSubmissions, 1);
      assert.equal(r.classAverageScore, 90);
      assert.equal(r.perAssessment[0].graded, 1);
      assert.equal(r.perAssessment[0].averageScore, 90);
    });
  });

  test('an in_progress submission is excluded entirely', () => {
    reset();
    assessmentRows = [assessment(A1, 100)];
    studentRows = [student(oid(201))];
    submissionRows = [
      submission(oid(301), A1, 80, { resultsReleased: true, status: 'graded' }),
      submission(oid(302), A1, 0, { status: 'in_progress', resultsReleased: false }),
    ];

    return run().then((r) => {
      assert.equal(r.gradedSubmissions, 1);
      assert.equal(r.classAverageScore, 80);
    });
  });

  test('class average is the mean of totalScore/points across graded+released', () => {
    reset();
    assessmentRows = [assessment(A1, 50), assessment(A2, 100)];
    studentRows = [student(oid(201))];
    submissionRows = [
      submission(oid(301), A1, 25, { resultsReleased: true }), // 50%
      submission(oid(302), A2, 90, { resultsReleased: true }), // 90%
    ];

    return run().then((r) => {
      // (50 + 90) / 2 = 70
      assert.equal(r.classAverageScore, 70);
      assert.equal(r.gradedSubmissions, 2);
    });
  });

  test('passRate and distribution use the grade-band pass mark (65)', () => {
    reset();
    assessmentRows = [assessment(A1, 100)];
    studentRows = [student(oid(201)), student(oid(202)), student(oid(203))];
    submissionRows = [
      submission(oid(301), A1, 64, { resultsReleased: true }), // F, below 65
      submission(oid(302), A1, 65, { resultsReleased: true }), // B, pass
      submission(oid(303), A1, 82, { resultsReleased: true }), // A, pass
    ];

    return run().then((r) => {
      assert.equal(r.passThreshold, 65);
      assert.equal(r.passRate, 0.6667); // 2 of 3
      const dist = Object.fromEntries(r.scoreDistribution.map((b) => [b.grade, b.count]));
      assert.equal(dist.F, 1);
      assert.equal(dist.B, 1);
      assert.equal(dist.A, 1);
    });
  });
});

// ── Campus visibility ───────────────────────────────────────────────────────

describe('getLmsAnalytics — campus filter applied', () => {
  test('a campus request excludes other campuses’ assessments and submissions', () => {
    reset();
    assessmentRows = [
      assessment(A1, 100, { campusId: CAMPUS_A, sharingScope: 'campus', title: 'A1' }),
      assessment(A2, 100, { campusId: CAMPUS_B, sharingScope: 'campus', title: 'A2' }),
      assessment(A3, 100, { campusId: null, sharingScope: 'school', title: 'A3' }), // school-wide
    ];
    studentRows = [student(oid(201), { campusId: CAMPUS_A }), student(oid(202), { campusId: CAMPUS_B })];
    submissionRows = [
      submission(oid(301), A1, 70, { campusId: CAMPUS_A }),
      submission(oid(302), A2, 40, { campusId: CAMPUS_B }), // other campus — excluded
      submission(oid(303), A3, 90, { campusId: null }),
    ];

    return run({ campusId: CAMPUS_A }).then((r) => {
      // A1 (campus A) + A3 (school-wide) are in scope; A2 (campus B) is not.
      assert.equal(r.assessmentsPublished, 2);
      // Only campus-A and school-wide submissions counted.
      assert.equal(r.gradedSubmissions, 2);
      // (70 + 90) / 2 = 80
      assert.equal(r.classAverageScore, 80);
      // Only the campus-A student is in the roster.
      assert.equal(r.studentCount, 1);
      const titles = r.perAssessment.map((p) => p.title).sort();
      assert.deepEqual(titles, ['A1', 'A3']);
    });
  });

  test('a school-wide request (no campus) sees school-wide items, not campus-scoped ones', () => {
    reset();
    // buildVisibilityFilter(null) shows school-wide / non-campus rows only; a
    // campus-scoped item is visible only when its campus is the one asked for.
    assessmentRows = [
      assessment(A1, 100, { campusId: CAMPUS_A, sharingScope: 'campus' }),
      assessment(A3, 100, { campusId: null, sharingScope: 'school' }),
    ];
    studentRows = [student(oid(201), { campusId: CAMPUS_A }), student(oid(202), { campusId: CAMPUS_B })];
    submissionRows = [
      submission(oid(301), A1, 70, { campusId: CAMPUS_A }),
      submission(oid(303), A3, 90, { campusId: null }),
    ];

    return run().then((r) => {
      assert.equal(r.assessmentsPublished, 1); // only the school-wide A3
      assert.equal(r.gradedSubmissions, 1);
      assert.equal(r.classAverageScore, 90);
    });
  });
});

// ── Empty scope ─────────────────────────────────────────────────────────────

describe('getLmsAnalytics — empty class yields zeros, not errors', () => {
  test('a class with no assessments returns zeroed metrics', () => {
    reset();
    assessmentRows = [];
    studentRows = [student(oid(201))];

    return run().then((r) => {
      assert.equal(r.assessmentsPublished, 0);
      assert.equal(r.gradedSubmissions, 0);
      assert.equal(r.classAverageScore, 0);
      assert.equal(r.passRate, 0);
      assert.equal(r.completionRate, 0);
      assert.deepEqual(r.perAssessment, []);
      assert.equal(r.scoreDistribution.length, 5);
      assert.ok(r.scoreDistribution.every((b) => b.count === 0));
    });
  });

  test('a teacher with no classes in scope returns zeros', () => {
    reset();
    // School has JHS 2A, but the teacher is assigned to nothing that exists.
    const user = { _id: oid(101), role: 'teacher', schoolId: SCHOOL_ID, assignedClasses: [] };

    return run({ user, teacherId: oid(101), isAdmin: false }).then((r) => {
      assert.equal(r.studentCount, 0);
      assert.equal(r.assessmentsPublished, 0);
      assert.equal(r.completionRate, 0);
    });
  });

  test('completionRate is graded / (students × assessments)', () => {
    reset();
    assessmentRows = [assessment(A1, 100), assessment(A2, 100)];
    studentRows = [student(oid(201)), student(oid(202))];
    // 2 graded of 4 expected (2 students × 2 assessments) = 0.5
    submissionRows = [
      submission(oid(301), A1, 70, { resultsReleased: true }),
      submission(oid(302), A2, 80, { resultsReleased: true }),
    ];

    return run().then((r) => {
      assert.equal(r.studentCount, 2);
      assert.equal(r.assessmentsPublished, 2);
      assert.equal(r.completionRate, 0.5);
      assert.equal(r.totalSubmissions, 2);
    });
  });
});