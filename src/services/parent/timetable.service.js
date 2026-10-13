import { Timetable } from "../../models/Timetable.js";
import { log as auditLog } from "../../utils/auditService.js";
import { hashTokenForLog } from "../../utils/tokens.js";
import { colorForSubject } from "../../utils/subjectColors.js";
import { resolveAcademicYear, resolvePortalStudent, resolveTerm } from "./portalContext.js";

/** Weekday keys in the order the portal renders them. Matches `Timetable.days`. */
export const DAY_KEYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/**
 * Ghana observes no daylight saving and is permanently UTC+0, so a lesson at
 * 08:00 is 08:00 every week of the term. The clock is nevertheless read in
 * `Africa/Accra` rather than with `getHours()`, because the process may run in
 * any timezone — a container set to US Eastern would otherwise report a lesson
 * as ongoing five hours late, and nothing on the page would say why.
 */
const ACCRA_TIMEZONE = "Africa/Accra";

/**
 * `"8:00 am"` → minutes since midnight, or `null` if unparseable.
 *
 * Exported because it is the one piece of arithmetic here a test can pin: a
 * malformed period time must be inert rather than NaN, and every comparison
 * against NaN is silently false — which is the desirable failure, but only if it
 * was chosen rather than stumbled into.
 */
export const parsePeriodTime = (text) => {
  if (!text) return null;
  const match = String(text)
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;

  const suffix = match[3];
  if (suffix === "pm" && hours < 12) hours += 12;
  if (suffix === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
};

/**
 * The current weekday name and minute-of-day in Accra.
 *
 * Exported because the teacher schedule needs the *same* clock, and a second
 * implementation of "what time is it in Ghana" is how a parent's timetable
 * ends up showing a lesson as ongoing while the teacher's register for the same
 * lesson says it has not started.
 */
export const accraNow = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ACCRA_TIMEZONE,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const value = (type) => parts.find((p) => p.type === type)?.value;
  // `hour12: false` renders midnight as `24` in some ICU builds.
  const hours = Number(value("hour")) % 24;
  const minutes = Number(value("minute"));

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return { weekday: null, minuteOfDay: null };
  }

  return { weekday: value("weekday"), minuteOfDay: hours * 60 + minutes };
};

/**
 * Whether a period is happening right now.
 *
 * Two conditions, both required: the day must be the weekday that is live
 * (otherwise Tuesday's 08:00–09:30 would glow on a Wednesday morning that
 * happens to fall in the same clock window), and the current minute-of-day must
 * fall inside the period's wall-clock bounds.
 *
 * Exported so the clock logic can be asserted without a database: the service
 * itself is tested through an integration run that stands up a school, but the
 * off-by-one risk here is arithmetic, not authorisation.
 */
export const isOngoing = (period, dayKey, clock) => {
  if (!clock?.weekday || clock.weekday !== dayKey) return false;
  const start = parsePeriodTime(period.startTime);
  const end = parsePeriodTime(period.endTime);
  if (start === null || end === null) return false;
  return clock.minuteOfDay >= start && clock.minuteOfDay <= end;
};

/**
 * The parent's timetable for one student's class.
 *
 * Resolved through `student.studentClass` rather than through the student, so
 * every child in a class reads the same grid and the school maintains one
 * timetable per class per term.
 *
 * Three decisions worth naming:
 *
 *  - **All five weekday keys are always present**, with `[]` for a day with no
 *    lessons. The page renders five tabs unconditionally; a missing key would
 *    make a Thursday with nothing scheduled look like a request that failed.
 *  - **Only published timetables are readable.** `published` is the boundary
 *    between a schedule the school is still editing and one it stands behind.
 *  - **`ongoing` is true only on the current weekday.** Computing it per period
 *    without the weekday would light up Tuesday's first lesson on a Wednesday
 *    morning that happens to fall in the same clock window, and a parent
 *    following a glowing "now" card would be looking at the wrong day.
 */
export const getStudentTimetable = async (token, { weekOf, now } = {}) => {
  const { student, school } = await resolvePortalStudent(token);

  const academicYear = resolveAcademicYear(student, school);
  const currentTerm = resolveTerm(undefined, school);

  const timetable = await Timetable.findOne({
    schoolId: student.schoolId,
    className: student.studentClass,
    academicYear,
    term: currentTerm,
    status: "published",
    deletedAt: null,
  }).lean();

  await auditLog({
    action: "parent.timetable_viewed",
    entity: "Student",
    entityId: student._id,
    schoolId: student.schoolId,
    meta: {
      tokenHash: hashTokenForLog(token),
      term: currentTerm,
      hasTimetable: Boolean(timetable),
    },
  });

  const clock = accraNow(now ? new Date(now) : new Date());

  const days = {};
  for (const key of DAY_KEYS) {
    const periods = timetable?.days?.[key] || [];
    days[key] = periods.map((p) => ({
      period: p.period,
      startTime: p.startTime,
      endTime: p.endTime,
      subject: p.subject,
      subjectColor: colorForSubject(p.subject),
      teacher: p.teacher || "",
      room: p.room || "",
      ongoing: isOngoing(p, key, clock),
    }));
  }

  return {
    studentId: student.studentId,
    studentClass: student.studentClass,
    term: currentTerm,
    // Echoed, not used: the timetable is per term, not per week, and the portal
    // passes the week it is rendering so a future weekly override has somewhere
    // to land without a breaking change.
    weekOf: weekOf ? String(weekOf).slice(0, 10) : new Date().toISOString().slice(0, 10),
    days,
  };
};
