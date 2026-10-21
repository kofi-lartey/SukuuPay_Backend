/**
 * Ghanaian terminal-report grading: the bands, and the 30/70 arithmetic.
 *
 * Used by the teacher portal (the grid that previews a mark as it is typed),
 * the admin (the headmaster's approval queue and the report-card compiler)
 * and the parent portal (the record a parent reads). One source, three
 * readers — because a parent who sees a "B" on a report card the school
 * computed as a "B+" is a support call, and the second implementation is
 * always where that disagreement comes from.
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
 * ## The weighting
 *
 * A Ghanaian terminal report is not a sum of two marks. It is a **30/70
 * split**:
 *
 *     Class Assessment (SBA)  30%
 *     End-of-Term Examination  70%
 *     Total                    100%
 *
 * So the class score is a figure out of 30 and the exam's contribution is a
 * figure out of 70, and the total is their sum:
 *
 *     class score 24/30  → 24 points
 *     exam 60/100        → 42 points
 *     Total              → 66  →  grade B
 *
 * The exam is scaled, not copied: 60/100 on the paper is 42/70 of the total.
 * Adding the raw marks instead (24 + 60 = 84) would report a student who
 * scored 48% in the exam at 84% overall, which is not a number the report
 * could print.
 *
 * ## The class score is itself a breakdown
 *
 * The 30% class assessment is not one mark. It is gathered across the term
 * and made up of parts, and the common split is:
 *
 *     Class Test   30% of the class assessment
 *     Group Work   30%
 *     Homework     20%
 *     Class Work   20%
 *
 * Out of the 30 points that is 9, 9, 6 and 6. Each part is marked on its own
 * maximum (a class test out of 100, two pieces of homework out of 20) and
 * contributes its **proportion** of its share:
 *
 *     Class Test 80/100  →  0.8 × 9 = 7.2 points
 *     Group Work 70/100  →  0.7 × 9 = 6.3 points
 *     Homework   12/20   →  0.6 × 6 = 3.6 points
 *     Class Work 15/20   →  0.75 × 6 = 4.5 points
 *     Class score         →  21.6 → 22 out of 30
 *
 * A part that is missing is not a zero: a subject whose breakdown is
 * incomplete has no class score, and a subject with no class score has no
 * total. That is the same rule the two halves always ran on — a partly marked
 * subject is not a result.
 *
 * ## Where the weights live
 *
 * The 30/70 split and the breakdown are a school's policy, not a constant of
 * the country: a private school on a Cambridge-style scheme runs 40/60. The
 * defaults here are the Ghanaian ones; `utils/gradingConfig.js` is where a
 * school overrides them, and every calculation takes the weights as an
 * argument so nothing is hard-wired to the defaults.
 */

/** The band table, in descending order — the first match wins. */
const BANDS = [
  { min: 80, grade: "A", meaning: "Advance" },
  { min: 75, grade: "A-", meaning: "Proficient" },
  { min: 70, grade: "B+", meaning: "Approaching Proficiency" },
  { min: 65, grade: "B", meaning: "Developing" },
  { min: 0, grade: "F", meaning: "Beginning" },
];

/**
 * The class score is out of 30 and the exam paper is out of 100.
 *
 * These are the two *marking* maxima — what a teacher's pen writes on the
 * paper. They are not the weights: the class score's 30 points become 30% of
 * the total, and the exam's 100 marks become 70% of it. Those are
 * `CLASS_WEIGHT` and `EXAM_WEIGHT`.
 */
export const CLASS_SCORE_MAX = 30;
export const EXAM_SCORE_MAX = 100;

/** How much of the total each half carries: 30/70. */
export const CLASS_WEIGHT = 30;
export const EXAM_WEIGHT = 70;

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
 * `maxScore` is respected rather than assumed to be 100, so a class test out
 * of 20 and an exam out of 100 land on the same letter for the same
 * proportion instead of everyone failing.
 */
export const gradeForScore = (score, maxScore = EXAM_SCORE_MAX) => {
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
 * The points one part of the class assessment contributes.
 *
 * A part is marked on its own maximum and contributes its **proportion** of
 * its share of the class score. A class test out of 100 worth 9 points that
 * scores 80 contributes 7.2 of those 9 — which is the point of recording the
 * proportion rather than the raw mark: 80/100 and 16/20 are the same mark, and
 * they must contribute the same.
 */
export const calculateComponentPoints = (score, maxScore, weight) => {
  const max = Number(maxScore);
  const share = Number(weight);
  if (!(max > 0) || !(share > 0)) return 0;
  return (toScore(score) / max) * share;
};

/**
 * The class score, out of 30, from the parts that make it up.
 *
 * `parts` are `{ score, maxScore, weight }` — one per configured component.
 * A part that is missing is **not** a zero: the breakdown is incomplete, so
 * the subject has no class score and therefore no total, no grade and no
 * position. Inventing the missing part's mark would be a worse lie than
 * printing nothing.
 *
 * `complete` says whether every configured part is in.
 */
export const calculateClassScore = (parts = []) => {
  const present = parts.filter(
    (part) => part && part.score !== null && part.score !== undefined && part.score !== ""
  );
  if (!present.length) {
    return { classScore: null, complete: false, missing: parts.length };
  }

  const points = present.reduce(
    (sum, part) =>
      sum + calculateComponentPoints(part.score, part.maxScore, part.weight),
    0
  );

  const missing = parts.length - present.length;

  return {
    classScore: Math.round(points),
    // Every configured part must be in for the class score to be a result.
    complete: missing === 0,
    missing,
  };
};

/**
 * The total, out of 100, from a class score and an exam mark.
 *
 * Each half is scaled onto the points it carries in the total and the two are
 * added:
 *
 *     class 24/30 × 30 = 24 points
 *     exam  60/100 × 70 = 42 points
 *     total = 66
 *
 * `weights` is the school's 30/70 split. The defaults are the Ghanaian ones;
 * a school that runs 40/60 passes its own and the arithmetic follows.
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
  examMax = EXAM_SCORE_MAX,
  weights = { classWeight: CLASS_WEIGHT, examWeight: EXAM_WEIGHT }
) => {
  const classMaxScore = Number(classMax) > 0 ? Number(classMax) : CLASS_SCORE_MAX;
  const examMaxScore = Number(examMax) > 0 ? Number(examMax) : EXAM_SCORE_MAX;
  const classWeight = Number(weights?.classWeight) > 0 ? Number(weights.classWeight) : CLASS_WEIGHT;
  const examWeight = Number(weights?.examWeight) > 0 ? Number(weights.examWeight) : EXAM_WEIGHT;

  // The class score's points in the total.
  const classPoints = (toScore(classScore) / classMaxScore) * classWeight;

  // The exam's points in the total.
  const examPoints = (toScore(examScore) / examMaxScore) * examWeight;

  const totalScore = Math.round(classPoints + examPoints);
  const grade = gradeForScore(totalScore);
  const meaning = meaningForGrade(grade);

  return {
    totalScore,
    grade,
    meaning,
    // The two contributions, as the report prints them: the class score out
    // of 30 and the exam out of 70.
    classPoints: Math.round(classPoints),
    examPoints: Math.round(examPoints),
  };
};

/**
 * A direct class score, rescaled onto the class weight.
 *
 * A class score written as a single mark is recorded against whatever maximum it
 * was written out of — a legacy test out of 50, a new one out of 30. The total
 * only cares about the *proportion*, so the raw mark is rescaled onto the class
 * weight (30 by default) here: 45/50 and 27/30 become the same 27/30 and add up
 * with the exam in exactly the same way. Doing it once, in this module, keeps
 * every reader — the teacher's grid, the headmaster's preview, the report card
 * — looking at the same figure.
 */
export const normaliseClassScore = (score, maxScore, weights = {}) => {
  const classWeight =
    Number(weights?.classWeight) > 0 ? Number(weights.classWeight) : CLASS_WEIGHT;
  const max = Number(maxScore) > 0 ? Number(maxScore) : classWeight;
  return Math.round((toScore(score) / max) * classWeight);
};

/** The band table itself, for anything that needs to render the whole scale. */
export const GRADE_BANDS = BANDS;

export default {
  gradeForScore,
  meaningForGrade,
  calculateComponentPoints,
  calculateClassScore,
  calculateTotalScore,
  GRADE_BANDS,
  CLASS_SCORE_MAX,
  EXAM_SCORE_MAX,
  CLASS_WEIGHT,
  EXAM_WEIGHT,
};
