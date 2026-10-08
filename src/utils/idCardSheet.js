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
  for (let index = 0; index < perPage; index++) {
    const col = index % perRow;
    const row = Math.floor(index / perRow);
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

const fetchImage = async (url) => {
  if (url.startsWith('data:')) {
    const matches = url.match(/^data:([a-zA-Z]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    return matches ? Buffer.from(matches[2], 'base64') : null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const fitText = (doc, text, maxWidth, size, font = BACKEND_FONTS.bold) => {
  const value = String(text ?? '').trim();
  if (!value || maxWidth <= 0) return '';
  doc.font(font).fontSize(size);
  if (doc.widthOfString(value) <= maxWidth) return value;
  let cut = value.length;
  while (cut > 1 && doc.widthOfString(`${value.slice(0, cut)}…`) > maxWidth) {
    cut -= 1;
  }
  return `${value.slice(0, cut)}…`;
};

const drawImageClipped = (doc, imgBuffer, x, y, w, h, radius) => {
  if (!imgBuffer) return false;
  try {
    doc.save();
    doc.roundedRect(x, y, w, h, radius || 0).clip();
    doc.image(imgBuffer, x, y, { width: w, height: h, align: 'center', valign: 'center' });
    doc.restore();
    return true;
  } catch {
    return false;
  }
};

// ─────────────────────────── FRONT ───────────────────────────

const drawCardFront = async (doc, card, x, y, W, H, imageCache, options) => {
  // Card container background + border (rounded 4% matching preview)
  doc.save();
  doc.roundedRect(x, y, W, H, mm(2.5)).fill('#FFFFFF');
  doc.roundedRect(x, y, W, H, mm(2.5))
    .lineWidth(0.5)
    .strokeColor('#CBD5E1')
    .stroke();
  doc.restore();

  const brandHex = card.brandColor || '#0F172A';

  // ── Header Band (30% height) ──
  const headerH = H * 0.30;
  doc.save();
  doc.roundedRect(x, y, W, headerH, mm(2.5)).clip();
  doc.rect(x, y, W, headerH).fill(brandHex);
  doc.restore();

  // Logo Tile (Left)
  const logoSize = headerH * 0.65;
  const logoX = x + W * 0.04;
  const logoY = y + (headerH - logoSize) / 2;

  let logoDrawn = false;
  if (card.schoolLogo) {
    const logoBuf = await imageCache(card.schoolLogo);
    logoDrawn = drawImageClipped(doc, logoBuf, logoX, logoY, logoSize, logoSize, mm(1.5));
  }
  if (!logoDrawn) {
    doc.save();
    doc.roundedRect(logoX, logoY, logoSize, logoSize, mm(1.5)).fill('#FFFFFF');
      doc.font(BACKEND_FONTS.bold)
        .fontSize(mm(3.5))
        .fillColor(COLORS.ink)
        .text(
          String(card.schoolName || 'S').charAt(0).toUpperCase(),
          logoX + logoSize / 2 - mm(1.5),
          logoY + logoSize / 2 - mm(1.75),
          );
    doc.restore();
  }

  // School Name & Motto (Right of logo)
  const textX = logoX + logoSize + W * 0.03;
  const textW = W - (textX - x) - W * 0.04;
  const schoolNameText = fitText(
    doc,
    String(card.schoolName || 'School Name').toUpperCase(),
    textW,
    mm(3.2),
    BACKEND_FONTS.bold
  );
  doc.font(BACKEND_FONTS.bold)
    .fontSize(mm(3.2))
    .fillColor('#FFFFFF')
    .text(schoolNameText, textX, logoY + mm(1));

  if (card.schoolMotto) {
    const mottoText = fitText(doc, card.schoolMotto, textW, mm(2.2), BACKEND_FONTS.regular);
    doc.font(BACKEND_FONTS.regular)
      .fontSize(mm(2.2))
      .fillColor(COLORS.surfaceLight)
      .text(mottoText, textX, logoY + mm(5));
  }

  // ── Gold Accent Line (2.5px height) ──
  doc.save();
  doc.rect(x, y + headerH, W, mm(0.8)).fill(COLORS.amber600);
  doc.restore();

  // ── Body Layout (Two Columns) ──
  const bodyY = y + headerH + mm(3);
  const leftX = x + W * 0.04;
  const leftW = W * 0.52;

  // Left Column Data Rows (Student ID, Course, Phone, Session)
  const rows = [
    { label: 'Student ID', value: card.studentId || '—', mono: true },
    { label: 'Class / stream', value: card.studentClass || '—', mono: false },
    { label: 'Phone', value: card.guardianPhone || card.studentPhone || '—', mono: true },
    { label: 'Session', value: card.academicYear || '—', mono: false },
  ];

  let currentY = bodyY;
  const rowSpacing = H * 0.115;

  for (const row of rows) {
    doc.font(BACKEND_FONTS.bold)
      .fontSize(mm(2.4))
      .fillColor('#334155')
      .text(row.label, leftX, currentY);

    doc.font(BACKEND_FONTS.bold)
      .fontSize(mm(2.4))
      .fillColor('#94A3B8')
      .text(':', leftX + leftW * 0.34, currentY);

    const valFont = row.mono ? BACKEND_FONTS.mono : BACKEND_FONTS.bold;
    const valText = fitText(doc, row.value, leftW * 0.62, mm(2.6), valFont);
    doc.font(valFont)
      .fontSize(mm(2.6))
      .fillColor('#0F172A')
      .text(valText, leftX + leftW * 0.38, currentY);

    currentY += rowSpacing;
  }

  // Authorize Signature Line
  const sigY = y + H - mm(10);
  doc.save();
  doc.moveTo(leftX, sigY).lineTo(leftX + leftW * 0.8, sigY).lineWidth(0.5).strokeColor('#CBD5E1').stroke();
  doc.restore();
  doc.font(BACKEND_FONTS.regular)
    .fontSize(mm(1.8))
    .fillColor('#94A3B8')
    .text('Authorize Signature', leftX, sigY + mm(1));

  // Right Column: Photo, Name, and QR Code
  const rightW = W * 0.38;
  const rightX = x + W - rightW - W * 0.04;
  const photoSize = W * 0.25;
  const photoX = rightX + (rightW - photoSize) / 2;
  const photoY = bodyY;

  // Photo Frame
  doc.save();
  doc.roundedRect(photoX, photoY, photoSize, photoSize, mm(2)).fill('#F1F5F9');
  doc.restore();

  let photoDrawn = false;
  if (options.showPhoto !== false && card.studentImage) {
    const photoBuf = await imageCache(card.studentImage);
    photoDrawn = drawImageClipped(doc, photoBuf, photoX, photoY, photoSize, photoSize, mm(2));
  }
  if (!photoDrawn) {
    doc.font(BACKEND_FONTS.bold)
      .fontSize(mm(2))
      .fillColor('#94A3B8')
      .text('PHOTO', photoX + photoSize / 2 - mm(2), photoY + photoSize / 2 - mm(1), { align: 'center' });
  }

  doc.save();
  doc.roundedRect(photoX, photoY, photoSize, photoSize, mm(2))
    .lineWidth(0.5)
    .strokeColor(COLORS.border)
    .stroke();
  doc.restore();

  // Student Name
  const nameY = photoY + photoSize + mm(1.5);
  const nameText = fitText(doc, card.studentName || 'Student Name', rightW, mm(2.8), BACKEND_FONTS.bold);
  doc.font(BACKEND_FONTS.bold)
    .fontSize(mm(2.8))
    .fillColor(COLORS.ink)
    .text(nameText, rightX, nameY, { align: 'center' });

  // QR Code Section (Bottom Right)
  const qrSize = mm(7.5);
  const qrX = rightX + rightW - qrSize - mm(2);
  const qrY = y + H - qrSize - mm(7);

  if (options.showQr !== false && card.qrCodeUrl) {
    const qrBuf = await imageCache(card.qrCodeUrl);
    if (qrBuf) {
      doc.save();
      doc.roundedRect(qrX, qrY, qrSize, qrSize, mm(1)).fill('#FFFFFF');
      doc.restore();
      drawImageClipped(doc, qrBuf, qrX, qrY, qrSize, qrSize, mm(1));
      doc.save();
      doc.roundedRect(qrX, qrY, qrSize, qrSize, mm(1))
        .lineWidth(0.5)
        .strokeColor('#CBD5E1')
        .stroke();
      doc.restore();
    }
  }

  // QR Label ("Scan Verify" / "Secure ID")
  doc.font(BACKEND_FONTS.bold)
    .fontSize(mm(1.6))
    .fillColor('#94A3B8')
    .text('Scan Verify', rightX, qrY + mm(0.5));
  doc.font(BACKEND_FONTS.mono)
    .fontSize(mm(1.6))
    .fillColor('#64748B')
    .text('Secure ID', rightX, qrY + mm(3.2));

  // Stamp Overlay
  if (options.showStamp !== false && card.schoolStamp) {
    const stampBuf = await imageCache(card.schoolStamp);
    if (stampBuf) {
      const stampSize = mm(10);
      doc.save();
      doc.opacity(0.20);
      doc.image(stampBuf, x + W * 0.42, y + H * 0.55, { width: stampSize, height: stampSize });
      doc.restore();
    }
  }
};

// ─────────────────────────── BACK ───────────────────────────

const drawCardBack = async (doc, card, x, y, W, H, imageCache, options) => {
  doc.save();
  doc.roundedRect(x, y, W, H, mm(2.5)).fill('#FFFFFF');
  doc.roundedRect(x, y, W, H, mm(2.5))
    .lineWidth(0.5)
    .strokeColor('#CBD5E1')
    .stroke();
  doc.restore();

  const brandHex = card.brandColor || '#0F172A';
  const pad = W * 0.05;
  const innerW = W - pad * 2;

  // Header Band
  const headerH = H * 0.14;
  doc.save();
  doc.roundedRect(x, y, W, headerH, mm(2.5)).clip();
  doc.rect(x, y, W, headerH).fill(brandHex);
  doc.restore();

  doc.font(BACKEND_FONTS.bold)
    .fontSize(mm(2.2))
    .fillColor('rgba(255,255,255,0.75)')
    .text('Official Credential', x + pad, y + H * 0.045);

  doc.font(BACKEND_FONTS.mono)
    .fontSize(mm(2.4))
    .fillColor('rgba(255,255,255,0.9)')
    .text('SUKUUPAY', x + W - pad, y + H * 0.045, { align: 'right' });

  doc.save();
  doc.rect(x, y + headerH, W, mm(0.8)).fill('#F2B705');
  doc.restore();

  // Terms & Conditions
  doc.font(BACKEND_FONTS.bold)
    .fontSize(mm(1.9))
    .fillColor('#94A3B8')
    .text('Institutional Terms & Conditions', x + pad, y + H * 0.18);

  const termsText = card.termsOverride ||
    `This credential is the exclusive legal property of ${card.schoolName || 'the issuing school'}. It is not transferable. Return promptly if requested. Valid for academic use only.`;

  doc.font(BACKEND_FONTS.regular)
    .fontSize(mm(2))
    .fillColor('#64748B')
    .text(termsText, x + pad, y + H * 0.22, {
      width: innerW,
      height: H * 0.14,
      lineGap: mm(0.4),
    });

  // Student ID row
  const idRowY = y + H * 0.38;
  doc.font(BACKEND_FONTS.mono)
    .fontSize(mm(2.4))
    .fillColor('#94A3B8')
    .text('Student ID', x + W * 0.28, idRowY);
  doc.font(BACKEND_FONTS.mono)
    .fontSize(mm(2.8))
    .fillColor('#0F172A')
    .text(`"${card.studentId || '—'}"`, x + W * 0.46, idRowY - mm(0.3));

  // Info Grid
  const gridX = x + pad;
  const gridY = y + H * 0.46;
  const gridW = innerW;
  const gridH = H * 0.36;

  doc.save();
  doc.roundedRect(gridX, gridY, gridW, gridH, mm(2))
    .lineWidth(0.3)
    .strokeColor('#CBD5E1')
    .stroke();
  doc.restore();

  const guardianText = card.guardianName
    ? `${card.guardianName}${card.guardianPhone ? ` · ${card.guardianPhone}` : ''}`
    : '—';

  const cells = [
    { row: 0, col: 0, label: 'Guardian', value: guardianText, warning: false },
    { row: 0, col: 1, label: 'Emergency', value: card.emergencyContact || '—', warning: false },
    { row: 1, col: 0, label: 'Holder', value: card.studentName || '—', warning: false },
    { row: 1, col: 1, label: 'Expires', value: 'Active Session', warning: true },
  ];

  const cellW = gridW / 2;
  const cellH = gridH / 2;

  for (const cell of cells) {
    const cellX = gridX + cell.col * cellW;
    const cellY = gridY + cell.row * cellH;

    doc.save();
    if (cell.col === 0 && cell.row === 0) {
      doc.moveTo(gridX, cellY + cellH).lineTo(gridX + gridW, cellY + cellH).lineWidth(0.3).strokeColor('#CBD5E1').stroke();
      doc.moveTo(gridX + cellW, gridY).lineTo(gridX + cellW, gridY + gridH).lineWidth(0.3).strokeColor('#CBD5E1').stroke();
    }
    doc.restore();

    const labelW = mm(16);
    doc.font(BACKEND_FONTS.bold)
      .fontSize(mm(1.8))
      .fillColor('#94A3B8')
      .text(cell.label, cellX + mm(2.5), cellY + mm(2.5));

    const valColor = cell.warning ? '#D97706' : '#0F172A';
    const valText = fitText(doc, cell.value, cellW - labelW - mm(4), mm(2.3), BACKEND_FONTS.bold);
    doc.font(BACKEND_FONTS.bold)
      .fontSize(mm(2.3))
      .fillColor(valColor)
      .text(valText, cellX + labelW + mm(2), cellY + mm(2.3));
  }

  // Footer
  doc.save();
  doc.rect(x + pad, y + H * 0.90, innerW, mm(0.5)).fill('#CBD5E1');
  doc.restore();

  doc.font(BACKEND_FONTS.bold)
    .fontSize(mm(1.8))
    .fillColor('#94A3B8')
    .text(card.footerLeft || 'SukuPay Secure ID', x + pad, y + H * 0.92);

  doc.font(BACKEND_FONTS.bold)
    .fontSize(mm(1.8))
    .fillColor('#94A3B8')
    .text(card.footerRight || card.academicYear || '', x + W * 0.5, y + H * 0.92);
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

const drawFillers = (doc, geometry, cardsInChunk) => {
  const { slots, perPage } = geometry;
  for (let i = cardsInChunk; i < perPage; i++) {
    const slot = slots[i];
    if (!slot) continue;
    doc.save();
    doc.rect(slot.x, slot.y, slot.width, slot.height).fill('#FFFFFF');
    doc.rect(slot.x, slot.y, slot.width, slot.height)
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

const drawCutGuides = (doc, geometry, cardsInChunk) => {
  const { slots, cardWidth, cardHeight } = geometry;
  const count = Math.min(cardsInChunk, slots.length);
  if (!count) return;

  doc.save();
  doc.lineWidth(0.3).strokeColor('#CBD5E1').dash(1, { space: 2 });
  for (let i = 0; i < count; i++) {
    const slot = slots[i];
    doc.rect(slot.x, slot.y, cardWidth, cardHeight).stroke();
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
  const { slots, perPage } = geometry;
  const faces = side === 'front' ? ['front'] : ['front', 'back'];

  const resolvedCards = cards.map((c) =>
    resolveCardData(c.student || c, c.school || {}, {
      qrCodeUrl: c.qrCodeUrl || (c.student && c.student.qrCodeUrl),
    })
  );

  const chunks = chunk(resolvedCards, perPage);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
      info: {
        Title: 'Student ID cards',
        Subject: `Print at A4 landscape, ${perPage} cards per page, double-sided`,
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

      for (const face of faces) {
        doc.addPage({
          size: [geometry.sheetWidth, geometry.sheetHeight],
          margin: 0,
        });

        const renderCount = Math.min(cardChunk.length, perPage);

        for (let i = 0; i < renderCount; i++) {
          const card = cardChunk[i];
          const slot = slots[i];
          if (!card || !slot) continue;
          try {
            await drawCard(doc, slot, card, face, imageCache, {
              showQr, showPhoto, showStamp,
            });
          } catch (err) {
            console.error(`[ID-CARD-SHEET] draw failed on slot ${i}:`, err.message);
          }
        }

        if (cardChunk.length < perPage) {
          drawFillers(doc, geometry, cardChunk.length);
        }

        if (includeCutGuides) {
          drawCutGuides(doc, geometry, cardChunk.length);
        }
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