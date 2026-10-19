import { Grade } from "../../models/Grade.js";
import { Student } from "../../models/studentModel.js";
import { loadTeacherScope, loadStudentScope } from "../../utils/teacherScope.js";
import { resolveTerm } from "../parent/portalContext.js";
import { gradeForScore } from "../../utils/gradeBands.js";
import { initialsOf } from "./classes.service.js";
import { log as auditLog } from "../../utils/auditService.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import { resolveSchoolAcademicYear } from "../../utils/termDates.js";
import ApiError from "../../utils/ApiError.js";

/** The assessment types a teacher may record. Mirrors the Grade schema enum. */
const ASSESSMENT_TYPES = ["class_test", "quiz", "assignment", "exam"];

/**
 * `GET /teacher/grades?className=JHS 2A&term=Term 2&subject=Mathematics`
 *
 * The class's grade book for one subject, formatted so the bulk entry grid
 * renders every student and their score in one pass.
 *
 * Every student in the class appears, including those with no score yet, and a
 * student with no score reads `score: null` rather than being omitted. That is
 * the whole point: a grid that reflows as marks are entered loses a teacher's
 * place mid-entry, and a missing row reads as "this student is not in the
 * class" when what it means is "this student has not been assessed".
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

  const grades = await Grade.find(filter)
    .select("studentId subject score maxScore assessmentType")
    .lean();

  const byStudent = new Map();
  for (const g of grades) {
    byStudent.set(String(g.studentId), g);
  }

  return {
    className,
    term: resolvedTerm,
    academicYear: resolvedYear,
    subject: subject || null,
    // The marks' own maximum, so a school marking out of 50 does not have every
    // score read as a mark out of 100. Defaults to 100 on an empty book.
    maxScore: grades[0]?.maxScore || 100,
    students: students.map((s) => {
      const g = byStudent.get(String(s._id));
      return {
        _id: s._id,
        studentId: s.studentId,
        studentName: s.studentName,
        initials: initialsOf(s.studentName),
        score: g?.score ?? null,
        grade:
          g?.score != null ? gradeForScore(g.score, g.maxScore || 100) : null,
      };
    }),
  };
};

/**
 * `GET /teacher/students/:studentId/grades?term=Term 2`
 *
 * One student's breakdown by subject — the other half of the roster drawer.
 * Subjects with several marks (a class test and a quiz) are averaged into one
 * percentage per subject, because the question the drawer answers is "how is
 * this child doing in Mathematics", not "what were the three marks".
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
    const list = bySubject.get(g.subject) || [];
    list.push(g);
    bySubject.set(g.subject, list);
  }

  const subjects = [...bySubject.entries()].map(([subject_, list]) => {
    const avg =
      list.reduce((sum, g) => sum + (g.score / (g.maxScore || 100)) * 100, 0) /
      list.length;
    const percentage = Math.round(avg * 10) / 10;
    return {
      subject: subject_,
      score: percentage,
      grade: gradeForScore(percentage),
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
const resolveWriteScope = async (user, { className, term, academicYear, maxScore }) => {
  if (!className || !term) {
    throw new ApiError(
      "className and term are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  if (!Number.isFinite(maxScore) || maxScore < 1) {
    throw new ApiError("maxScore must be at least 1", 400, "VALIDATION_ERROR");
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
    maxScore,
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
    assessmentType = "class_test",
    score,
    maxScore = 100,
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

  const scope = await resolveWriteScope(user, {
    className,
    term,
    academicYear,
    maxScore,
  });

  const enrolled = await classStudentIds(user.schoolId, className);
  if (!enrolled.has(String(studentId))) {
    throw new ApiError(
      "That student is not in this class",
      400,
      "INVALID_STUDENT"
    );
  }

  // Never trust a client-supplied score: the bound is the server's, not the
  // form's, and a mark above the maximum would silently become a 100+% grade.
  const read = readScore(score, scope.maxScore);
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
         maxScore: scope.maxScore,
         grade: gradeForScore(read.score, scope.maxScore),
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
    meta: { studentId, subject, term: scope.term, score: read.score },
  });

  return grade;
};

/**
 * `POST /teacher/grades/bulk`
 *
 * The whole class, one subject, one assessment — the working path, because a
 * teacher with thirty students on a flaky connection should not end the term
 * with a half-saved column.
 *
 * `bulkWrite` with `{ ordered: false }`: a bad score fails *that row* and the
 * rest of the class is still saved. The alternative — `ordered: true` — would
 * abandon the whole batch at the first malformed mark, so a teacher who has
 * entered 44 of 45 scores loses all 44 because of one typo. Every failed row
 * comes back in `errors` with its reason, so the response is a report rather
 * than a bare count.
 */
export const saveBulkGrades = async (user, payload) => {
  const {
    className,
    subject,
    term,
    academicYear,
    assessmentType = "class_test",
    maxScore = 100,
    grades,
  } = payload;

  if (!className || !subject || !term || !Array.isArray(grades)) {
    throw new ApiError(
      "className, subject, term, and grades are required",
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

  const scope = await resolveWriteScope(user, {
    className,
    term,
    academicYear,
    maxScore,
  });

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

    const read = readScore(row.score, scope.maxScore);
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
          assessmentType,
        },
        update: {
          $set: {
            schoolId: user.schoolId,
            studentId: row.studentId,
            className: scope.className,
            subject,
            term: scope.term,
            academicYear: scope.academicYear,
            assessmentType,
             score: read.score,
             maxScore: scope.maxScore,
             grade: gradeForScore(read.score, scope.maxScore),
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
