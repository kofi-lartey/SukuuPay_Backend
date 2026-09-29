// ─────────────────────────────────────────────
// HTML escaping
// ─────────────────────────────────────────────
// Email templates interpolate caller-supplied and record-supplied values
// (student names, parent names, announcement bodies) straight into HTML.
// Without escaping, a value containing markup becomes part of the message —
// and in a school system, parent-supplied names are attacker-controlled.

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (value) =>
  value === null || value === undefined
    ? ''
    : String(value).replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);

/** Escapes a value for use in an href attribute. */
export const escapeUrl = (value) => {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  if (!raw) return '';
  // Only http(s) and mailto links are allowed; anything else (javascript:,
  // data:) is dropped rather than escaped, because escaping would make it
  // look like a valid URL.
  if (!/^(https?:|mailto:)/i.test(raw)) return '';
  return escapeHtml(raw);
};

export default escapeHtml;
