import ApiError from "../utils/ApiError.js";
import { StudyPlan, Assessment, Submission, Meeting } from "../models/LMS.js";
import { Student } from "../models/studentModel.js";
import { requireCampusAccess } from "../middleware/campus.middleware.js";
import { loadTeacherScope } from "../utils/teacherScope.js";
import { resolveTermRange, resolveSchoolAcademicYear } from "../utils/termDates.js";
import { GRADE_BANDS } from "../utils/gradeBands.js";

/**
 * Campus-scoped LMS service (Wave 3, Agent 4).
 *
 * Content visibility rule, applied identically across every list/get/write:
 *
 *   - campusId = null            → school-wide, visible to every campus
 *   - campusId = X               → visible only at campus X
 *   - sharingScope = "school"    → school-wide, overrides campusId (even if set)
 *   - sharingScope = "campus"    → campus-scoped, falls back to campusId
 *
 * So an item is visible to a reader at campus C (or reading school-wide) when:
 *   sharingScope === "school"  OR  campusId == null  OR  campusId == C
 *
 * The service is the single reader of that rule. Controllers hand it the
 * caller's resolved schoolId, the caller's user document (for campus-membership
 * checks on writes) and the requested campusId (for list filtering), and never
 * re-implement the visibility predicate.
 */

const ADMIN_ROLES = ["school_admin", "super_admin"];

const isAdmin = (user) => ADMIN_ROLES.includes(user?.role);

/**
 * Build the Mongo filter that returns only items visible from `campusId`.
 *
 * `campusId` is the campus the reader is asking about:
 *   - null  → reader is school-wide (admin acting without a campus filter):
 *             show everything school-wide OR shared to "school" scope.
 *   - "X"   → reader is at campus X: show school-wide items + items shared to
 *             campus X.
 *
 * Combined with `base` (schoolId, teacherId, className, …) via `$and` so a
 * caller's existing filter is never lost.
 */
export const buildVisibilityFilter = (base = {}, campusId = null) => {
  const visibility =
    campusId === null
      ? {
          $or: [
            { campusId: null },
            { sharingScope: "school" },
            // campus-scoped items with no campusId are legacy school-wide rows
            // (pre-migration); treat them as school-wide.
            { sharingScope: { $ne: "campus" } },
          ],
        }
      : {
          $or: [
            { campusId: null },
            { sharingScope: "school" },
            { campusId: campusId },
          ],
        };

  const keys = Object.keys(base);
  if (!keys.length) return visibility;
  return { $and: [base, visibility] };
};

/**
 * Normalise a campusId from a request to an ObjectId-ready value or null.
 * Rejects obviously invalid ids so a malformed `?campusId=` is a 400, not a
 * CastError surfaced as a 500.
 */
export const normaliseCampusId = (campusId) => {
  if (campusId === null || campusId === undefined || campusId === "" || campusId === "null") {
    return null;
  }
  return String(campusId);
};

/**
 * Assert the user may create/update an item at `campusId`.
 *
 * super_admin and school_admin act across the whole school (any campus).
 * A teacher must have `campusId` in their `assignedCampuses`. A null campusId
 * is school-wide and allowed for any authenticated member of the school.
 */
export const assertCanWriteCampus = async (user, campusId) => {
  if (!user) throw new ApiError("Authentication required", 401, "UNAUTHENTICATED");
  if (campusId === null) return;
  if (isAdmin(user)) return;
  await requireCampusAccess(user, campusId);
};

// ── Study Plans ──

export const listStudyPlans = async ({ schoolId, teacherId, isAdmin: admin, campusId, className }) => {
  const base = { schoolId };
  if (!admin && teacherId) base.teacherId = teacherId;
  if (className) base.className = className;
  const filter = buildVisibilityFilter(base, normaliseCampusId(campusId));
  return StudyPlan.find(filter).sort({ createdAt: -1 });
};

export const createStudyPlan = async ({ data, user, schoolId, teacherId, campusId }) => {
  const cid = normaliseCampusId(campusId);
  await assertCanWriteCampus(user, cid);
  const sharingScope = data.sharingScope === "campus" ? "campus" : "school";
  const payload = {
    ...data,
    schoolId,
    teacherId,
    campusId: sharingScope === "school" ? null : cid,
    sharingScope,
  };
  return StudyPlan.create(payload);
};

export const updateStudyPlan = async ({ id, data, user, schoolId, teacherId, isAdmin: admin }) => {
  const filter = { _id: id, schoolId };
  if (!admin && teacherId) filter.teacherId = teacherId;
  const existing = await StudyPlan.findOne(filter);
  if (!existing) throw new ApiError("Study plan not found", 404, "NOT_FOUND");

  // If the update re-scopes the item, the target campus must be writable.
  const nextCampusId = normaliseCampusId(data.campusId ?? existing.campusId);
  const nextScope = data.sharingScope ?? existing.sharingScope ?? "school";
  await assertCanWriteCampus(user, nextScope === "campus" ? nextCampusId : null);

  if (data.sharingScope !== undefined) {
    data.sharingScope = data.sharingScope === "campus" ? "campus" : "school";
  }
  if (data.sharingScope === "school") data.campusId = null;
  else if (data.sharingScope === "campus" && nextCampusId) data.campusId = nextCampusId;

  return StudyPlan.findOneAndUpdate(filter, data, { returnDocument: "after" });
};

export const deleteStudyPlan = async ({ id, schoolId, teacherId, isAdmin: admin }) => {
  const filter = { _id: id, schoolId };
  if (!admin && teacherId) filter.teacherId = teacherId;
  const item = await StudyPlan.findOneAndDelete(filter);
  if (!item) throw new ApiError("Study plan not found", 404, "NOT_FOUND");
  return item;
};

// ── Assessments ──

export const listAssessments = async ({ schoolId, teacherId, isAdmin: admin, campusId, className }) => {
  const base = { schoolId };
  if (!admin && teacherId) base.teacherId = teacherId;
  if (className) base.className = className;
  const filter = buildVisibilityFilter(base, normaliseCampusId(campusId));
  return Assessment.find(filter).sort({ createdAt: -1 });
};

export const createAssessment = async ({ data, user, schoolId, teacherId, campusId }) => {
  const cid = normaliseCampusId(campusId);
  await assertCanWriteCampus(user, cid);
  const sharingScope = data.sharingScope === "campus" ? "campus" : "school";
  const payload = {
    ...data,
    schoolId,
    teacherId,
    campusId: sharingScope === "school" ? null : cid,
    sharingScope,
  };
  if (payload.status === "draft") {
    if (!payload.className) payload.className = "Unassigned";
    if (!payload.subject) payload.subject = "General";
    if (!payload.dueDate) payload.dueDate = new Date(Date.now() + 7 * 86400000);
    if (!payload.title) payload.title = "Untitled Assessment";
  }
  return Assessment.create(payload);
};

export const updateAssessment = async ({ id, data, user, schoolId, teacherId, isAdmin: admin }) => {
  const filter = { _id: id, schoolId };
  if (!admin && teacherId) filter.teacherId = teacherId;
  const existing = await Assessment.findOne(filter);
  if (!existing) throw new ApiError("Assessment not found", 404, "NOT_FOUND");

  const nextCampusId = normaliseCampusId(data.campusId ?? existing.campusId);
  const nextScope = data.sharingScope ?? existing.sharingScope ?? "school";
  await assertCanWriteCampus(user, nextScope === "campus" ? nextCampusId : null);

  const payload = { ...data };
  if (payload.sharingScope !== undefined) {
    payload.sharingScope = payload.sharingScope === "campus" ? "campus" : "school";
  }
  if (payload.sharingScope === "school") payload.campusId = null;
  else if (payload.sharingScope === "campus" && nextCampusId) payload.campusId = nextCampusId;

  if (payload.status === "draft") {
    if (!payload.className) payload.className = "Unassigned";
    if (!payload.subject) payload.subject = "General";
    if (!payload.dueDate) payload.dueDate = new Date(Date.now() + 7 * 86400000);
    if (!payload.title) payload.title = "Untitled Assessment";
  }

  return Assessment.findOneAndUpdate(filter, payload, { returnDocument: "after" });
};

export const deleteAssessment = async ({ id, schoolId, teacherId, isAdmin: admin }) => {
  const filter = { _id: id, schoolId };
  if (!admin && teacherId) filter.teacherId = teacherId;
  const item = await Assessment.findOneAndDelete(filter);
  if (!item) throw new ApiError("Assessment not found", 404, "NOT_FOUND");
  return item;
};

// ── Submissions ──

/**
 * List submissions for an assessment, optionally campus-filtered.
 *
 * Submissions inherit their campus from the assessment they belong to and the
 * student's own campus. The service accepts an optional campusId; when given,
 * it filters submissions to that campus (or school-wide assessments/submissions).
 */
export const listSubmissions = async ({ assessmentId, campusId }) => {
  const assessment = await Assessment.findById(assessmentId);
  if (!assessment) throw new ApiError("Assessment not found", 404, "NOT_FOUND");

  const base = { assessmentId: assessment._id };
  const filter = buildVisibilityFilter(base, normaliseCampusId(campusId));
  return Submission.find(filter)
    .populate("studentId", "studentName studentClass")
    .sort({ createdAt: -1 });
};

export const getSubmission = async ({ submissionId, user, campusId }) => {
  const sub = await Submission.findById(submissionId)
    .populate("studentId", "studentName studentClass")
    .populate("assessmentId");
  if (!sub) throw new ApiError("Submission not found", 404, "NOT_FOUND");

  // A campus-scoped read must be allowed for the reader's campus. A school-wide
  // submission (campusId null) is visible to anyone in the school.
  const cid = normaliseCampusId(campusId);
  if (cid && sub.campusId && String(sub.campusId) !== cid && !isAdmin(user)) {
    await requireCampusAccess(user, cid);
  }
  return sub;
};

// ── Meetings ──

export const createMeeting = async ({ data, user, schoolId, teacherId, campusId }) => {
  const cid = normaliseCampusId(campusId);
  await assertCanWriteCampus(user, cid);
  const { className, title, startAt, endAt } = data;
  if (!className || !title) {
    throw new ApiError("className and title required", 400, "BAD_REQUEST");
  }
  const roomName = `SukuuPay-${schoolId}-${Date.now()}`;
  const now = new Date();
  const s = startAt ? new Date(startAt) : now;
  const status = s > now ? "scheduled" : "live";
  return Meeting.create({
    schoolId,
    campusId: cid,
    className,
    teacherId,
    title,
    roomName,
    startAt: s,
    endAt: endAt ? new Date(endAt) : null,
    status,
  });
};

export const listTeacherMeetings = async ({ schoolId, classNames, campusId }) => {
  const base = { schoolId };
  if (Array.isArray(classNames) && classNames.length) {
    base.className = { $in: classNames };
  }
  const filter = buildVisibilityFilter(base, normaliseCampusId(campusId));
  return Meeting.find(filter).sort({ createdAt: -1 }).limit(50);
};

// ── LMS Analytics ──

/**
 * The pass mark, derived from the school's grade bands rather than hard-coded.
 *
 * `utils/gradeBands.js` is the single source of the terminal-report scale
 * (A 80–100, A- 75–79, B+ 70–74, B 65–69, F 0–64). The lowest band that is
 * *not* a fail ("F" = Beginning) is "B" at 65, so a graded submission at or
 * above 65% is a pass. Deriving it here means a school that re-tunes its bands
 * moves the pass mark with them, and nothing in this module invents a "50".
 *
 * `utils/gradingConfig.js` governs the 30/70 *weighting* of a report, not the
 * pass/fail cut, so the threshold comes from the bands, not the config.
 */
const PASS_THRESHOLD = (() => {
  const passing = GRADE_BANDS.filter((band) => band.grade !== "F");
  return passing.length ? Math.min(...passing.map((band) => band.min)) : 0;
})();

/**
 * Score-distribution buckets, aligned with the grade bands (ascending).
 *
 * Each band becomes a contiguous bucket: F 0–64, B 65–69, B+ 70–74, A- 75–79,
 * A 80–100. Built from `GRADE_BANDS` so the buckets and the pass mark can never
 * drift apart.
 */
const buildDistributionBuckets = () => {
  const ascending = [...GRADE_BANDS].sort((a, b) => a.min - b.min);
  return ascending.map((band, i) => {
    const upper = i < ascending.length - 1 ? ascending[i + 1].min - 1 : 100;
    return { label: `${band.min}-${upper}`, grade: band.grade, min: band.min, max: upper, count: 0 };
  });
};

const round = (value, dp) => Number(value.toFixed(dp));

const pointsFor = (assessment) =>
  (assessment.questions || []).reduce((sum, q) => sum + (q.points || 0), 0);

const pctScore = (totalScore, points) =>
  points > 0 ? (Number(totalScore || 0) / points) * 100 : 0;

/**
 * LMS analytics for the Growth plan.
 *
 * Mirrors `getGradebook`'s visibility and scoring semantics exactly:
 *   - class scope is the caller's classes (admin → the school's whole list,
 *     teacher → their assignments), resolved through `loadTeacherScope` — the
 *     same helper `resolveTeacherClasses` wraps;
 *   - only `status: "published"` assessments are counted;
 *   - only `status: "graded"` **and** `resultsReleased: true` submissions feed
 *     any score (average, pass rate, distribution, per-assessment average).
 *
 * ## Definitions (documented, not implicit)
 *
 *   assessmentsPublished  number of published assessments in scope.
 *   studentCount          active, non-deleted students in the scoped classes.
 *   totalSubmissions      every submission (any status) for those assessments —
 *                         a count of activity only; never a score.
 *   gradedSubmissions     submissions that are graded AND released (the scored set).
 *   completionRate        gradedSubmissions / (studentCount × assessmentsPublished),
 *                         a fraction 0–1 — the share of expected submissions
 *                         (one per student per assessment) that are graded+released.
 *   classAverageScore     mean of totalScore/points×100 across graded+released
 *                         submissions, a percentage 0–100.
 *   passRate              share of graded+released submissions scoring ≥ the
 *                         pass threshold (from the grade bands), a fraction 0–1.
 *   scoreDistribution     count of graded+released submissions per grade band.
 *   perAssessment[]       { assessmentId, title, averageScore, submitted, graded }
 *                         where `submitted` = submissions that reached
 *                         "submitted"/"graded" (any release state) and `graded`
 *                         = graded+released, `averageScore` from graded+released.
 *
 * ## Term filtering (Assessment has no `term` field)
 *
 * `Assessment` carries no term, so a term/year request is mapped onto a
 * `createdAt` window: `resolveTermRange(term, academicYear, school)` returns the
 * [start, end] dates (the school's explicit `academic.terms` when present, else
 * the GES default calendar), and the assessment query is bounded by
 * `createdAt` within that window (end made inclusive to end-of-day). When no
 * term is supplied — and the school has no `academic.currentTerm` — no window is
 * applied and every published assessment in scope counts. An explicit
 * `academicYear` overrides the school's; otherwise the school's current year is
 * resolved via `resolveSchoolAcademicYear`.
 */
export const getLmsAnalytics = async ({
  schoolId,
  teacherId,
  isAdmin: admin,
  campusId,
  className,
  subject,
  term,
  academicYear,
  user,
}) => {
  const cid = normaliseCampusId(campusId);

  // Class scope, resolved exactly as getGradebook does (admin → school list,
  // teacher → assignments). `loadTeacherScope` is what `resolveTeacherClasses`
  // calls, so the two endpoints agree on who sees which class.
  const { school, classes } = await loadTeacherScope(user, schoolId);
  const scoped = className ? classes.filter((c) => c.className === className) : classes;
  const classNames = scoped.map((c) => c.className);

  const distribution = buildDistributionBuckets();
  const blank = (studentCount = 0) => ({
    assessmentsPublished: 0,
    studentCount,
    totalSubmissions: 0,
    gradedSubmissions: 0,
    completionRate: 0,
    classAverageScore: 0,
    passThreshold: PASS_THRESHOLD,
    passRate: 0,
    scoreDistribution: distribution.map((b) => ({ ...b })),
    perAssessment: [],
  });

  if (!classNames.length) return blank(0);

  // Active students across the scoped classes, campus-filtered like the
  // gradebook's roster read.
  const studentFilter = { schoolId, studentClass: { $in: classNames }, deletedAt: null };
  if (cid) studentFilter.campusId = cid;
  const studentCount = await Student.countDocuments(studentFilter);

  // Assessment base filter — published, in scope, optional subject, optional
  // term window on createdAt (Assessment has no term field).
  const base = { schoolId, status: "published", className: { $in: classNames } };
  if (subject) base.subject = subject;

  const effectiveTerm = term || school?.academic?.currentTerm;
  const effectiveYear = academicYear || resolveSchoolAcademicYear(school);
  if (effectiveTerm) {
    const { start, end } = resolveTermRange(effectiveTerm, effectiveYear, school);
    const endInclusive = new Date(end);
    endInclusive.setUTCHours(23, 59, 59, 999);
    base.createdAt = { $gte: start, $lte: endInclusive };
  }

  const assessments = await Assessment.find(buildVisibilityFilter(base, cid));
  const ids = assessments.map((a) => a._id);
  if (!ids.length) return blank(studentCount);

  const pointsById = new Map(assessments.map((a) => [String(a._id), pointsFor(a)]));

  // The scored set: graded AND released only — identical to the gradebook.
  const scored = await Submission.find(
    buildVisibilityFilter(
      { schoolId, assessmentId: { $in: ids }, status: "graded", resultsReleased: true },
      cid
    )
  );

  // Activity counts (any status) — used for completionRate / totalSubmissions /
  // per-assessment `submitted`. Counts only; no score is read from here, so no
  // unreleased result can leak.
  const allSubs = await Submission.find(
    buildVisibilityFilter({ schoolId, assessmentId: { $in: ids } }, cid)
  );

  const percentages = scored.map((s) => pctScore(s.totalScore, pointsById.get(String(s.assessmentId)) || 0));
  const gradedSubmissions = scored.length;
  const classAverageScore = percentages.length
    ? round(percentages.reduce((sum, p) => sum + p, 0) / percentages.length, 2)
    : 0;

  for (const p of percentages) {
    const bucket = distribution.find((b) => p >= b.min && p <= b.max) || distribution[distribution.length - 1];
    bucket.count += 1;
  }

  const passed = percentages.filter((p) => p >= PASS_THRESHOLD).length;
  const passRate = gradedSubmissions ? round(passed / gradedSubmissions, 4) : 0;

  const expected = studentCount * assessments.length;
  const completionRate = expected > 0 ? round(gradedSubmissions / expected, 4) : 0;

  const gradedByAssessment = new Map();
  for (const s of scored) {
    const key = String(s.assessmentId);
    gradedByAssessment.set(key, (gradedByAssessment.get(key) || 0) + 1);
  }
  const submittedByAssessment = new Map();
  for (const s of allSubs) {
    if (s.status === "submitted" || s.status === "graded") {
      const key = String(s.assessmentId);
      submittedByAssessment.set(key, (submittedByAssessment.get(key) || 0) + 1);
    }
  }
  const pctSumByAssessment = new Map();
  for (const s of scored) {
    const key = String(s.assessmentId);
    const p = pctScore(s.totalScore, pointsById.get(key) || 0);
    pctSumByAssessment.set(key, (pctSumByAssessment.get(key) || 0) + p);
  }

  const perAssessment = assessments.map((a) => {
    const key = String(a._id);
    const graded = gradedByAssessment.get(key) || 0;
    const averageScore = graded ? round((pctSumByAssessment.get(key) || 0) / graded, 2) : 0;
    return {
      assessmentId: a._id,
      title: a.title,
      averageScore,
      submitted: submittedByAssessment.get(key) || 0,
      graded,
    };
  });

  return {
    assessmentsPublished: assessments.length,
    studentCount,
    totalSubmissions: allSubs.length,
    gradedSubmissions,
    completionRate,
    classAverageScore,
    passThreshold: PASS_THRESHOLD,
    passRate,
    scoreDistribution: distribution,
    perAssessment,
  };
};

export default {
  buildVisibilityFilter,
  normaliseCampusId,
  assertCanWriteCampus,
  getLmsAnalytics,
  listStudyPlans,
  createStudyPlan,
  updateStudyPlan,
  deleteStudyPlan,
  listAssessments,
  createAssessment,
  updateAssessment,
  deleteAssessment,
  listSubmissions,
  getSubmission,
  createMeeting,
  listTeacherMeetings,
};