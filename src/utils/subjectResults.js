/**
 * Turning raw grade rows into a terminal report's subject table.
 *
 * A Ghanaian terminal report does not print one number per subject. It prints
 * a breakdown — Class Score, Exam Score, Total, Grade, and the position the
 * student came in that subject — and the same breakdown has to appear on the
 * report card, in the headmaster's review table, on the PDF and on the parent's
 * phone. This module is where that breakdown is built, so the four surfaces
 * cannot disagree about what a student's English score was.
 *
 * ## The pieces
 *
 *  - `buildSubjectResults` folds one student's raw grade rows (the class-score
 *    parts, the exam score, and the optional direct class score) into one
 *    result per subject.
 *  - `assignSubjectPositions` ranks the class within each subject.
 *  - `rankByAverage` ranks the class overall, by the average of the subject
 *    totals, for the "Position: 4 of 30" line.
 *
 * ## Incomplete subjects
 *
 * A subject whose class assessment or whose exam is missing is **incomplete**,
 * and it says so: `complete: false`, no total, no grade. This is not a
 * nicety. A teacher who has entered the class scores but not yet the exam
 * scores would otherwise produce report cards reading "Total 42, Grade A" for
 * every child in the class — a number that looks like a result and is not one,
 * published to parents. An incomplete subject is excluded from the average and
 * from the ranking for the same reason: a student is not "first" because the
 * marks that would have put them second are missing.
 *
 * A class assessment is itself incomplete unless *every* part of the school's
 * breakdown is in. A missing part is not a zero: inventing the mark would be a
 * worse lie than printing nothing.
 *
 * ## Ranking
 *
 * Both rankings use **competition ranking** ("1224"): tied students share the
 * lower position and the next position is skipped, so two students joint first
 * are both `1` and the next is `3`. Assigning `index + 1` instead gives them
 * "1" and "2", which tells the second one they beat someone they did not — the
 * single most complained-about number on a Ghanaian report card.
 */
import {
  calculateTotalScore,
  calculateClassScore,
  normaliseClassScore,
  gradeForScore,
  meaningForGrade,
  EXAM_SCORE_MAX,
} from "./gradeBands.js";
import { normalizeGradingConfig, partsForSubject } from "./gradingConfig.js";

/**
 * "1st", "2nd", "3rd", "4th" — the ordinal a report card prints.
 *
 * The 11th/12th/13th case is the one a naive `index % 10` gets wrong: 11 is
 * "11th", not "11st".
 */
export const positionLabel = (rank) => {
  const numeric = Number(rank);
  if (!Number.isFinite(numeric) || numeric < 1) return "—";
  const n = Math.floor(numeric);
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
  return `${n}${suffix}`;
};

/**
 * Fold one student's raw grade rows into one result per subject.
 *
 * `rows` are the raw `Grade` documents for a single student: the class-score
 * parts (a class test, group work, homework, class work), the exam score,
 * and — for a school that does not break the class assessment down — a
 * single `class_score` row, per subject. A subject whose class assessment or
 * whose exam is missing is returned `complete: false` — see the note at the
 * top of this file.
 *
 * `grading` is the school's policy (`utils/gradingConfig.js`): the 30/70
 * split and the class-score breakdown. It is an argument rather than a
 * constant because the split is a school policy, not a law of the country.
 *
 * The results come back sorted by subject, because that is the order a report
 * card lists them in and a stable order keeps two compiles of the same class
 * byte-identical.
 */
export const buildSubjectResults = (rows = [], { grading } = {}) => {
  const policy = normalizeGradingConfig(grading);
  const bySubject = new Map();

  for (const row of rows) {
    if (!row?.subject) continue;
    const bucket = bySubject.get(row.subject) || {};
    // A duplicate row for the same assessment type cannot exist — the unique
    // index forbids it — so the last one read simply wins.
    bucket[row.assessmentType] = row;
    bySubject.set(row.subject, bucket);
  }

  const results = [];
  for (const [subject, bucket] of bySubject) {
    const classRow = bucket.class_score;
    const examRow = bucket.exam_score;

    // The class score, out of the class weight (30 by default). It comes from
    // the parts when the school runs a breakdown, and from a direct class
    // score row when it does not.
    const parts = partsForSubject(bucket, policy.components);
    const partsUsed = parts.filter((part) => part.score !== null);

    let classScore = null;
    let classMaxScore = policy.classMax;
    let classComplete = false;

    if (partsUsed.length) {
      const folded = calculateClassScore(parts);
      classComplete = folded.complete;
      // The class score is only a result when *every* part is in — an
      // incomplete breakdown prints nothing, not a partial sum, on the report
      // card. The teacher's grid still previews the partial sum live; this is
      // the compile-time fold that becomes the card.
      classScore = folded.complete ? folded.classScore : null;
    } else if (classRow) {
      // A direct class score (one a school recorded as a single mark). Its raw
      // mark is rescaled onto the class weight so a legacy /50 mark reads as the
      // right /30 value without a second data migration — only the proportion is
      // preserved, so 45/50 and 27/30 contribute identically to the total.
      classScore = normaliseClassScore(classRow.score, classRow.maxScore, {
        classWeight: policy.classWeight,
      });
      classMaxScore = policy.classMax;
      classComplete = true;
    }

    const examScore = examRow ? Number(examRow.score) : null;
    const examMaxScore = examRow
      ? Number(examRow.maxScore) || policy.examMax
      : policy.examMax;

    // Both the class assessment and the exam have to be in for the subject to
    // be a result — and the class assessment is only in when *every* part of
    // the breakdown is.
    const complete = classComplete && classScore !== null && examScore !== null;

    const { totalScore, grade, meaning, classPoints, examPoints } = complete
      ? calculateTotalScore(
          classScore,
          classMaxScore,
          examScore,
          examMaxScore,
          policy
        )
      : {
          totalScore: null,
          grade: "",
          meaning: "",
          classPoints: null,
          examPoints: null,
        };

    results.push({
      subject,
      classScore,
      classMaxScore,
      // The parts the breakdown was folded from, so the headmaster's preview
      // can show what was actually marked and not only the sum.
      classParts: partsUsed.length
        ? parts.map((part) => ({
            key: part.key,
            label: part.label,
            weight: part.weight,
            score: part.score,
            maxScore: part.maxScore,
          }))
        : [],
      examScore,
      examMaxScore,
      // The two contributions to the total, as the report prints them: the
      // class score out of 30 and the exam out of 70.
      classPoints,
      examPoints,
      totalScore,
      grade,
      meaning,
      complete,
    });
  }

  results.sort((a, b) => a.subject.localeCompare(b.subject));
  return results;
};

/**
 * Rank the class within each subject and attach the position to every result.
 *
 * `subjectResultsByStudent` is a `Map` of student id → that student's subject
 * results. Only **complete** subjects are ranked: a student with a missing
 * half has no total to rank on, and ranking them on a partial number would
 * hand them a position they did not earn.
 *
 * Returns a `Map` of student id → `Map` of subject → position label ("1st").
 */
export const assignSubjectPositions = (subjectResultsByStudent = new Map()) => {
  const bySubject = new Map();

  for (const [studentId, results] of subjectResultsByStudent) {
    for (const result of results) {
      if (!result.complete) continue;
      const list = bySubject.get(result.subject) || [];
      list.push({
        studentId,
        subject: result.subject,
        totalScore: result.totalScore,
      });
      bySubject.set(result.subject, list);
    }
  }

  const positions = new Map();
  for (const [, entries] of bySubject) {
    entries.sort((a, b) => b.totalScore - a.totalScore);

    let rank = 0;
    let previous = null;
    for (const [index, entry] of entries.entries()) {
      // Competition ranking: a tie shares the lower position and the next
      // position is skipped.
      if (previous === null || entry.totalScore < previous) {
        rank = index + 1;
        previous = entry.totalScore;
      }
      const label = positionLabel(rank);
      const bySubjectForStudent = positions.get(entry.studentId) || new Map();
      bySubjectForStudent.set(entry.subject, label);
      positions.set(entry.studentId, bySubjectForStudent);
    }
  }

  return positions;
};

/**
 * The class ranking, by average of the subject totals.
 *
 * `drafts` are `{ student, average, completedCount }` pairs. A student with no
 * *completed* subject is not ranked at all — there is nothing to place them
 * on, and an unranked student sitting in the middle of the table reads as a
 * fail rather than as "not marked yet".
 *
 * The filter is on the count of completed subjects, not on the average: a
 * student who genuinely scored zero in every subject has an average of 0 and
 * *is* ranked — last — whereas a student with nothing marked has an average of
 * 0 only because there is no average yet.
 */
export const rankByAverage = (drafts = []) => {
  const ranked = drafts.filter((entry) => (entry.completedCount || 0) > 0);
  const sorted = [...ranked].sort((a, b) => b.average - a.average);

  const positions = new Map();
  let position = 0;
  let previous = null;
  for (const [index, entry] of sorted.entries()) {
    if (previous === null || entry.average < previous) {
      position = index + 1;
      previous = entry.average;
    }
    positions.set(String(entry.student._id), position);
  }
  return positions;
};

/**
 * The average of a student's completed subject totals.
 *
 * Only complete subjects count. A subject with one half recorded is excluded
 * rather than counted as a zero, because a zero would drag the average down
 * and move the student down the class table for a mark that was never given.
 */
export const averageOfTotals = (results = []) => {
  const completed = results.filter((r) => r.complete);
  if (!completed.length) return 0;
  const sum = completed.reduce((acc, r) => acc + (r.totalScore || 0), 0);
  return Math.round((sum / completed.length) * 10) / 10;
};

/**
 * Fold a *payload* of subject marks into subject results.
 *
 * The teacher's own compile path carries its marks in the request body rather
 * than reading them from the grade book, and its rows come in two shapes:
 *
 *  - the breakdown — `{ subject, classScore, examScore }` — where the class
 *    score is out of the class weight (30) and the exam out of its own
 *    maximum (100), folded exactly as the raw grade rows would be;
 *  - the pre-split single figure — `{ subject, score, maxScore }` — which is
 *    already a total and is taken as one.
 *
 * A row with only one half of the breakdown is incomplete, on the same terms
 * as everywhere else: no total, no grade, no position.
 */
export const buildSubjectResultsFromPayload = (rows = [], { grading } = {}) => {
  const policy = normalizeGradingConfig(grading);
  const results = [];

  for (const row of rows) {
    if (!row?.subject) continue;

    const hasBreakdown = row.classScore != null || row.examScore != null;

    if (!hasBreakdown) {
      // The pre-split shape: one figure that is already a total.
      const score = Number(row.score);
      const maxScore = Number(row.maxScore) || policy.examMax;
      const grade = gradeForScore(score, maxScore);
      results.push({
        subject: row.subject,
        classScore: null,
        classMaxScore: policy.classMax,
        classParts: [],
        examScore: null,
        examMaxScore: policy.examMax,
        classPoints: null,
        examPoints: null,
        totalScore: score,
        grade,
        meaning: meaningForGrade(grade),
        complete: true,
      });
      continue;
    }

    const classScore = row.classScore != null ? Number(row.classScore) : null;
    const classMaxScore = Number(row.classMaxScore) || policy.classMax;
    const examScore = row.examScore != null ? Number(row.examScore) : null;
    const examMaxScore = Number(row.examMaxScore) || policy.examMax;
    const complete = classScore != null && examScore != null;

    const { totalScore, grade, meaning, classPoints, examPoints } = complete
      ? calculateTotalScore(
          classScore,
          classMaxScore,
          examScore,
          examMaxScore,
          policy
        )
      : {
          totalScore: null,
          grade: "",
          meaning: "",
          classPoints: null,
          examPoints: null,
        };

    results.push({
      subject: row.subject,
      classScore,
      classMaxScore,
      classParts: [],
      examScore,
      examMaxScore,
      classPoints,
      examPoints,
      totalScore,
      grade,
      meaning,
      complete,
    });
  }

  results.sort((a, b) => a.subject.localeCompare(b.subject));
  return results;
};
