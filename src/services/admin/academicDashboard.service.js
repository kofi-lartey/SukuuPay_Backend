import mongoose from "mongoose";
import { ReportCard } from "../../models/ReportCard.js";
import { Grade } from "../../models/Grade.js";
import { Attendance } from "../../models/Attendance.js";
import { Student } from "../../models/studentModel.js";
import { School } from "../../models/schoolModel.js";
import { resolveTermRange } from "../../utils/termDates.js";

/**
 * School-wide academic oversight for the headmaster.
 *
 * One live payload — totals, the review state of every grade and report card,
 * each class's standing, and the top pupils — because a headmaster checking
 * "how is the school doing" while marks are still going in must not be shown a
 * number that lags: nothing here is cached, and every figure is computed from
 * the collections on request.
 *
 * A note on attendance, which is the one place this is not a plain count:
 * `Attendance` is keyed by `date` and has no `term`. Attendance *rate* for a
 * term therefore tallies over the term's date window, derived with
 * `resolveTermRange` from the same source the report cards use — never a
 * `term`-equality match, which would silently match nothing. Without a term in
 * the query the rate is taken over all attendance the school has.
 */

export const getAcademicOverview = async (schoolId, { term, academicYear } = {}) => {
  const schoolObjectId = new mongoose.Types.ObjectId(String(schoolId));

  // The school carries the class list (a class is a name, not a document) and
  // the term calendar the attendance window is derived from. Both come from the
  // one read.
  const school = await School.findById(schoolObjectId).select("academic").lean();
  const totalClasses = Array.isArray(school?.academic?.classes)
    ? school.academic.classes.length
    : 0;
  const totalStudents = await Student.countDocuments({
    schoolId: schoolObjectId,
    deletedAt: null,
    status: "active",
  });

  // ── Report cards by status ──
  const rcFilter = { schoolId: schoolObjectId, deletedAt: null };
  if (term) rcFilter.term = term;
  if (academicYear) rcFilter.academicYear = academicYear;
  const reportCardStatus = await ReportCard.aggregate([
    { $match: rcFilter },
    { $group: { _id: "$status", count: { $sum: 1 }, average: { $avg: "$average" } } },
  ]);

  // ── Grades by approval status ──
  const gradeFilter = { schoolId: schoolObjectId, deletedAt: null };
  if (term) gradeFilter.term = term;
  if (academicYear) gradeFilter.academicYear = academicYear;
  const gradeStatus = await Grade.aggregate([
    { $match: gradeFilter },
    { $group: { _id: "$approvalStatus", count: { $sum: 1 } } },
  ]);

  // ── Attendance rate ──
  const attendanceMatch = {
    schoolId: schoolObjectId,
    deletedAt: null,
    status: { $in: ["present", "late", "absent"] },
  };
  if (term) {
    const { start, end } = resolveTermRange(term, academicYear, school);
    attendanceMatch.date = { $gte: start, $lte: end };
  }
  const attendance = await Attendance.aggregate([
    { $match: attendanceMatch },
    {
      $group: {
        _id: null,
        present: { $sum: { $cond: [{ $in: ["$status", ["present", "late"]] }, 1, 0] } },
        total: { $sum: 1 },
      },
    },
  ]);
  const attendanceRate =
    attendance[0]?.total > 0
      ? Math.round((attendance[0].present / attendance[0].total) * 1000) / 10
      : 0;

  // ── Class averages and top students, from published cards only ──
  const publishedFilter = { schoolId: schoolObjectId, status: "published", deletedAt: null };
  if (term) publishedFilter.term = term;
  if (academicYear) publishedFilter.academicYear = academicYear;

  const classAverages = await ReportCard.aggregate([
    { $match: publishedFilter },
    { $group: { _id: "$className", average: { $avg: "$average" }, count: { $sum: 1 } } },
    { $sort: { average: -1 } },
    { $project: { _id: 0, className: "$_id", average: { $round: ["$average", 1] }, count: 1 } },
  ]);

  const topStudents = await ReportCard.find(publishedFilter)
    .sort({ average: -1 })
    .limit(10)
    .populate("studentId", "studentName studentId studentClass")
    .select("studentId average grade className")
    .lean();

  return {
    term,
    academicYear,
    totals: {
      students: totalStudents,
      classes: totalClasses,
      attendanceRate,
    },
    reportCards: Object.fromEntries(
      reportCardStatus.map((s) => [
        s._id,
        { count: s.count, average: Math.round((s.average || 0) * 10) / 10 },
      ])
    ),
    grades: Object.fromEntries(gradeStatus.map((s) => [s._id, s.count])),
    classAverages,
    topStudents: topStudents.map((s) => ({
      studentName: s.studentId?.studentName || "",
      studentId: s.studentId?.studentId || "",
      className: s.className,
      average: s.average,
      grade: s.grade,
    })),
  };
};
