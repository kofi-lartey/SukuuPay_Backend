import { Attendance } from "../../models/Attendance.js";
import { Grade } from "../../models/Grade.js";
import { ReportCard } from "../../models/ReportCard.js";
import { loadTeacherScope } from "../../utils/teacherScope.js";
import { resolveTerm } from "../parent/portalContext.js";
import { isoDay, resolveSchoolAcademicYear } from "../../utils/termDates.js";

/** Weekday names, in the order the register is kept. */
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * The current weekday and calendar day, both read in Accra.
 *
 * The weekday is read through `Intl` with an explicit `Africa/Accra` zone
 * rather than with `getDay()`, because the process may run in any timezone: a
 * container set to US Eastern would call a Monday afternoon a Sunday evening
 * and every teacher would be told the wrong day's attendance was pending.
 * Ghana observes no daylight saving, so no branch is needed.
 *
 * The date is normalised to 00:00 UTC, which *is* Accra midnight (UTC+0), so it
 * matches the `date` values `Attendance` rows are stored with.
 */
const accraToday = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Accra",
    weekday: "long",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;

  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);

  return { weekday, date };
};

/**
 * `GET /teacher/dashboard`
 *
 * The teacher's home summary. Every figure on it is *derived* — there is no
 * stored counter to go stale — so it stays correct as marks and grades
 * accumulate, and a school that has never taken a register sees zeros rather
 * than an error.
 *
 * Three pending counts, each answering a question a teacher opens the portal
 * to ask: has anyone marked the register today, has a class gone ungraded this
 * term, and is there a compiled report card a headteacher has not published.
 */
export const getTeacherDashboard = async (user) => {
  const { school, classes } = await loadTeacherScope(user, user.schoolId);
  const classNames = classes.map((entry) => entry.className);
  const { weekday, date } = accraToday();
  const term = resolveTerm(undefined, school);
  const academicYear = resolveSchoolAcademicYear(school);

  // Classes already marked today, in one distinct query across all of them.
  const markedToday = classNames.length
    ? await Attendance.distinct("className", {
        schoolId: user.schoolId,
        className: { $in: classNames },
        date,
        deletedAt: null,
      })
    : [];
  const markedSet = new Set(markedToday);
  const pendingAttendance = classNames.filter((name) => !markedSet.has(name)).length;

  // Classes with no grade book rows for this term and year at all. Counted per
  // class rather than per student-on-subject, because the honest per-student
  // answer is a cross-product nobody can act on, and a class that has not been
  // graded *at all* is the one that needs chasing.
  const gradedThisTerm = classNames.length
    ? await Grade.distinct("className", {
        schoolId: user.schoolId,
        className: { $in: classNames },
        term,
        academicYear,
        deletedAt: null,
      })
    : [];
  const gradedSet = new Set(gradedThisTerm);
  const pendingGrades = classNames.filter((name) => !gradedSet.has(name)).length;

  // Report cards a teacher has compiled and a headteacher has not published.
  const draftReports = classNames.length
    ? await ReportCard.countDocuments({
        schoolId: user.schoolId,
        className: { $in: classNames },
        status: "draft",
        deletedAt: null,
      })
    : 0;

  const pending = [];
  if (pendingAttendance > 0) {
    pending.push({
      id: "attendance",
      label: `${pendingAttendance} ${
        pendingAttendance === 1 ? "class has" : "classes have"
      } attendance pending today`,
      to: "/teacher/attendance",
    });
  }
  if (pendingGrades > 0) {
    pending.push({
      id: "grades",
      label: `${pendingGrades} ${
        pendingGrades === 1 ? "class has" : "classes have"
      } no grades entered this term`,
      to: "/teacher/grades",
    });
  }
  if (draftReports > 0) {
    pending.push({
      id: "records",
      label: `${draftReports} report ${
        draftReports === 1 ? "card is" : "cards are"
      } awaiting publication`,
      to: "/teacher/records",
    });
  }

  return {
    teacherName: user.name,
    classCount: classes.length,
    totalStudents: classes.reduce((sum, entry) => sum + entry.studentCount, 0),
    today: weekday || DAY_NAMES[new Date().getDay()],
    date: isoDay(date),
    term,
    pendingAttendance,
    pendingGrades,
    pending,
  };
};
