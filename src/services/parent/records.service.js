import { ReportCard } from "../../models/ReportCard.js";
import { log as auditLog } from "../../utils/auditService.js";
import { hashTokenForLog } from "../../utils/tokens.js";
import { gradeForScore } from "../../utils/gradeBands.js";
import { resolveAcademicYear, resolvePortalStudent, resolveTerm } from "./portalContext.js";

/**
 * The parent's report card for one student, one term — or `null`.
 *
 * **Returns `null` rather than throwing when nothing is published**, and the
 * controller answers `200 { data: null }`. That is a deliberate shape and not a
 * shortcut: an unpublished term is an ordinary state, not an error. A parent
 * checking in October whether Term 1's card is out has done nothing wrong, and
 * the frontend renders an empty state. A 404 there reads as "this link is
 * broken", which sends the parent to the school office to ask about a problem
 * that does not exist.
 *
 * Only `status: "published"` is readable. A card the class teacher is still
 * compiling is a draft, and a draft is visible in the admin console only — the
 * publish step is the disclosure boundary, not an implementation detail.
 */
export const getStudentRecordsForTerm = async (token, { term } = {}) => {
  const { student, school } = await resolvePortalStudent(token);

  const requestedTerm = resolveTerm(term, school);
  const academicYear = resolveAcademicYear(student, school);

  const record = await ReportCard.findOne({
    studentId: student._id,
    term: requestedTerm,
    status: { $in: ["review", "published"] },
    deletedAt: null,
  })
    .sort({ academicYear: -1 })
    .lean();

  await auditLog({
    action: "parent.records_viewed",
    entity: "Student",
    entityId: student._id,
    schoolId: student.schoolId,
    meta: {
      tokenHash: hashTokenForLog(token),
      term: requestedTerm,
      hasRecord: Boolean(record),
    },
  });

  if (!record) return null;

  return {
    studentId: student.studentId,
    studentName: student.studentName,
    studentClass: student.studentClass,
    term: requestedTerm,
    academicYear: record.academicYear || academicYear,
    summary: {
      average: record.average,
      position: record.position,
      classSize: record.classSize,
      // The grade is stored at compile time and recomputed here as a fallback,
      // so a card compiled before `gradeBands.js` existed still reads a letter
      // rather than an empty string.
      grade: record.grade || gradeForScore(record.average),
    },
    subjects: (record.subjects || []).map((s) => ({
      subject: s.subject,
      // The Ghanaian breakdown, as the terminal report prints it: the class
      // score out of 30 and the exam mark out of 100, whose weighted points
      // add up to the total out of 100.
      classScore: s.classScore ?? null,
      classMaxScore: s.classMaxScore ?? 30,
      classParts: s.classParts || [],
      examScore: s.examScore ?? null,
      examMaxScore: s.examMaxScore ?? 100,
      examPoints: s.examPoints ?? null,
      totalScore: s.totalScore ?? s.score ?? null,
      // The grade is stored at compile time and recomputed here as a fallback,
      // so a card compiled before `gradeBands.js` existed still reads a letter
      // rather than an empty string. A subject with no total has no grade:
      // showing "F" for a subject that was never completed would tell a parent
      // their child failed when the truth is that the class was not finished.
      grade:
        s.grade ||
        (s.totalScore != null ? gradeForScore(s.totalScore) : ""),
      meaning: s.meaning || "",
      subjectPosition: s.subjectPosition || "",
      score: s.score ?? s.totalScore ?? null,
    })),
    teacherRemark: record.teacherRemark,
    headRemark: record.headRemark,
    conduct: record.conduct,
    attendance: record.attendance,
    pdfUrl: record.pdfUrl,
  };
};
