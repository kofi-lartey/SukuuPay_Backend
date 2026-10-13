import { ReportCard } from "../../models/ReportCard.js";
import { Student } from "../../models/studentModel.js";
import { Attendance } from "../../models/Attendance.js";
import { log as auditLog } from "../../utils/auditService.js";
import { gradeForScore } from "../../utils/gradeBands.js";
import { resolveTermRange } from "../../utils/termDates.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import ApiError from "../../utils/ApiError.js";

/**
 * Average, grade and position arithmetic.
 *
 * `average` is a percentage across subjects, so a subject marked out of 50 and
 * one marked out of 100 contribute equally:
 *
 *     (each subject's percentage) / number of subjects
 *
 * Computing it from raw scores instead would let one heavily-weighted subject
 * drag a class average down by a letter grade.
 */
const computeSummary = (subjects) => {
  if (!subjects.length) return { average: 0, grade: "F" };
  const pctSum = subjects.reduce((sum, s) => {
    const pct = (s.score / (s.maxScore || 100)) * 100;
    return sum + pct;
  }, 0);
  const average = Math.round((pctSum / subjects.length) * 10) / 10;
  return { average, grade: gradeForScore(average) };
};

/**
 * Compile a class's report cards for one term, as drafts.
 *
 * The body carries the class name, the term, and a map of student id → subject
 * scores. The service then:
 *
 *   1. loads every student in the class,
 *   2. loads attendance for the class in one query and tallies it,
 *   3. computes each student's average and grade,
 *   4. ranks the class, and
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

  const drafts = students.map((student) => {
    const key = String(student._id);
    const subjects = (scores[key] || []).map((s) => ({
      subject: s.subject,
      score: s.score,
      maxScore: s.maxScore || 100,
      grade: gradeForScore(s.score, s.maxScore || 100),
      remark: s.remark || "",
      teacher: s.teacher || "",
    }));
    const { average, grade } = computeSummary(subjects);
    return {
      student,
      subjects,
      average,
      grade,
      attendance: attendanceByStudent.get(key) || { present: 0, total: 0 },
    };
  });

  // Rank by average descending, ties sharing the lower position.
  const sorted = [...drafts].sort((a, b) => b.average - a.average);
  const positionByStudent = new Map();
  let position = 0;
  let previousAverage = null;
  sorted.forEach((entry, index) => {
    if (previousAverage === null || entry.average < previousAverage) {
      position = index + 1;
      previousAverage = entry.average;
    }
    positionByStudent.set(String(entry.student._id), position);
  });

  const results = [];
  for (const draft of drafts) {
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
          subjects: draft.subjects,
          average: draft.average,
          position: positionByStudent.get(String(draft.student._id)),
          classSize: students.length,
          grade: draft.grade,
          teacherRemark: {
            text: teacherRemark?.text || "",
            author: teacherRemark?.author || "",
          },
          headRemark: {
            text: headRemark?.text || "",
            author: headRemark?.author || "",
          },
          conduct: conductByStudent?.[String(draft.student._id)] || "Good",
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
