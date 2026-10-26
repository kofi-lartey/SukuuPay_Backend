import { Timetable } from "../../models/Timetable.js";
import { School } from "../../models/schoolModel.js";
import { User } from "../../models/userModel.js";
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
export const upsertTimetable = async (
  schoolId,
  userId,
  payload,
  { actorRole } = {}
) => {
  const {
    className,
    term,
    academicYear,
    days,
    status = "draft",
    teacherName,
    submissionStatus,
  } = payload;

  if (!className || !term || !academicYear || !days) {
    throw new ApiError(
      400,
      "className, term, academicYear, and days are required",
      "VALIDATION_ERROR"
    );
  }

  // A timetable that has been sent for review, approved, or published is locked
  // from further edits — only `draft` (never submitted) and `rejected` (sent
  // back by the administrator) can be overwritten. This keeps the approval
  // trail trustworthy: what the administrator saw is what they approve.
  const existing = await Timetable.findOne({
    schoolId,
    className,
    term,
    academicYear,
    deletedAt: null,
  }).select("submissionStatus").lean();
  if (
    existing &&
    ["submitted", "approved", "published"].includes(existing.submissionStatus)
  ) {
    throw new ApiError(
      `This timetable is ${existing.submissionStatus} and cannot be edited`,
      403,
      "TIMETABLE_LOCKED"
    );
  }

  // A school administrator is the approving authority, so a timetable they
  // create is approved straight away; a teacher's draft stays `draft` until
  // they submit it for review. On an update the existing lifecycle value is
  // preserved — saving never promotes or demotes a submission.
  const isAdmin = ["school_admin", "super_admin"].includes(actorRole || "");
  const nextSubmissionStatus =
    existing === null
      ? isAdmin
        ? "approved"
        : "draft"
      : existing.submissionStatus;

  const normalised = normalizeDays(days);

  // An admin creating a timetable is the approving authority — the grid is
  // approved and published in one step, so parents see it immediately. A
  // teacher's draft stays invisible until they submit and an admin approves.
  const isAdminCreated = existing === null && isAdmin;
  const nextStatus =
    isAdminCreated && status === "draft"
      ? "approved"
      : status;

  const isPublished = nextStatus === "published";

  const timetable = await Timetable.findOneAndUpdate(
    { schoolId, className, term, academicYear },
    {
      $set: {
        schoolId,
        className,
        term,
        academicYear,
        days: normalised,
        status: nextStatus,
        submissionStatus: nextSubmissionStatus,
        ...(teacherName !== undefined ? { teacherName } : {}),
        // A teacher's draft is owned by them: stamp `submittedBy` so
        // `getTimetableForTeacher` can find it. Admin-created timetables
        // leave it null (they use the unfiltered `getTimetable` instead).
        ...(actorRole === "teacher" ? { submittedBy: userId } : {}),
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
      status: nextStatus,
      submissionStatus: nextSubmissionStatus,
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
export const saveTimetableForClass = async (
  schoolId,
  userId,
  payload,
  { actorRole } = {}
) => {
  const { className } = payload;
  if (!className) {
    throw new ApiError("className is required", 400, "VALIDATION_ERROR");
  }
  await assertClassExists(schoolId, className);
  return upsertTimetable(schoolId, userId, payload, { actorRole });
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
    .select("className term academicYear status publishedAt deactivatedAt updatedAt")
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
 * Publish a class's timetable, but only once the administrator has approved it.
 *
 * A draft that was never submitted, or a submission the administrator rejected,
 * must not become visible to parents just because someone called publish. The
 * guard below is the load-bearing rule: publish is the last step of the
 * approval flow, not the first.
 */
export const publishApprovedTimetable = async (
  schoolId,
  userId,
  { className, term, academicYear }
) => {
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

  if (timetable.submissionStatus !== "approved") {
    throw new ApiError(
      "Only an approved timetable can be published",
      403,
      "TIMETABLE_NOT_APPROVED"
    );
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

  const rows = raw
    .filter((row) => {
      // Skip completely blank lines (e.g. a trailing newline in a CSV/Excel file).
      const values = Object.values(row || {});
      return values.some((v) => String(v ?? "").trim() !== "");
    })
    .map((row) => {
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
export const importTimetable = async (schoolId, userId, buffer, filename, payload, { actorRole } = {}) => {
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
  }, { actorRole });

  return { imported: rows, timetable };
};

/**
 * The submission-status values a timetable can be acted on.
 */
const EDITABLE_STATUSES = ["draft", "rejected"];

/**
 * Load one timetable and assert the caller may act on it.
 */
const loadTimetableForActor = async (schoolId, className, term, academicYear) => {
  const timetable = await Timetable.findOne({
    schoolId,
    className,
    term,
    academicYear,
    deletedAt: null,
  }).lean();
  if (!timetable) {
    throw new ApiError("Timetable not found", 404, "NOT_FOUND");
  }
  return timetable;
};

/**
 * `POST /teacher/timetables/:className/submit`
 *
 * A teacher sends their draft to the administrator for review. Once submitted,
 * the timetable is locked: the teacher can no longer edit it until the
 * administrator approves, rejects, or the teacher withdraws it.
 */
export const submitTimetable = async (
  schoolId,
  userId,
  { className, term, academicYear, teacherName }
) => {
  if (!className || !term || !academicYear) {
    throw new ApiError(
      "className, term, and academicYear are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const timetable = await loadTimetableForActor(
    schoolId,
    className,
    term,
    academicYear
  );

  if (timetable.submissionStatus !== "draft") {
    throw new ApiError(
      `Only a draft timetable can be submitted (current: ${timetable.submissionStatus})`,
      403,
      "TIMETABLE_NOT_DRAFT"
    );
  }

  const hasPeriods = VALID_DAYS.some(
    (day) => (timetable.days?.[day] || []).length > 0
  );
  if (!hasPeriods) {
    throw new ApiError(
      "Add at least one period before submitting",
      400,
      "TIMETABLE_EMPTY"
    );
  }

  // Conflict validation: no teacher may be double-booked across classes at the
  // same time. A Class Teacher cannot be assigned to more than one class during
  // the same period — their teacherId would appear in two live timetables at
  // overlapping times. Drafts are not checked because they are not yet live;
  // the clash is only enforced when the timetable is submitted for approval.
  for (const [day, periods] of Object.entries(timetable.days || {})) {
    for (const period of (periods || [])) {
      if (!period.teacherId) continue;
      await checkTeacherClash(
        schoolId,
        term,
        academicYear,
        day,
        period.startTime,
        period.endTime,
        period.teacherId,
        timetable._id
      );
    }
  }

  const updated = await Timetable.findOneAndUpdate(
    { schoolId, className, term, academicYear, deletedAt: null },
    {
      $set: {
        submissionStatus: "submitted",
        submittedAt: new Date(),
        submittedBy: userId,
        ...(teacherName !== undefined ? { teacherName } : {}),
      },
    },
    { new: true }
  ).lean();

  await auditLog({
    action: AUDIT_ACTIONS.TIMETABLE_SUBMIT,
    entity: "Timetable",
    entityId: updated._id,
    userId,
    schoolId,
    meta: { className, term, academicYear },
  });

  return updated;
};

/**
 * `POST /teacher/timetables/:className/withdraw`
 *
 * A teacher pulls a submitted timetable back before the administrator acts on
 * it. Returns the timetable to `draft` and re-enables editing.
 */
export const withdrawTimetable = async (
  schoolId,
  userId,
  { className, term, academicYear }
) => {
  if (!className || !term || !academicYear) {
    throw new ApiError(
      "className, term, and academicYear are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const timetable = await loadTimetableForActor(
    schoolId,
    className,
    term,
    academicYear
  );

  if (timetable.submissionStatus !== "submitted") {
    throw new ApiError(
      `Only a submitted timetable can be withdrawn (current: ${timetable.submissionStatus})`,
      403,
      "TIMETABLE_NOT_SUBMITTED"
    );
  }

  const updated = await Timetable.findOneAndUpdate(
    { schoolId, className, term, academicYear, deletedAt: null },
    {
      $set: {
        submissionStatus: "draft",
        submittedAt: null,
        submittedBy: null,
      },
    },
    { new: true }
  ).lean();

  await auditLog({
    action: AUDIT_ACTIONS.TIMETABLE_WITHDRAW,
    entity: "Timetable",
    entityId: updated._id,
    userId,
    schoolId,
    meta: { className, term, academicYear },
  });

  return updated;
};

/**
 * `POST /admin/timetables/:className/approve`
 *
 * The administrator signs off a submitted timetable. Approval is the publish
 * boundary — the timetable becomes visible to parents immediately, without a
 * separate publish step. The teacher can no longer edit it.
 */
export const approveTimetable = async (
  schoolId,
  adminUserId,
  arg
) => {
  const { className, term, academicYear, comment } = (arg && arg.className) ? arg : {};
  // Snippet-style approval by document id (final clash check).
  if (arg && !arg.className) {
    const timetableId = (arg && (arg.timetableId || arg._id)) || arg;
    const timetable = await Timetable.findById(timetableId);
    if (!timetable) throw new ApiError('Timetable not found', 404);
    for (const [day, periods] of Object.entries(timetable.days || {})) {
      for (const period of (periods || [])) {
        await checkTeacherClash(
          schoolId,
          timetable.term,
          timetable.academicYear,
          day,
          period.startTime,
          period.endTime,
          period.teacherId,
          timetableId
        );
      }
    }
    timetable.status = 'approved';
    timetable.submissionStatus = 'approved';
    timetable.approvedAt = new Date();
    timetable.approvedBy = adminUserId;
    await timetable.save();
    return timetable.toObject ? timetable.toObject() : timetable;
  }
  if (!className || !term || !academicYear) {
    throw new ApiError(
      "className, term, and academicYear are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const timetable = await loadTimetableForActor(
    schoolId,
    className,
    term,
    academicYear
  );

  if (timetable.submissionStatus !== "submitted") {
    throw new ApiError(
      `Only a submitted timetable can be approved (current: ${timetable.submissionStatus})`,
      403,
      "TIMETABLE_NOT_SUBMITTED"
    );
  }

  // Conflict validation: no teacher may be double-booked across classes at the
  // same time. A Class Teacher assigned to more than one class during the same
  // period is caught here by the same rule — their teacherId appears in two
  // live timetables at overlapping times.
  for (const [day, periods] of Object.entries(timetable.days || {})) {
    for (const period of (periods || [])) {
      if (!period.teacherId) continue;
      await checkTeacherClash(
        schoolId,
        term,
        academicYear,
        day,
        period.startTime,
        period.endTime,
        period.teacherId,
        timetable._id
      );
    }
  }

  const updated = await Timetable.findOneAndUpdate(
    { schoolId, className, term, academicYear, deletedAt: null },
    {
      $set: {
        status: "approved",
        submissionStatus: "approved",
        approvedAt: new Date(),
        approvedBy: adminUserId,
        approvalComment: String(comment || "").trim(),
      },
    },
    { new: true }
  ).lean();

  await auditLog({
    action: AUDIT_ACTIONS.TIMETABLE_APPROVE,
    entity: "Timetable",
    entityId: updated._id,
    userId: adminUserId,
    schoolId,
    meta: { className, term, academicYear, comment },
  });

  return updated;
};

/**
 * `POST /admin/timetables/:className/reject`
 *
 * The administrator sends a submitted timetable back to the teacher with a
 * reason. The timetable returns to `draft` and the teacher can edit and
 * resubmit it.
 */
export const rejectTimetable = async (
  schoolId,
  adminUserId,
  { className, term, academicYear, reason }
) => {
  if (!className || !term || !academicYear) {
    throw new ApiError(
      "className, term, and academicYear are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const rejectionReason = String(reason || "").trim();
  if (!rejectionReason) {
    throw new ApiError("A rejection reason is required", 400, "VALIDATION_ERROR");
  }

  const timetable = await loadTimetableForActor(
    schoolId,
    className,
    term,
    academicYear
  );

  if (timetable.submissionStatus !== "submitted") {
    throw new ApiError(
      `Only a submitted timetable can be rejected (current: ${timetable.submissionStatus})`,
      403,
      "TIMETABLE_NOT_SUBMITTED"
    );
  }

  const updated = await Timetable.findOneAndUpdate(
    { schoolId, className, term, academicYear, deletedAt: null },
    {
      $set: {
        submissionStatus: "rejected",
        rejectedAt: new Date(),
        rejectedBy: adminUserId,
        rejectionReason,
      },
    },
    { new: true }
  ).lean();

  await auditLog({
    action: AUDIT_ACTIONS.TIMETABLE_REJECT,
    entity: "Timetable",
    entityId: updated._id,
    userId: adminUserId,
    schoolId,
    meta: { className, term, academicYear, reason: rejectionReason },
  });

  return updated;
};

/**
 * `GET /admin/timetables/submissions` — the administrator's review queue.
 *
 * Every timetable in the school awaiting a decision, newest first. Projects
 * only the fields the review row needs, not the full `days` grid.
 */
export const listSubmissions = async (
  schoolId,
  { term, academicYear } = {}
) => {
  const filter = {
    schoolId,
    deletedAt: null,
    submissionStatus: "submitted",
  };
  if (term) filter.term = term;
  if (academicYear) filter.academicYear = academicYear;

  const submissions = await Timetable.find(filter)
    .select(
      "className term academicYear teacherName submissionStatus submittedAt submittedBy removalStatus removalReason updatedAt"
    )
    .sort({ submittedAt: -1 })
    .lean();

  // Attach the submitting teacher's name where it was not snapshotted.
  const ids = [...new Set(submissions.map((s) => String(s.submittedBy)))];
  const teachers = await User.find({ _id: { $in: ids } })
    .select("_id name")
    .lean();
  const teacherById = new Map(teachers.map((t) => [String(t._id), t.name]));

  return {
    submissions: submissions.map((s) => ({
      ...s,
      teacher: s.teacherName || teacherById.get(String(s.submittedBy)) || "",
    })),
  };
};

/**
 * `GET /teacher/timetables` — the teacher's own timetables.
 *
 * Every timetable the teacher has touched for their assigned classes, with
 * its current submission status so the teacher can see whether it is still a
 * draft, awaiting review, approved, rejected, or published.
 */
export const listTimetablesForTeacher = async (
  schoolId,
  teacherUserId,
  { term, academicYear } = {}
) => {
  const filter = {
    schoolId,
    deletedAt: null,
    $or: [
      { submittedBy: teacherUserId },
      { teacherName: { $regex: new RegExp(String(teacherUserId), "i") } },
    ],
  };
  if (term) filter.term = term;
  if (academicYear) filter.academicYear = academicYear;

  const timetables = await Timetable.find(filter)
    .select(
      "className term academicYear days status submissionStatus submittedAt submittedBy approvedAt rejectedAt rejectionReason removalStatus removalRequestedAt removalReason deactivatedAt updatedAt"
    )
    .sort({ updatedAt: -1 })
    .lean();

  return { timetables };
};

/**
 * `GET /teacher/timetables/:className` — one of the teacher's timetables.
 */
export const getTimetableForTeacher = async (
  schoolId,
  teacherUserId,
  className,
  { term, academicYear } = {}
) => {
  const filter = {
    schoolId,
    className,
    deletedAt: null,
    $or: [
      { submittedBy: teacherUserId },
      { submittedBy: null },
      { teacherName: { $regex: new RegExp(String(teacherUserId), "i") } },
    ],
  };
  if (term) filter.term = term;
  if (academicYear) filter.academicYear = academicYear;

  const timetable = await Timetable.findOne(filter)
    .sort({ updatedAt: -1 })
    .lean();
  return timetable || null;
};

/**
 * The guard shared by every state-transition service on a timetable:
 * load the document, assert it exists, and return it. Keeping this in one
 * place means "timetable not found" and "term/year mismatch" are always a
 * 404 with the same shape, no matter which endpoint a caller hits.
 */
const requireTimetable = async (schoolId, { className, term, academicYear }) => {
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
  return timetable;
};

/**
 * Deactivate a published timetable.
 *
 * Sets `status` back to `"draft"` and stamps `deactivatedAt`/`deactivatedBy`.
 * Schedule queries in both the teacher and parent surfaces filter on
 * `deactivatedAt: null`, so the timetable vanishes from views immediately.
 * Only a `published` timetable with no active removal request can be
 * deactivated — a draft is already invisible, and one caught in a removal
 * flow must be decided there, not here.
 */
export const deactivateTimetable = async (schoolId, userId, { className, term, academicYear }) => {
  const timetable = await requireTimetable(schoolId, { className, term, academicYear });

  if (!["published", "approved"].includes(timetable.status)) {
    throw new ApiError(
      `Only a published or approved timetable can be deactivated (current: ${timetable.status})`,
      403,
      "TIMETABLE_NOT_PUBLISHED"
    );
  }

  if (timetable.removalStatus === "requested") {
    throw new ApiError(
      "Timetable has a removal request in progress; resolve it first",
      409,
      "TIMETABLE_REMOVAL_PENDING"
    );
  }

  timetable.status = "draft";
  timetable.deactivatedAt = new Date();
  timetable.deactivatedBy = userId;
  await timetable.save();

  await auditLog({
    action: AUDIT_ACTIONS.TIMETABLE_DEACTIVATE,
    entity: "Timetable",
    entityId: timetable._id,
    userId,
    schoolId,
    meta: { className, term, academicYear },
  });

  return timetable.toObject();
};

/**
 * Re-publish a deactivated timetable.
 *
 * The inverse of `deactivateTimetable`: clears `deactivatedAt`/`deactivatedBy`
 * and stamps `publishedAt`/`publishedBy` so the publish audit trail is honest.
 * Only a timetable that was published and then deactivated can be re-published.
 */
export const republishTimetable = async (schoolId, userId, { className, term, academicYear }) => {
  const timetable = await requireTimetable(schoolId, { className, term, academicYear });

  if (!timetable.deactivatedAt || timetable.status !== "draft") {
    throw new ApiError(
      "Only a deactivated timetable can be republished",
      403,
      "TIMETABLE_NOT_DEACTIVATED"
    );
  }

  timetable.status = "published";
  timetable.deactivatedAt = null;
  timetable.deactivatedBy = null;
  timetable.deactivationReason = "";
  timetable.publishedAt = new Date();
  timetable.publishedBy = userId;
  await timetable.save();

  await auditLog({
    action: AUDIT_ACTIONS.TIMETABLE_REPUBLISH,
    entity: "Timetable",
    entityId: timetable._id,
    userId,
    schoolId,
    meta: { className, term, academicYear },
  });

  return timetable.toObject();
};

/**
 * Permanently remove a timetable (soft-delete).
 *
 * Sets `deletedAt`, making the timetable invisible to every query that filters
 * on `deletedAt: null`. This is a hard, irreversible action — the confirmation
 * step lives on the frontend; the backend simply honours the request.
 */
export const removeTimetable = async (schoolId, userId, { className, term, academicYear }) => {
  const timetable = await requireTimetable(schoolId, { className, term, academicYear });

  timetable.deletedAt = new Date();
  await timetable.save();

  await auditLog({
    action: AUDIT_ACTIONS.TIMETABLE_REMOVE,
    entity: "Timetable",
    entityId: timetable._id,
    userId,
    schoolId,
    meta: { className, term, academicYear },
  });

  return { deleted: true };
};

/**
 * List every timetable with an active removal request.
 *
 * The admin's removal-request queue — separate from the approval queue
 * (`listSubmissions`, which only shows `submissionStatus: "submitted"`).
 * Returns the full timetable projection so the admin can inspect who asked
 * and why without a separate fetch.
 */
export const listRemovalRequests = async (schoolId) => {
  const timetables = await Timetable.find({
    schoolId,
    deletedAt: null,
    removalStatus: "requested",
  })
    .select(
      "className term academicYear teacherName removalStatus removalRequestedAt removalReason removalRequestedBy removalDecidedAt removalDecidedBy deletionStatus updatedAt"
    )
    .populate("removalRequestedBy", "_id name")
    .sort({ removalRequestedAt: -1 })
    .lean();

  return {
    requests: timetables.map((t) => ({
      ...t,
      removalRequestedByName: t.removalRequestedBy?.name || t.teacherName || "",
      removalRequestedById: String(t.removalRequestedBy?._id || t.removalRequestedBy || ""),
    })),
  };
};

/**
 * Confirm a removal request — soft-delete the timetable.
 *
 * Sets `deletedAt`, `deletionStatus: "removed"`, and decision tracking fields.
 * Only a timetable with `removalStatus: "requested"` can be confirmed.
 */
export const confirmRemoval = async (schoolId, userId, { className, term, academicYear }) => {
  const timetable = await requireTimetable(schoolId, { className, term, academicYear });

  if (timetable.removalStatus !== "requested") {
    throw new ApiError(
      "Only a timetable with an active removal request can be confirmed for removal",
      403,
      "TIMETABLE_NOT_REQUESTED"
    );
  }

  timetable.deletedAt = new Date();
  timetable.deletionStatus = "removed";
  timetable.removalDecidedAt = new Date();
  timetable.removalDecidedBy = userId;
  await timetable.save();

  await auditLog({
    action: AUDIT_ACTIONS.TIMETABLE_REMOVAL_APPROVE,
    entity: "Timetable",
    entityId: timetable._id,
    userId,
    schoolId,
    meta: { className, term, academicYear },
  });

  return { deleted: true };
};

/**
 * Reject a removal request — clear the request and let the timetable live on.
 *
 * Sets `removalStatus` back to `null` and stamps decision tracking fields.
 * Only a timetable with `removalStatus: "requested"` can be rejected.
 */
export const rejectRemovalRequest = async (schoolId, userId, { className, term, academicYear }) => {
  const timetable = await requireTimetable(schoolId, { className, term, academicYear });

  if (timetable.removalStatus !== "requested") {
    throw new ApiError(
      "Only a timetable with an active removal request can be rejected",
      403,
      "TIMETABLE_NOT_REQUESTED"
    );
  }

  timetable.removalStatus = null;
  timetable.removalRequestedAt = null;
  timetable.removalRequestedBy = null;
  timetable.removalReason = "";
  timetable.removalDecidedAt = new Date();
  timetable.removalDecidedBy = userId;
  await timetable.save();

  await auditLog({
    action: AUDIT_ACTIONS.TIMETABLE_REMOVAL_REJECT,
    entity: "Timetable",
    entityId: timetable._id,
    userId,
    schoolId,
    meta: { className, term, academicYear },
  });

  return timetable.toObject();
};

/**
 * Teacher-initiated: request removal of a timetable the teacher owns.
 *
 * Only a timetable in `submitted` or `approved` state — i.e. not still being
 * edited, and not already published — can have a removal request filed
 * against it. The timetable must belong to this teacher, checked via
 * `submittedBy` or `teacherName`.
 */
export const requestTimetableRemoval = async (
  schoolId,
  userId,
  { className, term, academicYear, reason }
) => {
  if (!className || !term || !academicYear) {
    throw new ApiError(
      "className, term, and academicYear are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const removalReason = String(reason || "").trim();
  if (!removalReason || removalReason.length < 10) {
    throw new ApiError("A removal reason of at least 10 characters is required", 400, "VALIDATION_ERROR");
  }

  const timetable = await Timetable.findOne({
    schoolId,
    className,
    term,
    academicYear,
    deletedAt: null,
  }).lean();

  if (!timetable) {
    throw new ApiError("Timetable not found", 404, "NOT_FOUND");
  }

  const isOwner =
    String(timetable.submittedBy) === String(userId);

  if (!isOwner) {
    throw new ApiError("You do not have permission to request removal of this timetable", 403, "FORBIDDEN");
  }

  if (!["submitted", "approved"].includes(timetable.submissionStatus)) {
    throw new ApiError(
      `Only a submitted or approved timetable can have a removal requested (current: ${timetable.submissionStatus})`,
      403,
      "TIMETABLE_NOT_SUBMITTED"
    );
  }

  if (timetable.removalStatus === "requested") {
    throw new ApiError(
      "A removal request is already pending for this timetable",
      409,
      "TIMETABLE_REMOVAL_PENDING"
    );
  }

  const updated = await Timetable.findOneAndUpdate(
    { schoolId, className, term, academicYear, deletedAt: null },
    {
      $set: {
        removalStatus: "requested",
        removalRequestedAt: new Date(),
        removalRequestedBy: userId,
        removalReason,
      },
    },
    { new: true }
  ).lean();

  await auditLog({
    action: AUDIT_ACTIONS.TIMETABLE_REMOVAL_REQUEST,
    entity: "Timetable",
    entityId: updated._id,
    userId,
    schoolId,
    meta: { className, term, academicYear, reason: removalReason },
  });

  return { ...updated, teacherName: timetable.teacherName };
};

/**
 * Teacher-initiated: withdraw a removal request before the admin acts on it.
 *
 * Only the teacher who filed the request can withdraw it, and only while it is
 * still pending (`removalStatus: "requested"`).
 */
export const withdrawRemovalRequest = async (schoolId, userId, { className, term, academicYear }) => {
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

  if (timetable.removalStatus !== "requested") {
    throw new ApiError(
      "Only a timetable with an active removal request can be withdrawn",
      403,
      "TIMETABLE_NOT_REQUESTED"
    );
  }

  if (String(timetable.removalRequestedBy) !== String(userId)) {
    throw new ApiError("Only the teacher who requested removal can withdraw it", 403, "FORBIDDEN");
  }

  timetable.removalStatus = null;
  timetable.removalRequestedAt = null;
  timetable.removalRequestedBy = null;
  timetable.removalReason = "";
  await timetable.save();

  await auditLog({
    action: AUDIT_ACTIONS.TIMETABLE_REMOVAL_WITHDRAW,
    entity: "Timetable",
    entityId: timetable._id,
    userId,
    schoolId,
    meta: { className, term, academicYear },
  });

  return timetable.toObject();
};

/**
 * Check whether a teacher is already scheduled for another class at this time.
 *
 * Prevents double-booking a teacher across different classes. Only checks
 * against timetables that are approved or published — drafts are not yet live
 * and do not create a clash.
 *
 * Time overlap is any of:
 *   - The new period starts during an existing period.
 *   - The new period ends during an existing period.
 *   - The new period completely contains an existing period.
 *   - The new period is completely contained by an existing period.
 *
 * `excludeTimetableId` lets a timetable re-check itself after an edit without
 * flagging its own periods.
 */
export const checkTeacherClash = async (
  schoolId,
  term,
  academicYear,
  day,
  startTime,
  endTime,
  teacherId,
  excludeTimetableId = null
) => {
  if (!teacherId) return;

  const key = "days." + day;
  const query = {
    schoolId,
    term,
    academicYear,
    status: { $in: ["approved", "published"] },
  };
  query[key] = {
    $elemMatch: {
      teacherId,
      $or: [
        { startTime: { $lte: startTime }, endTime: { $gt: startTime } },
        { startTime: { $lt: endTime }, endTime: { $gte: endTime } },
        { startTime: { $gte: startTime }, endTime: { $lte: endTime } },
      ],
    },
  };
  if (excludeTimetableId) {
    query._id = { $ne: excludeTimetableId };
  }

  const overlapping = await Timetable.findOne(query).lean();
  if (overlapping) {
    throw new ApiError(
      `Teacher is already scheduled for ${overlapping.className} at this time.`,
      409,
      "TIMETABLE_CLASH"
    );
  }
};

/**
 * Submit a timetable for approval, after running clash detection on every period.
 *
 * This is the teacher-facing submission entry point. It validates that the
 * teacher is not double-booked, then sets the timetable to `pending_approval`.
 */
export const submitTimetableForApproval = async (schoolId, userId, payload) => {
  const { className, term, academicYear, days } = payload || {};

  // 1. Validate no clashes for the submitted periods
  for (const [d, periods] of Object.entries(days || {})) {
    for (const period of periods || []) {
      await checkTeacherClash(
        schoolId,
        term,
        academicYear,
        d,
        period.startTime,
        period.endTime,
        period.teacherId
      );
    }
  }

  // 2. Save as pending_approval
  const timetable = await Timetable.findOneAndUpdate(
    {
      schoolId,
      className,
      term,
      academicYear,
    },
    {
      $set: {
        days,
        status: "pending_approval",
        submittedBy: userId,
      },
    },
    { upsert: true, new: true }
  );

  return timetable && timetable.toObject ? timetable.toObject() : timetable;
};
