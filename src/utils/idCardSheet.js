import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import {
  CARD_GEOMETRY,
  MM,
  pt,
  COLORS,
  BACKEND_FONTS,
  resolveCardData,
} from "./idCardContract.js";

export { MM };
export const mm = (value) => value * MM;
export { pt };

const A4_LANDSCAPE = { width: 841.89, height: 595.28 };
const CR80 = { width: mm(85.6), height: mm(53.98) };

export const A4 = A4_LANDSCAPE;
export const CARD = CR80;

// ──────────────────── SukuuPay mark ────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUKUUPAY_MARK_PATH = path.join(HERE, "../../public/images/sukuupay-mark.png");

let sukuuPayMarkBuffer = null;
const getSukuuPayMark = () => {
  if (sukuuPayMarkBuffer !== null) return sukuuPayMarkBuffer;
  if (fs.existsSync(SUKUUPAY_MARK_PATH)) {
    try {
      sukuuPayMarkBuffer = fs.readFileSync(SUKUUPAY_MARK_PATH);
    } catch (err) {
      console.warn(`[ID-CARD] SukuuPay mark read failed: ${err.message}`);
      sukuuPayMarkBuffer = false;
    }
  } else {
    console.warn(`[ID-CARD] SukuuPay mark not found at ${SUKUUPAY_MARK_PATH}`);
    sukuuPayMarkBuffer = false;
  }
  return sukuuPayMarkBuffer;
};

// ──────────────────── Sheet geometry ────────────────────

export const LAYOUTS = {
  '6up_a4_landscape': {
    sheetWidth: A4_LANDSCAPE.width,
    sheetHeight: A4_LANDSCAPE.height,
    cardWidth: CR80.width,
    cardHeight: CR80.height,
    perRow: 3,
    perColumn: 2,
    perPage: 6,
    marginX: mm(12),
    marginY: mm(12),
    gapX: mm(6),
    gapY: mm(6),
  },
  '9up_a4_landscape': {
    sheetWidth: A4_LANDSCAPE.width,
    sheetHeight: A4_LANDSCAPE.height,
    cardWidth: CR80.width,
    cardHeight: CR80.height,
    perRow: 3,
    perColumn: 3,
    perPage: 9,
    marginX: mm(12),
    marginY: mm(6),
    gapX: mm(6),
    gapY: mm(4),
  },
};

export const DEFAULT_SHEET_LAYOUT = '6up_a4_landscape';
export const SHEET_LAYOUT_NAMES = Object.keys(LAYOUTS);

export const sheetGeometry = (layoutName = DEFAULT_SHEET_LAYOUT) => {
  const layout = LAYOUTS[layoutName] || LAYOUTS[DEFAULT_SHEET_LAYOUT];
  const {
    sheetWidth, sheetHeight,
    cardWidth, cardHeight,
    perRow, perColumn, perPage,
    marginX, marginY, gapX, gapY,
  } = layout;

  const slots = [];
  for (let row = 0; row < perColumn; row++) {
    for (let col = 0; col < perRow; col++) {
      const index = row * perRow + col;
      const x = marginX + col * (cardWidth + gapX);
      const y = marginY + row * (cardHeight + gapY);
      slots.push({
        index,
        row,
        column: col,
        x,
        y,
        width: cardWidth,
        height: cardHeight,
      });
    }
  }

  return {
    layoutName: LAYOUTS[layoutName] ? layoutName : DEFAULT_SHEET_LAYOUT,
    sheetWidth,
    sheetHeight,
    cardWidth,
    cardHeight,
    perRow,
    perColumn,
    perPage,
    marginX,
    marginY,
    gapX,
    gapY,
    slots,
  };
};

const slotAt = (geometry, row, column) =>
  geometry.slots.find((s) => s.row === row && s.column === column) || null;

// ──────────────────── Image cache ────────────────────

const IMAGE_FETCH_TIMEOUT_MS = 5000;

const createImageCache = () => {
  const cache = new Map();
  return async (url) => {
    if (!url || typeof url !== 'string') return null;
    if (cache.has(url)) return cache.get(url);
    const buffer = await fetchImage(url);
    cache.set(url, buffer);
    return buffer;
  };
};

/**
 * Fetches an image buffer.
 *
 * Cloudinary's `f_auto` transform serves WebP or AVIF to clients that
 * advertise support — and PDFKit can decode neither, so the school logo
 * would silently fall through to the initial-letter tile. Pin the format
 * to PNG at fetch time so the response is always decodable.
 */
const fetchImage = async (url) => {
  if (url.startsWith('data:')) {
    const matches = url.match(/^data:([a-zA-Z]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    return matches ? Buffer.from(matches[2], 'base64') : null;
  }

  const pinnedUrl = url.replace(/\bf_auto\b/g, 'f_png');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(pinnedUrl, { signal: controller.signal });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// ──────────────────── Helpers ────────────────────

/**
 * Folds a string down to the ASCII subset a standard PDF font can actually draw.
 *
 * pdfkit writes Helvetica & friends as raw bytes the font decodes as WinAnsi, so
 * a character outside ASCII prints as mojibake: each byte of its UTF-8 encoding
 * is shown as a separate WinAnsi character. An em dash is 3 such characters, an
 * ellipsis 3, a middle dot 2. The card is the artefact a school prints and hands
 * out, so a guardian name that reads as three broken characters is not an
 * acceptable outcome. Fold on the way in and nothing the school typed can be
 * misread by whoever opens the PDF.
 *
 * Truncation matters for the same reason: `fitText` appends `...` rather than a
 * one-character ellipsis, not because the three dots are prettier, but because
 * the single character has no safe byte here.
 */
const toPrintableAscii = (value) => {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/[\u2014\u2013]/g, '-') // em dash, en dash
    .replace(/[\u2018\u2019]/g, "'") // curly single quotes
    .replace(/[\u201C\u201D]/g, '"') // curly double quotes
    .replace(/\u2026/g, '...') // horizontal ellipsis
    .replace(/\u00B7/g, ',') // middle dot
    .replace(/\u2022/g, '-') // bullet
    .replace(/[\u00A0\u2007\u202F]/g, ' ') // non-breaking / figure spaces
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks: e-acute becomes e
    .replace(/[^\x20-\x7E]/g, ''); // anything still non-ASCII is dropped
};

/** Every card field that reaches the PDF as text. */
const CARD_TEXT_FIELDS = [
  'schoolName',
  'schoolMotto',
  'studentName',
  'studentId',
  'studentClass',
  'guardianName',
  'guardianPhone',
  'emergencyContact',
  'academicYear',
  'termsOverride',
];

/**
 * Folds a card's text fields to ASCII, in place.
 *
 * `drawCard` shallow-clones the card before calling a face renderer, so
 * normalising here cannot disturb the caller's resolved card — the same card
 * object is drawn twice, once per face, and the second draw re-folds already
 * folded text, which is idempotent.
 */
const normalizeCardText = (card) => {
  for (const field of CARD_TEXT_FIELDS) {
    card[field] = toPrintableAscii(card[field]);
  }
  return card;
};

const fitText = (doc, text, maxWidth, size, font = BACKEND_FONTS.bold) => {
  const value = String(text ?? '').trim();
  if (!value || maxWidth <= 0) return '';
  doc.font(font).fontSize(size);
  if (doc.widthOfString(value) <= maxWidth) return value;
  let cut = value.length;
  while (cut > 1 && doc.widthOfString(`${value.slice(0, cut)}...`) > maxWidth) {
    cut -= 1;
  }
  return `${value.slice(0, cut)}...`;
};

const drawImageFitClipped = (doc, imgBuffer, x, y, w, h, radius) => {
  if (!imgBuffer) return false;
  try {
    doc.save();
    doc.roundedRect(x, y, w, h, radius || 0).clip();
    doc.image(imgBuffer, x, y, {
      fit: [w, h],
      align: 'center',
      valign: 'center',
    });
    doc.restore();
    return true;
  } catch (err) {
    try { doc.restore(); } catch { /* noop */ }
    return false;
  }
};

const resetTextCursor = (doc, x, y) => {
  doc.x = x;
  doc.y = y;
};

/**
 * Draws the SukuuPay mark + caption on the left and the academic year on the
 * right, on one line at the bottom of the card — the same arrangement the React
 * preview uses. Called from both `drawCardFront` and `drawCardBack`.
 *
 * The year used to be missing entirely: the footer carried only the caption, so
 * a printed card did not say which session it belonged to even though the
 * preview showed it. It is now passed in and drawn on the right-hand edge.
 */
const drawSukuuPayFooterMark = (doc, x, y, W, H, academicYear) => {
  const markBuffer = getSukuuPayMark();

  const markSize = mm(3.0);
  const gap = mm(1.2);
  const captionText = 'SukuuPay Secure ID';
  const captionSize = mm(1.5);
  const sidePad = W * 0.05;
  const bottomPad = mm(1.5);

  const rowY = y + H - bottomPad - markSize;
  const captionH = doc.heightOfString(captionText);
  const captionY = rowY + (markSize - captionH) / 2;

  if (markBuffer) {
    try {
      doc.save();
      doc.image(markBuffer, x + sidePad, rowY, {
        fit: [markSize, markSize],
        align: 'center',
        valign: 'center',
      });
      doc.restore();
    } catch (err) {
      console.warn(`[ID-CARD] SukuuPay footer mark draw failed: ${err.message}`);
    }
  }

  const textX = markBuffer ? x + sidePad + markSize + gap : x + sidePad;
  resetTextCursor(doc, textX, captionY);
  doc.font(BACKEND_FONTS.bold)
    .fontSize(captionSize)
    .fillColor('#94A3B8')
    .text(captionText, textX, captionY, {
      lineBreak: false,
    });

  if (academicYear) {
    doc.font(BACKEND_FONTS.bold).fontSize(captionSize);
    const yearText = String(academicYear);
    const yearW = doc.widthOfString(yearText);
    const yearX = x + W - sidePad - yearW;
    resetTextCursor(doc, yearX, captionY);
    doc.font(BACKEND_FONTS.bold)
      .fontSize(captionSize)
      .fillColor('#94A3B8')
      .text(yearText, yearX, captionY, {
        lineBreak: false,
      });
  }
};


/**
 * The card is monochrome.
 *
 * The header band used to be filled with the school's `brandColor`, so a
 * school with a blue brand printed a blue credential, and a yellow accent rule
 * (`#F2B705`) ran beneath both faces. Both are gone: the band is a fixed
 * neutral charcoal, and the band's own edge separates it from the body without
 * a coloured rule underneath.
 */
const HEADER_FILL = '#0F172A';

const drawCardFront = async (doc, card, x, y, W, H, imageCache, options) => {
  normalizeCardText(card);
  doc.save();
  resetTextCursor(doc, x, y);

  // Card container
  doc.roundedRect(x, y, W, H, mm(2)).fill('#FFFFFF');
  doc.roundedRect(x, y, W, H, mm(2))
    .lineWidth(0.5)
    .strokeColor('#CBD5E1')
    .stroke();

  const pad = W * 0.045;

  // ── Header Band (28% height) ──
  const headerH = H * 0.28;
  doc.save();
  doc.roundedRect(x, y, W, headerH, mm(2)).clip();
  doc.rect(x, y, W, headerH).fill(HEADER_FILL);
  doc.restore();

  // ── Logo Tile ──
  const logoSize = headerH * 0.62;
  const logoX = x + pad;
  const logoY = y + (headerH - logoSize) / 2;

  let logoDrawn = false;
  if (card.schoolLogo) {
    const logoBuf = await imageCache(card.schoolLogo);
    if (!logoBuf) {
      console.warn(`[ID-CARD] school logo fetch returned null for ${card.schoolLogo}`);
    } else {
      doc.save();
      doc.roundedRect(logoX, logoY, logoSize, logoSize, mm(1)).fill('#FFFFFF');
      doc.restore();
      logoDrawn = drawImageFitClipped(
        doc,
        logoBuf,
        logoX + mm(0.6),
        logoY + mm(0.6),
        logoSize - mm(1.2),
        logoSize - mm(1.2),
        mm(0.8)
      );
      if (!logoDrawn) {
        console.warn(`[ID-CARD] school logo decode failed for ${card.schoolLogo}`);
      }
    }
  }
  if (!logoDrawn) {
    doc.roundedRect(logoX, logoY, logoSize, logoSize, mm(1)).fill('#FFFFFF');
    doc.font(BACKEND_FONTS.bold).fontSize(mm(3.5)).fillColor(COLORS.ink);
    const initial = String(card.schoolName || 'S').charAt(0).toUpperCase();
    const iw = doc.widthOfString(initial);
    const ih = doc.heightOfString(initial);
    resetTextCursor(doc, logoX + (logoSize - iw) / 2, logoY + (logoSize - ih) / 2);
    doc.text(initial, logoX + (logoSize - iw) / 2, logoY + (logoSize - ih) / 2, {
      lineBreak: false,
    });
  }

  // ── School Name & Motto ──
  const textX = logoX + logoSize + W * 0.03;
  const textW = W - (textX - x) - pad;
  const schoolNameText = fitText(
    doc,
    String(card.schoolName || 'School Name').toUpperCase(),
    textW,
    mm(2.5),
    BACKEND_FONTS.bold
  );

  resetTextCursor(doc, textX, logoY + mm(0.6));
  doc.font(BACKEND_FONTS.bold)
    .fontSize(mm(2.5))
    .fillColor('#FFFFFF')
    .text(schoolNameText, textX, logoY + mm(0.6), { lineBreak: false });

  if (card.schoolMotto) {
    const mottoText = fitText(
      doc,
      card.schoolMotto,
      textW,
      mm(1.6),
      BACKEND_FONTS.regular
    );
    resetTextCursor(doc, textX, logoY + mm(4.0));
    doc.font(BACKEND_FONTS.regular)
      .fontSize(mm(1.6))
      .fillColor('#FFFFFF')
      .text(mottoText, textX, logoY + mm(4.0), { lineBreak: false });
  }

  // ── Body Layout ──
  // No accent rule under the band: the charcoal band against the white body is
  // separation enough, and a coloured rule here is what made the card read as a
  // blue-and-yellow scheme.
  const bodyY = y + headerH + mm(3);
  const leftX = x + pad;
  const leftW = W * 0.52;

  // An ASCII hyphen for a missing value.
  //
  // This was an em dash, which has no safe byte in the standard fonts: it prints
  // as three mojibake characters, so an empty field looked like corruption rather
  // than a blank. `normalizeCardText` folds any em dash that gets in anyway.
  const PLACEHOLDER = '-';

  const rows = [
    { label: 'Student ID', value: card.studentId || PLACEHOLDER, mono: true },
    { label: 'Class / stream', value: card.studentClass || PLACEHOLDER, mono: false },
    {
      label: 'Phone',
      value: card.guardianPhone || card.studentPhone || PLACEHOLDER,
      mono: true,
    },
    { label: 'Session', value: card.academicYear || PLACEHOLDER, mono: false },
  ];

  let currentY = bodyY;
  const rowSpacing = H * 0.105;

  for (const row of rows) {
    resetTextCursor(doc, leftX, currentY);
    doc.font(BACKEND_FONTS.bold)
      .fontSize(mm(1.8))
      .fillColor('#334155')
      .text(row.label, leftX, currentY, {
        width: leftW * 0.38,
        lineBreak: false,
      });

    doc.font(BACKEND_FONTS.bold)
      .fontSize(mm(1.8))
      .fillColor('#94A3B8')
      .text(':', leftX + leftW * 0.38, currentY, {
        width: mm(2),
        lineBreak: false,
      });

    const valFont = row.mono ? BACKEND_FONTS.mono : BACKEND_FONTS.bold;
    const valText = fitText(doc, row.value, leftW * 0.58, mm(1.9), valFont);
    doc.font(valFont)
      .fontSize(mm(1.9))
      .fillColor('#0F172A')
      .text(valText, leftX + leftW * 0.42, currentY, {
        width: leftW * 0.58,
        lineBreak: false,
      });

    currentY += rowSpacing;
  }

  // ── Signature Line — above the footer mark ──
  const sigY = y + H - mm(9);
  doc.moveTo(leftX, sigY)
    .lineTo(leftX + leftW * 0.75, sigY)
    .lineWidth(0.4)
    .strokeColor('#CBD5E1')
    .stroke();
  resetTextCursor(doc, leftX, sigY + mm(0.8));
  doc.font(BACKEND_FONTS.regular)
    .fontSize(mm(1.2))
    .fillColor('#94A3B8')
    .text('AUTHORIZE SIGNATURE', leftX, sigY + mm(0.8), {
      lineBreak: false,
      characterSpacing: 0.4,
    });

  // ── Right Column: Photo, Name, QR ──
  const rightW = W * 0.40;
  const rightX = x + W - rightW - pad;

  const photoSize = rightW * 0.52;
  const photoX = rightX + (rightW - photoSize) / 2;
  const photoY = bodyY;

  doc.roundedRect(photoX, photoY, photoSize, photoSize, mm(1.5)).fill('#F1F5F9');

  let photoDrawn = false;
  if (options.showPhoto !== false && card.studentImage) {
    const photoBuf = await imageCache(card.studentImage);
    photoDrawn = drawImageFitClipped(
      doc,
      photoBuf,
      photoX,
      photoY,
      photoSize,
      photoSize,
      mm(1.5)
    );
  }
  if (!photoDrawn) {
    resetTextCursor(doc, photoX, photoY + photoSize / 2 - mm(1));
    doc.font(BACKEND_FONTS.bold)
      .fontSize(mm(1.7))
      .fillColor('#94A3B8')
      .text('PHOTO', photoX, photoY + photoSize / 2 - mm(1), {
        width: photoSize,
        align: 'center',
        lineBreak: false,
      });
  }

  doc.roundedRect(photoX, photoY, photoSize, photoSize, mm(1.5))
    .lineWidth(0.5)
    .strokeColor(COLORS.border)
    .stroke();

  // Name
  const nameY = photoY + photoSize + mm(1.5);
  const nameText = fitText(
    doc,
    card.studentName || 'Student Name',
    rightW,
    mm(2.0),
    BACKEND_FONTS.bold
  );
  resetTextCursor(doc, rightX, nameY);
  doc.font(BACKEND_FONTS.bold)
    .fontSize(mm(2.0))
    .fillColor(COLORS.ink)
    .text(nameText, rightX, nameY, {
      width: rightW,
      align: 'center',
      lineBreak: false,
    });

  // QR — anchored above the footer mark.
  //
  // The 10mm bottom offset used to park the QR within a millimetre of the
  // student name, so the name and "SCAN VERIFY" collided. Dropping it to 6.7mm
  // puts the QR 2.5mm clear of the name while still leaving 2mm above the
  // footer mark, which is what balances the right column.
  const qrSize = mm(5.5);
  const qrX = rightX + rightW - qrSize;
  const qrY = y + H - qrSize - mm(6.7);

  if (options.showQr !== false && card.qrCodeUrl) {
    const qrBuf = await imageCache(card.qrCodeUrl);
    if (qrBuf) {
      doc.roundedRect(qrX, qrY, qrSize, qrSize, mm(0.8)).fill('#FFFFFF');
      drawImageFitClipped(doc, qrBuf, qrX, qrY, qrSize, qrSize, mm(0.8));
      doc.roundedRect(qrX, qrY, qrSize, qrSize, mm(0.8))
        .lineWidth(0.4)
        .strokeColor('#CBD5E1')
        .stroke();
    }
  }

  const labelX = rightX;
  const labelW = rightW - qrSize - mm(1.5);
  const labelMidY = qrY + qrSize / 2;

  resetTextCursor(doc, labelX, labelMidY - mm(1.8));
  doc.font(BACKEND_FONTS.bold)
    .fontSize(mm(1.2))
    .fillColor('#64748B')
    .text('SCAN VERIFY', labelX, labelMidY - mm(1.8), {
      width: labelW,
      align: 'right',
      lineBreak: false,
      characterSpacing: 0.3,
    });

  resetTextCursor(doc, labelX, labelMidY + mm(0.3));
  doc.font(BACKEND_FONTS.mono)
    .fontSize(mm(1.2))
    .fillColor('#94A3B8')
    .text('Secure ID', labelX, labelMidY + mm(0.3), {
      width: labelW,
      align: 'right',
      lineBreak: false,
    });

  // ── SukuuPay footer mark ──
  drawSukuuPayFooterMark(doc, x, y, W, H, card.academicYear);

  doc.restore();
};

// ─────────────────────────── BACK ───────────────────────────

const drawCardBack = async (doc, card, x, y, W, H, imageCache, options) => {
  normalizeCardText(card);
  doc.save();
  resetTextCursor(doc, x, y);

  doc.roundedRect(x, y, W, H, mm(2)).fill('#FFFFFF');
  doc.roundedRect(x, y, W, H, mm(2))
    .lineWidth(0.5)
    .strokeColor('#CBD5E1')
    .stroke();

  const pad = W * 0.05;

  // ── Header Band ──
  const headerH = H * 0.13;
  doc.save();
  doc.roundedRect(x, y, W, headerH, mm(2)).clip();
  doc.rect(x, y, W, headerH).fill(HEADER_FILL);
  doc.restore();

  resetTextCursor(doc, x + pad, y + (headerH - mm(1.7)) / 2 - mm(0.3));
  doc.font(BACKEND_FONTS.bold)
    .fontSize(mm(1.7))
    .fillColor('#FFFFFF')
    .text('OFFICIAL CREDENTIAL', x + pad, y + (headerH - mm(1.7)) / 2 - mm(0.3), {
      lineBreak: false,
      characterSpacing: 0.5,
    });

  // School logo right-aligned in the header
  let logoDrawn = false;
  if (card.schoolLogo) {
    const logoBuf = await imageCache(card.schoolLogo);
    if (logoBuf) {
      const logoSize = headerH * 0.55;
      const logoX = x + W - pad - logoSize;
      const logoY = y + (headerH - logoSize) / 2;
      try {
        doc.save();
        doc.roundedRect(logoX, logoY, logoSize, logoSize, mm(1)).fill('#FFFFFF');
        doc.restore();
        logoDrawn = drawImageFitClipped(
          doc,
          logoBuf,
          logoX + mm(0.4),
          logoY + mm(0.4),
          logoSize - mm(0.8),
          logoSize - mm(0.8),
          mm(0.6)
        );
      } catch (err) {
        console.warn(`[ID-CARD] school logo header draw failed: ${err.message}`);
        logoDrawn = false;
      }
    }
  }
  if (!logoDrawn) {
    resetTextCursor(doc, x + pad, y + (headerH - mm(1.7)) / 2 - mm(0.3));
    doc.font(BACKEND_FONTS.bold)
      .fontSize(mm(1.7))
      .fillColor('#FFFFFF')
      .text('SUKUUPAY', x + pad, y + (headerH - mm(1.7)) / 2 - mm(0.3), {
        width: W - pad * 2,
        align: 'right',
        lineBreak: false,
        characterSpacing: 0.5,
      });
  }

  // ── Terms ──
  // No accent rule under the band, so the terms move up by the rule's height.
  const termsTop = y + headerH + mm(2.5);
  resetTextCursor(doc, x + pad, termsTop);
  doc.font(BACKEND_FONTS.bold)
    .fontSize(mm(1.6))
    .fillColor('#94A3B8')
    .text('INSTITUTIONAL TERMS & CONDITIONS', x + pad, termsTop, {
      lineBreak: false,
      characterSpacing: 0.4,
    });

  const termsText =
    card.termsOverride ||
    `This credential is the exclusive legal property of ${card.schoolName || 'the issuing school'
    }. It is not transferable. Return promptly if requested. Valid for academic use only.`;

  const termsBodyY = termsTop + mm(2.6);
  resetTextCursor(doc, x + pad, termsBodyY);
  doc.font(BACKEND_FONTS.regular)
    .fontSize(mm(1.7))
    .fillColor('#64748B')
    .text(termsText, x + pad, termsBodyY, {
      width: W - pad * 2,
      height: H * 0.11,
      lineGap: mm(0.3),
    });

  // ── Student ID row ──
  const idRowY = y + H * 0.42;
  const idLabel = 'STUDENT ID';
  const idValue = `"${card.studentId || '-'}"`;

  doc.font(BACKEND_FONTS.bold).fontSize(mm(1.7));
  const idLabelW = doc.widthOfString(idLabel);
  doc.font(BACKEND_FONTS.mono).fontSize(mm(2.2));
  const idValueW = doc.widthOfString(idValue);
  const idGap = mm(2.5);
  const idTotalW = idLabelW + idGap + idValueW;
  const idStartX = x + (W - idTotalW) / 2;

  resetTextCursor(doc, idStartX, idRowY + mm(0.6));
  doc.font(BACKEND_FONTS.bold)
    .fontSize(mm(1.7))
    .fillColor('#94A3B8')
    .text(idLabel, idStartX, idRowY + mm(0.6), {
      lineBreak: false,
      characterSpacing: 0.4,
    });

  resetTextCursor(doc, idStartX + idLabelW + idGap, idRowY);
  doc.font(BACKEND_FONTS.mono)
    .fontSize(mm(2.2))
    .fillColor('#0F172A')
    .text(idValue, idStartX + idLabelW + idGap, idRowY, {
      lineBreak: false,
    });

  // ── Info Grid ──
  const gridX = x + pad;
  const gridY = y + H * 0.50;
  const gridW = W - pad * 2;
  const gridH = H * 0.27;

  doc.roundedRect(gridX, gridY, gridW, gridH, mm(1.5))
    .lineWidth(0.4)
    .strokeColor('#CBD5E1')
    .stroke();

  // Guardian name and phone, separated by a comma rather than a middle dot: the
  // dot is outside ASCII and would print as two mojibake characters.
  const guardianText = card.guardianName
    ? `${card.guardianName}${card.guardianPhone ? `, ${card.guardianPhone}` : ''
    }`
    : '-';

  const cells = [
    { row: 0, col: 0, label: 'GUARDIAN', value: guardianText },
    {
      row: 0,
      col: 1,
      label: 'EMERGENCY',
      value: card.emergencyContact || '-',
    },
    {
      row: 1,
      col: 0,
      label: 'HOLDER',
      value: card.studentName || '-',
    },
    {
      row: 1,
      col: 1,
      label: 'EXPIRES',
      value: 'Active Session',
    },
  ];

  const cellW = gridW / 2;
  const cellH = gridH / 2;

  doc.save();
  doc.lineWidth(0.4).strokeColor('#CBD5E1');
  doc
    .moveTo(gridX + cellW, gridY)
    .lineTo(gridX + cellW, gridY + gridH)
    .stroke();
  doc
    .moveTo(gridX, gridY + cellH)
    .lineTo(gridX + gridW, gridY + cellH)
    .stroke();
  doc.restore();

  for (const cell of cells) {
    const cellX = gridX + cell.col * cellW;
    const cellY = gridY + cell.row * cellH;

    const innerPadX = mm(2.5);
    const labelW = mm(16);

    resetTextCursor(doc, cellX + innerPadX, cellY + mm(2.0));
    doc.font(BACKEND_FONTS.bold)
      .fontSize(mm(1.4))
      .fillColor('#94A3B8')
      .text(cell.label, cellX + innerPadX, cellY + mm(2.0), {
        width: labelW,
        lineBreak: false,
        characterSpacing: 0.3,
      });

    // Monochrome: the Expires cell used to be amber (#D97706), which read as a
    // third colour on a card that is otherwise charcoal and grey.
    const valColor = '#0F172A';
    const valText = fitText(
      doc,
      cell.value,
      cellW - labelW - mm(5),
      mm(1.8),
      BACKEND_FONTS.bold
    );
    doc.font(BACKEND_FONTS.bold)
      .fontSize(mm(1.8))
      .fillColor(valColor)
      .text(valText, cellX + labelW + innerPadX, cellY + mm(2.0), {
        width: cellW - labelW - mm(5),
        lineBreak: false,
      });
  }

  // ── SukuuPay footer mark ──
  drawSukuuPayFooterMark(doc, x, y, W, H, card.academicYear);

  doc.restore();
};

// ─────────────────────────── RENDER LOOP ───────────────────────────

const drawCard = async (doc, slot, card, side, imageCache, options) => {
  const { x, y, width: W, height: H } = slot;
  const fullCard = { ...card };
  if (options.showPhoto === false) fullCard.studentImage = null;
  if (options.showQr === false) fullCard.qrCodeUrl = null;
  if (options.showStamp === false) fullCard.schoolStamp = null;

  if (side === 'front') {
    await drawCardFront(doc, fullCard, x, y, W, H, imageCache, options);
  } else {
    await drawCardBack(doc, fullCard, x, y, W, H, imageCache, options);
  }
};

const drawFillers = (doc, geometry, occupiedSlotIndexes) => {
  const occupied = new Set(occupiedSlotIndexes);
  for (const slot of geometry.slots) {
    if (occupied.has(slot.index)) continue;
    doc.save();
    resetTextCursor(doc, slot.x, slot.y);
    doc.rect(slot.x, slot.y, slot.width, slot.height).fill('#FFFFFF');
    doc
      .rect(slot.x, slot.y, slot.width, slot.height)
      .lineWidth(0.25)
      .strokeColor('#CBD5E1')
      .dash(1.5, { space: 1.5 })
      .stroke()
      .undash();
    doc.font(BACKEND_FONTS.regular)
      .fontSize(mm(2.5))
      .fillColor('#94A3B8')
      .text('CUT HERE', slot.x, slot.y + slot.height / 2 - mm(1), {
        width: slot.width,
        align: 'center',
        lineBreak: false,
      });
    doc.restore();
  }
};

const drawCutGuides = (doc, geometry, occupiedSlotIndexes) => {
  if (!occupiedSlotIndexes.length) return;
  doc.save();
  doc.lineWidth(0.3).strokeColor('#CBD5E1').dash(1, { space: 2 });
  for (const index of occupiedSlotIndexes) {
    const slot = geometry.slots.find((s) => s.index === index);
    if (!slot) continue;
    doc.rect(slot.x, slot.y, slot.width, slot.height).stroke();
  }
  doc.undash();
  doc.restore();
};

const chunk = (array, size) => {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
};

/**
 * How many students share one sheet.
 *
 * `generateIdCardSheets` lays each chunk out as **one row of fronts plus one row
 * of backs**, so a chunk is capped by the row width (`perRow`) — not by half the
 * sheet's slots. The old `floor(perPage / 2)` read `perPage` as if every slot
 * were a student, which only happens to be true for a two-row layout.
 *
 * For 9-up (3 rows x 3 columns) it produced 4, so a chunk needed a 4th column
 * that the layout does not have. `slotAt()` returned null for it and the render
 * loop silently `continue`d, so the fourth student on every 9-up sheet vanished
 * from the print run — a card missing from the printer, not an obvious crash.
 */
const studentsPerSheet = (geometry) => Math.max(1, geometry.perRow);

/**
 * Normalises whatever the caller handed over into resolved cards.
 *
 * Cards arrive here **already resolved** — both the single-card path and the
 * batch path run `resolveCardData` against the school record first. Re-resolving
 * such a card is destructive: a flat card carries no `school` object, so
 * `resolveCardData` is handed `{}` and rebrands the card from its fallbacks.
 * `schoolName` collapses to `''`, `schoolLogo` to `null`, `schoolMotto` to
 * `''` and `brandColor` to the fallback — which is why a printed card showed a
 * green header with an "S" initial tile instead of the school's own logo and
 * name. The student fields survived only because the flat card itself was
 * passed in as the student argument.
 *
 * A raw `{ student, school }` pair is still resolved. The two shapes are told
 * apart by a nested `student` object, which `resolveCardData` never returns.
 */
const resolveCards = (cards) =>
  cards.map((input) => {
    if (input && input.student && typeof input.student === 'object') {
      return resolveCardData(input.student, input.school || {}, {
        qrCodeUrl: input.qrCodeUrl || input.student.qrCodeUrl,
      });
    }
    return input;
  });

export const generateIdCardSheets = async (cards, options = {}) => {
  const {
    layout = DEFAULT_SHEET_LAYOUT,
    side = 'front_back',
    showQr = true,
    showPhoto = true,
    showStamp = true,
    includeCutGuides = false,
  } = options;

  const geometry = sheetGeometry(layout);
  const perSheet = studentsPerSheet(geometry);

  const resolvedCards = resolveCards(cards);

  const chunks = chunk(resolvedCards, perSheet);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
      info: {
        Title: 'Student ID cards',
        Subject: `Print at A4 landscape, ${perSheet} students per sheet, double-sided`,
      },
    });

    const buffers = [];
    doc.on('data', (buffer) => buffers.push(buffer));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const imageCache = createImageCache();

    const renderChunk = async (chunkIndex) => {
      if (chunkIndex >= chunks.length) {
        doc.end();
        return;
      }

      const cardChunk = chunks[chunkIndex];

      doc.addPage({
        size: [geometry.sheetWidth, geometry.sheetHeight],
        margin: 0,
      });

      const occupiedSlotIndexes = [];

      const rows = side === 'front' ? [0] : side === 'back' ? [1] : [0, 1];

      for (const row of rows) {
        for (let col = 0; col < cardChunk.length; col++) {
          const card = cardChunk[col];
          const slot = slotAt(geometry, row, col);
          if (!card || !slot) continue;

          try {
            await drawCard(
              doc,
              slot,
              card,
              row === 0 ? 'front' : 'back',
              imageCache,
              { showQr, showPhoto, showStamp }
            );
            occupiedSlotIndexes.push(slot.index);
          } catch (err) {
            console.error(
              `[ID-CARD-SHEET] draw failed on student ${col} (${row === 0 ? 'front' : 'back'
              }):`,
              err.message
            );
          }
        }
      }

      drawFillers(doc, geometry, occupiedSlotIndexes);

      if (includeCutGuides) {
        drawCutGuides(doc, geometry, occupiedSlotIndexes);
      }

      setImmediate(() => renderChunk(chunkIndex + 1));
    };

    if (chunks.length === 0) {
      doc.addPage({ size: [geometry.sheetWidth, geometry.sheetHeight], margin: 0 });
      doc.end();
    } else {
      setImmediate(() => renderChunk(0));
    }
  });
};

export default {
  MM,
  mm,
  CARD: CR80,
  A4: A4_LANDSCAPE,
  LAYOUTS,
  SHEET_LAYOUT_NAMES,
  DEFAULT_SHEET_LAYOUT,
  sheetGeometry,
  generateIdCardSheets,
  drawCardFront,
  drawCardBack,
};