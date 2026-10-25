import mongoose from "mongoose";
import { ReportCard } from "../../models/ReportCard.js";
import { Grade } from "../../models/Grade.js";
import { Student } from "../../models/studentModel.js";
import { Attendance } from "../../models/Attendance.js";
import { School } from "../../models/schoolModel.js";
import { log as auditLog } from "../../utils/auditService.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import { gradeForScore } from "../../utils/gradeBands.js";
import {
  buildSubjectResults,
  assignSubjectPositions,
  rankByAverage,
  averageOfTotals,
} from "../../utils/subjectResults.js";
import { resolveTermRange } from "../../utils/termDates.js";
import { getSchoolGrading } from "../../utils/gradingConfig.js";
import { generateReportCardPdf, uploadReportCardPdf } from "./reportCardPdf.service.js";
import ApiError from "../../utils/ApiError.js";

/**
 * The grades-driven report card pipeline — compile from *approved* marks,
 * review, publish. The counterpart of `admin/records.service.js`, which compiles
 * from a teacher's submitted payload; this one is the flow the grade approval
 * workflow exists to feed.
 *
 *     approved grades ──compile──▶ review ──publish──▶ published
 *                                     ▲                    │
 *                                     └────unpublish────────┘
 *
 * The invariant that makes the whole approval layer worth anything: **only
 * `approved` grades are ever compiled.** A mark a headmaster has not signed off
 * cannot reach a report card, and therefore cannot reach a parent. Compilation
 * filters on `approvalStatus: "approved"` and nothing else — a draft or a
 * rejected block is simply not there to be read.
 */

/**
 * Attach a term's attendance tally to each draft.
 *
 * Tallied over the term's date window, not the student's whole history: a card
 * that reported three years of attendance against one term would print "present
 * 310 of 320" for a ninety-day term, and the parent portal would display it.
 * `Attendance` is keyed by `date` and has no `term`, so the window comes from
 * `resolveTermRange` and the count is over `[start, end]`.
 */
const tallyAttendance = async (schoolId, school, { className, term, academicYear, students }) => {
  const { start, end } = resolveTermRange(term, academicYear, school);
  const rows = await Attendance.find({
    schoolId,
    studentId: { $in: students.map((s) => s._id) },
    date: { $gte: start, $lte: end },
    status: { $in: ["present", "late", "absent"] },
    deletedAt: null,
  })
    .select("studentId status")
    .lean();

  const byStudent = new Map();
  for (const row of rows) {
    const key = String(row.studentId);
    const tally = byStudent.get(key) || { present: 0, total: 0 };
    // Late is attendance — the student was there. Penalising them in the
    // attendance column as well as wherever punctuality is already noted double
    // counts one lateness.
    if (row.status === "present" || row.status === "late") tally.present += 1;
    tally.total += 1;
    byStudent.set(key, tally);
  }
  return byStudent;
};

/**
 * Compile every review-state report card for a class and term from the class's
 * **approved** grades.
 *
 * The headmaster runs this after approving the class's marks. For each student:
 * pull the approved grades, fold the class score and the exam score into one
 * total per subject, rank the class within each subject and overall, attach
 * the term's attendance, and upsert one card into `review`.
 *
 * ## What a subject row is
 *
 * A Ghanaian terminal report prints a *breakdown* per subject — Class Score,
 * Exam Score, Total, Grade, and the position the student came in that subject —
 * and that is exactly what this writes:
 *
 *     class score 24/30  +  exam 60/100  →  total 66  →  grade B
 *
 * The total is the server's arithmetic, never the teacher's: the two halves
 * are normalised onto 50 points each and added, so a school marking its
 * continuous assessment out of 60 and one marking it out of 50 produce
 * comparable totals.
 *
 * ## What a subject row is not
 *
 * A subject with only one of its two halves recorded is **incomplete**: it
 * carries the mark that was given and no total, no grade and no position, and
 * it is excluded from the average. Compiling a half-marked class into report
 * cards that read "Total 42, Grade A" for every child would publish a number
 * that looks like a result and is not one.
 *
 * Existing remarks and conduct are left untouched on recompile (`$set` writes
 * only the computed fields), so a headmaster's remark written before a
 * correction survives the recompile that fixes the numbers.
 */
export const compileClassReportsFromGrades = async (schoolId, userId, payload) => {
  const { className, term, academicYear } = payload;
  if (!className || !term || !academicYear) {
    throw new ApiError(
      "className, term, and academicYear are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const [students, school] = await Promise.all([
    Student.find({ schoolId, studentClass: className, deletedAt: null })
      .select("_id studentId studentName")
      .lean(),
    School.findById(schoolId).select("academic").lean(),
  ]);
  if (!students.length) {
    throw new ApiError("No students in this class", 404, "NO_STUDENTS");
  }

  // Only approved grades. This is the load-bearing filter of the whole module.
  const grades = await Grade.find({
    schoolId,
    className,
    term,
    academicYear,
    approvalStatus: "approved",
    deletedAt: null,
  })
    .select("studentId subject assessmentType score maxScore")
    .lean();

  // student ─▶ [ raw grade rows ]. A subject is a *set* of rows — the parts of
  // the class assessment and the exam — and the whole set is what makes a
  // total.
  const rowsByStudent = new Map();
  for (const g of grades) {
    const key = String(g.studentId);
    const list = rowsByStudent.get(key) || [];
    list.push(g);
    rowsByStudent.set(key, list);
  }

  // The school's grading policy: the 30/70 split and the class-score
  // breakdown. The card is compiled from it, so the school gets its own
  // scheme and not the default.
  const policy = getSchoolGrading(school);

  // Fold each student's marks into one result per subject.
  const subjectResultsByStudent = new Map();
  const drafts = students.map((student) => {
    const results = buildSubjectResults(rowsByStudent.get(String(student._id)) || [], {
      grading: policy,
    });
    subjectResultsByStudent.set(String(student._id), results);
    return {
      student,
      results,
      average: averageOfTotals(results),
      completedCount: results.filter((r) => r.complete).length,
    };
  });

  // Where the student came in each subject, and where they came in the class.
  const subjectPositions = assignSubjectPositions(subjectResultsByStudent);
  const positions = rankByAverage(drafts);
  const attendanceByStudent = await tallyAttendance(schoolId, school, {
    className,
    term,
    academicYear,
    students,
  });

  const results = [];
  for (const draft of drafts) {
    const studentKey = String(draft.student._id);
    const positionsForStudent = subjectPositions.get(studentKey) || new Map();

    const subjects = draft.results.map((result) => ({
      subject: result.subject,
      // The two marking maxima the terminal report prints: the class score out
      // of 30 and the exam mark out of 100. Both are raw figures the teacher
      // wrote down. `totalScore` is the weighted sum (the class contributes its
      // 30 points and the exam its 70), so "24/30 + 60/100 = 66" is honest in
      // both the raw marks and the total that the band is read from.
      classScore: result.classScore,
      classMaxScore: result.classMaxScore,
      examScore: result.examScore,
      examMaxScore: result.examMaxScore,
      totalScore: result.totalScore,
      grade: result.grade,
      meaning: result.meaning,
      subjectPosition: positionsForStudent.get(result.subject) || "",
      // The single-figure mirror of the total, for readers that predate the
      // split. `null` — not zero — when the subject is incomplete, so a
      // half-marked subject never reads as a fail.
      score: result.totalScore,
      maxScore: 100,
      remark: "",
      teacher: "",
    }));

    const record = await ReportCard.findOneAndUpdate(
      { schoolId, studentId: draft.student._id, term, academicYear },
      {
        $set: {
          schoolId,
          studentId: draft.student._id,
          className,
          term,
          academicYear,
          subjects,
          average: draft.average,
          position: positions.get(studentKey) ?? null,
          classSize: students.length,
          grade: draft.completedCount ? gradeForScore(draft.average) : "",
          attendance: attendanceByStudent.get(studentKey) || {
            present: 0,
            total: 0,
          },
          status: "review",
          statusChangedAt: new Date(),
          statusChangedBy: userId,
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
    meta: {
      className,
      term,
      academicYear,
      compiled: results.length,
      from: "approved-grades",
    },
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
 * Set the headmaster's remark on every card in a class and term.
 *
 * One call writes the whole class — a remark is a single voice over the whole
 * set, not a per-student sentence the headmaster types thirty times. Applied to
 * every card regardless of state, so it can be written during review and again
 * after a correction.
 */
/**
 * Set the headmaster's remark on every card in a class and term.
 *
 * One call writes the whole class — a remark is a single voice over the whole
 * set, not a per-student sentence the headmaster types thirty times. Applied to
 * every card regardless of state, so it can be written during review and again
 * after a correction.
 */
export const setTeacherRemarkForClass = async (schoolId, userId, payload) => {
  const { className, term, academicYear, text, author } = payload;
  if (!className || !term || !academicYear || !text) {
    throw new ApiError(
      "className, term, academicYear, and text are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const result = await ReportCard.updateMany(
    { schoolId, className, term, academicYear, deletedAt: null },
    {
      $set: {
        teacherRemark: { text: text.trim(), author: (author || "").trim() },
      },
    }
  );

  await auditLog({
    action: AUDIT_ACTIONS.REPORT_CARD_HEAD_REMARK,
    entity: "ReportCard",
    userId,
    schoolId,
    meta: { className, term, academicYear, updated: result.modifiedCount, kind: "teacher" },
  });

  return { updated: result.modifiedCount };
};

export const setHeadRemarkForClass = async (schoolId, userId, payload) => {
  const { className, term, academicYear, text, author } = payload;
  if (!className || !term || !academicYear || !text) {
    throw new ApiError(
      "className, term, academicYear, and text are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const result = await ReportCard.updateMany(
    { schoolId, className, term, academicYear, deletedAt: null },
    {
      $set: {
        headRemark: { text: text.trim(), author: (author || "").trim() },
      },
    }
  );

  await auditLog({
    action: AUDIT_ACTIONS.REPORT_CARD_HEAD_REMARK,
    entity: "ReportCard",
    userId,
    schoolId,
    meta: { className, term, academicYear, updated: result.modifiedCount },
  });

  return { updated: result.modifiedCount };
};

/**
 * Publish every review card for a class and term.
 *
 * The disclosure boundary: parents holding the student's pay link can read a
 * grade from the moment this returns. Refused when there is nothing in `review`
 * to publish — publishing an empty class is a "you have not compiled yet", not a
 * double-click, and answering 200 there would hide the gap.
 *
 * After the state change, each freshly published card is rendered and uploaded
 * to Cloudinary best-effort, so `pdfUrl` resolves for the parent's download. A
 * card whose PDF fails is still published: a missing attachment is not a reason
 * to withhold a term's results.
 */
export const publishClassReports = async (schoolId, userId, payload) => {
  const { className, term, academicYear } = payload;
  if (!className || !term || !academicYear) {
    throw new ApiError(
      "className, term, and academicYear are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const ready = await ReportCard.countDocuments({
    schoolId,
    className,
    term,
    academicYear,
    status: { $in: ["draft", "review"] },
    deletedAt: null,
  });
  if (ready === 0) {
    throw new ApiError(
      "No report cards to publish",
      400,
      "NOTHING_TO_PUBLISH"
    );
  }

  const result = await ReportCard.updateMany(
    { schoolId, className, term, academicYear, status: { $in: ["draft", "review"] }, deletedAt: null },
    {
      $set: {
        status: "published",
        publishedAt: new Date(),
        publishedBy: userId,
        statusChangedAt: new Date(),
        statusChangedBy: userId,
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

  await attachReportCardPdfs(schoolId, { className, term, academicYear });

  return { className, term, academicYear, published: result.modifiedCount };
};

/**
 * Unpublish a class's cards back to `review`.
 *
 * The correction path: the headmaster finds an error after publication and pulls
 * the term back to `review`, fixes it, and republishes. The parent portal reads
 * `status: "published"`, so a card in `review` is invisible again the instant
 * this returns — which is exactly what a parent should see while a term is being
 * corrected.
 */
export const unpublishClassReports = async (schoolId, userId, payload) => {
  const { className, term, academicYear } = payload;
  if (!className || !term || !academicYear) {
    throw new ApiError(
      "className, term, and academicYear are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const result = await ReportCard.updateMany(
    { schoolId, className, term, academicYear, status: "published", deletedAt: null },
    {
      $set: {
        status: "review",
        publishedAt: null,
        publishedBy: null,
        statusChangedAt: new Date(),
        statusChangedBy: userId,
      },
    }
  );

  await auditLog({
    action: AUDIT_ACTIONS.REPORT_CARD_UNPUBLISH,
    entity: "ReportCard",
    userId,
    schoolId,
    meta: { className, term, academicYear, unpublished: result.modifiedCount },
  });

  return { className, term, academicYear, unpublished: result.modifiedCount };
};

/**
 * The headmaster's review queue: every card in `review`, grouped by class, term
 * and year, with the class average. `reviewQueue` answers "what is waiting on me
 * to look at"; the average tells them which class to start with.
 */
export const getReportReviewQueue = async (schoolId, { term, academicYear } = {}) => {
  const match = {
    schoolId: new mongoose.Types.ObjectId(String(schoolId)),
    status: "review",
    deletedAt: null,
  };
  if (term) match.term = term;
  if (academicYear) match.academicYear = academicYear;

  const grouped = await ReportCard.aggregate([
    { $match: match },
    {
      $group: {
        _id: { className: "$className", term: "$term", academicYear: "$academicYear" },
        count: { $sum: 1 },
        average: { $avg: "$average" },
      },
    },
    {
      $project: {
        _id: 0,
        className: "$_id.className",
        term: "$_id.term",
        academicYear: "$_id.academicYear",
        count: 1,
        average: { $round: ["$average", 1] },
      },
    },
    { $sort: { className: 1 } },
  ]);

  return { queue: grouped };
};

/**
 * Render and upload a PDF for each freshly published card, best-effort.
 *
 * Split out so `publishClassReports` stays the state change and this stays the
 * side effect. Each card is wrapped independently: one upload failing must not
 * stop the rest of the class, and none of it may fail the publish, which has
 * already committed. Cards that already carry a `pdfUrl` are skipped so
 * republishing does not churn the CDN.
 */
const attachReportCardPdfs = async (schoolId, { className, term, academicYear }) => {
  let cards;
  let school;
  try {
    school = await School.findById(schoolId).select("name schoolName").lean();
    cards = await ReportCard.find({
      schoolId,
      className,
      term,
      academicYear,
      status: "published",
      pdfUrl: null,
      deletedAt: null,
    }).populate("studentId", "studentName studentId");
  } catch {
    return; // a read failure here must not undo the publish
  }

  for (const card of cards) {
    try {
      const buffer = await generateReportCardPdf(card, { school, student: card.studentId });
      const { url, publicId } = await uploadReportCardPdf(buffer, {
        student: card.studentId,
        term,
        academicYear,
      });
      await ReportCard.updateOne({ _id: card._id }, { $set: { pdfUrl: url, pdfPublicId: publicId } });
    } catch {
      // Best-effort: leave pdfUrl null and keep the published card.
    }
  }
};
