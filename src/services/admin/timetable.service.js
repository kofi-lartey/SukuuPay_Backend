import { Timetable } from "../../models/Timetable.js";
import { School } from "../../models/schoolModel.js";
import { log as auditLog } from "../../utils/auditService.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import ApiError from "../../utils/ApiError.js";
import XLSX from "xlsx";

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

/**
 * The columns a school's timetable file may use.
 *
 * Headers are matched case-insensitively, with underscores and spaces treated as
 * the same separator, so "Start Time", "start_time" and "starttime" all work.
 */
const FIELD_ALIASES = {
  day: ["day", "weekday"],
  period: ["period", "no", "#"],
  startTime: ["start_time", "start time", "starttime", "start"],
  endTime: ["end_time", "end time", "endtime", "end"],
  subject: ["subject"],
  teacher: ["teacher", "staff"],
  room: ["room"],
};

const normalizeHeader = (header) =>
  String(header || "").trim().toLowerCase().replace(/[_\s]+/g, " ");

const parseCsv = (text, delimiter) => {
  const rows = [];
  let fields = [];
  let current = "";
  let inQuotes = false;

  const flushField = () => {
    fields.push(current);
    current = "";
  };

  const flushRow = () => {
    if (fields.length || current !== "") {
      rows.push(fields);
    }
    fields = [];
    current = "";
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"') {
        if (next === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      flushField();
    } else if (ch === "\r") {
      // Carriage returns are line noise; newlines end a row.
    } else if (ch === "\n") {
      flushField();
      flushRow();
    } else {
      current += ch;
    }
  }

  flushField();
  flushRow();

  if (!rows.length) return [];
  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map((row) =>
    Object.fromEntries(
      headers.map((header, index) => [header, row[index] === undefined ? "" : row[index]])
    )
  );
};

const pickColumn = (row, field) => {
  const aliases = FIELD_ALIASES[field];
  return Object.keys(row).find((key) => aliases.includes(normalizeHeader(key)));
};

/**
 * Guess a CSV delimiter from the header line so schools exporting semicolon
 * CSVs are not rejected for not using commas.
 */
const guessDelimiter = (firstLine) => {
  const candidates = [",", ";", "\t", "|"];
  return candidates.reduce(
    (best, d) => {
      const count = firstLine.split(d).length - 1;
      return count > best.count ? { d, count } : best;
    },
    { d: ",", count: 0 }
  ).d;
};

/**
 * Parse an uploaded CSV or Excel buffer into lesson rows.
 *
 * Rows with blank required cells are kept and reported as invalid, rather than
 * silently dropped, so a school can see exactly which rows failed instead of
 * wondering why a lesson vanished.
 */
export const parseTimetableFile = (buffer, filename) => {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  let raw;

  if (ext === ".csv" || ext === ".txt") {
    const text = buffer.toString("utf8");
    const firstLine = text.split("\n")[0] || "";
    const delimiter = guessDelimiter(firstLine);
    raw = parseCsv(text, delimiter);
  } else if (ext === ".xlsx" || ext === ".xls" || ext === ".xlsm") {
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (!rows.length || rows.length < 2) {
      throw new ApiError(
        "The file has no data rows — add a header row and at least one lesson.",
        400,
        "PARSE_ERROR"
      );
    }
    const headers = rows[0].map(normalizeHeader);
    raw = rows.slice(1).map((row) =>
      Object.fromEntries(headers.map((header, index) => [header, row[index]]))
    );
  } else {
    throw new ApiError("Only CSV and Excel files are allowed", 400, "UNSUPPORTED_FILE");
  }

  const rows = raw.map((row) => {
    const mapped = {};
    for (const field of Object.keys(FIELD_ALIASES)) {
      const key = pickColumn(row, field);
      if (key !== undefined) mapped[field] = row[key];
    }
    return mapped;
  });

  const errors = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2; // header is row 1
    const day = String(row.day || "").trim();
    const period = Number(row.period);
    const subject = String(row.subject || "").trim();
    const startTime = String(row.startTime || "").trim();
    const endTime = String(row.endTime || "").trim();

    if (!VALID_DAYS.includes(day)) {
      errors.push({ row: rowNumber, field: "day", message: `Unknown day "${day}"` });
    }
    if (!Number.isInteger(period) || period < 1 || period > 20) {
      errors.push({
        row: rowNumber,
        field: "period",
        message: `Period must be a whole number between 1 and 20, got "${row.period}"`,
      });
    }
    if (!subject) {
      errors.push({ row: rowNumber, field: "subject", message: "Subject is required" });
    }
    if (!startTime) {
      errors.push({ row: rowNumber, field: "startTime", message: "Start time is required" });
    }
    if (!endTime) {
      errors.push({ row: rowNumber, field: "endTime", message: "End time is required" });
    }
  });

  if (errors.length) {
    throw new ApiError(
      `The file has ${errors.length} invalid row(s)`,
      400,
      "VALIDATION_ERROR",
      { invalidRows: errors.slice(0, 50) }
    );
  }

  const days = {};
  for (const row of rows) {
    const day = String(row.day).trim();
    days[day] = [...(days[day] || []), {
      period: Number(row.period),
      startTime: String(row.startTime || "").trim(),
      endTime: String(row.endTime || "").trim(),
      subject: String(row.subject || "").trim(),
      teacher: String(row.teacher || "").trim(),
      room: String(row.room || "").trim(),
    }];
  }

  return { rows: rows.length, days };
};

/**
 * Import a class timetable from an uploaded CSV or Excel file.
 *
 * The file is parsed in memory and then written through the same guarded upsert
 * as the form, so an import validates the class exists and stores exactly the
 * same shape a teacher or parent would see in the portal.
 */
export const importTimetable = async (schoolId, userId, buffer, filename, payload) => {
  const { className, term, academicYear, status = "draft" } = payload;

  if (!className || !term || !academicYear) {
    throw new ApiError("className, term, and academicYear are required", 400, "VALIDATION_ERROR");
  }

  const { rows, days } = parseTimetableFile(buffer, filename);
  await assertClassExists(schoolId, className);

  const timetable = await upsertTimetable(schoolId, userId, {
    className,
    term,
    academicYear,
    days,
    status,
  });

  return { imported: rows, timetable };
};
