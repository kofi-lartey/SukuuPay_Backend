import crypto from 'node:crypto';
import { INVITE_PASSWORD_SUFFIX_LENGTH } from '../config/env.js';

/**
 * Default passwords for admin-provisioned accounts.
 *
 * The product requirement is that an invited user's initial password is derived
 * from "the associated School ID", so this is seeded from the school's
 * `schoolCode` (e.g. `PBS001`) with a cryptographically random suffix:
 *
 *     PBS001-7K4M2XQ9
 *     └── school ──┘ └─ random ─┘
 *
 * Why a hybrid rather than either half alone:
 *
 * - School code *alone* is guessable. It is three initials plus a three-digit
 *   counter, it is printed on the school's own join instructions, and the join
 *   flow's own comment says so outright. A password derived from it alone would
 *   be a shared secret across every teacher at the school.
 * - Random *alone* loses the requirement and loses the operations story: a
 *   bursar who needs to tell a new teacher "just use the one from your email"
 *   has nothing to say, and an auditor reading the audit log cannot tell which
 *   credential belongs to which institution.
 *
 * So the school code carries provenance and recognisability, and the suffix
 * carries the entropy. Neither half is secret on its own.
 *
 * The suffix is drawn with rejection sampling rather than
 * `crypto.randomInt(0, alphabet.length)` per character. A 31-character
 * alphabet over a byte-sized range has a modulo bias: 256 % 31 leaves the first
 * 8 characters roughly 2.3% more likely than the rest. That is far too small to
 * exploit against a per-user credential, but it is also free to avoid, and a
 * generator whose entire job is entropy should not carry a known bias.
 */

// Uppercase, lowercase and digits, minus the glyphs that are routinely
// misread when a password is copied out of an email by hand or read over the
// phone: 0/O, 1/l/I. 31 characters, all ASCII, all safe in a URL, a shell, a
// CSV export and a PDF without quoting.
const SUFFIX_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const MAX_UNBIASED_BYTE = Math.floor(256 / SUFFIX_ALPHABET.length) * SUFFIX_ALPHABET.length;

/** Draws `length` characters uniformly from `alphabet`. */
const randomFromAlphabet = (alphabet, length) => {
  let out = '';
  while (out.length < length) {
    // Rejection sampling: discard the tail that would skew the distribution.
    for (const byte of crypto.randomBytes(length + 8)) {
      if (byte >= MAX_UNBIASED_BYTE) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
};

/**
 * Reduces a School ID to a password-safe prefix.
 *
 * Accepts a `School` document, a bare `schoolCode`, or an ObjectId, because the
 * caller has one of the three depending on how far it got before the lookup.
 * Anything unexpected degrades to `SCH` rather than throwing: a cosmetic prefix
 * must never be the reason an invitation fails to send.
 */
export const schoolPasswordPrefix = (schoolIdSource) => {
  const raw =
    typeof schoolIdSource === 'string'
      ? schoolIdSource
      : schoolIdSource?.schoolCode || schoolIdSource?.slug || schoolIdSource?._id || schoolIdSource?.id || '';

  const cleaned = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cleaned) return 'SCH';

  return cleaned.slice(0, 8);
};

/**
 * Mints the default password for an invited user.
 *
 * @param {string|object} schoolIdSource School document, `schoolCode`, or ObjectId.
 * @param {number} [suffixLength]        Overrides `INVITE_PASSWORD_SUFFIX_LENGTH`.
 * @returns {string} e.g. `PBS001-7K4M2XQ9`
 */
export const generateDefaultPassword = (schoolIdSource, suffixLength) => {
  const size = Number.isInteger(suffixLength) && suffixLength > 0
    ? suffixLength
    : INVITE_PASSWORD_SUFFIX_LENGTH;

  return `${schoolPasswordPrefix(schoolIdSource)}-${randomFromAlphabet(SUFFIX_ALPHABET, size)}`;
};

/**
 * Whether `candidate` still looks like a default password this module minted.
 *
 * Advisory only — it is a heuristic over the shape, not a check against the
 * stored hash — and is used by `POST /users/:userId/resend-invite` to decide
 * whether reissuing is even meaningful, never to weaken a real authentication
 * decision.
 */
export const looksLikeDefaultPassword = (candidate) =>
  typeof candidate === 'string' && /^[A-Z0-9]{1,8}-[A-Za-z0-9]{6,}$/.test(candidate);

export default { generateDefaultPassword, schoolPasswordPrefix, looksLikeDefaultPassword };