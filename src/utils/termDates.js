/**
 * Term date ranges.
 *
 * A school either has explicit `academic.terms` on its record, or falls back to
 * the Ghanaian Basic school default. Both paths return the same shape so
 * callers never branch.
 *
 * The defaults are the GES calendar for a school whose academic year is written
 * "2026/2027" — Term 1 from August to mid-November, Term 2 from January to
 * mid-April, Term 3 from late April to the end of July. They are a *fallback*,
 * not a rule: the term's `endMonth`/`endDay` are what bounds the attendance
 * calendar a parent sees, and a school that breaks up on a different date sets
 * its own terms rather than living with the default.
 *
 * Note the asymmetry between the two paths, which is deliberate. An explicit
 * range is taken verbatim — the school said what it said. A default range is
 * built from the *start* year of the academic year string, because Term 2 and
 * Term 3 of "2026/2027" both fall in calendar 2027; deriving them from the end
 * year would push Term 1 a full year into the future.
 */
const DEFAULT_TERMS = {
  "Term 1": { startMonth: 8, startDay: 1, endMonth: 11, endDay: 15 },
  "Term 2": { startMonth: 0, startDay: 5, endMonth: 3, endDay: 15 },
  "Term 3": { startMonth: 3, startDay: 20, endMonth: 6, endDay: 30 },
};

export const resolveTermRange = (term, academicYear, school) => {
  const explicit = school?.academic?.terms?.find((t) => t.name === term);
  if (explicit?.startDate && explicit?.endDate) {
    return { start: new Date(explicit.startDate), end: new Date(explicit.endDate) };
  }

  const [startYear] = String(academicYear || "").split("/");
  const year = Number(startYear) || new Date().getFullYear();
  const range = DEFAULT_TERMS[term] || DEFAULT_TERMS["Term 1"];

  const start = new Date(Date.UTC(year, range.startMonth, range.startDay));
  const end = new Date(Date.UTC(year, range.endMonth, range.endDay));
  return { start, end };
};

/**
 * Every UTC day from `start` to `end`, inclusive.
 *
 * The cursor is advanced on the UTC date rather than by adding 86,400,000ms,
 * which would drift by an hour on the day a DST boundary is crossed and by a
 * leap second more often than that. `daysBetween` is the shape the attendance
 * calendar needs: one entry per day the register *could* have been marked,
 * whether or not it was.
 */
export const daysBetween = (start, end) => {
  const days = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor <= end) {
    days.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
};

/** `2026-10-06` — the ISO day a Date falls on in UTC. */
export const isoDay = (date) => new Date(date).toISOString().slice(0, 10);

/** `2026/2027` — the one written form the platform's academic years take. */
const SLASHED_YEAR = /^(\d{4})\/(\d{4})$/;
const BARE_YEAR = /^(\d{4})$/;

/**
 * The academic year the school is currently in, in the platform's written form.
 *
 * **Why this exists rather than `school.academic.currentYear` read directly.**
 *
 * Every write path in the platform constrains its academic year to `YYYY/YYYY`:
 * `Timetable` (`admin.timetable.validation.js:4`), `ReportCard` and `Student`
 * (`student.validation.js:50`), and the school's own settings flow
 * (`settings.validation.js:36`). But the *schema default* for
 * `School.academic.currentYear` is a bare calendar year — `"2026"`
 * (`schoolModel.js:365`) — and nothing migrates it.
 *
 * The result is two different values meaning the same year: a school that has
 * never opened the academic-year settings screen has `"2026"` on its record and
 * `"2026/2027"` on every timetable, report card and student. Any read that
 * filters on the raw stored string matches nothing at all, and does so
 * silently — the teacher's schedule comes back empty and the class summary
 * quietly loses its rank and top students, with no error anywhere to explain
 * why. A bare `"2026"` is therefore read as the school intending the academic
 * year that *starts* in 2026, which is the only sensible expansion: Ghana's
 * academic year 2026/2027 begins in August 2026, so the start year is the one
 * the default carries.
 *
 * Unreadable values fall back to the current calendar year rather than throwing
 * — a school record nobody has filled in should still produce a usable
 * calendar, not a 500.
 */
export const resolveSchoolAcademicYear = (school, now = new Date()) => {
  const raw = String(school?.academic?.currentYear || "").trim();

  const slashed = raw.match(SLASHED_YEAR);
  if (slashed) return raw;

  const bare = raw.match(BARE_YEAR);
  if (bare) return `${bare[1]}/${Number(bare[1]) + 1}`;

  const year = now.getFullYear();
  return `${year}/${year + 1}`;
};

export default { resolveTermRange, daysBetween, isoDay, resolveSchoolAcademicYear };
