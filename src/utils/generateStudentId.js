import mongoose from "mongoose";

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
 */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Generate the next unique studentId for a school + academic year.
 *
 * Format: <schoolCode>-<academicYearStart>-<4-digit-padded-counter>
 * e.g. PBS-2026-0001. The counter resets each academic year per school.
 *
 * The school is fetched by the caller (service/hook) and its schoolCode is
 * passed in, so this helper has no model-level dependency except Student
 * (imported lazily to avoid a circular import with the Student model).
 */
export const generateStudentId = async (schoolCode, academicYear) => {
  if (!schoolCode) {
    throw new Error("Cannot generate studentId: school code is missing");
  }

  const year = resolveAcademicYearStart(academicYear);
  const prefix = `${schoolCode}-${year}-`;

  // Lazy import: Student is defined in a module that imports this util via its
  // pre-save hook, so we import it lazily to break the cycle.
  // eslint-disable-next-line no-async-promise-executor
  const { Student } = await import("../models/studentModel.js");

  const prefixRegex = new RegExp(`^${escapeRegExp(prefix)}`);

  // Aggregate the highest numeric counter for this schoolCode+year so the
  // generation is robust against 4-digit padding rollover and sorting quirks.
  const aggregation = await Student.aggregate([
    {
      $match: {
        studentId: prefixRegex,
        deletedAt: null,
      },
    },
    {
      $group: {
        _id: null,
        maxCounter: {
          $max: {
            $toInt: { $substrCP: ["$studentId", prefix.length, 10] },
          },
        },
      },
    },
  ]);

  const nextCounter = ((aggregation[0]?.maxCounter) || 0) + 1;
  const padded = String(nextCounter).padStart(4, "0");

  return `${prefix}${padded}`;
};
