import crypto from "node:crypto";

/**
 * PIN derivation for the parent pay portal.
 *
 * The PIN is deterministically derived from the student's date of birth.
 * This is a shared-secret model: the parent knows the child's DOB,
 * and the system derives the same PIN server-side for verification.
 *
 * ## Format: DDMMYYYY (8 digits)
 * - Example: DOB "2020-06-09" → PIN "09062020"
 * - Maximum entropy from available data (day + month + 4-digit year)
 * - Familiar format for Ghanaian parents (day/month/year)
 * - Consistent 8-digit length for UI validation
 *
 * ## Security Notes
 * - The PIN is NOT stored in plaintext anywhere
 * - It is derived on-demand during verification
 * - Rate limiting protects against brute force
 * - The token scopes the request to one student, so PIN collisions
 *   (siblings with same DOB) are not a cross-account risk
 */

export const PIN_FORMAT = {
  length: 8,
  pattern: /^\d{8}$/,
  description: "DDMMYYYY (e.g., 09062020 for 9th June 2020)",
};

/**
 * Derives the parent PIN from a date of birth.
 *
 * @param {Date|string} dob - Date of birth as Date object, ISO string, or "DD/MM/YYYY"
 * @returns {string} 8-digit PIN in DDMMYYYY format
 * @throws {Error} If DOB is invalid or cannot be parsed
 */
export const derivePinFromDob = (dob) => {
  if (!dob) {
    throw new Error("Date of birth is required to derive PIN");
  }

  let date;
  if (dob instanceof Date) {
    date = dob;
  } else if (typeof dob === "string") {
    // Try ISO format first (YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      date = new Date(dob);
    }
    // Try DD/MM/YYYY format
    else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dob)) {
      const [day, month, year] = dob.split("/").map(Number);
      date = new Date(year, month - 1, day);
    }
    // Try other common formats
    else {
      date = new Date(dob);
    }
  } else {
    throw new Error("Invalid date of birth format");
  }

  if (isNaN(date.getTime())) {
    throw new Error("Invalid date of birth");
  }

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();

  return `${day}${month}${year}`;
};

/**
 * Constant-time comparison for PIN verification.
 * Prevents timing attacks on the PIN comparison.
 *
 * @param {string} inputPin - PIN provided by the parent
 * @param {string} expectedPin - PIN derived from student's DOB
 * @returns {boolean} True if PINs match
 */
export const verifyPin = (inputPin, expectedPin) => {
  // Validate inputs are strings of correct length
  if (
    typeof inputPin !== "string" ||
    typeof expectedPin !== "string" ||
    inputPin.length !== expectedPin.length
  ) {
    return false;
  }

  // Use crypto.timingSafeEqual for constant-time comparison
  // Convert strings to buffers for comparison
  const inputBuffer = Buffer.from(inputPin);
  const expectedBuffer = Buffer.from(expectedPin);

  return crypto.timingSafeEqual(inputBuffer, expectedBuffer);
};

/**
 * Validates PIN format (8 digits).
 *
 * @param {string} pin - PIN to validate
 * @returns {boolean} True if format is valid
 */
export const isValidPinFormat = (pin) => {
  return typeof pin === "string" && PIN_FORMAT.pattern.test(pin);
};

/**
 * Masks a PIN for display/logging (shows only last 2 digits).
 *
 * @param {string} pin - PIN to mask
 * @returns {string} Masked PIN (e.g., "******20")
 */
export const maskPin = (pin) => {
  if (!pin || pin.length < 2) return "****";
  return "*".repeat(pin.length - 2) + pin.slice(-2);
};

/**
 * Rate limit key for PIN verification attempts.
 * Keyed by token suffix to avoid storing full tokens in memory.
 *
 * @param {string} token - Pay token
 * @returns {string} Rate limit key
 */
export const pinRateLimitKey = (token) => {
  if (!token || typeof token !== "string") return "pin:unknown";
  return `pin:${token.slice(-4)}`;
};

export default {
  derivePinFromDob,
  verifyPin,
  isValidPinFormat,
  maskPin,
  pinRateLimitKey,
  PIN_FORMAT,
};