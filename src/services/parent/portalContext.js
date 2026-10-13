import { Student } from "../../models/studentModel.js";
import { School } from "../../models/schoolModel.js";
import ApiError from "../../utils/ApiError.js";

/**
 * The pay-token lookup every parent-portal academic read starts from.
 *
 * Written once rather than three times because the three reads (attendance,
 * records, timetable) must resolve a token identically: the same uppercase
 * normalisation, the same `deletedAt` guard, the same refusal. Three copies is
 * how the timetable would end up finding a student the records page refuses, and
 * a parent who sees a grade on one tab and "invalid link" on the next has been
 * told nothing useful.
 *
 * **Why uppercase.** `generatePayLinkToken` emits `STU-` + 8 uppercase hex
 * characters, but a link arrives however it was pasted — a chat client
 * lowercases URLs, an email client wraps them, and `STU-ab12cd34` is a token a
 * real parent can legitimately be holding. Every payment-surface lookup
 * normalises for the same reason (`pay.service.js:requireStudentByToken`).
 *
 * **Why 404 and not 401.** The token *is* the credential on this surface, so a
 * miss is "that is not a link we know" — and because the token space is not
 * guessable, saying so confirms nothing about whether a student exists.
 */
export const resolvePortalStudent = async (token) => {
  const student = await Student.findOne({
    uniquePayLinkToken: String(token || "").toUpperCase(),
    deletedAt: null,
  }).lean();

  if (!student) {
    throw new ApiError(404, "Invalid or expired payment link", "INVALID_TOKEN");
  }

  // The school carries the academic calendar — current term, current year, and
  // the explicit term ranges when a school has set them. A read with no school
  // behind it is a roster row whose school was archived; the term fallbacks
  // below still produce a sane range rather than throwing.
  const school = await School.findById(student.schoolId).lean();

  return { student, school };
};

/**
 * Which academic year a read is for.
 *
 * The student's own `academicYear` first, because a promoted or graduated
 * student keeps the year the record belongs to; the school's current year is the
 * fallback for a roster row imported before the field was written.
 */
export const resolveAcademicYear = (student, school) =>
  student.academicYear || school?.academic?.currentYear || "";

/** The term a read is for, defaulting to the school's current term. */
export const resolveTerm = (term, school, fallback = "Term 2") => {
  const requested = String(term || "").trim();
  return requested || school?.academic?.currentTerm || fallback;
};

export default { resolvePortalStudent, resolveAcademicYear, resolveTerm };
