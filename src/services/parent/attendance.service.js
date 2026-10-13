import { Attendance } from "../../models/Attendance.js";
import { log as auditLog } from "../../utils/auditService.js";
import { hashTokenForLog } from "../../utils/tokens.js";
import { isoDay, daysBetween, resolveTermRange } from "../../utils/termDates.js";
import { isWithinRadius } from "../../utils/geoDistance.js";
import { resolveAcademicYear, resolvePortalStudent, resolveTerm } from "./portalContext.js";

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
 */
export const getStudentAttendanceForTerm = async (token, { term } = {}) => {
  const { student, school } = await resolvePortalStudent(token);

  const requestedTerm = resolveTerm(term, school);
  const academicYear = resolveAcademicYear(student, school);
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
        label: monthLabel(day),
        present: 0,
        late: 0,
        absent: 0,
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

    bucket.days.push({ date: iso, day: day.getUTCDate(), status, isToday: iso === todayIso });
  }

  const months = [...monthsMap.values()].reverse();

  const present = records.filter((r) => r.status === "present").length;
  const late = records.filter((r) => r.status === "late").length;
  const absent = records.filter((r) => r.status === "absent").length;
  // `excused` and `holiday` marks are not counted in the denominator either: an
  // excused absence is a day the school agreed the student need not attend, and
  // scoring it against the family is how a portal stops being trusted.
  const totalDays = present + late + absent;
  const rate = totalDays > 0 ? Math.round((present / totalDays) * 1000) / 10 : 0;

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
    term: requestedTerm,
    summary: { rate, present, late, absent, totalDays },
    months,
    recent,
  };
};
