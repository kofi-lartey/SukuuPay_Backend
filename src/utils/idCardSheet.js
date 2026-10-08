import PDFDocument from "pdfkit";
import {
  CARD_GEOMETRY,
  MM,
  pt,
  COLORS,
  BACKEND_FONTS,
  TYPO,
  layoutFor,
  resolveCardData,
  BRAND_BADGE_TEXT,
} from "./idCardContract.js";

/** PDF user units are points. 72 per inch, 25.4mm per inch. */
export { MM };
export const mm = (value) => value * MM;
export { pt };

/**
 * Printable ID-card sheets: several true-size CR80 cards per A4 page.
 *
 * ## Why this module exists
 *
 * `utils/pdfGenerator.js` draws **one card per A4 page** at 40pt margins with 16pt type.
 * That is a *proof sheet*: useful for showing someone what a card looks like on screen,
 * useless as a thing a school prints. It wastes 90% of every sheet, and a card rendered
 * at full A4 cannot be cut down to anything — there is no relationship between the drawn
 * rectangle and a real card's dimensions, so nothing on it comes out at ID-card size.
 *
 * This draws cards at **true CR80** (85.60 × 53.98 mm) on shared A4 sheets, with the
 * fronts and backs on paired pages in matching slot order, so a sheet printed both sides
 * and cut yields matched cards.
 *
 * ## Layouts
 *
 * `a4_c80_5up` (the default) — one column, five rows.
 *   Five cards is what the product asked for, and one column is the arrangement a school
 *   can guillotine without measuring: a straight cut straight down the page, five times.
 *   It uses 91% of the sheet's height.
 *
 * `a4_c80_8up` — two columns, four rows.
 *   The denser, conventional CR80-on-A4 layout, for a school printing hundreds. It leaves
 *   generous margins rather than pushing to the paper edge, because most desktop printers
 *   cannot print into the last 5mm and a card clipped by the unprintable margin is worse
 *   than a sheet with air around it.
 *
 * Both keep cards at **exact CR80**. The layouts differ in how many share a sheet, never
 * in how big a card is — a card that is not standard size is not an ID card.
 */

/** ISO/IEC 7810 ID-1, the "CR80" everybody means by an ID card, in PDF points. */
export const CARD = {
  width: mm(85.6),
  height: mm(53.98),
};

export const SHEET_LAYOUTS = {
  a4_c80_5up: {
    columns: 1,
    rows: 5,
    label: '5 per sheet (1 column)',
    // A single column is centred horizontally, which is also why the margin is derived
    // from the leftover width rather than fixed.
    marginTop: mm(8),
    marginBottom: mm(8),
  },
  a4_c80_8up: {
    columns: 2,
    rows: 4,
    label: '8 per sheet (2 columns)',
    marginTop: mm(10),
    marginBottom: mm(10),
    // Only the side gutters are explicit here; the block is centred anyway.
    marginSide: mm(8),
  },
};

export const SHEET_LAYOUT_NAMES = Object.keys(SHEET_LAYOUTS);
export const DEFAULT_SHEET_LAYOUT = 'a4_c80_5up';

/** A4 in points. Matches the `size: "A4"` the rest of the product prints at. */
export const A4 = { width: mm(210), height: mm(297) };

/**
 * Where every slot on a sheet sits, in PDF coordinates.
 *
 * Exported and pure so the geometry can be tested without rendering a PDF — the
 * assertions that matter ("exactly five cards", "every card inside the printable area",
 * "no two cards overlap") are arithmetic, not visual.
 *
 * @returns {{ columns: number, rows: number, perPage: number, cardsPerPage: number,
 *   slots: Array<{ index: number, row: number, column: number, x: number, y: number, width: number, height: number }> }}
 */
export const sheetGeometry = (layoutName = DEFAULT_SHEET_LAYOUT) => {
  const layout = SHEET_LAYOUTS[layoutName] || SHEET_LAYOUTS[DEFAULT_SHEET_LAYOUT];
  const { columns, rows, marginTop, marginBottom } = layout;

  const blockWidth = CARD.width * columns;
  const blockHeight = CARD.height * rows;

  // Centre the block in both axes. The top/bottom margins in the layout are a *minimum*
  // — honouring them exactly and centring the rest is what keeps a 5-up sheet from
  // hugging the paper edge on a printer that happens to be set to borderless.
  const slackY = A4.height - marginTop - marginBottom - blockHeight;
  const originY = marginTop + Math.max(0, slackY) / 2;

  const slackX = A4.width - blockWidth;
  const originX = Math.max(0, slackX) / 2;

  const slots = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      slots.push({
        index: slots.length,
        row,
        column,
        // PDF's origin is the bottom-left, so row 0 must be drawn from the *top*.
        y: A4.height - originY - CARD.height * (row + 1),
        x: originX + CARD.width * column,
        width: CARD.width,
        height: CARD.height,
      });
    }
  }

  return {
    layoutName: SHEET_LAYOUTS[layoutName] ? layoutName : DEFAULT_SHEET_LAYOUT,
    columns,
    rows,
    perPage: columns * rows,
    cardsPerPage: columns * rows,
    slots,
  };
};

/**
 * Fetches and decodes images once per document.
 *
 * Without this a 200-card order fetches the **school logo 200 times** and each student's
 * photo once per appearance, over the network, while the event loop stays open. The
 * difference between a generation that takes four seconds and one that takes ninety is
 * entirely this cache — so it is keyed by URL and holds failures as `null` too, which
 * stops a dead image URL from being retried once per card as well.
 */
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

/** Supports `data:` URIs and HTTP(S). Returns `null` rather than throwing.
 *
 * Remote images (a school logo or student photo hosted on Cloudinary/S3) are
 * fetched with a hard timeout. A slow or unreachable asset must never stall a
 * print request: on timeout the card simply renders without the image, which is
 * what a school accepts. Without this cap a single hung DNS/TLS round-trip made
 * the whole PDF appear to hang "forever" (the old behaviour the timeout bug was
 * raised against). */
const IMAGE_FETCH_TIMEOUT_MS = 5000;
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
    if (error.name === 'AbortError') {
      console.error('[ID-CARD-SHEET] image fetch timed out after', IMAGE_FETCH_TIMEOUT_MS, 'ms:', url);
    } else {
      console.error('[ID-CARD-SHEET] image fetch failed:', url, error.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Truncates to fit a width, with an ellipsis.
 *
 * Uses `doc.widthOfString(text, { size })` — the pdfkit 0.20 API. `font` is set
 * first because `widthOfString` measures with the font that is *current*, so
 * measuring before selecting the face measures the wrong glyphs.
 *
 * Font faces come from `BACKEND_FONTS` (the shared contract), so the PDF uses
 * exactly the face the preview's font-stack resolves to.
 */
const fitText = (doc, text, maxWidth, size, font = BACKEND_FONTS.bold) => {
  const value = String(text ?? '').trim();
  if (!value || maxWidth <= 0) return '';

  doc.font(font).fontSize(size);

  if (doc.widthOfString(value, { size }) <= maxWidth) return value;

  let cut = value.length;
  while (cut > 1 && doc.widthOfString(`${value.slice(0, cut)}…`, { size }) > maxWidth) {
    cut -= 1;
  }
  return `${value.slice(0, cut)}…`;
};

/** Points at a mm offset from the top-left of the card, into PDF page coords. */
const cardOrigin = (slot) => ({ x0: slot.x, y0: slot.y + CARD.height, w: CARD.width, h: CARD.height });

/**
 * Draws one card face, replicating `IdCardPreview.jsx`'s `IdCardFront` /
 * `IdCardBack` exactly.
 *
 * Every position, colour and font is derived from the shared `cardContract`
 * (`COLORS`, `TYPO`, `BACKEND_FONTS`, `layoutFor`), which is the same source
 * the React preview is driven by. The two renderers therefore cannot disagree
 * on where the photo sits, how big the QR is, which fields appear, or which
 * font weight a label uses — that is the whole point.
 *
 * pdfkit's origin is bottom-left; `layoutFor` returns top-left mm, so each
 * coordinate is flipped with `cardTop.y - mm(offset)`.
 *
 * @param {'front'|'back'} side
 */
const drawCard = async (doc, slot, card, side, image) => {
  const origin = cardOrigin(slot);
  const L = layoutFor(CARD_GEOMETRY.widthMm, CARD_GEOMETRY.heightMm);

  const brandHex = card.brandColor || COLORS.brandFallback;

  doc.save();

  // Card surface: white body, rounded corners, subtle ring — mirrors CardSurface.
  const radius = mm(CARD_GEOMETRY.cornerRadiusMm);
  doc
    .roundedRect(origin.x0, origin.y0 - CARD.height, CARD.width, CARD.height, radius)
    .fillColor(COLORS.cardBg)
    .fill()
    .roundedRect(origin.x0, origin.y0 - CARD.height, CARD.width, CARD.height, radius)
    .lineWidth(0.5)
    .strokeColor(COLORS.border)
    .stroke();

  if (side === 'front') {
    /* ── Front: centered header, photo | info list, QR corner, stamp, footer
     *      Mirrors the on-screen `IdCardFront` — the arrangement from the original
     *      `idCard.template.html`: centered issuing header, a 32mm photo on the
     *      left with a short info list to its right, the QR in the bottom-right
     *      corner, a faint school stamp, and a centred footer. ──────────────── */

    const lead = pt(TYPO.name) * 0.78;
    const labelPt = pt(TYPO.label) * 0.78;
    const bodyPt = pt(TYPO.body) * 0.78;
    const smallPt = pt(TYPO.small) * 0.78;
    const footerPt = pt(TYPO.footer) * 0.78;

    // Amber rule beneath the header band.
    const ruleY = origin.y0 - mm(L.header.y + L.header.h);
    doc.rect(origin.x0, ruleY, CARD.width, mm(0.4)).fillColor(COLORS.headerRule).fill();

    // Centered issuing-institution header: logo (or brand circle), school name, motto.
    const hdrTop = origin.y0 - mm(L.header.y);
    const headerMid = origin.x0 + mm(L.header.x + L.header.w / 2);
    const logoSize = 6;
    const logo = await image(card.schoolLogo);
    if (logo) {
      try {
        doc.image(logo, headerMid - mm(logoSize) / 2, hdrTop, { width: mm(logoSize), height: mm(logoSize) });
      } catch { /* corrupt asset must not fail the sheet */ }
    } else {
      const cx = headerMid;
      const cy = hdrTop + mm(logoSize) / 2;
      doc.circle(cx, cy, mm(logoSize) / 2).fillColor(brandHex).fill();
      doc.font(BACKEND_FONTS.bold).fontSize(pt(TYPO.name) * 0.5)
        .fillColor(COLORS.brandBadgeText)
        .text(BRAND_BADGE_TEXT[0], cx, cy, { align: 'center', valign: 'center' });
    }

    const nameColW = mm(L.header.w);
    doc.fillColor(COLORS.body).font(BACKEND_FONTS.bold).fontSize(lead)
      .text(
        fitText(doc, String(card.schoolName || '').toUpperCase(), nameColW, lead, BACKEND_FONTS.bold),
        origin.x0 + mm(L.header.x), hdrTop + mm(logoSize) + 0.3,
        { width: nameColW, align: 'center' }
      );
    if (card.schoolMotto) {
      doc.fillColor(COLORS.muted).font(BACKEND_FONTS.regular).fontSize(labelPt)
        .text(
          fitText(doc, card.schoolMotto, nameColW, labelPt, BACKEND_FONTS.regular),
          origin.x0 + mm(L.header.x), hdrTop + mm(logoSize) + lead + 0.6,
          { width: nameColW, align: 'center' }
        );
    }

    // Body: 32mm photo (left) + info list (right) + QR (bottom-right corner).
    const photoY = origin.y0 - mm(L.photo.y);
    const photoSize = mm(L.photo.size);
    doc.rect(origin.x0 + mm(L.photo.x), photoY, photoSize, photoSize)
      .fillColor(COLORS.surfaceLight).fill();
    const photo = await image(card.studentImage);
    if (photo) {
      try {
        doc.image(photo, origin.x0 + mm(L.photo.x), photoY, {
          width: photoSize, height: photoSize, fit: [photoSize, photoSize], align: 'center', valign: 'center',
        });
      } catch { /* leave the placeholder */ }
    }
    doc.rect(origin.x0 + mm(L.photo.x), photoY, photoSize, photoSize)
      .lineWidth(0.5).strokeColor(COLORS.border).stroke();

    // Info list, top-aligned with the photo in the column to its right.
    const textX = origin.x0 + mm(L.text.x);
    const textW = mm(L.text.w);
    let cur = photoY + mm(1);

    const infoRows = [
      ['Student ID', card.studentId || '—'],
      ['Full name', card.studentName || '—'],
      ['Class / stream', card.studentClass || '—'],
      ['Emergency', card.emergencyContact || '—'],
    ];
    for (const [label, value] of infoRows) {
      doc.font(BACKEND_FONTS.regular).fontSize(labelPt).fillColor(COLORS.label)
        .text(fitText(doc, label, textW, labelPt, BACKEND_FONTS.regular), textX, cur);
      cur += labelPt + 0.3;
      doc.font(BACKEND_FONTS.bold).fontSize(bodyPt).fillColor(COLORS.body)
        .text(fitText(doc, value, textW, bodyPt, BACKEND_FONTS.bold), textX, cur, { width: textW, lineGap: -0.3 });
      cur += bodyPt + 1;
    }

    // QR — bottom-right corner of the body, "Scan to pay" beneath it.
    const qrSize = mm(L.qr.size);
    const qr = await image(card.qrCodeUrl);
    if (qr) {
      try {
        const qrX = origin.x0 + mm(L.qr.x);
        const qrY = origin.y0 - mm(L.qr.y);
        doc.rect(qrX, qrY, qrSize, qrSize).fillColor(COLORS.qrBg).fill();
        doc.image(qr, qrX, qrY, { width: qrSize, height: qrSize });
        doc.rect(qrX, qrY, qrSize, qrSize).lineWidth(0.5).strokeColor(COLORS.border).stroke();
        doc.font(BACKEND_FONTS.regular).fontSize(smallPt).fillColor(COLORS.label)
          .text('Scan to pay', qrX, qrY + qrSize + 0.4, { width: qrSize, align: 'center' });
      } catch { /* skip */ }
    }

    // School stamp — bottom-left, faint.
    const stamp = await image(card.schoolStamp);
    if (stamp) {
      try {
        const stampW = mm(18);
        doc.image(stamp, origin.x0 + mm(L.pad), origin.y0 - mm(L.footer.y) - mm(1), {
          width: stampW, opacity: 0.15,
        });
      } catch { /* skip */ }
    }

    // Footer — centred.
    const footY = origin.y0 - mm(L.footer.y);
    doc.rect(origin.x0, footY, CARD.width, mm(0.4)).fillColor(COLORS.footerRule).fill();
    doc.font(BACKEND_FONTS.regular).fontSize(footerPt).fillColor(COLORS.label)
      .text(
        'GES compliant student card',
        origin.x0 + mm(L.pad), footY + mm(0.6),
        { width: mm(L.footer.w), align: 'center' }
      );
  } else {
    /* ── Back: magnetic stripe, terms, student ID number, contact grid ───────── */
    //
    // Anchored to the same `layoutFor` frames the front uses so the back is not
    // a second, independent layout. Stripe = header band, terms+barcode live in
    // the body field, contact grid sits just above the footer rule.
    const bodyLeft = origin.x0 + mm(L.body.x);
    const bodyW = mm(L.body.w);
    const leadPt = pt(TYPO.label) * 0.78;
    const bodyPt = pt(TYPO.body) * 0.78;

    // Magnetic stripe band — full card width, top-aligned in the header frame.
    const magY = origin.y0 - mm(L.header.y);
    doc.rect(origin.x0, magY + mm(L.header.h) - mm(4.8), CARD.width, mm(4.8)).fillColor(COLORS.magStripe).fill();
    doc.font(BACKEND_FONTS.regular).fontSize(pt(TYPO.magStripe) * 0.78).fillColor(COLORS.magStripeText)
      .text('Track 1 encrypted', origin.x0 + mm(3), magY + mm(L.header.h) - mm(4));
    doc.font(BACKEND_FONTS.mono).fontSize(pt(TYPO.magStripe) * 0.78).fillColor(COLORS.magStripeBrand)
      .text('SUKUUPAY', origin.x0 + CARD.width - mm(11), magY + mm(L.header.h) - mm(4), { width: mm(8) });

    const bodyTop = origin.y0 - mm(L.body.y + L.body.h);
    const termsTop = bodyTop + mm(2);


    // Institutional terms & conditions.
    const terms = `This credential is the exclusive legal property of ${card.schoolName || 'the issuing school'}. It is not transferable. Return it promptly if so requested. Authorised for classroom identification only.`;
    doc.font(BACKEND_FONTS.regular).fontSize(leadPt).fillColor(COLORS.label)
      .text(fitText(doc, 'Institutional terms & conditions', bodyW, leadPt, BACKEND_FONTS.regular), bodyLeft, termsTop);
    doc.font(BACKEND_FONTS.regular).fontSize(bodyPt).fillColor(COLORS.muted)
      .text(fitText(doc, terms, bodyW, bodyPt, BACKEND_FONTS.regular), bodyLeft, termsTop + leadPt + 0.6, { maxRows: 3 });

    // Student ID number — rendered where a barcode would go, so the back carries
    // a human-readable identifier the staff can type back, not a fake barcode that
    // only looks scannable.
    const idStr = String(card.studentId || '000000');
    const idTop = termsTop + leadPt + bodyPt * 3 + 3;
    doc.font(BACKEND_FONTS.regular).fontSize(leadPt).fillColor(COLORS.label)
      .text('Student ID', bodyLeft, idTop);
    doc.font(BACKEND_FONTS.mono).fontSize(pt(TYPO.name) * 0.78).fillColor(COLORS.body)
      .text(fitText(doc, idStr, bodyW, pt(TYPO.name) * 0.78, BACKEND_FONTS.bold), bodyLeft, idTop + leadPt + 0.4, { width: bodyW });

    // Guardian / Emergency / Holder / Expires grid (2 columns), below the ID.
    const gridY = idTop + leadPt + pt(TYPO.name) * 0.78 + 2.5;
    const half = bodyW / 2 - 1.5;
    const gx = bodyLeft;
    const drawPair = (labelA, valA, labelB, valB, colorB) => {
      doc.font(BACKEND_FONTS.regular).fontSize(leadPt).fillColor(COLORS.label)
        .text(fitText(doc, labelA, half, leadPt, BACKEND_FONTS.regular), gx, gridY);
      doc.font(BACKEND_FONTS.bold).fontSize(bodyPt).fillColor(COLORS.body)
        .text(String(valA || '—'), gx, gridY + leadPt + 0.3, { width: half });
      doc.font(BACKEND_FONTS.regular).fontSize(leadPt).fillColor(COLORS.label)
        .text(fitText(doc, labelB, half, leadPt, BACKEND_FONTS.regular), gx + bodyW / 2, gridY);
      doc.font(BACKEND_FONTS.bold).fontSize(bodyPt).fillColor(colorB || COLORS.body)
        .text(String(valB || '—'), gx + bodyW / 2, gridY + leadPt + 0.3, { width: half });
    };
    const guardianText = card.guardianName
      ? `${card.guardianName}${card.guardianPhone ? ` · ${card.guardianPhone}` : ''}`
      : '—';
    drawPair('Guardian', guardianText, 'Emergency', card.emergencyContact);
    const row2Y = gridY + leadPt + bodyPt + 1;
    doc.font(BACKEND_FONTS.regular).fontSize(leadPt).fillColor(COLORS.label)
      .text('Holder', gx, row2Y);
    doc.font(BACKEND_FONTS.bold).fontSize(bodyPt).fillColor(COLORS.body)
      .text(String(card.studentName || '—'), gx, row2Y + leadPt + 0.3, { width: half });
    doc.font(BACKEND_FONTS.regular).fontSize(leadPt).fillColor(COLORS.label)
      .text('Expires', gx + bodyW / 2, row2Y);
    doc.font(BACKEND_FONTS.bold).fontSize(bodyPt).fillColor('#b45309')
      .text('Not tracked', gx + bodyW / 2, row2Y + leadPt + 0.3, { width: half });
  }

  doc.restore();
};

/**
 * Hairlines in the gutters between cards.
 *
 * **In the gutters only, never across a card.** A rule drawn over a printed card face
 * is a scratch across somebody's name; these sit in the unprintable space between
 * neighbours so they are crop guides and nothing else. On the outer edges they are drawn
 * just inside the block, which is where a guillotine cut goes.
 */
const drawCropMarks = (doc, geometry) => {
  const { slots } = geometry;
  if (!slots.length) return;

  doc.save().lineWidth(0.25).strokeColor('#94a3b8');

  const minX = Math.min(...slots.map((slot) => slot.x));
  const maxX = Math.max(...slots.map((slot) => slot.x + slot.width));
  const minY = Math.min(...slots.map((slot) => slot.y));
  const maxY = Math.max(...slots.map((slot) => slot.y + slot.height));

  const tick = mm(2);

  // Horizontal rules, midway through each inter-row gutter.
  for (let row = 1; row < geometry.rows; row += 1) {
    const y = maxY - CARD.height * row;
    doc.moveTo(minX, y).lineTo(maxX, y).stroke();
  }

  // Vertical rules, only where there is more than one column.
  if (geometry.columns > 1) {
    for (let column = 1; column < geometry.columns; column += 1) {
      const x = minX + CARD.width * column;
      doc.moveTo(x, minY).lineTo(x, maxY).stroke();
    }
  }

  // Corner ticks on the outer boundary, so the block's extent is unambiguous.
  for (const [cx, cy, dx, dy] of [
    [minX, maxY, -1, -1],
    [maxX, maxY, 1, -1],
    [minX, minY, -1, 1],
    [maxX, minY, 1, 1],
  ]) {
    doc.moveTo(cx, cy).lineTo(cx + tick * dx, cy).stroke();
    doc.moveTo(cx, cy).lineTo(cx, cy + tick * dy).stroke();
  }

  doc.restore();
};

/**
 * Renders cards onto printable sheets.
 *
 * ## Front/back pairing — the part that makes it usable
 *
 * For every group of `perPage` cards, page *N* carries the **fronts** in slot order and
 * page *N+1* carries the **backs in exactly the same order**. Print the pair double-sided
 * ("flip on short edge"), guillotine, and each card has its own matching reverse.
 *
 * The alternative — all fronts then all backs — looks identical on screen and is
 * unusable in the hand: the operator has to sort 200 cards against a list afterwards.
 *
 * ## The last sheet
 *
 * Padded with hairline "cut here" placeholders rather than left empty, so nobody prints
 * a half-blank sheet and wonders whether the job failed or there is more coming.
 *
 * @param {object[]} cards
 * @param {{ layout?: string, side?: 'front_back'|'front_only' }} options
 * @returns {Promise<Buffer>}
 */
export const generateIdCardSheets = async (cards = [], options = {}) => {
  const { layout = DEFAULT_SHEET_LAYOUT, side = 'front_back' } = options;
  const geometry = sheetGeometry(layout);
  const { slots, perPage } = geometry;

  const faces = side === 'front_only' ? ['front'] : ['front', 'back'];

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
      size: 'A4',
      // No compression: card art is mostly vector text and thin rules, and the
      // difference in output size is small next to the photos.
      info: {
        Title: 'Student ID cards',
        // Says what to do with it, because a sheet of ID cards in a Downloads folder is
        // a sheet nobody knows how to print.
        Subject: `Print at A4, ${geometry.perPage} cards per page, double-sided (flip on short edge)`,
      },
    });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const image = createImageCache();

    // Nothing to draw at all is a valid answer — a school with no students yet, or a
    // filtered selection that matched no one. An empty PDF is more useful than a throw,
    // because the caller can report "0 cards" without catching an exception.
    const groups = Math.ceil(cards.length / perPage);

    const renderGroup = async (groupIndex) => {
      if (groupIndex >= groups) {
        doc.end();
        return;
      }

      const slice = cards.slice(groupIndex * perPage, (groupIndex + 1) * perPage);

      for (const face of faces) {
        doc.addPage({ size: 'A4', margin: 0 });

        for (const slot of slots) {
          const card = slice[slot.index];

          if (!card) {
            // Filler: a dashed outline on the last sheet only, so a partly-used sheet is
            // obviously partly used.
            drawFillerSlot(doc, slot);
            continue;
          }

          await drawCard(doc, slot, card, face, image);
        }

        // Crop marks on **every** page, but only for the face that will be cut against
        // its partner — the same grid on both pages of a pair is what makes the cut
        // line up.
        drawCropMarks(doc, geometry);
      }

      // Deferred so the stream flushes between groups, keeping memory bounded — the
      // reason this is a loop of `setImmediate` rather than a `for`.
      setImmediate(() => renderGroup(groupIndex + 1));
    };

    setImmediate(() => renderGroup(0));
  });
};

/** A dashed "cut here" box for an unused slot. */
const drawFillerSlot = (doc, slot) => {
  doc.save();
  doc.rect(slot.x, slot.y, slot.width, slot.height).fillColor('#ffffff').fill();

  doc
    .rect(slot.x, slot.y, slot.width, slot.height)
    .lineWidth(0.25)
    .strokeColor('#cbd5e1')
    .dash(1.5, { space: 1.5 })
    .stroke()
    .undash();

  doc
    .fillColor('#cbd5e1')
    .font('Helvetica')
    .fontSize(5)
    .text('cut here', slot.x, slot.y + slot.height / 2 - 2, {
      width: slot.width,
      align: 'center',
    });

  doc.restore();
};

export default {
  MM,
  mm,
  CARD,
  A4,
  SHEET_LAYOUTS,
  SHEET_LAYOUT_NAMES,
  DEFAULT_SHEET_LAYOUT,
  sheetGeometry,
  generateIdCardSheets,
};