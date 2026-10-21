import { Attendance } from "../../models/Attendance.js";
import { loadStudentScope, assertTeacherScope } from "../../utils/teacherScope.js";
import { resolveTerm } from "../parent/portalContext.js";
import {
  resolveTermRange,
  resolveSchoolAcademicYear,
  isoDay,
} from "../../utils/termDates.js";
import { summariseAttendance } from "../../utils/attendanceRate.js";
import ApiError from "../../utils/ApiError.js";

/**
 * 00:00 UTC of the given day.
 *
 * Ghana is permanently UTC+0, so the Accra calendar day and the UTC calendar
 * day are the same day and a roll taken at 07:30 in Accra is stored as
 * `2026-10-06T00:00:00.000Z` — never rolled back into the 5th the way a
 * European morning would be. Normalising here means a request carrying `07:00`
 * on the 6th and one carrying `10:30` on the 6th land on the same row, which is
 * the entire reason `Attendance` can be keyed on a date at all.
 */
const startOfDay = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new ApiError("That date could not be read", 400, "INVALID_DATE");
  }
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

/**
 * `GET /teacher/attendance?className=JHS 2A&date=2026-10-07`
 *
 * Every mark already recorded for the class on the given date, so the register
 * screen can hydrate its local draft instead of overwriting a teacher's earlier
 * work with an empty sheet.
 *
 * `[]` when nothing has been marked yet, and that is a normal answer rather
 * than an error: the first roll of a day is taken on an empty register. It is
 * not a 404 either — the class exists and is the teacher's, it simply has no
 * marks to show.
 */
export const getAttendanceForDate = async (user, { className, date }) => {
  if (!className || !date) {
    throw new ApiError(
      "className and date are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  await assertTeacherScope(user, user.schoolId, className);

  const day = startOfDay(date);

  const records = await Attendance.find({
    schoolId: user.schoolId,
    className,
    date: day,
    deletedAt: null,
  })
    .select("studentId status arrivalTime note autoMarked markedAt")
    .sort({ studentId: 1 })
    .lean();

  return {
    className,
    date: isoDay(day),
    marks: records.map((r) => ({
      studentId: r.studentId,
      status: r.status,
      arrivalTime: r.arrivalTime || null,
      note: r.note || "",
      autoMarked: Boolean(r.autoMarked),
      markedAt: r.markedAt || null,
    })),
  };
};

/**
 * `GET /teacher/students/:studentId/attendance?term=Term 2`
 *
 * One student's register — the drawer a teacher opens by tapping a name on the
 * roster. Scoped through the student's own class, so the 403 comes from
 * `loadStudentScope` rather than from a class name the caller typed.
 *
 * The term bounds resolve through the same `resolveTermRange` the parent portal
 * uses, so the teacher's summary and the parent's calendar describe the same
 * set of days.
 */
export const getStudentAttendance = async (user, studentId, { term } = {}) => {
  const { student, school } = await loadStudentScope(user, user.schoolId, studentId);

  const resolvedTerm = resolveTerm(term, school);
  // The **school's** year, not the student's own `academicYear` — and the same
  // one the class summary uses (`classes.service.js`), so the teacher's per-
  // student drawer and the class rate beside it describe the same term.
  //
  // The two used to be read from different places: the term from the school,
  // the year from the student. A term and the year it sits in are one thing,
  // and the student's field is written when they are enrolled and never
  // refreshed when the school rolls over its academic year — so a school that
  // moved to 2026/2027 still had students carrying "2025/2026", and the window
  // landed in the previous September while the register was being taken now.
  const academicYear = resolveSchoolAcademicYear(school);
  const { start, end } = resolveTermRange(resolvedTerm, academicYear, school);

  const records = await Attendance.find({
    studentId: student._id,
    date: { $gte: start, $lte: end },
    deletedAt: null,
  })
    .sort({ date: 1 })
    .lean();

  // One definition of the rate, shared with the parent portal — see
  // `utils/attendanceRate.js`. A `late` mark is an attendance; `excused` and
  // `holiday` are days the family is not scored on.
  const summary = summariseAttendance(records);

  return {
    studentId: student.studentId,
    studentName: student.studentName,
    studentClass: student.studentClass,
    term: resolvedTerm,
    summary: {
      rate: summary.rate,
      present: summary.present,
      late: summary.late,
      absent: summary.absent,
      excused: summary.excused,
      totalDays: summary.totalDays,
    },
    recent: records
      .slice(-10)
      .reverse()
      .map((r) => ({
        date: isoDay(r.date),
        status: r.status,
        note: r.note || "",
      })),
  };
};
