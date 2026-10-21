import { Grade } from "../../models/Grade.js";
import { Student } from "../../models/studentModel.js";
import { buildSubjectResults, assignSubjectPositions } from "../../utils/subjectResults.js";

/**
 * The headmaster's view of a class's marks, for the approval queue.
 *
 * One row per **student and subject**, not per grade row, because a subject is
 * now two rows in the grade book — a class score and an exam score — and the
 * headmaster's question is "what did this child get in English", which is a
 * breakdown and a total rather than two separate lines.
 *
 * The breakdown and the total are computed here rather than read from a
 * column, so what the headmaster approves is the same arithmetic the report
 * card will carry. The compile is the server's; this is the preview of it.
 * That includes the **subject position**: the card stamps one, so the queue
 * shows the one the card will carry rather than a total the headmaster has to
 * trust that someone else will rank.
 */

/**
 * The state of a subject, when its two halves disagree.
 *
 * A subject is two rows, and they can drift apart: a teacher who corrects one
 * half after the block was approved puts that half back to `submitted` while
 * the other stays `approved`. The subject is then not fully approved, and the
 * queue must say so — a row reading "approved" over a half that is still in
 * the teacher's hands is the kind of thing a headmaster finds out from a
 * parent.
 *
 * The order is the workflow's own: `draft` → `submitted` → `approved`, and a
 * `rejected` block outranks all of them because a rejection is an explicit
 * decision that something is wrong.
 */
const STATUS_ORDER = { draft: 0, submitted: 1, approved: 2 };

/** The state that says the least — the one a reviewer must still act on. */
const weakestStatus = (statuses) => {
  const present = statuses.filter(Boolean);
  if (!present.length) return "draft";
  if (present.includes("rejected")) return "rejected";
  return present.reduce((weakest, status) =>
    (STATUS_ORDER[status] ?? 0) < (STATUS_ORDER[weakest] ?? 0) ? status : weakest
  );
};

/**
 * `GET /admin/class-grades`
 *
 * The approval queue's preview of a class's marks.
 */
export const getAdminClassGrades = async (schoolId, { className, subject, term, academicYear }) => {
  const filter = { schoolId, deletedAt: null };
  if (className) filter.className = className;
  if (subject) filter.subject = subject;
  if (term) filter.term = term;
  if (academicYear) filter.academicYear = academicYear;

  const grades = await Grade.find(filter)
    .select("studentId className subject assessmentType score maxScore grade approvalStatus recordedAt")
    .sort({ studentId: 1 })
    .lean();

  // The students are read separately rather than with `.populate()`. A
  // populated `studentId` *replaces* the id with the student's document, and
  // that id is the key everything below is grouped by — `String()` of a lean
  // populated object is `"[object Object]"`, so the grouping silently
  // collapsed every student in the school into one.
  const studentIds = [...new Set(grades.map((g) => String(g.studentId)))];
  const students = await Student.find({ _id: { $in: studentIds } })
    .select("studentName studentId")
    .lean();
  const studentById = new Map(students.map((s) => [String(s._id), s]));

  // class ─▶ student ─▶ [ raw grade rows ]. A subject is two rows — a class
  // score and an exam score — and the pair is what makes a total.
  const byClass = new Map();
  for (const g of grades) {
    const classKey = String(g.className || "");
    const studentsInClass = byClass.get(classKey) || new Map();
    const studentKey = String(g.studentId);
    const rows = studentsInClass.get(studentKey) || [];
    rows.push(g);
    studentsInClass.set(studentKey, rows);
    byClass.set(classKey, studentsInClass);
  }

  const rows = [];
  for (const [classKey, studentsInClass] of byClass) {
    // A position is "3rd in English in JHS 2A" — it is only meaningful
    // inside one class, so the ranking is per class and never spans two.
    const resultsByStudent = new Map();
    for (const [studentKey, studentRows] of studentsInClass) {
      resultsByStudent.set(studentKey, buildSubjectResults(studentRows));
    }
    const positions = assignSubjectPositions(resultsByStudent);

    for (const [studentKey, results] of resultsByStudent) {
      const studentRows = studentsInClass.get(studentKey);
      const student = studentById.get(studentKey);
      const positionsForStudent = positions.get(studentKey) || new Map();

      for (const result of results) {
        const subjectRows = studentRows.filter((r) => r.subject === result.subject);
        const source =
          subjectRows.find((r) => r.assessmentType === "class_score") || subjectRows[0];

        rows.push({
          studentId: studentKey,
          studentName: student?.studentName || studentKey,
          studentCode: student?.studentId || "",
          className: source?.className || classKey,
          subject: result.subject,
          classScore: result.classScore,
          classMaxScore: result.classMaxScore,
          examScore: result.examScore,
          examMaxScore: result.examMaxScore,
          totalScore: result.totalScore,
          grade: result.grade,
          meaning: result.meaning,
          complete: result.complete,
          // "1st", "2nd" — the label the report card prints beside the
          // subject, or "" while the subject is half-marked.
          subjectPosition: positionsForStudent.get(result.subject) || "",
          approvalStatus: weakestStatus(
            subjectRows.map((r) => r.approvalStatus)
          ),
          recordedAt: source?.recordedAt || null,
        });
      }
    }
  }

  return { grades: rows };
};
