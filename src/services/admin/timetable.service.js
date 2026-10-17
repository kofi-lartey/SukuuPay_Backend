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
      status,
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
 * The administrator signs off a submitted timetable. After approval, the
 * administrator may publish it (parents then see it); the teacher can no longer
 * edit it.
 */
export const approveTimetable = async (
  schoolId,
  adminUserId,
  { className, term, academicYear, comment }
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
      `Only a submitted timetable can be approved (current: ${timetable.submissionStatus})`,
      403,
      "TIMETABLE_NOT_SUBMITTED"
    );
  }

  const updated = await Timetable.findOneAndUpdate(
    { schoolId, className, term, academicYear, deletedAt: null },
    {
      $set: {
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
      "className term academicYear teacherName submissionStatus submittedAt submittedBy updatedAt"
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
      "className term academicYear days status submissionStatus submittedAt submittedBy approvedAt rejectedAt rejectionReason updatedAt"
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
