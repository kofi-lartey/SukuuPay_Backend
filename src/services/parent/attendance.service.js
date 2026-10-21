import { Attendance } from "../../models/Attendance.js";
import { log as auditLog } from "../../utils/auditService.js";
import { hashTokenForLog } from "../../utils/tokens.js";
import { isoDay, daysBetween, resolveTermRange, resolveSchoolAcademicYear } from "../../utils/termDates.js";
import { summariseAttendance } from "../../utils/attendanceRate.js";
import { isWithinRadius } from "../../utils/geoDistance.js";
import { resolvePortalStudent, resolveTerm } from "./portalContext.js";

/**
 * Whether a handset is inside the school's geofence.
 *
 * Re-exported from `utils/geoDistance.js` so the admin auto-mark service can
 * ask the same question the parent-facing check-in does, without importing
 * across layers. The arithmetic lives in the util; this is the name the
 * attendance domain uses for it.
 */
export const isWithinSchoolRadius = (studentLocation, schoolLocation, meters = 200) =>
  isWithinRadius(studentLocation, schoolLocation, meters);

/** `October 2026` — the label each month block in the parent calendar prints. */
const monthLabel = (date) =>
  date.toLocaleString("en-GB", { month: "long", year: "numeric" });

/** `7:35 am` — how an arrival time is shown beside a late mark. */
const clockLabel = (date) =>
  new Date(date).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

/**
 * The parent's attendance view for one student, one term.
 *
 * Two things this endpoint decides that a naive implementation gets wrong:
 *
 *  1. **It renders every day of the term, not only the days that were marked.**
 *     A calendar with holes in it reads as missing data, and a parent cannot
 *     tell "the school did not take the register on the 14th" from "the register
 *     for the 14th has not loaded". So the whole range is walked and each day is
 *     given a status — a real mark where one exists, `future` for a day that has
 *     not happened, `holiday` for a weekend.
 *
 *  2. **Weekends and future days are not absences.** They are excluded from the
 *     rate, which is computed from `present + late + absent` — the days that
 *     were actually marked. A term with 60 school days and 120 weekend days must
 *     not report a 33% attendance rate.
 *
 * ## Which term is shown
 *
 * The term is the one the caller asks for, and when the caller does not ask for
 * one it is **the school's current term** — `school.academic.currentTerm`, the
 * same value the school's own Settings screen writes and the same one the
 * teacher portal, the timetable and the report cards resolve against. The
 * caller is expected to ask for the school's current term too; the client that
 * renders this page defaults its term picker to that value for exactly this
 * reason, because a page that quietly shows Term 1 while the school is in Term
 * 2 is a page that looks like the teacher's marks have gone missing.
 *
 * The **year** comes from the school as well, and for the same reason: a term
 * and the year it sits in are one thing, and the school is the only party that
 * knows which of the two it is currently running. See the comment at the
 * resolution below for what happens when the two are read from different
 * places.
 *
 * The resolved term is echoed back in the response, together with the academic
 * year and the term's date range, so the client never has to re-derive which
 * window it is looking at.
 */
export const getStudentAttendanceForTerm = async (token, { term } = {}) => {
  const { student, school } = await resolvePortalStudent(token);

  const requestedTerm = resolveTerm(term, school);

  /*
    The year is the **school's**, not the student's — and that is the whole
    point of the next line.

    A term and the year it sits in are one thing: "Term 1 of 2026/2027". The
    term comes from the school (`school.academic.currentTerm`, the same value
    the Settings screen writes), so the year has to come from the school too
    (`school.academic.currentYear`). Taking the term from the school and the
    year from the student's own `academicYear` field produced a window that was
    not the school's term at all.

    And the student's field goes stale: it is written when the student is
    enrolled or imported and is never refreshed when the school rolls over its
    academic year, so a school that started in 2025/2026 and moved to 2026/2027
    in September still had every student carrying "2025/2026". The window then
    became September–December **2025** while the teachers were taking registers
    for October **2026**, and every mark fell outside it — the calendar
    rendered, the rate read 0%, and the marks looked like they had never been
    taken.

    `Student.academicYear` is the year a student's *record* belongs to — the
    report card compiled for them, the cohort they graduated in. The register
    being taken this morning belongs to the term the school is running now.
  */
  const academicYear = resolveSchoolAcademicYear(school);
  const { start, end } = resolveTermRange(requestedTerm, academicYear, school);

  const records = await Attendance.find({
    studentId: student._id,
    date: { $gte: start, $lte: end },
    deletedAt: null,
  })
    .sort({ date: 1 })
    .lean();

  await auditLog({
    action: "parent.attendance_viewed",
    entity: "Student",
    entityId: student._id,
    schoolId: student.schoolId,
    meta: { tokenHash: hashTokenForLog(token), term: requestedTerm },
  });

  const markedByDay = new Map(records.map((r) => [isoDay(r.date), r]));
  const todayIso = isoDay(new Date());

  // Grouped by month, newest first: a term spans two or three calendar months
  // and the page renders them as separate blocks, so the grouping is done here
  // rather than in the client — which would otherwise need the term's date range
  // to do it.
  const monthsMap = new Map();
  for (const day of daysBetween(start, end)) {
    const iso = isoDay(day);
    const key = iso.slice(0, 7);

    if (!monthsMap.has(key)) {
      monthsMap.set(key, {
        // `key` is the month's identity — `2026-10`. The client keys the
        // expanded month on it rather than on its position in the list, so
        // switching term does not leave the wrong month open, and so the
        // "current month" can be found without matching on a display label.
        key,
        label: monthLabel(day),
        present: 0,
        late: 0,
        absent: 0,
        excused: 0,
        days: [],
      });
    }
    const bucket = monthsMap.get(key);

    const record = markedByDay.get(iso);
    const isWeekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
    const isFuture = iso > todayIso;

    let status;
    if (record) status = record.status;
    else if (isFuture) status = "future";
    else status = "holiday";

    if (status === "present") bucket.present += 1;
    else if (status === "late") bucket.late += 1;
    else if (status === "absent") bucket.absent += 1;
    else if (status === "excused") bucket.excused += 1;

    bucket.days.push({ date: iso, day: day.getUTCDate(), status, isToday: iso === todayIso });
  }

  const months = [...monthsMap.values()].reverse();

  // One definition of the rate, shared with the teacher's own view — see
  // `utils/attendanceRate.js`. A `late` mark is an attendance; an `excused` day
  // and a `holiday` are days the family is not scored on.
  const summary = summariseAttendance(records);

  const recent = records
    .slice(-10)
    .reverse()
    .map((r) => ({
      date: isoDay(r.date),
      status: r.status,
      // "Arrived 7:42 am" is the note a late mark needs and the one a teacher
      // rarely types, so it is derived from the arrival time when there is none.
      note: r.note || (r.arrivalTime ? `Arrived ${clockLabel(r.arrivalTime)}` : null),
    }));

  return {
    studentId: student.studentId,
    studentName: student.studentName,
    studentClass: student.studentClass,
    // The term this answer is about, the year it belongs to, and the window it
    // covers — so the client renders the right pills and can say which dates it
    // is talking about without asking the server twice.
    term: requestedTerm,
    academicYear,
    range: { start: isoDay(start), end: isoDay(end) },
    // The school's current date, as the server sees it. The client rings this
    // day in the calendar and opens the month it falls in, and it does so from
    // this value rather than from the browser's clock — a parent's handset in
    // another timezone must still open on the school's day.
    today: todayIso,
    summary: {
      rate: summary.rate,
      present: summary.present,
      late: summary.late,
      absent: summary.absent,
      excused: summary.excused,
      totalDays: summary.totalDays,
    },
    months,
    recent,
  };
};
