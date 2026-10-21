import { Grade } from "../../models/Grade.js";
import { Student } from "../../models/studentModel.js";
import { loadTeacherScope, loadStudentScope } from "../../utils/teacherScope.js";
import { resolveTerm } from "../parent/portalContext.js";
import {
  gradeForScore,
  calculateTotalScore,
  CLASS_SCORE_MAX,
  EXAM_SCORE_MAX,
} from "../../utils/gradeBands.js";
import {
  buildSubjectResults,
  assignSubjectPositions,
} from "../../utils/subjectResults.js";
import { initialsOf } from "./classes.service.js";
import { log as auditLog } from "../../utils/auditService.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import { resolveSchoolAcademicYear } from "../../utils/termDates.js";
import ApiError from "../../utils/ApiError.js";

/**
 * The two halves of a Ghanaian terminal report row.
 *
 * A subject is two marks on a Ghanaian report card: the **class score**
 * (continuous assessment, out of 50) and the **exam score** (out of 100).
 * The teacher enters both; the total, the grade and the subject position are
 * the server's arithmetic.
 */
export const ASSESSMENT_TYPES = ["class_score", "exam_score"];

/** The mark each assessment type is recorded against unless the school says otherwise. */
const DEFAULT_MAX_SCORE = {
  class_score: CLASS_SCORE_MAX,
  exam_score: EXAM_SCORE_MAX,
};

/** The widest a school may widen a mark, so a stray `maxScore: 100000` is refused. */
const MAX_ALLOWED_SCORE = 200;

/**
 * `GET /teacher/grades?className=JHS 2A&term=Term 2&subject=Mathematics`
 *
 * The class's grade book for one subject, formatted so the bulk entry grid
 * renders every student and their two marks in one pass.
 *
 * Every student in the class appears, including those with no score yet, and a
 * student with no score reads `classScore: null` rather than being omitted.
 * That is the whole point: a grid that reflows as marks are entered loses a
 * teacher's place mid-entry, and a missing row reads as "this student is not
 * in the class" when what it means is "this student has not been assessed".
 *
 * The total and grade are computed here as well as at compile time, so the
 * teacher sees the same number the report card will carry while they are
 * still typing rather than after the headmaster has approved.
 */
export const getClassGrades = async (user, { className, term, subject, academicYear }) => {
  if (!className) {
    throw new ApiError("className is required", 400, "VALIDATION_ERROR");
  }

  const { school, classes } = await loadTeacherScope(user, user.schoolId);
  if (!classes.some((entry) => entry.className === className)) {
    throw new ApiError("You are not assigned to this class", 403, "FORBIDDEN_SCOPE");
  }

  const students = await Student.find({
    schoolId: user.schoolId,
    studentClass: className,
    deletedAt: null,
    status: "active",
  })
    .select("_id studentId studentName")
    .sort({ studentName: 1 })
    .lean();

  // An absent subject is a legitimate read — the grid is rendered before the
  // teacher has picked one — and it returns the roster with no scores rather
  // than an error, so the page never has a "pick a subject" failure state.
  const resolvedTerm = resolveTerm(term, school);
  const resolvedYear = academicYear || resolveSchoolAcademicYear(school);

  const filter = {
    schoolId: user.schoolId,
    studentId: { $in: students.map((s) => s._id) },
    term: resolvedTerm,
    academicYear: resolvedYear,
    deletedAt: null,
  };
  if (subject) filter.subject = subject;

  // Without a subject there is no column to read, and the contract is the
  // roster with no scores — the grid is rendered before the teacher has picked
  // one. Reading every subject and folding them into one row per student
  // returned one *arbitrary* subject's marks (the last row the query happened
  // to produce), and the teacher then overwrote that subject's numbers with
  // the subject they had actually picked.
  const grades = subject
    ? await Grade.find(filter)
        .select("studentId subject score maxScore assessmentType")
        .lean()
    : [];

  // student ─▶ assessmentType. One row per half of the subject, keyed so the
  // pair can be read back together.
  const byStudent = new Map();
  for (const g of grades) {
    const key = String(g.studentId);
    const bucket = byStudent.get(key) || {};
    bucket[g.assessmentType] = g;
    byStudent.set(key, bucket);
  }

  // Where each student came in this subject — the same competition ranking the
  // report card carries, computed from the same two halves, so the teacher
  // reads the number the card will print before anything is approved.
  const resultsByStudent = new Map();
  for (const [key, bucket] of byStudent) {
    resultsByStudent.set(
      key,
      buildSubjectResults([
        ...(bucket.class_score ? [bucket.class_score] : []),
        ...(bucket.exam_score ? [bucket.exam_score] : []),
      ])
    );
  }
  const positions = assignSubjectPositions(resultsByStudent);

  return {
    className,
    term: resolvedTerm,
    academicYear: resolvedYear,
    subject: subject || null,
    // The two marks a Ghanaian terminal report is built from. They are the
    // report's own maxima, not a school's discretion: the class score is out
    // of 50 and the exam out of 100.
    maxClassScore: CLASS_SCORE_MAX,
    maxExamScore: EXAM_SCORE_MAX,
    students: students.map((s) => {
      const bucket = byStudent.get(String(s._id)) || {};
      const classRow = bucket.class_score;
      const examRow = bucket.exam_score;

      const classScore = classRow ? classRow.score : null;
      const examScore = examRow ? examRow.score : null;
      const complete = classRow != null && examRow != null;

      const { totalScore, grade, meaning } = complete
        ? calculateTotalScore(
            classScore,
            classRow.maxScore || CLASS_SCORE_MAX,
            examScore,
            examRow.maxScore || EXAM_SCORE_MAX
          )
        : { totalScore: null, grade: null, meaning: null };

      const positionsForStudent = positions.get(String(s._id)) || new Map();

      return {
        _id: s._id,
        studentId: s.studentId,
        studentName: s.studentName,
        initials: initialsOf(s.studentName),
        classScore,
        examScore,
        totalScore,
        grade,
        meaning,
        // Whether the pair is complete enough to be banded. The grid shows a
        // dash rather than a grade until it is.
        complete,
        // Where the student came in this subject, or "" while the subject is
        // incomplete — a half-marked pair has no total to rank on.
        subjectPosition: positionsForStudent.get(subject) || "",
      };
    }),
  };
};

/**
 * `GET /teacher/students/:studentId/grades?term=Term 2`
 *
 * One student's breakdown by subject — the other half of the roster drawer.
 *
 * Each subject is one row with the class score, the exam score and the total
 * the two make, because that is the shape the report card has and the question
 * the drawer answers is "how is this child doing in Mathematics", not "what
 * were the three marks".
 */
export const getStudentGrades = async (user, studentId, { term, academicYear } = {}) => {
  const { student, school } = await loadStudentScope(user, user.schoolId, studentId);

  const resolvedTerm = resolveTerm(term, school);
  const resolvedYear =
    academicYear || student.academicYear || resolveSchoolAcademicYear(school);

  const grades = await Grade.find({
    schoolId: user.schoolId,
    studentId: student._id,
    term: resolvedTerm,
    academicYear: resolvedYear,
    deletedAt: null,
  })
    .select("subject score maxScore assessmentType")
    .sort({ subject: 1 })
    .lean();

  const bySubject = new Map();
  for (const g of grades) {
    const bucket = bySubject.get(g.subject) || {};
    bucket[g.assessmentType] = g;
    bySubject.set(g.subject, bucket);
  }

  const subjects = [...bySubject.entries()].map(([subject, bucket]) => {
    const classRow = bucket.class_score;
    const examRow = bucket.exam_score;
    const complete = classRow != null && examRow != null;

    const { totalScore, grade, meaning } = complete
      ? calculateTotalScore(
          classRow.score,
          classRow.maxScore || CLASS_SCORE_MAX,
          examRow.score,
          examRow.maxScore || EXAM_SCORE_MAX
        )
      : { totalScore: null, grade: "", meaning: "" };

    return {
      subject,
      classScore: classRow ? classRow.score : null,
      examScore: examRow ? examRow.score : null,
      totalScore,
      grade,
      meaning,
    };
  });

  return {
    studentId: student.studentId,
    studentName: student.studentName,
    studentClass: student.studentClass,
    term: resolvedTerm,
    academicYear: resolvedYear,
    subjects,
  };
};

/** A score the server will accept, or null with the reason it will not. */
const readScore = (score, maxScore) => {
  const numeric = Number(score);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > maxScore) {
    return { ok: false, reason: `Score must be between 0 and ${maxScore}` };
  }
  return { ok: true, score: numeric };
};

/**
 * The mark a row is recorded against.
 *
 * The server owns the default — a class score is out of 50 and an exam score
 * out of 100 — and a school that marks its continuous assessment differently
 * may override it per row, bounded so a stray value cannot turn a mark into a
 * percentage of nothing.
 */
const resolveMaxScore = (assessmentType, requested) => {
  const fallback = DEFAULT_MAX_SCORE[assessmentType] || EXAM_SCORE_MAX;
  const numeric = Number(requested);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.min(numeric, MAX_ALLOWED_SCORE);
};

/**
 * The shared write body: resolve the class, the school, the year and the term,
 * and confirm the students are in the class being marked.
 *
 * Two guards that are easy to skip and each defend a different hole:
 *
 *  - **The scope check.** A class name in a payload is untrusted like any other
 *    input; it is checked against `User.assignedClasses` exactly as a GET is.
 *  - **The roster check.** The upsert key includes `schoolId`, so a forged
 *    `studentId` would otherwise write a grade row *for another school's
 *    student* into this school's collection. Verifying every id resolves to a
 *    student in this class closes it, and is the same guard
 *    `admin.attendance.service.js:bulkMarkAttendance` already runs before it
 *    writes a register.
 */
const resolveWriteScope = async (user, { className, term, academicYear }) => {
  if (!className || !term) {
    throw new ApiError(
      "className and term are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const { school, classes } = await loadTeacherScope(user, user.schoolId);
  if (!classes.some((entry) => entry.className === className)) {
    throw new ApiError(
      "You are not assigned to this class",
      403,
      "FORBIDDEN_SCOPE"
    );
  }

  return {
    school,
    className,
    term: resolveTerm(term, school),
    academicYear: academicYear || resolveSchoolAcademicYear(school),
  };
};

/** The students of a class that exist, as a Set of string ids. */
const classStudentIds = async (schoolId, className) => {
  const students = await Student.find({
    schoolId,
    studentClass: className,
    deletedAt: null,
  })
    .select("_id")
    .lean();

  return new Set(students.map((s) => String(s._id)));
};

/**
 * `POST /teacher/grades/single`
 *
 * One student, one subject, one assessment — a correction after a test.
 *
 * An upsert on the unique key, so submitting the same mark twice updates the
 * same row rather than adding a second one. `recordedBy` is the *authenticated
 * teacher's* id taken from the token, never from the payload.
 */
export const saveSingleGrade = async (user, payload) => {
  const {
    studentId,
    className,
    subject,
    term,
    academicYear,
    assessmentType,
    score,
    maxScore,
  } = payload;

  if (!studentId || !className || !subject || !term) {
    throw new ApiError(
      "studentId, className, subject, and term are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  if (!ASSESSMENT_TYPES.includes(assessmentType)) {
    throw new ApiError(
      "assessmentType must be one of " + ASSESSMENT_TYPES.join(", "),
      400,
      "VALIDATION_ERROR"
    );
  }

  const scope = await resolveWriteScope(user, { className, term, academicYear });

  const enrolled = await classStudentIds(user.schoolId, className);
  if (!enrolled.has(String(studentId))) {
    throw new ApiError(
      "That student is not in this class",
      400,
      "INVALID_STUDENT"
    );
  }

  const effectiveMax = resolveMaxScore(assessmentType, maxScore);

  // Never trust a client-supplied score: the bound is the server's, not the
  // form's, and a mark above the maximum would silently become a 100+% grade.
  const read = readScore(score, effectiveMax);
  if (!read.ok) {
    throw new ApiError(read.reason, 400, "INVALID_SCORE");
  }

  const grade = await Grade.findOneAndUpdate(
    {
      schoolId: user.schoolId,
      studentId,
      className: scope.className,
      subject,
      term: scope.term,
      academicYear: scope.academicYear,
      assessmentType,
    },
    {
      $set: {
        schoolId: user.schoolId,
        studentId,
        className: scope.className,
        subject,
        term: scope.term,
        academicYear: scope.academicYear,
        assessmentType,
        score: read.score,
        maxScore: effectiveMax,
        grade: gradeForScore(read.score, effectiveMax),
        approvalStatus: "submitted",
        submittedAt: new Date(),
        submittedBy: user._id,
        recordedBy: user._id,
        recordedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  ).lean();

  await auditLog({
    action: AUDIT_ACTIONS.TEACHER_GRADE_SAVE,
    entity: "Grade",
    entityId: grade._id,
    userId: user._id,
    schoolId: user.schoolId,
    meta: {
      studentId,
      subject,
      term: scope.term,
      assessmentType,
      score: read.score,
    },
  });

  return grade;
};

/**
 * `POST /teacher/grades/bulk`
 *
 * The whole class, one subject, both assessments — the working path, because a
 * teacher with thirty students on a flaky connection should not end the term
 * with a half-saved column.
 *
 * The payload is a *mix* of `class_score` and `exam_score` rows: the teacher
 * types both marks for the class and sends them in one call, and each row
 * carries its own `assessmentType` so the server knows which half of the
 * terminal report it is writing.
 *
 * `bulkWrite` with `{ ordered: false }`: a bad score fails *that row* and the
 * rest of the class is still saved. The alternative — `ordered: true` — would
 * abandon the whole batch at the first malformed mark, so a teacher who has
 * entered 44 of 45 scores loses all 44 because of one typo. Every failed row
 * comes back in `errors` with its reason, so the response is a report rather
 * than a bare count.
 */
export const saveBulkGrades = async (user, payload) => {
  const { className, subject, term, academicYear, grades } = payload;

  if (!className || !subject || !term || !Array.isArray(grades)) {
    throw new ApiError(
      "className, subject, term, and grades are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const scope = await resolveWriteScope(user, { className, term, academicYear });

  const enrolled = await classStudentIds(user.schoolId, className);

  const errors = [];
  const operations = [];

  for (const row of grades) {
    if (!row?.studentId) {
      errors.push({ studentId: row?.studentId || null, reason: "studentId is required" });
      continue;
    }
    if (!enrolled.has(String(row.studentId))) {
      errors.push({
        studentId: row.studentId,
        reason: "That student is not in this class",
      });
      continue;
    }
    if (!ASSESSMENT_TYPES.includes(row.assessmentType)) {
      errors.push({
        studentId: row.studentId,
        reason:
          "assessmentType must be one of " + ASSESSMENT_TYPES.join(", "),
      });
      continue;
    }

    const effectiveMax = resolveMaxScore(row.assessmentType, row.maxScore);

    const read = readScore(row.score, effectiveMax);
    if (!read.ok) {
      errors.push({ studentId: row.studentId, reason: read.reason });
      continue;
    }

    operations.push({
      updateOne: {
        filter: {
          schoolId: user.schoolId,
          studentId: row.studentId,
          className: scope.className,
          subject,
          term: scope.term,
          academicYear: scope.academicYear,
          // The assessment type is part of the upsert key: a student's class
          // score and their exam score are two rows, and correcting one must
          // never land on the other.
          assessmentType: row.assessmentType,
        },
        update: {
          $set: {
            schoolId: user.schoolId,
            studentId: row.studentId,
            className: scope.className,
            subject,
            term: scope.term,
            academicYear: scope.academicYear,
            assessmentType: row.assessmentType,
            score: read.score,
            maxScore: effectiveMax,
            grade: gradeForScore(read.score, effectiveMax),
            approvalStatus: "submitted",
            submittedAt: new Date(),
            submittedBy: user._id,
            recordedBy: user._id,
            recordedAt: new Date(),
          },
        },
        upsert: true,
      },
    });
  }

  let result = { upsertedCount: 0, modifiedCount: 0 };
  if (operations.length) {
    result = await Grade.bulkWrite(operations, { ordered: false });
  }

  await auditLog({
    action: AUDIT_ACTIONS.TEACHER_GRADE_BULK_SAVE,
    entity: "Grade",
    userId: user._id,
    schoolId: user.schoolId,
    meta: {
      className: scope.className,
      subject,
      term: scope.term,
      attempted: grades.length,
      saved: operations.length,
      created: result.upsertedCount,
      updated: result.modifiedCount,
      failed: errors.length,
    },
  });

  return {
    className: scope.className,
    subject,
    term: scope.term,
    attempted: grades.length,
    saved: operations.length,
    created: result.upsertedCount,
    updated: result.modifiedCount,
    failed: errors.length,
    errors,
  };
};
