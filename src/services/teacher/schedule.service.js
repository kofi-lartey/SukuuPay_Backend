import { Timetable } from "../../models/Timetable.js";
import { TeacherAttendance } from "../../models/TeacherAttendance.js";
import {
  loadTeacherScope,
  assertTeacherScope,
} from "../../utils/teacherScope.js";
import { colorForSubject } from "../../utils/subjectColors.js";
import { DAY_KEYS, parsePeriodTime, accraNow } from "../parent/timetable.service.js";
import { Attendance } from "../../models/Attendance.js";
import { isoDay, resolveSchoolAcademicYear } from "../../utils/termDates.js";
import { resolveTerm } from "../parent/portalContext.js";

/** The Accra day boundary; `Attendance.date` rows are stored on it. */
const startOfAccraToday = () => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

const isSameName = (a, b) =>
  String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

const fold = (value) => String(value || "").trim().toLowerCase();

/**
 * Whether one period belongs to this teacher.
 *
 * **A named period belongs to the teacher whose name it carries.** That is the
 * only teacher↔period link the data model has — `Timetable.days.<day>[].teacher`
 * is a free-text display name (`Timetable.js:29`), not a reference — and a name
 * match is authoritative: a school that filled the column in should get exactly
 * the answer it asked for, and a subject teacher must not be shown a
 * colleague's lesson.
 *
 * **An unnamed period belongs to the teacher assigned to that subject in that
 * class.** `teacher` defaults to `""` (`Timetable.js:29`), and a school that
 * publishes a grid without filling the column is the common case, not the
 * exotic one. Without this second rule every such teacher sees an empty week,
 * which reads to them as a bug in the portal rather than as a gap in their
 * school's data entry — and there is nothing on the screen that would tell them
 * the difference.
 *
 * The attribution is by *subject*, not by class, because the alternative is the
 * failure mode worth naming: a teacher assigned to take Mathematics in JHS 2A
 * would otherwise be shown every unnamed period in JHS 2A, including the
 * Chemistry they do not teach. An unnamed period with a subject nobody at the
 * school has assigned to this teacher belongs to nobody.
 */
const isMyPeriod = (period, teacherName, mySubjects, ownsTimetable) => {
  if (!period?.subject) return false;

  // The teacher who submitted a timetable owns every period in it, so their
  // schedule is not empty even when no individual period names them.
  if (ownsTimetable) return true;

  if (period.teacher) return isSameName(period.teacher, teacherName);

  const assigned = (mySubjects || []).map(fold);
  return assigned.includes(fold(period.subject));
};

/**
 * `GET /teacher/schedule`
 *
 * The teacher's week, flattened into one array of periods.
 *
 * A teacher teaches several classes, so their week is the union of those
 * classes' published timetables filtered to the periods this teacher is named
 * against. Returned flat rather than nested by day: the page groups by day
 * itself, and reshaping a flat list is cheaper than un-reshaping a nested one.
 *
 * ## How a period is known to be this teacher's
 *
 * `Timetable.days.<day>[].teacher` is a free-text *name*, not a reference — the
 * only teacher↔class link that exists in this data model. So a period the
 * school has named belongs to that teacher, and a period it has left unnamed
 * belongs to whoever is assigned to its subject in that class. See
 * `isMyPeriod` for why the second half matters: `teacher` defaults to `""`, so
 * without it every teacher in a school that never filled the column in sees an
 * empty week.
 *
 * ## What `status` means
 *
 * Attendance is recorded per *class* per *day*, not per period, so a period's
 * status is honest about that: on today's weekday, a period is `marked` when the
 * class has any attendance row for today, `missed` when it has none and the
 * period has already ended, `pending` while it is running, and `upcoming` before
 * it starts. Every other weekday is `upcoming`.
 */
export const getTeacherSchedule = async (user) => {
  const { school, classes } = await loadTeacherScope(user, user.schoolId);
  if (!classes.length) return { schedule: [] };

  const classNames = classes.map((entry) => entry.className);
  const teacherName = user.name;

  const term = resolveTerm(undefined, school);
  const academicYear = resolveSchoolAcademicYear(school);

  // Scoped to the *current* term and year as well as the class. Without both,
  // a class promoted from one term's timetable to the next would return two
  // documents per class — the unique index is { schoolId, className, term,
  // academicYear } — and every period would appear twice.
  const timetables = await Timetable.find({
    schoolId: user.schoolId,
    className: { $in: classNames },
    term,
    academicYear,
    deletedAt: null,
    deactivatedAt: null,
    $or: [
      { status: "published" },
      { submissionStatus: "approved" },
    ],
  }).lean();

  const clock = accraNow();

  // The subjects this teacher is assigned to, per class, so an unnamed period
  // can be attributed by subject rather than by name.
  const subjectsByClass = new Map(
    classes.map((entry) => [entry.className, entry.subjects])
  );

  const flat = [];
  for (const timetable of timetables) {
    const mySubjects = subjectsByClass.get(timetable.className) || [];
    const ownsTimetable = isSameName(timetable.teacherName, teacherName);
    for (const day of DAY_KEYS) {
      const periods = timetable.days?.[day] || [];
      for (const p of periods) {
        if (!isMyPeriod(p, teacherName, mySubjects, ownsTimetable)) continue;

        const start = parsePeriodTime(p.startTime);
        const end = parsePeriodTime(p.endTime);

        flat.push({
          day,
          timetableId: timetable._id,
          className: timetable.className,
          subject: p.subject,
          subjectColor: colorForSubject(p.subject),
          startTime: p.startTime,
          endTime: p.endTime,
          room: p.room || "",
          period: p.period,
          ongoing: clock.weekday === day && start != null && end != null
            ? clock.minuteOfDay >= start && clock.minuteOfDay <= end
            : false,
          status: "upcoming",
        });
      }
    }
  }

  // Weekday first, then wall-clock start. A period with an unreadable time
  // sorts to the top of its day rather than dropping to the bottom on a NaN
  // comparison.
  flat.sort((a, b) => {
    const dayDiff = DAY_KEYS.indexOf(a.day) - DAY_KEYS.indexOf(b.day);
    if (dayDiff !== 0) return dayDiff;
    return (parsePeriodTime(a.startTime) ?? -1) - (parsePeriodTime(b.startTime) ?? -1);
  });

  const markedToday = await Attendance.distinct("className", {
    schoolId: user.schoolId,
    className: { $in: classNames },
    date: startOfAccraToday(),
    deletedAt: null,
  });
  const markedSet = new Set(markedToday);

  // The teacher's own punctuality for today's periods, so the dashboard's
  // "Accept Class" button does not reappear after a reload. Keyed by
  // timetable + period, which is the unique key `TeacherAttendance` writes.
  const acceptedToday = await TeacherAttendance.find({
    teacherId: user._id,
    date: startOfAccraToday(),
    deletedAt: null,
  }).lean();
  const acceptedByPeriod = new Map(
    acceptedToday.map((row) => [
      `${row.timetableId}|${row.periodNumber}`,
      row.status,
    ])
  );

  for (const period of flat) {
    if (period.day !== clock.weekday) continue;

    const start = parsePeriodTime(period.startTime);
    const end = parsePeriodTime(period.endTime);
    if (start == null || end == null) {
      // A period the school never gave times cannot be "missed" — there is no
      // moment at which it was due.
      period.status = "pending";
      continue;
    }

    const accepted = acceptedByPeriod.get(`${period.timetableId}|${period.period}`);
    if (accepted) {
      period.status = accepted;
      period.accepted = true;
      continue;
    }

    const marked = markedSet.has(period.className);
    if (clock.minuteOfDay > end) {
      period.status = marked ? "marked" : "missed";
    } else if (clock.minuteOfDay >= start) {
      period.status = marked ? "marked" : "pending";
    }
  }

  return {
    term,
    schedule: flat,
  };
};
