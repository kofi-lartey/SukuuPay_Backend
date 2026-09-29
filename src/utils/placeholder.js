// ─────────────────────────────────────────────
// Placeholder detection
// ─────────────────────────────────────────────
// `.env` ships with `MTN_API_KEY=your-mtn-api-key`. That is a non-empty string
// and therefore truthy, so a plain `if (!MTN_API_KEY)` check reports the
// integration as configured — routes traffic to it — and then fails every call
// with a 401, while the fallback meant to catch exactly that case never runs.
//
// Treating unfilled placeholders as absent is what makes a configured fallback
// actually reachable, and what stops GET /version reporting a channel as ready
// when it cannot make a single request.
//
// Shared by every provider status helper so one definition of "unfilled" applies
// platform-wide. A new integration that forgets to call this is the bug this
// module exists to make hard to write.
const PLACEHOLDER_PATTERNS = [
  /^your[-_ ]/i,
  /^your$/i,
  /^changeme$/i,
  /^change[-_]?me$/i,
  /^todo$/i,
  /^xxx+$/i,
  /^placeholder$/i,
  /^replace[-_]?me$/i,
  /^insert[-_]?here$/i,
  /^example$/i,
];

/**
 * True when a value is absent or an unfilled placeholder.
 *
 * @param {unknown} value
 * @returns {boolean} true means "treat this as not configured"
 */
export const isPlaceholder = (value) => {
  if (value === undefined || value === null) return true;
  const trimmed = String(value).trim();
  if (!trimmed) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
};

/**
 * True only when every supplied value is a real credential.
 *
 * @param {...unknown} values
 * @returns {boolean}
 */
export const allConfigured = (...values) => values.every((value) => !isPlaceholder(value));

/**
 * A per-credential report for GET /version: never the value, only its state.
 *
 * @param {Record<string, unknown>} credentials
 * @returns {Record<string, { present: boolean, placeholder: boolean }>}
 */
export const describeCredentials = (credentials) =>
  Object.fromEntries(
    Object.entries(credentials).map(([name, value]) => [
      name,
      { present: value !== undefined && value !== null && String(value).trim() !== '',
        placeholder: isPlaceholder(value) },
    ])
  );
