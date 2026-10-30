import cron from "cron";
import { TeacherAttendance } from "../models/TeacherAttendance.js";
import { Timetable } from "../models/Timetable.js";
import { log as auditLog } from "../utils/auditService.js";
import { AUDIT_ACTIONS } from "../config/constants.js";

/**
 * The teacher punctuality sweep.
 *
 * Runs every five minutes to mark periods that have ended and for which the
 * teacher never accepted. A teacher who accepts their period through the
 * dashboard's CurrentPeriodWidget writes `present` or `late` immediately; this
 * job is the backstop that catches the periods nobody clicked.
 *
 * It only writes `missed` records — it never overwrites a `present` or `late`
 * record, so a teacher who accepted late in the day is not un-accepted by the
 * sweep.
 *
 * The sweep is deliberately narrow: it looks at approved/published timetables
 * for the current Accra day, finds periods whose end time has passed, and
 * upserts a `missed` record only when one does not already exist.
 */
const SCHEDULE = "*/5 * * * *";
const TIMEZONE = "Africa/Accra";

/**
 * The current Accra wall-clock, in minutes since midnight.
 *
 * Ghana is UTC+0 and observes no daylight saving, so the conversion is exact
 * rather than approximate. Times stored on periods are wall-clock strings
 * ("8:00 am"), and minutesSinceMidnight is the same wall-clock measure.
 */
const accraNow = () => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Accra",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return hour * 60 + minute;
};

const accraToday = () => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

const parseMinutes = (time) => {
  if (!time) return null;
  const m = String(time).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

export const runTeacherAttendanceSweep = async () => {
  const nowMinutes = accraNow();
  const today = accraToday();

  const timetables = await Timetable.find({
    status: { $in: ["approved", "published"] },
    deactivatedAt: null,
    deletedAt: null,
  })
    .select("_id schoolId className days")
    .lean();

  let marked = 0;
  for (const timetable of timetables) {
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
      const periods = timetable.days?.[day] || [];
      for (const period of periods) {
        const endMinutes = parseMinutes(period.endTime);
        if (endMinutes == null) continue;
        // Only sweep periods that have already ended.
        if (nowMinutes <= endMinutes) continue;

        if (!period.teacherId) continue;

        const existing = await TeacherAttendance.findOne({
          teacherId: period.teacherId,
          date: today,
          timetableId: timetable._id,
          periodNumber: period.period,
        }).lean();

        if (existing) continue;

        try {
          await TeacherAttendance.create({
            schoolId: timetable.schoolId,
            teacherId: period.teacherId,
            date: today,
            timetableId: timetable._id,
            className: timetable.className,
            subject: period.subject,
            periodNumber: period.period,
            status: "missed",
            arrivedAt: null,
            minutesLate: 0,
            markedBy: null,
            markedAt: new Date(),
          });
          marked += 1;
        } catch (err) {
          console.error("[TEACHER-ATTENDANCE-JOB] Failed to create missed record:", err.message);
          continue;
        }
      }
    }
  }

  if (marked > 0) {
    await auditLog({
      action: AUDIT_ACTIONS.TEACHER_ATTENDANCE_SWEEP,
      entity: "TeacherAttendance",
      entityId: null,
      userId: null,
      schoolId: null,
      meta: { marked, date: today.toISOString().slice(0, 10) },
    });
  }

  return { marked };
};

const job = new cron.CronJob(
  SCHEDULE,
  async () => {
    try {
      const result = await runTeacherAttendanceSweep();
      if (result.marked > 0) {
        console.log(`[TEACHER-ATTENDANCE-JOB] Marked ${result.marked} missed period(s)`);
      }
    } catch (error) {
      console.error("[TEACHER-ATTENDANCE-JOB] Sweep failed:", error.message);
    }
  },
  null,
  false,
  TIMEZONE
);

export default job;