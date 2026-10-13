/**
 * Stable colour per subject name.
 *
 * A hash-derived lookup so the same subject is always the same colour in every
 * class and every term. Rendered in the parent portal's timetable as a vertical
 * accent bar on each period card — which is the whole reason it is derived from
 * the subject *name* rather than stored on the period: a teacher who renames
 * "Maths" to "Mathematics" mid-term would otherwise recolour every lesson the
 * parent has already learned to recognise.
 *
 * The palette is deliberately dark enough to carry white text, because the same
 * value is used as a fill and as a label background in the portal.
 */
const SUBJECT_COLORS = [
  "#0A5C36",
  "#0284C7",
  "#7C3AED",
  "#EA580C",
  "#0891B2",
  "#BE185D",
  "#D97706",
  "#059669",
];

export const colorForSubject = (subject) => {
  const text = String(subject || "").trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return SUBJECT_COLORS[Math.abs(hash) % SUBJECT_COLORS.length];
};

export default { colorForSubject, SUBJECT_COLORS };
