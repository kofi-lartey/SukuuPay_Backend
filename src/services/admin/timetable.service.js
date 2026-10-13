import { Timetable } from "../../models/Timetable.js";
import { School } from "../../models/schoolModel.js";
import { log as auditLog } from "../../utils/auditService.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import ApiError from "../../utils/ApiError.js";

/** The five days a Ghanaian basic school has lessons. Weekends are never scheduled. */
const VALID_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/**
 * Normalise incoming `days` to the stored shape.
 *
 * Extracted from `upsertTimetable` so the shape rule is testable without a
 * database: a period with no subject, start or end is dropped, every weekday is
 * present as an array, and periods are sorted by `period`.
 */
export const normalizeDays = (days) => {
  const normalised = {};
  for (const day of VALID_DAYS) {
    const periods = Array.isArray(days?.[day]) ? days[day] : [];
    normalised[day] = periods
      .map((p) => ({
        period: Number(p.period),
        startTime: String(p.startTime || "").trim(),
        endTime: String(p.endTime || "").trim(),
        subject: String(p.subject || "").trim(),
        teacher: String(p.teacher || "").trim(),
        room: String(p.room || "").trim(),
      }))
      .filter((p) => p.subject && p.startTime && p.endTime && Number.isFinite(p.period))
      .sort((a, b) => a.period - b.period);
  }
  return normalised;
};

/**
 * Create or replace a class's timetable for one term.
 *
 * An upsert on `{ schoolId, className, term, academicYear }`, because a
 * timetable is edited across a term rather than versioned: the "add Tuesday's
 * double maths" action replaces the document, and the previous version is not
 * preserved. That is a deliberate trade — a timetable history nobody reads is
 * storage, not a feature — and it is why the audit entry records the number of
 * periods written on each save.
 *
 * `days` is normalised before it is written, so every weekday key exists and:
 *
 *  - a period with no subject, start or end is dropped. A half-entered row from
 *    an interrupted form would otherwise render as an empty card on a parent's
 *    Monday, and the parent has no way to tell that from a lesson that was
 *    cancelled;
 *  - periods are sorted by `period`, because the array order is the order the
 *    portal renders and a form that appends rows in the wrong sequence would
 *    show period 4 before period 1;
 *  - times keep their wall-clock string form. They are "8:00 am", not an
 *    instant, and storing them as one would pin them to a single Monday.
 */
export const upsertTimetable = async (schoolId, userId, payload) => {
  const { className, term, academicYear, days, status = "draft" } = payload;

  if (!className || !term || !academicYear || !days) {
    throw new ApiError(
      400,
      "className, term, academicYear, and days are required",
      "VALIDATION_ERROR"
    );
  }

  const normalised = normalizeDays(days);

  const isPublished = status === "published";

  const timetable = await Timetable.findOneAndUpdate(
    { schoolId, className, term, academicYear },
    {
      $set: {
        schoolId,
        className,
        term,
        academicYear,
        days: normalised,
        status,
        // Stamped only on the transition into `published`. Re-saving a published
        // timetable must not silently renew its publish date, which is the record
        // of when parents were first shown it.
        ...(isPublished ? { publishedAt: new Date(), publishedBy: userId } : {}),
      },
    },
    { upsert: true, new: true }
  );

  await auditLog({
    action: AUDIT_ACTIONS.TIMETABLE_UPSERT,
    entity: "Timetable",
    entityId: timetable._id,
    userId,
    schoolId,
    meta: {
      className,
      term,
      academicYear,
      status,
      periods: VALID_DAYS.reduce((sum, day) => sum + normalised[day].length, 0),
    },
  });

  return timetable.toObject();
};

/**
 * The school names this class, or throw.
 *
 * A class is a name in `School.academic.classes`, so "does JHS 2A exist" is a
 * membership check on that list — the same source `teacherScope` and the class
 * service read. Building a timetable for a class the school does not run would
 * leave an orphan grid nobody can open, so the write path refuses it. A school
 * that has not configured any classes yet has an empty list, and the check
 * correctly refuses it until at least one class name exists.
 */
const assertClassExists = async (schoolId, className) => {
  const school = await School.findById(schoolId).select("academic.classes").lean();
  const names = Array.isArray(school?.academic?.classes)
    ? school.academic.classes
    : [];
  if (!names.includes(className)) {
    throw new ApiError(`Class "${className}" not found`, 404, "CLASS_NOT_FOUND");
  }
};

/**
 * Save a class's timetable, but only for a class the school actually runs.
 *
 * The guarded entry point used by the admin console's `PUT /admin/timetables`.
 * The base `upsertTimetable` above deliberately does not check the class — the
 * older `PUT /admin/timetable` route relied on that — so the check lives here
 * rather than in the shared write, and only the newer, class-aware surface gets
 * the 404.
 */
export const saveTimetableForClass = async (schoolId, userId, payload) => {
  const { className } = payload;
  if (!className) {
    throw new ApiError("className is required", 400, "VALIDATION_ERROR");
  }
  await assertClassExists(schoolId, className);
  return upsertTimetable(schoolId, userId, payload);
};

/**
 * Read one class's timetable, latest first.
 *
 * Uniqueness on `{ schoolId, className, term, academicYear }` means there is at
 * most one live document, so `term`/`academicYear` in the query narrow which of
 * a class's terms is returned and the newest wins. Returns `null` when the class
 * has none — the parent portal renders an empty timetable, which is a state,
 * not an error.
 */
export const getTimetable = async (schoolId, className, { term, academicYear } = {}) => {
  const filter = { schoolId, className, deletedAt: null };
  if (term) filter.term = term;
  if (academicYear) filter.academicYear = academicYear;

  const timetable = await Timetable.findOne(filter).sort({ updatedAt: -1 }).lean();
  return timetable || null;
};

/**
 * Every timetable in the school, as a summary list for the console index.
 *
 * Projects only the fields a list row needs — the full `days` grid is large and
 * would be downloaded fifty times to render fifty rows. `status` filters the
 * "published only" and "drafts" views the headmaster switches between.
 */
export const listTimetables = async (schoolId, { term, academicYear, status } = {}) => {
  const filter = { schoolId, deletedAt: null };
  if (term) filter.term = term;
  if (academicYear) filter.academicYear = academicYear;
  if (status) filter.status = status;

  const timetables = await Timetable.find(filter)
    .select("className term academicYear status publishedAt updatedAt")
    .sort({ className: 1 })
    .lean();

  return { timetables };
};

/**
 * Publish a class's timetable.
 *
 * The moment the grid becomes readable through every pay link in that class
 * (`services/parent/timetable.service.js` filters on `status: "published"`).
 * Publishing a `draft` stamps `publishedAt`/`publishedBy`; republishing an
 * already-published one renews the stamp, which is the record of when parents
 * were last shown it. A 404 if the class has no timetable to publish.
 */
export const publishTimetable = async (schoolId, userId, { className, term, academicYear }) => {
  if (!className || !term || !academicYear) {
    throw new ApiError(
      "className, term, and academicYear are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const timetable = await Timetable.findOne({
    schoolId,
    className,
    term,
    academicYear,
    deletedAt: null,
  });
  if (!timetable) {
    throw new ApiError("Timetable not found", 404, "NOT_FOUND");
  }

  timetable.status = "published";
  timetable.publishedAt = new Date();
  timetable.publishedBy = userId;
  await timetable.save();

  await auditLog({
    action: AUDIT_ACTIONS.TIMETABLE_PUBLISH,
    entity: "Timetable",
    entityId: timetable._id,
    userId,
    schoolId,
    meta: { className, term, academicYear },
  });

  return timetable.toObject();
};
