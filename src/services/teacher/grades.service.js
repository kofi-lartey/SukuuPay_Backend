import { Grade } from "../../models/Grade.js";
import { Student } from "../../models/studentModel.js";
import { loadTeacherScope, loadStudentScope } from "../../utils/teacherScope.js";
import { resolveTerm } from "../parent/portalContext.js";
import {
  gradeForScore,
  calculateTotalScore,
  calculateClassScore,
  normaliseClassScore,
  EXAM_SCORE_MAX,
} from "../../utils/gradeBands.js";
import {
  buildSubjectResults,
  assignSubjectPositions,
} from "../../utils/subjectResults.js";
import {
  ASSESSMENT_TYPES,
  CLASS_COMPONENT_KEYS,
  getSchoolGrading,
  normalizeGradingConfig,
  partsForSubject,
} from "../../utils/gradingConfig.js";
import { initialsOf } from "./classes.service.js";
import { log as auditLog } from "../../utils/auditService.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import { resolveSchoolAcademicYear } from "../../utils/termDates.js";
import ApiError from "../../utils/ApiError.js";

export { ASSESSMENT_TYPES };

/** The widest a school may widen a mark, so a stray `maxScore: 100000` is refused. */
const MAX_ALLOWED_SCORE = 200;

/**
 * `GET /teacher/grades?className=JHS 2A&term=Term 2&subject=Mathematics`
 *
 * The class's grade book for one subject, formatted so the bulk entry grid
 * renders every student and their marks in one pass.
 *
 * Every student in the class appears, including those with no score yet, and a
 * student with no score reads `classScore: null` rather than being omitted.
 * That is the whole point: a grid that reflows as marks are entered loses a
 * teacher's place mid-entry, and a missing row reads as "this student is not
 * in the class" when what it means is "this student has not been assessed".
 *
 * The response carries the school's **grading policy** — the 30/70 split and
 * the class-score breakdown — because the grid's columns are the policy's
 * columns. A school that does not run a group project must not be shown a
 * group-work box, and a school that runs 40/60 must see its own numbers.
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
  const policy = getSchoolGrading(school);

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

  // student ─▶ assessmentType. One row per part of the subject, keyed so the
  // whole set can be read back together.
  const byStudent = new Map();
  for (const g of grades) {
    const key = String(g.studentId);
    const bucket = byStudent.get(key) || {};
    bucket[g.assessmentType] = g;
    byStudent.set(key, bucket);
  }

  // Where each student came in this subject — the same competition ranking the
  // report card carries, computed from the same marks, so the teacher reads
  // the number the card will print before anything is approved.
  const resultsByStudent = new Map();
  for (const [key, bucket] of byStudent) {
    resultsByStudent.set(
      key,
      buildSubjectResults(Object.values(bucket), { grading: policy })
    );
  }
  const positions = assignSubjectPositions(resultsByStudent);

  return {
    className,
    term: resolvedTerm,
    academicYear: resolvedYear,
    subject: subject || null,
    // The policy the grid's columns are built from: the 30/70 split and the
    // parts the class assessment is made of.
    grading: {
      classWeight: policy.classWeight,
      examWeight: policy.examWeight,
      classMax: policy.classMax,
      examMax: policy.examMax,
      components: policy.components,
    },
    students: students.map((s) => {
      const bucket = byStudent.get(String(s._id)) || {};
      const examRow = bucket.exam_score;
      const classRow = bucket.class_score;

      // The class score, from the parts when the school runs a breakdown and
      // from the direct class-score row when it does not.
      const parts = partsForSubject(bucket, policy.components);
      const partsUsed = parts.filter((part) => part.score !== null);
      const folded = partsUsed.length
        ? calculateClassScore(parts)
        : classRow
          ? (() => {
              const rawMax = Number(classRow.maxScore) || policy.classMax;
              return {
                classScore: normaliseClassScore(classRow.score, rawMax, policy),
                classMax: policy.classMax,
                complete: true,
              };
            })()
          : { classScore: null, classMax: policy.classMax, complete: false };

      const classScore = folded.classScore;
      const classMaxScore = policy.classMax;
      const examScore = examRow ? examRow.score : null;
      const examMaxScore = examRow ? examRow.maxScore || policy.examMax : policy.examMax;

      const complete = folded.complete && classScore !== null && examScore !== null;

      const { totalScore, grade, meaning, examPoints } = complete
        ? calculateTotalScore(
            classScore,
            classMaxScore,
            examScore,
            examMaxScore,
            policy
          )
        : { totalScore: null, grade: null, meaning: null, examPoints: null };

      const positionsForStudent = positions.get(String(s._id)) || new Map();

      return {
        _id: s._id,
        studentId: s.studentId,
        studentName: s.studentName,
        initials: initialsOf(s.studentName),
        // Each part of the class assessment, keyed by its assessment type, so
        // the grid can rehydrate one box per part.
        classParts: Object.fromEntries(
          policy.components.map((part) => {
            const row = bucket[part.key];
            return [
              part.key,
              row
                ? { score: row.score, maxScore: row.maxScore || part.maxScore }
                : { score: null, maxScore: part.maxScore },
            ];
          })
        ),
        classScore,
        classMaxScore,
        examScore,
        examMaxScore,
        // The exam's points in the total — out of 70 — which is the figure the
        // report card prints beside the class score.
        examPoints,
        totalScore,
        grade,
        meaning,
        // Whether the subject is complete enough to be banded. The grid shows a
        // dash rather than a grade until it is.
        complete,
        // Where the student came in this subject, or "" while the subject is
        // incomplete — a partly marked subject has no total to rank on.
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

  const policy = getSchoolGrading(school);

  const subjects = [...bySubject.entries()].map(([subject, bucket]) => {
    const examRow = bucket.exam_score;
    const classRow = bucket.class_score;
    const parts = partsForSubject(bucket, policy.components);
    const partsUsed = parts.filter((part) => part.score !== null);
    const folded = partsUsed.length
      ? calculateClassScore(parts)
      : classRow
        ? {
            classScore: Number(classRow.score),
            classMax: Number(classRow.maxScore) || policy.classMax,
            complete: true,
          }
        : { classScore: null, classMax: policy.classMax, complete: false };

    const classScore = folded.classScore;
    const classMaxScore = folded.classMax;
    const examScore = examRow ? examRow.score : null;
    const examMaxScore = examRow ? examRow.maxScore || policy.examMax : policy.examMax;
    const complete = folded.complete && classScore !== null && examScore !== null;

    const { totalScore, grade, meaning, examPoints } = complete
      ? calculateTotalScore(
          classScore,
          classMaxScore,
          examScore,
          examMaxScore,
          policy
        )
      : { totalScore: null, grade: "", meaning: "", examPoints: null };

    return {
      subject,
      classParts: Object.fromEntries(
        policy.components.map((part) => {
          const row = bucket[part.key];
          return [
            part.key,
            row
              ? { score: row.score, maxScore: row.maxScore || part.maxScore }
              : { score: null, maxScore: part.maxScore },
          ];
        })
      ),
      classScore,
      classMaxScore,
      examScore,
      examMaxScore,
      examPoints,
      totalScore,
      grade,
      meaning,
      complete,
    };
  });

  return {
    studentId: student.studentId,
    studentName: student.studentName,
    studentClass: student.studentClass,
    term: resolvedTerm,
    academicYear: resolvedYear,
    grading: {
      classWeight: policy.classWeight,
      examWeight: policy.examWeight,
      classMax: policy.classMax,
      examMax: policy.examMax,
      components: policy.components,
    },
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
 * The server owns the default — a class score is out of the class weight, an
 * exam out of 100, and each part of the class assessment out of the maximum
 * the school marked it against — and a school that marks a part differently
 * may override it per row, bounded so a stray value cannot turn a mark into a
 * percentage of nothing.
 */
const resolveMaxScore = (assessmentType, requested, policy) => {
  const fallback =
    assessmentType === "class_score"
      ? policy.classMax
      : assessmentType === "exam_score"
        ? policy.examMax
        : policy.components.find((part) => part.key === assessmentType)?.maxScore ||
          policy.examMax;
  const numeric = Number(requested);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.min(numeric, MAX_ALLOWED_SCORE);
};

/**
 * The shared write scope: resolve the class, the school, the year and the term,
 * and confirm the students are in the class being marked.
 *
 * Three guards:
 *
 *  - **The scope check.** A class name in a payload is untrusted like any other
 *    input; it is checked against `User.assignedClasses` exactly as a GET is.
 *  - **The subject check.** A subject teacher may only grade subjects they are
 *    assigned to in that class. A class teacher (empty-subject slot) and
 *    school admins may grade every subject in the class.
 *  - **The roster check.** The upsert key includes `schoolId`, so a forged
 *    `studentId` would otherwise write a grade row *for another school's
 *    student* into this school's collection. Verifying every id resolves to a
 *    student in this class closes it, and is the same guard
 *    `admin.attendance.service.js:bulkMarkAttendance` already runs before it
 *    writes a register.
 */
const resolveWriteScope = async (
  user,
  { className, term, academicYear, subject }
) => {
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

  // Subject-level gate: a subject teacher grades only their assigned subjects;
  // a class teacher or school admin grades every subject in the class.
  if (subject) {
    const ADMIN_ROLES = ["school_admin", "super_admin"];
    const isAdmin = ADMIN_ROLES.includes(user.role);
    const entry = classes.find((c) => c.className === className);
    const isClassTeacher = Array.isArray(user.assignedClasses)
      ? user.assignedClasses.some(
          (e) =>
            String(e.className || "").trim() === className &&
            String(e.subject || "").trim() === ""
        )
      : false;
    const isAuthorised =
      isAdmin ||
      isClassTeacher ||
      (Boolean(entry) && Array.isArray(entry.subjects) && entry.subjects.includes(subject));
    if (!isAuthorised) {
      throw new ApiError(
        "You are not assigned to teach this subject in this class",
        403,
        "FORBIDDEN_SUBJECT"
      );
    }
  }

  return {
    school,
    // The school's grading policy: the 30/70 split and the class-score
    // breakdown. The maxima a mark is recorded against come from it, so a
    // class test marked out of 20 and one marked out of 100 are both accepted
    // as the school meant them.
    policy: getSchoolGrading(school),
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
 * Clear whichever of the two ways of recording a class score is not being
 * used.
 *
 * A subject's class score is either a direct `class_score` row (a school that
 * does not break the class assessment down) or the set of parts that make it
 * up (a class test, group work, homework, class work). Both at once would
 * leave two different class scores on the book, and the report would have to
 * pick one.
 */
const clearTheOtherClassScore = async ({
  schoolId,
  studentId,
  className,
  subject,
  term,
  academicYear,
  assessmentType,
}) => {
  const scope = {
    schoolId,
    studentId,
    className,
    subject,
    term,
    academicYear,
  };

  if (assessmentType === "class_score") {
    await Grade.deleteMany({
      ...scope,
      assessmentType: { $in: CLASS_COMPONENT_KEYS },
    });
    return;
  }

  if (CLASS_COMPONENT_KEYS.includes(assessmentType)) {
    await Grade.deleteMany({ ...scope, assessmentType: "class_score" });
  }
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

  const scope = await resolveWriteScope(user, {
    className,
    term,
    academicYear,
    subject,
  });

  const enrolled = await classStudentIds(user.schoolId, className);
  if (!enrolled.has(String(studentId))) {
    throw new ApiError(
      "That student is not in this class",
      400,
      "INVALID_STUDENT"
    );
  }

  const effectiveMax = resolveMaxScore(assessmentType, maxScore, scope.policy);

  // Never trust a client-supplied score: the bound is the server's, not the
  // form's, and a mark above the maximum would silently become a 100+% grade.
  const read = readScore(score, effectiveMax);
  if (!read.ok) {
    throw new ApiError(read.reason, 400, "INVALID_SCORE");
  }

  // The class score and the breakdown are two ways of saying the same thing,
  // so only one of them may be on the book. Writing a part clears any direct
  // class score, and writing a direct class score clears the parts — otherwise
  // the subject would have two class scores and the reader would have to guess
  // which one the report meant.
  await clearTheOtherClassScore({
    schoolId: user.schoolId,
    studentId,
    className: scope.className,
    subject,
    term: scope.term,
    academicYear: scope.academicYear,
    assessmentType,
  });

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
    { upsert: true, returnDocument: 'after' }
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
 * The payload is a *mix* of rows: the parts of the class assessment (a class
 * test, group work, homework, class work), the exam score, and — for a school
 * that does not break the class assessment down — a single class score. The
 * teacher types every mark for the class and sends them in one call, and each
 * row carries its own `assessmentType` so the server knows which part of the
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

  const scope = await resolveWriteScope(user, {
    className,
    term,
    academicYear,
    subject,
  });

  const enrolled = await classStudentIds(user.schoolId, className);

  const errors = [];
  const operations = [];
  // Which kind of class score this batch is recording, so the other kind can
  // be cleared once the write is done.
  const wroteClassScore = new Set();
  const wroteComponents = new Set();

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

    const effectiveMax = resolveMaxScore(row.assessmentType, row.maxScore, scope.policy);

    const read = readScore(row.score, effectiveMax);
    if (!read.ok) {
      errors.push({ studentId: row.studentId, reason: read.reason });
      continue;
    }

    // Note which kind of class score this batch is recording, so the other
    // kind can be cleared once the write is done.
    if (row.assessmentType === "class_score") wroteClassScore.add(String(row.studentId));
    if (CLASS_COMPONENT_KEYS.includes(row.assessmentType)) {
      wroteComponents.add(String(row.studentId));
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
          // test and their exam are two rows, and correcting one must never
          // land on the other.
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

  // A class score and its breakdown are two ways of saying the same thing, so
  // only one of them may be on the book. Writing the parts clears any direct
  // class score, and writing a direct class score clears the parts.
  for (const studentKey of wroteComponents) {
    await Grade.deleteMany({
      schoolId: user.schoolId,
      studentId: studentKey,
      className: scope.className,
      subject,
      term: scope.term,
      academicYear: scope.academicYear,
      assessmentType: "class_score",
    });
  }
  for (const studentKey of wroteClassScore) {
    await Grade.deleteMany({
      schoolId: user.schoolId,
      studentId: studentKey,
      className: scope.className,
      subject,
      term: scope.term,
      academicYear: scope.academicYear,
      assessmentType: { $in: CLASS_COMPONENT_KEYS },
    });
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

