/**
 * Ghana WAEC-style grade bands.
 *
 * Used by both the admin (when compiling a class report card) and the parent
 * portal (when displaying grades). One source, two readers — because a parent
 * who sees a "B" on a report card the school computed as a "B+" is a support
 * call, and the second implementation is always where that disagreement comes
 * from.
 *
 * `score` is a percentage, not a raw mark: the bands compare against `pct` so a
 * subject marked out of 50 and one marked out of 100 land on the same letter
 * for the same proportion. `gradeForScore` does the division.
 */
const BANDS = [
  { min: 80, grade: "A+" },
  { min: 75, grade: "A" },
  { min: 70, grade: "A-" },
  { min: 65, grade: "B+" },
  { min: 60, grade: "B" },
  { min: 55, grade: "B-" },
  { min: 50, grade: "C+" },
  { min: 45, grade: "C" },
  { min: 40, grade: "D" },
  { min: 35, grade: "E" },
  { min: 0, grade: "F" },
];

export const gradeForScore = (score, maxScore = 100) => {
  const pct = maxScore > 0 ? (Number(score) / maxScore) * 100 : 0;
  const band = BANDS.find((b) => pct >= b.min);
  return band?.grade || "F";
};

/** The band table itself, for anything that needs to render the whole scale. */
export const GRADE_BANDS = BANDS;

export default { gradeForScore, GRADE_BANDS };
