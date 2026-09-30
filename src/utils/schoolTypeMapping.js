/**
 * Signup classification ↔ `School.type` translation.
 *
 * The signup form collects a "classification" from `SCHOOL_CLASSIFICATIONS`
 * (frontend/src/utils/constants.js), which offers `senior_high` and `university`.
 * The `School.type` enum has neither — it is `public | private | international |
 * mission | charter` (models/schoolModel.js).
 *
 * Left alone this is invisible until it bites: the bursar picks "Senior High
 * School", the school is created at Step 1, and Joi rejects `type: "senior_high"`
 * with a 422 about an enum they never saw. Signup used to hand the value straight
 * to the API, so this mapping is the difference between a working self-service
 * flow and an unfixable dead end at the last step of onboarding.
 */

/** Mirrors the `type` enum on the School model. */
export const SCHOOL_TYPES = ['public', 'private', 'international', 'mission', 'charter'];

/** Mirrors `SCHOOL_CLASSIFICATIONS` in frontend/src/utils/constants.js. */
export const SIGNUP_CLASSIFICATIONS = [
  'private',
  'international',
  'senior_high',
  'university',
];

const CLASSIFICATION_TO_TYPE = {
  private: 'private',
  international: 'international',
  // No closer enum value exists. These two collapse deliberately, and the UI
  // says so rather than silently rewriting what the bursar chose — see
  // `isLossyClassification`.
  senior_high: 'public',
  university: 'private',
};

const TYPE_TO_DEFAULT_CLASSIFICATION = {
  public: 'senior_high',
  private: 'private',
  international: 'international',
  mission: 'senior_high',
  charter: 'senior_high',
};

/** Values a School actually stores, i.e. the enum the API will accept. */
const PREFERRED_CLASSIFICATION = {
  public: 'public',
  private: 'private',
  international: 'international',
};

/**
 * @param {string} value either a signup classification or a raw `School.type`
 * @returns {string|null} a valid `School.type`, or null when unrecognised
 */
export const toSchoolType = (value) => {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (SCHOOL_TYPES.includes(key)) return key;
  return CLASSIFICATION_TO_TYPE[key] ?? null;
};

/**
 * True when the submitted value is a valid enum member *only because* it was
 * remapped. The Step 1 form uses this to show "saved as a public school", so
 * the lossy step is visible rather than surprising.
 */
export const isLossyClassification = (value) => {
  if (typeof value !== 'string') return false;
  const key = value.trim().toLowerCase();
  if (SCHOOL_TYPES.includes(key)) return false;
  return key in CLASSIFICATION_TO_TYPE && CLASSIFICATION_TO_TYPE[key] !== key;
};

/** Reverse mapping: which classification to preselect for a stored type. */
export const toSignupClassification = (type) => {
  if (typeof type !== 'string') return 'private';
  const key = type.trim().toLowerCase();
  return PREFERRED_CLASSIFICATION[key] ?? TYPE_TO_DEFAULT_CLASSIFICATION[key] ?? 'private';
};

export default { SCHOOL_TYPES, SIGNUP_CLASSIFICATIONS, toSchoolType, toSignupClassification, isLossyClassification };
