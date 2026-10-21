/**
 * Ghanaian grading bands and the class-score / exam-score arithmetic.
 *
 * Used by both the admin (when compiling a class report card) and the parent
 * portal (when displaying grades). One source, two readers — because a parent
 * who sees a "B" on a report card the school computed as a "B+" is a support
 * call, and the second implementation is always where that disagreement comes
 * from.
 *
 * ## The five-band scale
 *
 * The terminal report prints one letter per subject, and this is the scale it
 * uses:
 *
 *     A  (80–100)  Advance
 *     A- (75–79)   Proficient
 *     B+ (70–74)   Approaching Proficiency
 *     B  (65–69)   Developing
 *     F  (0–64)    Beginning
 *
 * Each band carries a `meaning` as well as a letter, because the physical
 * report prints both: a letter alone tells a parent nothing they can act on,
 * while "Developing" tells them what the child did and what to expect next.
 *
 * ## The total
 *
 * A Ghanaian terminal report breaks a subject down as **Class Score (out of 50)
 * + Exam Score (out of 100) = Total (out of 100)**, and the two halves carry
 * equal weight. `calculateTotalScore` normalises each half onto 50 points and
 * adds them, so:
 *
 *     42/50  → 42 points
 *     48/100 → 24 points
 *     Total  → 66  →  grade B
 *
 * The normalisation is what makes the two scales comparable. A raw sum of 42 +
 * 48 = 90 would put a student who scored 84% in class and 48% in the exam at
 * 90% overall, which is not a number the report could print and not a number
 * that means anything.
 *
 * `score` is a percentage, not a raw mark: the bands compare against `pct` so a
 * subject marked out of 50 and one marked out of 100 land on the same letter
 * for the same proportion. `gradeForScore` does the division.
 */

/** The band table, in descending order — the first match wins. */
const BANDS = [
  { min: 80, grade: "A", meaning: "Advance" },
  { min: 75, grade: "A-", meaning: "Proficient" },
  { min: 70, grade: "B+", meaning: "Approaching Proficiency" },
  { min: 65, grade: "B", meaning: "Developing" },
  { min: 0, grade: "F", meaning: "Beginning" },
];

/** The class score is marked out of 50 and the exam out of 100. */
export const CLASS_SCORE_MAX = 50;
export const EXAM_SCORE_MAX = 100;

/**
 * A number, or zero.
 *
 * `Number('')` is 0 and `Number(undefined)` is `NaN`, and a `NaN` that reaches
 * `Math.round` comes back as `NaN` — which then serialises to `null` in a
 * report card and prints as a blank cell on a parent's screen. Every score that
 * reaches this module is therefore funnelled through here first.
 */
const toScore = (value) => {
  if (value === "" || value === null || value === undefined) return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

/**
 * The letter a percentage earns.
 *
 * `maxScore` is respected rather than assumed to be 100, so a school marking
 * out of 50 gets the same letter for the same proportion instead of everyone
 * failing.
 */
export const gradeForScore = (score, maxScore = 100) => {
  const max = Number(maxScore);
  const pct = max > 0 ? (toScore(score) / max) * 100 : 0;
  const band = BANDS.find((b) => pct >= b.min);
  return band?.grade || "F";
};

/** The meaning that prints beside a letter — "Developing", "Advance", … */
export const meaningForGrade = (grade) => {
  const band = BANDS.find((b) => b.grade === grade);
  return band?.meaning || "—";
};

/**
 * Normalise a class score and an exam score into a total out of 100.
 *
 * Each half is scaled onto 50 points, so the two carry equal weight whatever
 * maximum they were marked against, and the total is the sum of the two — the
 * number the physical report prints under "Total".
 *
 * A missing half counts as zero rather than as `NaN`, so a partially marked
 * class still compiles. Callers that need to know a subject is *incomplete*
 * (one half recorded, the other not) must check for that themselves — see
 * `utils/subjectResults.js`, which is where that distinction is load-bearing.
 */
export const calculateTotalScore = (
  classScore,
  classMax = CLASS_SCORE_MAX,
  examScore,
  examMax = EXAM_SCORE_MAX
) => {
  const classMaxScore = Number(classMax) > 0 ? Number(classMax) : CLASS_SCORE_MAX;
  const examMaxScore = Number(examMax) > 0 ? Number(examMax) : EXAM_SCORE_MAX;

  // Normalise class to 50%.
  const normalizedClass = (toScore(classScore) / classMaxScore) * 50;

  // Normalise exam to 50%.
  const normalizedExam = (toScore(examScore) / examMaxScore) * 50;

  const totalScore = Math.round(normalizedClass + normalizedExam);
  const grade = gradeForScore(totalScore);
  const meaning = meaningForGrade(grade);

  return { totalScore, grade, meaning };
};

/** The band table itself, for anything that needs to render the whole scale. */
export const GRADE_BANDS = BANDS;

export default {
  gradeForScore,
  meaningForGrade,
  calculateTotalScore,
  GRADE_BANDS,
  CLASS_SCORE_MAX,
  EXAM_SCORE_MAX,
};
