import { ReportCard } from "../../models/ReportCard.js";
import { Student } from "../../models/studentModel.js";
import { School } from "../../models/schoolModel.js";
import { Attendance } from "../../models/Attendance.js";
import { log as auditLog } from "../../utils/auditService.js";
import { gradeForScore } from "../../utils/gradeBands.js";
import { getSchoolGrading } from "../../utils/gradingConfig.js";
import {
  buildSubjectResultsFromPayload,
  assignSubjectPositions,
  rankByAverage,
  averageOfTotals,
} from "../../utils/subjectResults.js";
import { resolveTermRange } from "../../utils/termDates.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import ApiError from "../../utils/ApiError.js";

/**
 * Compile a class's report cards for one term, as drafts.
 *
 * The body carries the class name, the term, and a map of student id → subject
 * scores. The service then:
 *
 *   1. loads every student in the class,
 *   2. loads attendance for the class in one query and tallies it,
 *   3. computes each student's subject breakdown, average and grade,
 *   4. ranks the class within each subject and overall, and
 *   5. writes one `draft` ReportCard per student.
 *
 * **Attendance is tallied over the term's date range, not over the student's
 * whole history.** A draft that reported a student's attendance for three years
 * would produce "present 310 of 320" against a term that has 90 days in it, and
 * the parent portal would print it.
 *
 * **Position uses competition ranking** ("1224"): tied averages share the lower
 * position and the next position is skipped, so two students joint first are
 * both `position: 1` and the next is `3`. Assigning `index + 1` instead gives
 * two students "1" and "2", which tells the second one they beat someone they
 * did not — the single most complained-about number on a Ghanaian report card.
 *
 * **The subject rows are a breakdown, not a number.** A Ghanaian terminal
 * report prints the class score, the exam score, the total, the grade and the
 * subject position for every subject, and that is what is written here — the
 * same shape the grades-driven compiler in `recordsApproval.service.js`
 * produces, so the two compile paths cannot disagree.
 */
export const compileClassReportCards = async (schoolId, userId, payload) => {
  const {
    className,
    term,
    academicYear,
    scores,
    teacherRemark,
    headRemark,
    conductByStudent,
  } = payload;

  if (!className || !term || !academicYear || !scores) {
    throw new ApiError(
      400,
      "className, term, academicYear, and scores are required",
      "VALIDATION_ERROR"
    );
  }

  const students = await Student.find({
    schoolId,
    studentClass: className,
    deletedAt: null,
  })
    .select("_id studentId studentName")
    .lean();

  if (students.length === 0) {
    throw new ApiError(404, "No students found in this class", "NO_STUDENTS");
  }

  // One query for the whole class, tallied in memory: a query per student is N
  // round trips to answer a question one query answers.
  const { start, end } = resolveTermRange(term, academicYear, null);
  const attendanceRows = await Attendance.find({
    schoolId,
    studentId: { $in: students.map((s) => s._id) },
    date: { $gte: start, $lte: end },
    status: { $in: ["present", "late", "absent"] },
    deletedAt: null,
  })
    .select("studentId status")
    .lean();

  const attendanceByStudent = new Map();
  for (const row of attendanceRows) {
    const key = String(row.studentId);
    const tally = attendanceByStudent.get(key) || { present: 0, total: 0 };
    // A late arrival is attendance: the student was there, and penalising them
    // in the attendance column as well as in the punctuality column is double
    // counting.
    if (row.status === "present" || row.status === "late") tally.present += 1;
    tally.total += 1;
    attendanceByStudent.set(key, tally);
  }

  // The school's grading policy — the 30/70 split — decides how a class
  // score and an exam mark become a total, and the card is written from it.
  const school = await School.findById(schoolId).select("academic.grading").lean();
  const policy = getSchoolGrading(school);

  // student ─▶ subject breakdown, and the class ranking within each subject.
  const subjectResultsByStudent = new Map();
  const rowsByStudent = new Map();
  const drafts = students.map((student) => {
    const key = String(student._id);
    const rows = scores[key] || [];
    const results = buildSubjectResultsFromPayload(rows, { grading: policy });
    subjectResultsByStudent.set(key, results);
    // The payload rows again, keyed by subject, so a remark and a teacher's
    // name can ride along with the breakdown they belong to.
    rowsByStudent.set(
      key,
      new Map(rows.map((row) => [row.subject, row]))
    );
    return {
      student,
      results,
      average: averageOfTotals(results),
      completedCount: results.filter((r) => r.complete).length,
      attendance: attendanceByStudent.get(key) || { present: 0, total: 0 },
    };
  });

  const subjectPositions = assignSubjectPositions(subjectResultsByStudent);

  // Rank by average descending, ties sharing the lower position.
  const positionByStudent = rankByAverage(drafts);

  const results = [];
  for (const draft of drafts) {
    const key = String(draft.student._id);
    const positionsForStudent = subjectPositions.get(key) || new Map();
    const rows = rowsByStudent.get(key) || new Map();

    const subjects = draft.results.map((result) => ({
      subject: result.subject,
      classScore: result.classScore,
      classMaxScore: result.classMaxScore,
      // The exam's points out of 70 — the 70% it carries — so the class score
      // and the exam add up to the total, as they do on the printed report.
      examScore: result.examPoints,
      examMaxScore: policy.examWeight,
      totalScore: result.totalScore,
      grade: result.grade,
      meaning: result.meaning,
      subjectPosition: positionsForStudent.get(result.subject) || "",
      score: result.totalScore,
      maxScore: 100,
      // A remark and a teacher name may be carried on the payload row; they
      // ride along with the breakdown rather than replacing it.
      remark: rows.get(result.subject)?.remark || "",
      teacher: rows.get(result.subject)?.teacher || "",
    }));

    const record = await ReportCard.findOneAndUpdate(
      {
        schoolId,
        studentId: draft.student._id,
        term,
        academicYear,
      },
      {
        $set: {
          schoolId,
          studentId: draft.student._id,
          className,
          term,
          academicYear,
          subjects,
          average: draft.average,
          position: positionByStudent.get(key) ?? null,
          classSize: students.length,
          grade: draft.completedCount ? gradeForScore(draft.average) : "",
          teacherRemark: {
            text: teacherRemark?.text || "",
            author: teacherRemark?.author || "",
          },
          headRemark: {
            text: headRemark?.text || "",
            author: headRemark?.author || "",
          },
          conduct: conductByStudent?.[key] || "Good",
          attendance: draft.attendance,
          // Re-compiling a published card withdraws it: the numbers on it have
          // just changed, and a parent who downloaded the previous version is
          // holding a record the school no longer stands behind. It goes back
          // out only through `publishClassReportCards`.
          status: "draft",
        },
      },
      { upsert: true, new: true }
    );
    results.push({ studentId: draft.student.studentId, recordId: record._id });
  }

  await auditLog({
    action: AUDIT_ACTIONS.REPORT_CARD_COMPILE,
    entity: "ReportCard",
    userId,
    schoolId,
    meta: { className, term, academicYear, count: results.length },
  });

  return {
    className,
    term,
    academicYear,
    compiled: results.length,
    records: results,
  };
};

/**
 * Publish a class's draft report cards for one term.
 *
 * The disclosure boundary. Until this runs, nothing the class teacher compiled
 * is readable through a pay link — the parent reads filter on
 * `status: "published"` — so this is the moment the school decides a term's
 * grades are final and its parents may see them.
 *
 * Returns `0` rather than an error when there are no drafts, because publishing
 * an already-published class is a double-click, not a failure.
 */
export const publishClassReportCards = async (schoolId, userId, payload) => {
  const { className, term, academicYear } = payload;
  if (!className || !term || !academicYear) {
    throw new ApiError(400, "className, term, and academicYear are required", "VALIDATION_ERROR");
  }

  const result = await ReportCard.updateMany(
    {
      schoolId,
      className,
      term,
      academicYear,
      status: "draft",
      deletedAt: null,
    },
    {
      $set: {
        status: "published",
        publishedAt: new Date(),
        publishedBy: userId,
      },
    }
  );

  await auditLog({
    action: AUDIT_ACTIONS.REPORT_CARD_PUBLISH,
    entity: "ReportCard",
    userId,
    schoolId,
    meta: { className, term, academicYear, published: result.modifiedCount },
  });

  return { className, term, academicYear, published: result.modifiedCount };
};
