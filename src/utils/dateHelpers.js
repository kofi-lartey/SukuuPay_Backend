// ─────────────────────────────────────────────
// Date helpers (Accra / Ghana)
// ─────────────────────────────────────────────
// Ghana observes no daylight saving and sits permanently on UTC+0, so a
// "Ghana local" wall-clock time maps 1:1 onto UTC. Every helper below
// therefore works in UTC and simply avoids shifting the day.
export const ACCRA_TIMEZONE = "Africa/Accra";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const addDays = (date, days) => {
  const base = new Date(date);
  return new Date(base.getTime() + days * MS_PER_DAY);
};

export const addWeeks = (date, weeks) => addDays(date, weeks * 7);

export const addMonths = (date, months) => {
  const base = new Date(date);
  const dayOfMonth = base.getUTCDate();
  // Clamp the day so 31 Jan + 1 month lands on the last day of February
  // rather than rolling over into March.
  const target = new Date(
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth() + months,
      1,
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds()
    )
  );
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return target;
};

// Walks a date forward by whole `interval` steps. "custom" is unsupported on
// its own (custom plans carry explicit due dates) and is treated as a single
// month so the schedule never collapses onto one day.
export const addInterval = (date, interval, steps = 1) => {
  const n = Number(steps) || 0;
  switch (interval) {
    case "weekly":
      return addWeeks(date, n);
    case "biweekly":
      return addWeeks(date, n * 2);
    case "monthly":
    case "custom":
    default:
      return addMonths(date, n);
  }
};

// 00:00 of the given day (used as the anchor for schedule generation).
export const startOfDayAccra = (date) => {
  const d = new Date(date);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)
  );
};

// 23:59 of the given day — the deadline an installment is "due" by.
export const endOfDayAccra = (date) => {
  const d = new Date(date);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 0, 0)
  );
};

// Whole-day difference, ignoring the time of day.
export const differenceInDays = (later, earlier) => {
  const a = startOfDayAccra(later).getTime();
  const b = startOfDayAccra(earlier).getTime();
  return Math.round((a - b) / MS_PER_DAY);
};

export const isPast = (date) => new Date(date).getTime() < Date.now();
