// Contract coverage for the headmaster's academic console — the grade approval
// workflow, class and subject-teacher management, the grades-driven report card
// review/publish pipeline, timetables, and the oversight dashboard.
//
// Pure unit tests: no database, no network, no live server — the same constraint
// every suite in this directory works under, and the reason these assert
// *contracts* rather than round trips. The services' risk is in the authorisation
// and the state transitions (who may move a mark from `submitted` to `approved`,
// and that only `approved` grades ever reach a card a parent can see), and the
// layer that is checkable without a running Mongo is exactly the layer those
// guarantees rest on: the model enums and indexes, the validation shapes, the
// pre-query guards that throw before any DB call, the role gate, and the audit
// vocabulary. The round trips need a real integration run.
//
// Why a suite like this exists for this module specifically: the whole review
// layer exists so a parent can never read an unsigned mark, and that invariant
// is set by a model default (`approvalStatus: 'draft'`) and a status enum
// (`review` between `draft` and `published`). Both are one keystroke from a
// regression, and neither throws when broken — a card would simply publish
// straight out of `draft`. Those are pinned here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Grade } from '../src/models/Grade.js';
import { ReportCard } from '../src/models/ReportCard.js';
import { AUDIT_ACTIONS as CONSTANTS_ACTIONS, AUDIT_ACTION_VALUES } from '../src/config/constants.js';
import { AUDIT_ACTIONS as SCHEMA_ACTIONS } from '../src/models/AuditLog.js';
import { requireTeacher, requireSchoolAdmin } from '../src/middleware/roles.js';
import { adminAcademicRoute } from '../src/routes/admin.academic.routes.js';
import {
  GRADE_STATUSES,
  submitClassGrades,
  approveClassGrades,
  rejectClassGrades,
  reopenRejectedGrades,
} from '../src/services/admin/gradeApproval.service.js';
import { generateReportCardPdf, uploadReportCardPdf } from '../src/services/admin/reportCardPdf.service.js';

import {
  submitGradesSchema,
  approveGradesSchema,
  rejectGradesSchema,
  reopenGradesSchema,
  createClassSchema,
  classNameParamSchema,
  assignClassTeacherSchema,
  assignSubjectTeacherSchema,
  subjectTeacherParamsSchema,
  compileReportsSchema,
  setHeadRemarkSchema,
  publishReportsSchema,
  overviewQuerySchema,
  timetableQuerySchema,
  publishTimetableSchema,
  saveTimetableSchema,
} from '../src/validations/admin.academic.validation.js';

const validate = (schema, payload) =>
  schema.validate(payload, { abortEarly: false, stripUnknown: true, convert: true });

const ID = '507f1f77bcf86cd799439011';
const scope = { term: 'Term 2', academicYear: '2026/2027' };

// ── Model contracts ─────────────────────────────────────────────────────────
//
// The load-bearing defaults and enums of the review layer. A regression here
// does not throw; it just quietly lets an unsigned mark or an unpublished card
// through, which is the exact failure the module exists to prevent.

describe('Grade — approval workflow shape', () => {
  test('approvalStatus carries the four states', () => {
    assert.deepEqual(
      Grade.schema.path('approvalStatus').enumValues,
      ['draft', 'submitted', 'approved', 'rejected']
    );
  });

  test('a freshly recorded grade lands in draft, unsigned', () => {
    // The one default the whole workflow leans on: a teacher-entered mark is a
    // claim until approved, and every path that reads approved grades depends on
    // it starting here.
    assert.equal(Grade.schema.path('approvalStatus').defaultValue, 'draft');
  });

  test('the review queue index exists', () => {
    const hasQueueIndex = Grade.schema.indexes().some(([keys]) => {
      const k = keys;
      return k.schoolId === 1 && k.approvalStatus === 1 && k.term === 1;
    });
    assert.ok(hasQueueIndex, 'Grade is missing the { schoolId, approvalStatus, term } index');
  });

  test('the workflow stamps and the rejection reason are on the schema', () => {
    for (const field of ['submittedAt', 'approvedAt', 'rejectedAt', 'rejectionReason']) {
      assert.ok(Grade.schema.path(field), `Grade.${field} is missing`);
    }
    assert.equal(Grade.schema.path('rejectionReason').options.maxlength, 500);
  });
});

describe('ReportCard — review sits between draft and published', () => {
  test('status carries draft, review, published and archived', () => {
    assert.deepEqual(
      ReportCard.schema.path('status').enumValues,
      ['draft', 'review', 'published', 'archived']
    );
  });

  test('a new card defaults to draft, not published', () => {
    assert.equal(ReportCard.schema.path('status').defaultValue, 'draft');
  });

  test('the status-change trail exists and points at a User', () => {
    assert.ok(ReportCard.schema.path('statusChangedAt'));
    assert.equal(ReportCard.schema.path('statusChangedBy').options.ref, 'User');
  });

  test('the parent-facing fields survive (pdf is still optional)', () => {
    // The review layer added `pdfUrl` population; these were always here and a
    // refactor that drops them breaks the parent portal silently. `headRemark`
    // and `teacherRemark` are nested ({ text, author }), so they live on
    // `schema.paths` under a dotted key rather than as a top-level path.
    const paths = ReportCard.schema.paths;
    assert.ok(paths.pdfUrl, 'ReportCard.pdfUrl is missing');
    assert.ok(paths.pdfPublicId, 'ReportCard.pdfPublicId is missing');
    assert.ok(paths['headRemark.text'], 'ReportCard.headRemark.text is missing');
    assert.ok(paths['teacherRemark.text'], 'ReportCard.teacherRemark.text is missing');
  });
});

// ── Audit-action parity (both lists must agree, contract test) ───────────────

describe('academic console audit actions stay in step', () => {
  const expected = {
    GRADE_SUBMIT: 'grade.submit',
    GRADE_APPROVE: 'grade.approve',
    GRADE_REJECT: 'grade.reject',
    GRADE_REOPEN: 'grade.reopen',
    CLASS_CREATE: 'class.create',
    CLASS_ARCHIVE: 'class.archive',
    CLASS_ASSIGN_TEACHER: 'class.assign_teacher',
    CLASS_ASSIGN_SUBJECT_TEACHER: 'class.assign_subject_teacher',
    CLASS_UNASSIGN_SUBJECT_TEACHER: 'class.unassign_subject_teacher',
    REPORT_CARD_HEAD_REMARK: 'report_card.head_remark',
    REPORT_CARD_UNPUBLISH: 'report_card.unpublish',
    TIMETABLE_PUBLISH: 'timetable.publish',
  };

  test('every new action is in the schema enum and the constants map', () => {
    for (const [key, action] of Object.entries(expected)) {
      assert.ok(SCHEMA_ACTIONS.includes(action), `AuditLog schema missing ${action}`);
      assert.equal(CONSTANTS_ACTIONS[key], action, `constants map missing ${key}`);
      assert.ok(AUDIT_ACTION_VALUES.includes(action), `AUDIT_ACTION_VALUES missing ${action}`);
    }
  });

  test('reused actions stay put — compile, publish, timetable.upsert', () => {
    // The grades-driven pipeline reuses `report_card.compile` / `.publish` and
    // `timetable.upsert`; renaming them would break the earlier admin console.
    assert.equal(CONSTANTS_ACTIONS.REPORT_CARD_COMPILE, 'report_card.compile');
    assert.equal(CONSTANTS_ACTIONS.REPORT_CARD_PUBLISH, 'report_card.publish');
    assert.equal(CONSTANTS_ACTIONS.TIMETABLE_UPSERT, 'timetable.upsert');
  });
});

// ── Role gate ───────────────────────────────────────────────────────────────

describe('requireSchoolAdmin — the disclosure and governance boundary', () => {
  const run = (middleware, role) => {
    const req = role === null ? {} : { user: { role } };
    let nexted = false;
    let status = null;
    const res = {
      status(code) { status = code; return this; },
      json() { return this; },
    };
    middleware(req, res, () => { nexted = true; });
    return nexted ? { passed: true } : { passed: false, status };
  };

  test('a school_admin (headmaster) and a super_admin pass', () => {
    assert.equal(run(requireSchoolAdmin, 'school_admin').passed, true);
    assert.equal(run(requireSchoolAdmin, 'super_admin').passed, true);
  });

  test('a teacher is refused 403 — the head signs, the teacher marks', () => {
    const r = run(requireSchoolAdmin, 'teacher');
    assert.equal(r.passed, false);
    assert.equal(r.status, 403);
  });

  test('an accountant and a viewer are refused 403', () => {
    assert.equal(run(requireSchoolAdmin, 'accountant').passed, false);
    assert.equal(run(requireSchoolAdmin, 'viewer').passed, false);
  });

  test('no user on the request is a 401, not a 403', () => {
    const r = run(requireSchoolAdmin, null);
    assert.equal(r.passed, false);
    assert.equal(r.status, 401);
  });

  test('requireTeacher still admits a teacher (submit/reopen is theirs)', () => {
    // The complement: submit and reopen are gated on requireTeacher, so a
    // teacher who submits a class must not be blocked by the admin gate.
    assert.equal(run(requireTeacher, 'teacher').passed, true);
    assert.equal(run(requireTeacher, 'school_admin').passed, true);
  });
});

// ── Service guards that throw before any DB call ────────────────────────────
//
// These run without a database because the guards are the first statement, ahead
// of every `updateMany`/`aggregate`. They pin the ApiError contract the
// controllers rely on (status + code) and the "reason is mandatory" rule.

describe('grade workflow — validation guards', () => {
  test('submit without term or academicYear is a 400 VALIDATION_ERROR', async () => {
    await assert.rejects(
      submitClassGrades('schoolid', 'userid', { className: 'JHS 2A' }),
      (e) => e.status === 400 && e.code === 'VALIDATION_ERROR'
    );
  });

  test('submit without a class name is rejected too', async () => {
    await assert.rejects(
      submitClassGrades('schoolid', 'userid', { ...scope }),
      (e) => e.status === 400
    );
  });

  test('approve without a term is a 400', async () => {
    await assert.rejects(
      approveClassGrades('schoolid', 'userid', { academicYear: '2026/2027' }),
      (e) => e.status === 400 && e.code === 'VALIDATION_ERROR'
    );
  });

  test('reject needs a real reason — a blank or three-word one is refused', async () => {
    // A rejection that tells the teacher nothing is worse than none. The reason
    // is bounded below so it can't be an empty label.
    await assert.rejects(
      rejectClassGrades('schoolid', 'userid', { ...scope, reason: 'no' }),
      (e) => e.status === 400 && e.code === 'REASON_REQUIRED'
    );
    await assert.rejects(
      rejectClassGrades('schoolid', 'userid', { ...scope }),
      (e) => e.status === 400 && e.code === 'REASON_REQUIRED'
    );
  });

  test('reopen without a term is a 400', async () => {
    await assert.rejects(
      reopenRejectedGrades('schoolid', 'userid', { className: 'JHS 2A' }),
      (e) => e.status === 400
    );
  });

  test('the documented lifecycle is exactly the four states', () => {
    // Exported as data so the UI stepper and the workflow cannot drift.
    assert.deepEqual(GRADE_STATUSES, ['draft', 'submitted', 'approved', 'rejected']);
  });
});

// ── Report card PDF (pure buffer path) ──────────────────────────────────────

describe('report card PDF — the artefact the parent downloads', () => {
  test('a full card renders to a PDF buffer', async () => {
    const card = {
      term: 'Term 2',
      academicYear: '2026/2027',
      className: 'JHS 2A',
      average: 74,
      grade: 'A-',
      position: 3,
      classSize: 30,
      subjects: [{ subject: 'Mathematics', score: 80, maxScore: 100, grade: 'A' }],
      teacherRemark: { text: 'Good term.', author: 'Mr. Owusu' },
      headRemark: { text: 'Keep it up.', author: 'Head' },
      conduct: 'Good',
      attendance: { present: 38, total: 40 },
    };
    const buf = await generateReportCardPdf(card, {
      school: { name: 'Accra JHS' },
      student: { studentName: 'Ama Mensah', studentId: 'PBS-2026-0001' },
    });
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 0);
    assert.equal(buf.subarray(0, 4).toString(), '%PDF', 'not a PDF');
  });

  test('a half-empty card still renders — never throws a 500 on a mid-term draft', async () => {
    // No subjects, no remarks, no attendance is a normal mid-term state. The
    // generator must produce a page, not crash the publish.
    const buf = await generateReportCardPdf(
      { term: 'Term 1', academicYear: '2025/2026', className: 'JHS 1A', subjects: [] },
      { school: {}, student: {} }
    );
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.subarray(0, 4).toString(), '%PDF');
  });

  test('an empty buffer is refused before any Cloudinary call', async () => {
    // The upload guards on emptiness first, so this holds whether or not
    // Cloudinary is configured in the environment.
    await assert.rejects(
      uploadReportCardPdf(Buffer.alloc(0), {}),
      /empty/
    );
  });
});

// ── Route wiring (paths are registered under /admin) ────────────────────────

describe('admin academic routes are wired', () => {
  const paths = adminAcademicRoute.stack
    .map((layer) => (layer.route ? layer.route.path : null))
    .filter(Boolean);
  const has = (needle) => paths.some((p) => p.includes(needle));

  test('the grade approval endpoints exist', () => {
    for (const needle of [
      '/grades/approval-queue',
      '/grades/submit',
      '/grades/approve',
      '/grades/reject',
      '/grades/reopen',
    ]) {
      assert.ok(has(needle), `missing route containing ${needle}`);
    }
  });

  test('the report review endpoints exist', () => {
    for (const needle of ['/reports/review-queue', '/reports/compile', '/reports/head-remark', '/reports/publish', '/reports/unpublish']) {
      assert.ok(has(needle), `missing route containing ${needle}`);
    }
  });

  test('classes, timetables and the overview are present', () => {
    for (const needle of ['/academic/overview', '/classes', '/classes/:className/teacher', '/classes/:className/subject-teacher/:subject', '/timetables', '/timetables/publish', '/timetables/:className']) {
      assert.ok(has(needle), `missing route containing ${needle}`);
    }
  });
});

// ── Validation schemas ──────────────────────────────────────────────────────

describe('grade approval validation', () => {
  test('submit requires className, term and academicYear', () => {
    assert.equal(validate(submitGradesSchema, { className: 'JHS 2A', ...scope }).error, undefined);
    assert.ok(validate(submitGradesSchema, { ...scope }).error);
    assert.ok(validate(submitGradesSchema, { className: 'JHS 2A', term: 'Term 2' }).error);
  });

  test('the academic year must be YYYY/YYYY, not a bare year', () => {
    assert.ok(validate(submitGradesSchema, { className: 'JHS 2A', term: 'Term 2', academicYear: '2026' }).error);
    assert.ok(validate(submitGradesSchema, { className: 'JHS 2A', term: 'Term 2', academicYear: '2026/27' }).error);
  });

  test('subject is optional on submit (submit the whole class)', () => {
    const { value } = validate(submitGradesSchema, { className: 'JHS 2A', ...scope, junk: 1 });
    assert.equal(value.subject, undefined);
    assert.equal(value.junk, undefined); // stripUnknown
  });

  test('approve allows no class (whole school) but still needs term + year', () => {
    assert.equal(validate(approveGradesSchema, { ...scope }).error, undefined);
    assert.ok(validate(approveGradesSchema, { className: 'JHS 2A', term: 'Term 2' }).error);
  });

  test('approve ids are checked against the ObjectId shape', () => {
    assert.equal(validate(approveGradesSchema, { ...scope, ids: [ID, ID] }).error, undefined);
    assert.ok(validate(approveGradesSchema, { ...scope, ids: ['not-an-id'] }).error);
  });

  test('reject carries the reason, and five characters is the floor', () => {
    assert.equal(validate(rejectGradesSchema, { className: 'JHS 2A', ...scope, reason: 'Recheck marks' }).error, undefined);
    assert.ok(validate(rejectGradesSchema, { ...scope, reason: 'no' }).error);
    assert.ok(validate(rejectGradesSchema, { ...scope }).error);
  });

  test('reopen is submit-shaped', () => {
    assert.equal(reopenGradesSchema, submitGradesSchema);
  });
});

describe('class management validation', () => {
  test('create takes only the name (no Class-document fields)', () => {
    const { value, error } = validate(createClassSchema, { className: 'JHS 2A', room: '5', capacity: 40 });
    assert.equal(error, undefined);
    assert.deepEqual(value, { className: 'JHS 2A' }); // room/capacity stripped — there is no Class doc
  });

  test('a one-character name is refused', () => {
    assert.ok(validate(createClassSchema, { className: 'A' }).error);
  });

  test('a class is addressed by name in the path', () => {
    assert.equal(validate(classNameParamSchema, { className: 'JHS 2A' }).error, undefined);
    assert.ok(validate(classNameParamSchema, { className: 'x' }).error);
  });

  test('teacher assignments require an ObjectId teacher', () => {
    assert.equal(validate(assignClassTeacherSchema, { teacherId: ID }).error, undefined);
    assert.ok(validate(assignClassTeacherSchema, { teacherId: 'nope' }).error);
  });

  test('a subject-teacher assignment needs both a subject and a teacher', () => {
    assert.equal(validate(assignSubjectTeacherSchema, { subject: 'Mathematics', teacherId: ID }).error, undefined);
    assert.ok(validate(assignSubjectTeacherSchema, { teacherId: ID }).error);
    assert.ok(validate(assignSubjectTeacherSchema, { subject: 'Mathematics' }).error);
  });

  test('the unassignment path carries both class and subject', () => {
    assert.equal(validate(subjectTeacherParamsSchema, { className: 'JHS 2A', subject: 'Mathematics' }).error, undefined);
    assert.ok(validate(subjectTeacherParamsSchema, { className: 'JHS 2A' }).error);
  });
});

describe('report review validation', () => {
  test('compile and publish need the three keys', () => {
    assert.equal(validate(compileReportsSchema, { className: 'JHS 2A', ...scope }).error, undefined);
    assert.equal(validate(publishReportsSchema, { className: 'JHS 2A', ...scope }).error, undefined);
    assert.ok(validate(compileReportsSchema, { ...scope }).error);
  });

  test('the head remark needs real text; the author is optional', () => {
    assert.equal(validate(setHeadRemarkSchema, { className: 'JHS 2A', ...scope, text: 'Well done.' }).error, undefined);
    assert.ok(validate(setHeadRemarkSchema, { className: 'JHS 2A', ...scope, text: 'no' }).error);
    assert.ok(validate(setHeadRemarkSchema, { className: 'JHS 2A', ...scope }).error);
  });
});

describe('timetable and overview validation', () => {
  test('the console save fills every weekday, dropping only none', () => {
    const { value, error } = validate(saveTimetableSchema, {
      className: 'JHS 2A',
      ...scope,
      days: { Monday: [{ period: 1, startTime: '8:00 am', endTime: '8:45 am', subject: 'Maths' }] },
    });
    assert.equal(error, undefined);
    assert.deepEqual(Object.keys(value.days).sort(), ['Friday', 'Monday', 'Thursday', 'Tuesday', 'Wednesday']);
    assert.deepEqual(value.days.Friday, []);
  });

  test('publish needs the three keys', () => {
    assert.equal(validate(publishTimetableSchema, { className: 'JHS 2A', ...scope }).error, undefined);
    assert.ok(validate(publishTimetableSchema, { className: 'JHS 2A', term: 'Term 2' }).error);
  });

  test('the overview query is optional and scoped to known terms', () => {
    assert.equal(validate(overviewQuerySchema, {}).error, undefined);
    assert.equal(validate(overviewQuerySchema, { term: 'Term 2', academicYear: '2026/2027' }).error, undefined);
    assert.ok(validate(overviewQuerySchema, { term: 'Term 4' }).error);
  });

  test('the timetable query only accepts draft or published status', () => {
    assert.equal(validate(timetableQuerySchema, { status: 'published' }).error, undefined);
    assert.ok(validate(timetableQuerySchema, { status: 'archived' }).error);
  });
});
