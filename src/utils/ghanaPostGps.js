/**
 * Ghana Post GPS digital addresses.
 *
 * A digital address identifies a 5m x 5m square of Ghana and is printed on
 * receipts, on delivery paperwork and — increasingly — on the national ID
 * application. Getting one wrong is worse than leaving it blank, so the format
 * is enforced rather than merely suggested.
 *
 * Structure, per the UPU addressing spec for Ghana:
 *
 *   GA-183-8164
 *   │  │    └── 4 digits: the unique address within the postal code
 *   │  └─────── 3 digits: the postal code area (sub-district / post office zone)
 *   └────────── 2 letters: the area code — first letter region, second district
 *
 * Ghana Post's own API also emits the undashed form (`GA1838164`), and older
 * records in this database predate the picker, so both are accepted and
 * normalised to the canonical dashed form on write.
 */

/**
 * Canonical shape. Dashes optional, case-insensitive, normalised on write.
 *
 * `[-\s]*` rather than `[-\s]?` because users paste from all sorts of places:
 * "GA-183-8164", "GA1838164" and "GA - 183 - 8164" are all the same address, and
 * a single-character separator class rejects the third of those.
 */
const DIGITAL_ADDRESS = /^([A-Za-z]{2})[-\s]*(\d{3})[-\s]*(\d{4})$/;

/**
 * Area codes verified against Ghana Post's published region/district guide.
 *
 * Deliberately partial, and used only as `<datalist>` suggestions — never as an
 * enforced mapping from the school's region to a code. That mapping is ~260
 * districts long, was last reorganised when Ghana's regions were split in 2019,
 * and a stale entry would silently file a school under the wrong district on a
 * document a parent relies on. The user picks; we suggest.
 */
export const AREA_CODE_SUGGESTIONS = [
  { code: 'GA', district: 'Accra', region: 'Greater Accra' },
  { code: 'GB', district: 'Ashaiman', region: 'Greater Accra' },
  { code: 'GC', district: 'Ga Central', region: 'Greater Accra' },
  { code: 'GD', district: 'Adentan', region: 'Greater Accra' },
  { code: 'GE', district: 'Ga East', region: 'Greater Accra' },
  { code: 'GS', district: 'Ga South', region: 'Greater Accra' },
  { code: 'GX', district: 'Ada West', region: 'Greater Accra' },
  { code: 'GY', district: 'Ada East', region: 'Greater Accra' },
  { code: 'AA', district: 'Asante Akim South', region: 'Ashanti' },
  { code: 'AK', district: 'Kumasi Metropolitan', region: 'Ashanti' },
  { code: 'AH', district: 'Atwima Nwabiagya', region: 'Ashanti' },
  { code: 'AJ', district: 'Ejura Sekyedumase', region: 'Ashanti' },
  { code: 'AR', district: 'Sekyere East', region: 'Ashanti' },
  { code: 'AS', district: 'Asokore Mampong', region: 'Ashanti' },
  { code: 'AT', district: 'Bosomtwe', region: 'Ashanti' },
  { code: 'AU', district: 'Kumawu', region: 'Ashanti' },
  { code: 'BA', district: 'Atebubu-Amantin', region: 'Bono' },
  { code: 'BB', district: 'Berekum', region: 'Bono' },
  { code: 'BT', district: 'Cape Coast', region: 'Central' },
  { code: 'EA', district: 'Asuogyaman', region: 'Eastern' },
  { code: 'EB', district: 'Birim Central', region: 'Eastern' },
  { code: 'EK', district: 'Kwaebibirem', region: 'Eastern' },
  { code: 'EM', district: 'Akyemansa', region: 'Eastern' },
  { code: 'NK', district: 'Kumbugu', region: 'Northern' },
  { code: 'NR', district: 'Karaga', region: 'Northern' },
  { code: 'NT', district: 'Tamale Metropolitan', region: 'Northern' },
  { code: 'NW', district: 'Sawla-Tuna-Kalba', region: 'Northern' },
  { code: 'NY', district: 'Yendi Municipal', region: 'Northern' },
  { code: 'UA', district: 'Bawku Municipal', region: 'Upper East' },
  { code: 'UB', district: 'Bolgatanga Municipal', region: 'Upper East' },
  { code: 'UG', district: 'Garu-Tempane', region: 'Upper East' },
  { code: 'UW', district: 'Wa Municipal', region: 'Upper West' },
  { code: 'VC', district: 'Hohoe Municipal', region: 'Volta' },
  { code: 'VD', district: 'North Dayi', region: 'Volta' },
  { code: 'VE', district: 'South Dayi', region: 'Volta' },
  { code: 'VV', district: 'Central Tongu', region: 'Volta' },
  { code: 'VW', district: 'Akatsi North', region: 'Volta' },
  { code: 'VY', district: 'Ketu North', region: 'Volta' },
  { code: 'WA', district: 'Aowin', region: 'Western' },
  { code: 'WD', district: 'Sefwi Wiawso', region: 'Western' },
];

/** True when the value is a well-formed digital address in either spelling. */
export const isValidDigitalAddress = (value) => {
  if (typeof value !== 'string') return false;
  return DIGITAL_ADDRESS.test(value.trim());
};

/**
 * Canonical form, e.g. `ga 183 8164` -> `GA-183-8164`. Returns null when the
 * value cannot be normalised, so callers never store a half-corrected address.
 */
export const normaliseDigitalAddress = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(DIGITAL_ADDRESS);
  if (!match) return null;
  const [, area, postal, unique] = match;
  return `${area.toUpperCase()}-${postal}-${unique}`;
};

/** Splits an address into its three parts, for a segmented input. Null if invalid. */
export const parseDigitalAddress = (value) => {
  const normalised = normaliseDigitalAddress(value);
  if (!normalised) return null;
  const [area, postal, unique] = normalised.split('-');
  return { areaCode: area, postalCode: postal, uniqueAddress: unique };
};

/**
 * Builds a canonical address from parts, returning null unless all three are
 * the right shape. Used by the picker so a half-typed address is never stored.
 */
export const composeDigitalAddress = ({ areaCode, postalCode, uniqueAddress }) => {
  const area = String(areaCode ?? '').trim().toUpperCase();
  const postal = String(postalCode ?? '').trim();
  const unique = String(uniqueAddress ?? '').trim();

  if (!/^[A-Z]{2}$/.test(area)) return null;
  if (!/^\d{3}$/.test(postal)) return null;
  if (!/^\d{4}$/.test(unique)) return null;

  return `${area}-${postal}-${unique}`;
};

export default {
  isValidDigitalAddress,
  normaliseDigitalAddress,
  parseDigitalAddress,
  composeDigitalAddress,
  AREA_CODE_SUGGESTIONS,
};
