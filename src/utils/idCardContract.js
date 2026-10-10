/**
 * Shared contract for student ID cards — the single source of truth that keeps
 * the on-screen preview and the printed PDF in agreement.
 */

export const CARD_GEOMETRY = {
  widthMm: 85.6,
  heightMm: 53.98,
  cornerRadiusMm: 3,
  bleedMm: 3.175,
  safeMarginMm: 4,
  printDpi: 300,
};

export const MM = 72 / 25.4;
export const pt = (mm) => mm * MM;

export const PAD_PCT = 0.04;

export const BRAND_BADGE_TEXT = 'SukuPay';

export const COLORS = {
  body: '#0F172A',
  ink: '#0F172A',
  muted: '#64748B',
  label: '#94A3B8',
  border: '#E2E8F0',
  cardBg: '#FFFFFF',
  headerRule: '#E2E8F0',
  footerRule: '#E2E8F0',
  magStripe: '#1E293B',
   magStripeText: '#64748B',
  magStripeBrand: '#E2E8F0',
  brandBadge: '#ECFDF3',
  brandBadgeText: '#0F172A',
  brandFallback: '#0A5C36',
  surfaceLight: '#F1F5F9',
  qrBg: '#F8FAFC',
  amber600: '#B45309',
  slate500: '#64748B',
  slate400: '#94A3B8',
  slate200: '#E2E8F0',
  slate100: '#F1F5F9',
};

export const BACKEND_FONTS = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  boldOblique: 'Helvetica-BoldOblique',
  oblique: 'Helvetica-Oblique',
  mono: 'Courier',
};

export const FRONTEND_FONT_STACK = {
  regular: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  bold: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, "Courier New", monospace',
};

export const TYPO = {
  name: 8,
  field: 6.5,
  label: 4,
  body: 5.5,
  footer: 3.5,
  scan: 3.5,
  magStripe: 4.5,
  barcode: 4.5,
  small: 3,
  schoolName: 8,
  motto: 5.5,
  studentId: 6,
  fieldLabel: 4,
  fieldValue: 6.5,
  full_name: 6.5,
  emergencyContact: 6.5,
  qrCaption: 3.5,
  magStripeLeft: 4.5,
  magStripeRight: 5,
  termsLabel: 4,
  termsBody: 4,
  studentIdBack: 6,
  studentIdBackLabel: 4.5,
  backLabel: 4,
  backValue: 5,
};

export const MM_PER_PX = 25.4 / 96;
export const PX_PER_MM = 96 / 25.4;
export const LAYOUT_SCALE = 480;

export const mm = (value) => value * MM;

export const layoutFor = (W = CARD_GEOMETRY.widthMm * MM, H = CARD_GEOMETRY.heightMm * MM) => {
  const safeX = W * PAD_PCT;
  const safeY = H * PAD_PCT;
  const innerW = W - safeX * 2;
  const innerH = H - safeY * 2;

  return {
    w: W,
    h: H,
    safeX,
    safeY,
    innerW,
    innerH,
    header: {
      y: safeY,
      height: H * 0.18,
      logoX: safeX,
      logoY: safeY + H * 0.005,
      logoW: W * 0.08,
      logoH: W * 0.08,
      schoolNameX: W * 0.15,
      schoolNameY: safeY + H * 0.005,
      schoolNameW: W * 0.8,
      mottoY: safeY + H * 0.07,
      dividerY: H * 0.18,
      dividerH: 0.5,
    },
    photo: { x: W * 0.04, y: H * 0.24, size: W * 0.2 },
    grid: {
      originX: W * 0.28,
      originY: H * 0.24,
      colWidth: W * 0.22,
      colGap: W * 0.04,
      rowGap: H * 0.06,
      cellHeight: H * 0.16,
    },
    qr: { x: W * 0.8, y: H * 0.36, size: W * 0.14, captionY: H * 0.54 },
    stamp: { x: W * 0.04, y: H * 0.58, size: W * 0.06, opacity: 0.15 },
    back: {
      magStripe: { y: 0, height: H * 0.15, leftX: W * 0.04, rightX: W * 0.54 },
      terms: {
        labelY: H * 0.18,
        bodyY: H * 0.23,
        width: W * 0.88,
        maxRows: 3,
        lineGap: H * 0.01,
      },
      studentIdRow: {
        y: H * 0.41,
        labelFont: 'Courier',
        labelSize: TYPO.studentIdBackLabel,
        valueFontSize: TYPO.studentIdBack,
      },
      infoGrid: {
        x: W * 0.04,
        y: H * 0.5,
        width: W * 0.88,
        height: H * 0.24,
        colCount: 2,
        rowCount: 2,
        colGap: W * 0.02,
        rowGap: H * 0.02,
        labelWidth: mm(15),
        cellHeight: H * 0.12,
        radius: 3,
        borderWidth: 0.3,
      },
      footer: {
        y: H * 0.9,
        dividerH: 0.5,
        leftX: W * 0.04,
        rightX: W * 0.5,
        width: W * 0.92,
      },
    },
  };
};

export const FONT_PX = {
  body: 9,
  schoolName: Math.round(TYPO.schoolName * PX_PER_MM),
  motto: Math.round(TYPO.motto * PX_PER_MM),
  studentId: Math.round(TYPO.studentId * PX_PER_MM),
  fieldLabel: Math.round(TYPO.fieldLabel * PX_PER_MM),
  fieldValue: Math.round(TYPO.fieldValue * PX_PER_MM),
  qrCaption: Math.round(TYPO.qrCaption * PX_PER_MM),
  magStripeLeft: Math.round(TYPO.magStripeLeft * PX_PER_MM),
  magStripeRight: Math.round(TYPO.magStripeRight * PX_PER_MM),
  termsLabel: Math.round(TYPO.termsLabel * PX_PER_MM),
  termsBody: Math.round(TYPO.termsBody * PX_PER_MM),
  studentIdBack: Math.round(TYPO.studentIdBack * PX_PER_MM),
  studentIdBackLabel: Math.round(TYPO.studentIdBackLabel * PX_PER_MM),
  backLabel: Math.round(TYPO.backLabel * PX_PER_MM),
  backValue: Math.round(TYPO.backValue * PX_PER_MM),
  footer: Math.round(TYPO.footer * PX_PER_MM),
};

export const DEFAULT_ID_CARD_SETTINGS = {
  sheetLayout: '6up_a4_landscape',
  sides: 'front_back',
  showQr: true,
  showPhoto: true,
  showStamp: true,
  includeCutGuides: false,
};

export const DEFAULT_CARD_FIELDS = {
  showPhoto: true,
  showQr: true,
  showStamp: true,
  showEmergency: true,
  showGuardian: true,
  showClass: true,
  showStudentId: true,
};

export const resolveCardData = (student = {}, school = {}, derived = {}, options = {}) => {
  const guardian =
    (student?.parents || []).find((p) => p.isPrimary) ||
    (student?.parents || [])[0] ||
    null;
  const emergency = (student?.emergencyContacts || [])[0];

  const base = {
    schoolName: school?.name || '',
    schoolLogo: school?.logo || null,
    schoolStamp: school?.stamp || null,
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
      ? `${emergency.contactName || ''} (${emergency.phone || ''})`.trim()
      : '',
    qrCodeUrl: derived.qrCodeUrl || null,
  };

  if (options.fields) {
    const { fields } = options;
    if (!fields.showPhoto) base.studentImage = null;
    if (!fields.showQr) base.qrCodeUrl = null;
    if (!fields.showStamp) base.schoolStamp = null;
    if (!fields.showGuardian) {
      base.guardianName = '';
      base.guardianPhone = '';
    }
    if (!fields.showEmergency) base.emergencyContact = '';
    if (!fields.showClass) base.studentClass = '';
    if (!fields.showStudentId) base.studentId = '';
  }

  return base;
};

export default {
  CARD_GEOMETRY,
  MM,
  pt,
  PAD_PCT,
  BRAND_BADGE_TEXT,
  COLORS,
  BACKEND_FONTS,
  FRONTEND_FONT_STACK,
  TYPO,
  MM_PER_PX,
  PX_PER_MM,
  LAYOUT_SCALE,
  FONT_PX,
  DEFAULT_ID_CARD_SETTINGS,
  DEFAULT_CARD_FIELDS,
  resolveCardData,
};