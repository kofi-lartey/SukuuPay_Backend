import { Counter } from "../models/counterModel.js";

/**
 * Resolve the start year of an academic year.
 * "2025/2026" -> "2025"; "2025" -> "2025"; falls back to the current year.
 */
export const resolveAcademicYearStart = (academicYear) => {
  const match = String(academicYear || "").match(/^(\d{4})/);
  return match ? match[1] : String(new Date().getFullYear());
};

/**
 * Normalise an academic year to the "YYYY/YYYY+1" form.
 * "2025" -> "2025/2026"; "2025/2026" -> "2025/2026".
 */
export const normalizeAcademicYear = (value) => {
  if (!value) return null;
  const str = String(value).trim();
  if (/^\d{4}\/\d{4}$/.test(str)) return str;
  const single = str.match(/^(\d{4})$/);
  if (single) return `${single[1]}/${Number(single[1]) + 1}`;
  return str;
};

/**
 * Escape a string so it can be safely used inside a RegExp.
 *
 * Exported because student *search* needs it just as much as id generation did:
 * a user-supplied term is spliced into a `$regex` on four code paths, and an
 * unescaped `.*` matches every student in the school while a malformed pattern
 * like `[` throws and surfaces as a 500.
 */
export const escapeRegExp = (value) =>
  String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Generate a unique studentId for a school + academic year.
 *
 * Format: <schoolCode>-<academicYearStart>-<4-digit-padded-counter>
 * e.g. PBS-2026-0001. The counter resets each academic year per school.
 *
 * The counter is allocated from the `Counter` collection with a single atomic
 * `$inc`, not from an aggregate over existing students. The old implementation
 * read the current maximum and added one, which is a read-then-write race: two
 * concurrent imports both read `0007`, both produce `0008`, and one fails with a
 * duplicate-key error at insert time. Because `insertMany` was not wrapped, that
 * single collision discarded the whole batch's `{ created, failed, errors }`
 * report even though the other 199 documents were written.
 *
 * `reserveStudentIds(count)` is the form the bulk importer uses, so an entire
 * file is allocated in one round trip instead of one per row.
 *
 * The school is fetched by the caller (service/hook) and its schoolCode is
 * passed in, so this helper has no model-level dependency beyond Counter.
 */
const idFor = (schoolCode, year, seq) =>
  `${schoolCode}-${year}-${String(seq).padStart(4, "0")}`;

const counterKey = (schoolCode, year) => `studentId:${schoolCode}:${year}`;

export const reserveStudentIds = async (schoolCode, academicYear, count = 1) => {
  if (!schoolCode) {
    throw new Error("Cannot generate studentId: school code is missing");
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Cannot reserve ${count} student ids: count must be a positive integer`);
  }

  const year = resolveAcademicYearStart(academicYear);
  const key = counterKey(schoolCode, year);

  // One atomic $inc for the whole block. `upsert` creates the counter on first
  // use; a simultaneous upsert from another process throws a duplicate-key
  // error, which is the signal to retry — the counter itself is unique.
  let doc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      doc = await Counter.findOneAndUpdate(
        { key },
        { $inc: { seq: count } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      break;
    } catch (error) {
      if (error?.code === 11000 && attempt < 2) continue;
      throw error;
    }
  }

  if (!doc) {
    throw new Error("Could not allocate a student id counter");
  }

  // `doc.seq` is the value *after* the increment, so the block we own is
  // (seq - count + 1) … seq.
  const start = doc.seq - count + 1;
  return Array.from({ length: count }, (_, i) => idFor(schoolCode, year, start + i));
};

/** Single id, for the one-at-a-time paths. */
export const generateStudentId = async (schoolCode, academicYear) => {
  const [id] = await reserveStudentIds(schoolCode, academicYear, 1);
  return id;
};

/**
 * Ensure the counter is at least as high as the highest id already in the
 * collection, then return it.
 *
 * One-time migration helper. Existing schools have ids allocated by the old
 * max-based scheme; without this, the first request after deploy would restart
 * the counter at 1 and collide with every id already issued. Safe to re-run: it
 * only ever raises the counter, never lowers it.
 */
export const syncStudentIdCounter = async (schoolCode, academicYear) => {
  const { Student } = await import("../models/studentModel.js");
  const year = resolveAcademicYearStart(academicYear);
  const prefix = `${schoolCode}-${year}-`;
  const key = counterKey(schoolCode, year);

  const [row] = await Student.aggregate([
    { $match: { studentId: new RegExp(`^${escapeRegExp(prefix)}`) } },
    {
      $group: {
        _id: null,
        maxCounter: {
          $max: { $toInt: { $substrCP: ["$studentId", prefix.length, 10] } },
        },
      },
    },
  ]);

  const highest = row?.maxCounter || 0;
  await Counter.updateOne({ key, seq: { $lt: highest } }, { $set: { seq: highest } });
  return highest;
};

