/**
 * A school's grading policy: the 30/70 split and the class-score breakdown.
 *
 * ## Why this is a setting and not a constant
 *
 * The 30/70 split is the Ghanaian standard under the Ministry of Education
 * and GES, and it is the default here. It is not, however, the only scheme in
 * the country: a private school on a Cambridge-style curriculum commonly runs
 * 40/60, and a school that does not run a group project has no group-work
 * column to weight.
 *
 * So the policy lives on the school and every calculation takes it as an
 * argument. Nothing in the arithmetic reads a default directly — a school that
 * has never opened the settings page gets the Ghanaian scheme because that is
 * what its stored config normalises to, not because the code assumes it.
 *
 * ## The class-score breakdown
 *
 * The 30% class assessment is gathered across the term from several parts, and
 * the split most Ghanaian schools use is:
 *
 *     Class Test   30% of the class assessment
 *     Group Work   30%
 *     Homework     20%
 *     Class Work   20%
 *
 * Out of the 30 points that is 9, 9, 6 and 6. Each part is marked on its own
 * maximum — a class test out of 30, two pieces of homework out of 20 — and
 * the part contributes its proportion of its share.
 *
 * The part weights are stored as **points out of the class score** (9, 9, 6, 6
 * out of 30) rather than as percentages of the class assessment, because that
 * is the number a teacher needs when the school reweights the split to 40/60:
 * the parts keep their points and the class score's 30 points become 40 of
 * the total.
 */
import { CLASS_SCORE_MAX, EXAM_SCORE_MAX, CLASS_WEIGHT, EXAM_WEIGHT } from "./gradeBands.js";

/**
 * The default breakdown, as a school that has never configured one gets it.
 *
 * `maxScore` is the default maximum a part is marked against. It is a
 * *default*, not a rule: the maximum is recorded on the grade row, so a
 * teacher who marks a class test out of 50 says so on the row and the
 * arithmetic follows it.
 */
export const DEFAULT_CLASS_COMPONENTS = [
   { key: "class_test", label: "Class Test", weight: 9, maxScore: 30 },
   { key: "group_work", label: "Group Work", weight: 9, maxScore: 30 },
  { key: "homework", label: "Homework", weight: 6, maxScore: 20 },
  { key: "class_work", label: "Class Work", weight: 6, maxScore: 20 },
];

/**
 * The assessment types a class-score part may use.
 *
 * Fixed rather than free text, because the type is on the `Grade` row and the
 * row's unique index is built from it: a type that is not in this list has no
 * row to live in, and a school that invents one is asking for a migration.
 * A school that renames a part changes its *label*; the key stays.
 */
export const CLASS_COMPONENT_KEYS = ["class_test", "group_work", "homework", "class_work"];

/** The assessment types a grade row may hold. */
export const ASSESSMENT_TYPES = [...CLASS_COMPONENT_KEYS, "class_score", "exam_score"];

const isFiniteNumber = (value) => Number.isFinite(Number(value));

/**
 * The grading policy a school is running.
 *
 * Read from the school document, with every field defaulted and every field
 * bounded. A school with no stored config gets the Ghanaian scheme; a school
 * with a half-written one gets a working policy rather than a broken page.
 *
 * The returned object is what every calculation takes as its `weights`, so it
 * always has the same shape:
 *
 *     {
 *       classWeight: 30,          // points out of 100 the class score carries
 *       examWeight: 70,           // points out of 100 the exam carries
 *       classMax: 30,             // the class score is marked out of 30
 *       examMax: 100,             // the exam paper is marked out of 100
 *       components: [ … ],        // the class-score breakdown
 *     }
 */
export const normalizeGradingConfig = (config = {}) => {
  const classWeight = isFiniteNumber(config?.classWeight)
    ? Math.max(0, Math.min(100, Number(config.classWeight)))
    : CLASS_WEIGHT;
  const examWeight = isFiniteNumber(config?.examWeight)
    ? Math.max(0, Math.min(100, Number(config.examWeight)))
    : EXAM_WEIGHT;

  const rawComponents = Array.isArray(config?.components)
    ? config.components
    : DEFAULT_CLASS_COMPONENTS;

  const seen = new Set();
  const components = rawComponents
    .filter((part) => part && CLASS_COMPONENT_KEYS.includes(part.key))
    .filter((part) => {
      if (seen.has(part.key)) return false;
      seen.add(part.key);
      return true;
    })
    .map((part) => ({
      key: part.key,
      label: String(part.label || part.key).trim().slice(0, 40) || part.key,
      weight: isFiniteNumber(part.weight) ? Math.max(0, Number(part.weight)) : 0,
      maxScore: isFiniteNumber(part.maxScore) && Number(part.maxScore) > 0
        ? Number(part.maxScore)
        : EXAM_SCORE_MAX,
    }));

  return {
    classWeight,
    examWeight,
    // The class score is out of the points it carries in the total — 30 out of
    // 30 by default. That is what makes "Class Score 27/30" and "Exam 42/70"
    // add up to the total on the report card.
    classMax: classWeight,
    examMax: isFiniteNumber(config?.examMax) && Number(config.examMax) > 0
      ? Number(config.examMax)
      : EXAM_SCORE_MAX,
    components,
  };
};

/**
 * The grading policy a school document is running.
 *
 * The same normalisation, reading the sub-document off the school. A school
 * that has never been configured gets the Ghanaian scheme, which is the whole
 * point of the default living here rather than at every call site.
 */
export const getSchoolGrading = (school) =>
  normalizeGradingConfig(school?.academic?.grading || school?.grading);

/**
 * The parts of a class score, as the arithmetic needs them.
 *
 * `rows` are the component grade rows for one subject, keyed by their
 * assessment type. Each configured part is paired with the row that carries
 * it, so a missing part is visible as a missing part rather than as an
 * absence.
 */
export const partsForSubject = (rows, components = []) =>
  components.map((part) => {
    const row = rows?.[part.key];
    return {
      key: part.key,
      label: part.label,
      weight: part.weight,
      score: row ? Number(row.score) : null,
      maxScore: row ? Number(row.maxScore) || part.maxScore : part.maxScore,
    };
  });
