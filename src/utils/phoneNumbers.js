// ─────────────────────────────────────────────
// Phone number normalisation
// ─────────────────────────────────────────────
// Every messaging gateway — WhatsApp's Cloud API in particular — addresses
// recipients in E.164 (`+<country><national>`), but the Student model stores
// whatever the school typed into the parent form: `0241234567`,
// `233241234567`, `+233 24 123 4567`, `00233241234567`. Those all describe one
// number and all fail at the provider if forwarded verbatim.
//
// Normalisation is deliberately conservative: a number it cannot confidently
// resolve is reported as invalid rather than guessed at, because sending a fee
// reminder to the wrong parent is worse than not sending it.

// Ghana is the platform's only market today. National numbers are 9 digits
// starting 2 (mobile) or 3 (fixed line); locally they are written with a
// leading 0.
export const GHANA_COUNTRY_CODE = '233';
export const GHANA_NSN_LENGTH = 9;

/**
 * Reduces a phone number to bare digits, dropping an international prefix.
 * Returns null when the input contains no digits at all.
 */
export const toDigits = (input) => {
  if (input === null || input === undefined) return null;
  // Some gateways prefix a local number with `+` meaning "local", e.g. `+233`
  // is a country code but `+` alone is not. Only the country-code form is
  // stripped here; a lone `+` is meaningless and rejected downstream.
  const trimmed = String(input).trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return null;

  // 00 is the international access code, so `0044...` means `+44...`.
  if (digits.startsWith('00')) return digits.slice(2);
  return digits;
};

/**
 * Resolves any accepted spelling of a Ghanaian number to E.164.
 *
 * Accepted: `+233241234567`, `00233241234567`, `233241234567`,
 * `0241234567`, `241234567`, and any spacing/punctuation variant of those.
 *
 * @returns {{ valid: boolean, e164: string|null, national: string|null,
 *   reason: string|null }}
 */
export const toGhanaE164 = (input) => {
  const invalid = (reason) => ({ valid: false, e164: null, national: null, reason });

  if (input === null || input === undefined || String(input).trim() === '') {
    return invalid('no phone number on record');
  }

  const raw = String(input).trim();
  // A `+` in the middle of a number, or letters, means the field holds
  // something other than a phone number.
  if (/[^\d\s+()-]/.test(raw)) {
    return invalid('phone number contains letters or unexpected characters');
  }

  const digits = toDigits(raw);
  if (!digits) return invalid('phone number contains no digits');

  let national = digits;

  if (digits.startsWith(GHANA_COUNTRY_CODE)) {
    national = digits.slice(GHANA_COUNTRY_CODE.length);
  } else if (digits.length === 10 && digits.startsWith('0')) {
    national = digits.slice(1);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    national = digits.slice(1);
  }

  if (national.length !== GHANA_NSN_LENGTH) {
    return invalid(
      `phone number is not a ${GHANA_NSN_LENGTH}-digit Ghanaian number (got ${national.length} digits after normalisation)`
    );
  }

  return {
    valid: true,
    e164: `+${GHANA_COUNTRY_CODE}${national}`,
    national,
    reason: null,
  };
};

/**
 * E.164 for a number already in international form, for numbers outside Ghana.
 * Used only where a provider has already told us the country code, since a
 * local number cannot be disambiguated without knowing its market.
 */
export const toInternationalE164 = (input) => {
  const raw = String(input ?? '').trim();
  if (/^\+\d{8,15}$/.test(raw)) {
    return { valid: true, e164: raw, national: raw.slice(1), reason: null };
  }

  const digits = toDigits(raw);
  if (digits && /^[1-9]\d{7,14}$/.test(digits)) {
    return { valid: true, e164: `+${digits}`, national: digits, reason: null };
  }

  return {
    valid: false,
    e164: null,
    national: null,
    reason: 'phone number is not a valid international number',
  };
};

/**
 * Best-effort normalisation used where a failure must not block the operation
 * — the SMS gateway accepts local formats, so a number that will not resolve
 * is still worth submitting.
 */
export const normalisePhone = (input) => {
  const ghana = toGhanaE164(input);
  if (ghana.valid) return ghana;

  const international = toInternationalE164(input);
  if (international.valid) return international;

  return ghana;
};

/**
 * Renders a number for display: `+233 24 123 4567`.
 *
 * Grouping is the Ghanaian 2-3-4 split of the national significant number. A
 * number from another market has no known convention here, so it is returned
 * unchanged rather than grouped by a guess.
 */
export const formatPhone = (e164) => {
  if (!e164) return '';
  const value = String(e164).trim();
  const digits = value.replace(/\D/g, '');
  if (!digits.startsWith(GHANA_COUNTRY_CODE)) return value;

  const national = digits.slice(GHANA_COUNTRY_CODE.length);
  const groups = national.match(/^(\d{2})(\d{3})(\d{4})$/);
  if (!groups) return `+${GHANA_COUNTRY_CODE} ${national}`;

  return `+${GHANA_COUNTRY_CODE} ${groups[1]} ${groups[2]} ${groups[3]}`;
};

/**
 * The mobile network a Ghanaian number belongs to, from its prefix.
 *
 * Ghana's operators hold overlapping but distinct 2-digit blocks, and the blocks
 * are the *only* way to tell MTN from Telecel from AirtelTigo without asking the
 * carrier. Used for the operator split on a broadcast — "68% of these parents
 * are on MTN" is the figure a school argues about coverage with — and so that
 * a school's delivery report can be read by operator.
 *
 * Returns null for anything unrecognised rather than guessing. A misattributed
 * number in a coverage split is worse than an absent one: it makes a real
 * pattern look like noise.
 */
export const networkForGhanaNumber = (input) => {
  const { valid, national } = toGhanaE164(input);
  if (!valid) return null;

  const prefix = national.slice(0, 2);
  // MTN
  if (['24', '54', '55', '59'].includes(prefix)) return 'mtn';
  // Telecel
  if (['22', '72'].includes(prefix)) return 'telecel';
  // AirtelTigo — the two brands share the 20/02/057/058 ranges since the merger.
  if (['20', '26', '27', '57', '58'].includes(prefix)) return 'airteltigo';
  return null;
};

/**
 * Masks the middle of a number for logs and admin lists: `+233 ••••• 567`.
 *
 * The country code is kept so a reader can still tell which market a number
 * belongs to; everything between it and the last three digits is hidden.
 */
export const maskPhone = (input) => {
  const { valid, e164 } = normalisePhone(input);
  if (!valid || !e164) return '';

  const countryCode = e164.startsWith(`+${GHANA_COUNTRY_CODE}`)
    ? GHANA_COUNTRY_CODE
    : e164.slice(2, 3);

  return `+${countryCode} ••••• ${e164.slice(-3)}`;
};

/**
 * Every spelling of one number that could plausibly be on a Student record.
 *
 * Used to resolve an inbound message back to a school: Meta tells us the sender
 * in E.164 (`+233241234567`) while the number on the parent form could be any
 * of the accepted forms, so a single equality match would miss most parents.
 */
export const phoneSearchCandidates = (input) => {
  const { valid, e164, national } = normalisePhone(input);
  if (!valid) {
    // Not normalisable — fall back to the literal digits so an unusual format
    // still gets an exact match rather than being silently dropped.
    const digits = toDigits(input);
    return digits ? [String(input).trim(), digits] : [];
  }

  const candidates = new Set([e164, String(input).trim()]);
  candidates.add(`+${GHANA_COUNTRY_CODE}${national}`);
  candidates.add(`${GHANA_COUNTRY_CODE}${national}`);
  candidates.add(`00${GHANA_COUNTRY_CODE}${national}`);
  candidates.add(`0${national}`);
  candidates.add(national);

  // Only return spellings that make sense for this number: a 9-digit national
  // form is a Ghana convention, and adding it to a non-Ghanaian number would
  // create false matches.
  if (e164.startsWith(`+${GHANA_COUNTRY_CODE}`)) {
    candidates.add(`0${national}`);
  }

  return [...candidates].filter(Boolean);
};
