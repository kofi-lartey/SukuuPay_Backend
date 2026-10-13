import { Student } from "../../models/studentModel.js";
import { Grade } from "../../models/Grade.js";
import { ReportCard } from "../../models/ReportCard.js";
import { Attendance } from "../../models/Attendance.js";
import {
  loadTeacherScope,
  assertTeacherScope,
} from "../../utils/teacherScope.js";
import {
  resolveTerm,
} from "../parent/portalContext.js";
import {
  resolveTermRange,
  resolveSchoolAcademicYear,
} from "../../utils/termDates.js";
import ApiError from "../../utils/ApiError.js";

/**
 * `"Kwame Mensah"` → `"KM"`.
 *
 * The roster row's avatar text. Exported because the grades grid renders the
 * same avatar for the same students, and the two must agree — two initials
 * helpers is how one screen ends up showing "KM" beside "KM.".
 */
export const initialsOf = (name) =>
  String(name || "")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/**
 * `GET /teacher/classes`
 *
 * The classes this account teaches. Never another teacher's — the list is
 * resolved from `User.assignedClasses` scoped to the caller's own school, so
 * there is no class name in the request for a leak to come through.
 */
export const getMyClasses = async (user) => {
  const { classes } = await loadTeacherScope(user, user.schoolId);
  return { classes };
};

/**
 * `GET /teacher/classes/roster?className=JHS 2A`
 *
 * The students in one class, with enough on each row for the attendance grid
 * to render without a second lookup: the avatar initials and the display id.
 *
 * `_id` is the id the attendance write uses — `TakeAttendance` keys its draft
 * map on it and posts it back as `studentId` — and it is returned alongside
 * the human `studentId` ("JHS/2026/014") without the client ever guessing
 * which one an endpoint wants.
 */
export const getClassRoster = async (user, { className }) => {
  if (!className) {
    throw new ApiError("className is required", 400, "VALIDATION_ERROR");
  }

  await assertTeacherScope(user, user.schoolId, className);

  const students = await Student.find({
    schoolId: user.schoolId,
    studentClass: className,
    deletedAt: null,
    status: "active",
  })
    .select("_id studentId studentName studentImage")
    .sort({ studentName: 1 })
    .lean();

  return {
    className,
    students: students.map((s) => ({
      _id: s._id,
      studentId: s.studentId,
      studentName: s.studentName,
      studentImage: s.studentImage || null,
      initials: initialsOf(s.studentName),
    })),
  };
};

/**
 * How much of a class's register was attended, over the term.
 *
 * The definition is borrowed whole from the parent portal
 * (`parent/attendance.service.js`) rather than re-derived: `excused` and
 * `holiday` marks are outside the denominator, because an excused absence is a
 * day the school agreed the student need not attend and scoring it against the
 * class is how a portal stops being trusted. Parent and teacher must never
 * quote different attendance rates to each other.
 */
const computeAttendanceRate = async (schoolId, className, term, school, academicYear) => {
  const { start, end } = resolveTermRange(term, academicYear, school);

  const records = await Attendance.find({
    schoolId,
    className,
    date: { $gte: start, $lte: end },
    status: { $in: ["present", "late", "absent"] },
    deletedAt: null,
  })
    .select("status")
    .lean();

  if (!records.length) return 0;

  const attended = records.filter(
    (r) => r.status === "present" || r.status === "late"
  ).length;
  return Math.round((attended / records.length) * 1000) / 10;
};

/**
 * `GET /teacher/classes/:className/summary?term=Term 2`
 *
 * "How is this class doing?" in one screen: the average, where it sits among
 * the school's classes, how much of the register was attended, and who the top
 * students are.
 *
 * The average comes from the published report cards when any exist, because
 * those are the numbers the school has already stood behind. When none do it
 * falls back to the grade book, which is what a teacher has actually entered.
 * When neither exists the answer is zeros — a class that has not been assessed
 * *yet* is not an error, and rendering it as one is how a portal trains its
 * users not to trust it.
 *
 * All three paths return the same shape, so the UI never branches.
 */
export const getClassSummary = async (user, className, { term } = {}) => {
  const { school, classes } = await loadTeacherScope(user, user.schoolId);
  if (!classes.some((entry) => entry.className === className)) {
    throw new ApiError("You are not assigned to this class", 403, "FORBIDDEN_SCOPE");
  }

  // Defaulted from the school rather than hard-coded: a Term 3 read must not
  // silently compute Term 3 while showing the number the school calls Term 1.
  const resolvedTerm = resolveTerm(term, school);
  // The academic year a read is for, in the platform's written form — see
  // `resolveSchoolAcademicYear`. The teacher portal reads a *class*, so this is
  // the school's year rather than any one student's recorded one, which is what
  // `resolveAcademicYear` in `parent/portalContext.js` is for.
  const academicYear = resolveSchoolAcademicYear(school);
  const schoolId = user.schoolId;

  const studentCount = await Student.countDocuments({
    schoolId,
    studentClass: className,
    deletedAt: null,
    status: "active",
  });

  const base = {
    className,
    term: resolvedTerm,
    studentCount,
    rankOfClasses: null,
    rankOfTotalClasses: null,
    topStudents: [],
  };

  // ── Published report cards: the school's own answer ──
  const reportCards = await ReportCard.find({
    schoolId,
    className,
    term: resolvedTerm,
    academicYear,
    status: "published",
    deletedAt: null,
  })
    .select("studentId average grade")
    .lean();

  if (reportCards.length) {
    const totalAverage =
      reportCards.reduce((sum, r) => sum + (Number(r.average) || 0), 0) /
      reportCards.length;

    // Rank among the school's classes for the same term and year, so "#3 of 8"
    // is a statement about one term's marks and not about last year's.
    const classAverages = await ReportCard.aggregate([
      {
        $match: {
          schoolId,
          term: resolvedTerm,
          academicYear,
          status: "published",
          deletedAt: null,
        },
      },
      { $group: { _id: "$className", average: { $avg: "$average" } } },
      { $sort: { average: -1 } },
    ]);

    const ranked = [...reportCards]
      .sort((a, b) => (b.average || 0) - (a.average || 0))
      .slice(0, 5);

    // The names, in one query.
    const names = await Student.find({ _id: { $in: ranked.map((r) => r.studentId) } })
      .select("_id studentName")
      .lean();
    const nameById = new Map(names.map((s) => [String(s._id), s.studentName]));

    return {
      ...base,
      average: Math.round(totalAverage * 10) / 10,
      rankOfClasses: classAverages.findIndex((c) => c._id === className) + 1 || null,
      rankOfTotalClasses: classAverages.length,
      attendanceRate: await computeAttendanceRate(
        schoolId,
        className,
        resolvedTerm,
        school,
        academicYear
      ),
      topStudents: ranked.map((r) => ({
        studentId: r.studentId,
        studentName: nameById.get(String(r.studentId)) || "",
        average: Math.round((Number(r.average) || 0) * 10) / 10,
        grade: r.grade || "",
      })),
    };
  }

  // ── The grade book: what the teacher has actually entered ──
  const grades = await Grade.find({
    schoolId,
    className,
    term: resolvedTerm,
    academicYear,
    deletedAt: null,
  })
    .select("studentId score maxScore")
    .lean();

  if (grades.length) {
    // Averaged per student first, then across students: a class where one
    // student has three marks and the rest have one must not let the
    // well-assessed student outvote the rest of the class.
    const perStudent = new Map();
    for (const g of grades) {
      const key = String(g.studentId);
      const list = perStudent.get(key) || [];
      list.push(g);
      perStudent.set(key, list);
    }

    let total = 0;
    for (const [, list] of perStudent) {
      const pct =
        list.reduce((sum, g) => sum + (g.score / (g.maxScore || 100)) * 100, 0) /
        list.length;
      total += pct;
    }

    return {
      ...base,
      average: Math.round((total / perStudent.size) * 10) / 10,
      attendanceRate: await computeAttendanceRate(
        schoolId,
        className,
        resolvedTerm,
        school,
        academicYear
      ),
    };
  }

  // ── Nothing recorded yet ──
  return {
    ...base,
    average: 0,
    attendanceRate: await computeAttendanceRate(
      schoolId,
      className,
      resolvedTerm,
      school,
      academicYear
    ),
  };
};
