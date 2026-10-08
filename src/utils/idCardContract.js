/**
 * Backend twin of `frontend/.../idcards/cardContract.js`.
 *
 * The frontend and the backend cannot share a file path across the two roots
 * (the repo has no shared package), so this module duplicates the contract.
 * The rule is: **every layout constant lives in exactly one of these two
 * files, and the other imports its twin here.** The test
 * `tests/idCardContract.test.js` imports both and asserts the geometry and
 * palette are deep-equal — if you change one, change the other or it fails.
 */

/* ── Geometry ───────────────────────────────────────────── */

/** ISO/IEC 7810 ID-1 (CR80) finished geometry, in millimetres. */
export const CARD_GEOMETRY = {
  widthMm: 85.6,
  heightMm: 53.98,
  cornerRadiusMm: 3.18,
  bleedMm: 3.175,
  safeMarginMm: 3.0,
  printDpi: 300,
};


export const MM = 72 / 25.4;
export const pt = (mm) => mm * MM;

const PAD_PCT = 0.04;

/** Exact brand word in the "Powered by" badge — centralised so the two renderers
 *  can never disagree on the spelling (mirrors cardContract.js). */
export const BRAND_BADGE_TEXT = '\x53\x75\x6b\x75\x75\x50\x61\x79'; // "SukuuPay"

/* ── Palette ────────────────────────────────────────────── */

export const COLORS = {
  body: '#0B1220',
  muted: '#64748b',
  label: '#94a3b8',
  border: '#cbd5e1',
  cardBg: '#ffffff',
  headerRule: '#fbbf24',
  footerRule: '#f1f5f9',
  magStripe: '#1e293b',
  magStripeText: '#94a3b8',
  magStripeBrand: '#cbd5e1',
  brandBadge: '#ecfdf3',
  brandBadgeText: '#0c4529',
  brandFallback: '#1E3A8A',
  surfaceLight: '#f1f5f9',
  qrBg: '#f8fafc',
};

/* ── Fonts ──────────────────────────────────────────────── */

export const BACKEND_FONTS = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  boldOblique: 'Helvetica-BoldOblique',
  mono: 'Courier',
};

export const FRONTEND_FONT_STACK = {
  regular: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  bold: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, "Courier New", monospace',
};

export const TYPO = {
  name: 3.0,
  field: 2.5,
  label: 1.7,
  body: 2.2,
  footer: 1.6,
  scan: 1.5,
  magStripe: 1.6,
  barcode: 1.6,
  small: 1.4,
};

export const MM_PER_PX = 25.4 / 96;
export const PX_PER_MM = 96 / 25.4;
export const LAYOUT_SCALE = 480;

export const FONT_PX = {
  name: Math.round(TYPO.name * PX_PER_MM),
  field: Math.round(TYPO.field * PX_PER_MM),
  label: Math.round(TYPO.label * PX_PER_MM),
  body: Math.round(TYPO.body * PX_PER_MM),
  footer: Math.round(TYPO.footer * PX_PER_MM),
  scan: Math.round(TYPO.scan * PX_PER_MM),
  magStripe: Math.round(TYPO.magStripe * PX_PER_MM),
  barcode: Math.round(TYPO.barcode * PX_PER_MM),
  small: Math.round(TYPO.small * PX_PER_MM),
};

export const layoutFor = (w = CARD_GEOMETRY.widthMm, h = CARD_GEOMETRY.heightMm) => {
  const pad = w * PAD_PCT;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;
  const headerH = 5.6;
  const footerH = 5.2;
  const bodyH = innerH - headerH - footerH;

  const photo = { size: 13, x: pad, y: pad + headerH + bodyH - 14.5 };
  const qrSize = 12;
  const qr = { size: qrSize, x: pad + innerW - qrSize, y: photo.y };

  const textX = photo.x + photo.size + 3;
  const textW = qr.x - textX - 2;

  return {
    w, h, pad, innerW, innerH,
    header: { x: pad, y: pad, h: headerH, w: innerW },
    body: { x: pad, y: pad + headerH, h: bodyH, w: innerW },
    footer: { x: pad, y: pad + innerH - footerH, h: footerH, w: innerW },
    photo, qr,
    text: { x: textX, y: photo.y, w: textW, h: qrSize },
  };
};

export const resolveCardData = (student = {}, school = {}, derived = {}) => {
  const guardian = (student?.parents || []).find((p) => p.isPrimary) || (student?.parents || [])[0] || null;
  const emergency = (student?.emergencyContacts || [])[0];

  return {
    schoolName: school?.name || '',
    schoolLogo: school?.logo || null,
    schoolMotto: school?.motto || '',
    schoolCode: school?.schoolCode || '',
    brandColor: school?.brandColor || COLORS.brandFallback,
    studentImage: student?.studentImage || null,
    studentName: student?.studentName || '',
    studentId: student?.studentId || '',
    dateOfBirth: student?.dateOfBirth || null,
    studentClass: student?.studentClass || '',
    academicYear: student?.academicYear || school?.academic?.currentYear || '',
    guardianName: guardian?.parentName || '',
    guardianPhone: guardian?.phone || '',
    emergencyContact: emergency
      ? `${emergency.contactName} (${emergency.phone})`
      : '',
    qrCodeUrl: derived.qrCodeUrl || null,
  };
};

export default {
  CARD_GEOMETRY,
  MM,
  pt,
  COLORS,
  BACKEND_FONTS,
  FRONTEND_FONT_STACK,
  TYPO,
  LAYOUT_SCALE,
  FONT_PX,
  MM_PER_PX,
  PX_PER_MM,
  layoutFor,
  resolveCardData,
};
