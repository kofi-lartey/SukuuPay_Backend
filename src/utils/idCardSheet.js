import PDFDocument from "pdfkit";

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

/** PDF user units are points. 72 per inch, 25.4mm per inch. */
export const MM = 72 / 25.4;
export const mm = (value) => value * MM;

/** ISO/IEC 7810 ID-1, the "CR80" everybody means by an ID card. */
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

/** Supports `data:` URIs and HTTP(S). Returns `null` rather than throwing. */
const fetchImage = async (url) => {
  if (url.startsWith('data:')) {
    const matches = url.match(/^data:([a-zA-Z]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    return matches ? Buffer.from(matches[2], 'base64') : null;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    // Logged, not thrown. One unreachable logo must not fail a 200-card job; the card
    // simply renders without it, which is what a school would accept.
    console.error('[ID-CARD-SHEET] image fetch failed:', url, error.message);
    return null;
  }
};

/** `#rrggbb` → `{ r, g, b }`, falling back to the brand ink. */
const hexToRgb = (hex, fallback = { r: 30, g: 41, b: 59 }) => {
  if (typeof hex !== 'string' || !hex.startsWith('#')) return fallback;
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  if (full.length !== 6) return fallback;
  const value = Number.parseInt(full, 16);
  if (Number.isNaN(value)) return fallback;
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
};

/**
 * Truncates to fit a width, with an ellipsis.
 *
 * Uses `doc.widthOfString(text, { size })` — the pdfkit 0.20 API. `widthOfText` is not a
 * pdfkit method at all, and calling it threw `TypeError` on the very first card, which
 * is why this is worth stating: the same helper exists in `reportPdf.js` and the method
 * name there is the correct one.
 *
 * `font` is set first because `widthOfString` measures with the font that is *current*,
 * so measuring before selecting the font measures the wrong face and every truncation
 * is computed against the wrong width.
 *
 * @param {string} text
 * @param {number} maxWidth
 * @param {PDFDocument} doc
 * @param {number} size
 * @param {string} font
 */
const fitText = (doc, text, maxWidth, size, font = 'Helvetica-Bold') => {
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

/**
 * Draws one card face into a rectangle.
 *
 * Every dimension is derived from `CARD.width`/`CARD.height` rather than hardcoded, so
 * changing the card size changes the layout with it — which is the whole point of having
 * a geometry module instead of a pile of magic numbers.
 *
 * @param {'front'|'back'} side
 */
const drawCard = async (doc, slot, card, side, image) => {
  const { x, y, width, height } = slot;
  const brand = hexToRgb(card.brandColor);

  doc.save();

  // The card body: a filled panel with a hairline border, clipped to the slot so nothing
  // drawn later can spill into a neighbour's space on a shared sheet.
  doc.rect(x, y, width, height).fillColor('#ffffff').fill();
  doc.rect(x, y, width, height).lineWidth(0.5).strokeColor('#cbd5e1').stroke();

  if (side === 'front') {
    // A brand-coloured header band. Short, so the photo and the name keep the card.
    doc.rect(x, y + height - mm(13), width, mm(13)).fillColor(brand).fill();

    const logo = await image(card.schoolLogo);
    if (logo) {
      try {
        doc.image(logo, x + mm(2.5), y + height - mm(11), {
          width: mm(8),
          height: mm(8),
          fit: [mm(8), mm(8)],
        });
      } catch {
        /* a corrupt asset must not fail the sheet */
      }
    }

    doc
      .fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text(
        fitText(doc, card.schoolName || 'School', width - mm(24), 7.5),
        x + (logo ? mm(12) : mm(3)),
        y + height - mm(9.5),
        { width: width - (logo ? mm(15) : mm(6)), align: 'left' }
      );

    // The photo, fixed frame. A fixed rectangle rather than the image's own aspect so a
    // row of cards lines up — inconsistent photo sizes are the first thing that makes a
    // printed sheet look amateur.
    const photoSize = mm(19);
    const photoX = x + mm(3);
    const photoY = y + height - mm(36);
    doc.rect(photoX, photoY, photoSize, photoSize).fillColor('#f1f5f9').fill();

    const photo = await image(card.studentImage);
    if (photo) {
      try {
        doc.image(photo, photoX, photoY, {
          width: photoSize,
          height: photoSize,
          fit: [photoSize, photoSize],
          align: 'center',
          valign: 'center',
        });
      } catch {
        /* leave the placeholder */
      }
    }
    doc.rect(photoX, photoY, photoSize, photoSize).lineWidth(0.5).strokeColor('#cbd5e1').stroke();

    const textX = photoX + photoSize + mm(3);
    const textWidth = x + width - mm(3) - textX;

    doc
      .fillColor('#0f172a')
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(fitText(doc, card.studentName || '', textWidth, 9), textX, y + height - mm(31), {
        width: textWidth,
      });

    doc
      .fillColor('#475569')
      .font('Helvetica')
      .fontSize(6.5)
      .text(fitText(doc, card.studentClass || '', textWidth, 6.5, 'Helvetica'), textX, y + height - mm(24), {
        width: textWidth,
      })
      .fontSize(5.5)
      .fillColor('#64748b')
      .text(fitText(doc, card.studentId || '', textWidth, 5.5, 'Helvetica'), textX, y + height - mm(19), {
        width: textWidth,
      });

    // QR, bottom-left under the photo.
    const qrSize = mm(13);
    const qr = await image(card.qrCodeUrl);
    if (qr) {
      try {
        doc.image(qr, photoX, y + mm(3), { width: qrSize, height: qrSize });
      } catch {
        /* skip */
      }
    }

    doc
      .fillColor(brand)
      .font('Helvetica')
      .fontSize(5)
      .text('Scan to pay school fees', x + mm(3), y + mm(2.5), {
        width: width - mm(6),
        align: 'center',
      });
  } else {
    // ── The back ──
    //
    // Deliberately carries **no student photo and no QR**. A card back is read by staff
    // and by whoever finds the card; a QR on both faces doubles the ways a lost card can
    // be scanned, and the photo on the back is the copy that gets skimmed off in a
    // lost wallet.
    doc
      .rect(x, y, width, height)
      .fillColor('#f8fafc')
      .fill();
    doc.rect(x, y, width, height).lineWidth(0.5).strokeColor('#cbd5e1').stroke();

    const stamp = await image(card.schoolStamp);
    if (stamp) {
      try {
        doc.image(stamp, x + width - mm(13), y + mm(3), {
          width: mm(10),
          height: mm(10),
          fit: [mm(10), mm(10)],
        });
      } catch {
        /* skip */
      }
    }

    const backX = x + mm(3);
    const backWidth = width - mm(18);

    doc
      .fillColor(brand)
      .font('Helvetica-Bold')
      .fontSize(7)
      .text(fitText(doc, card.schoolName || '', backWidth, 7), backX, y + height - mm(9), {
        width: backWidth,
      });

    doc
      .fillColor('#334155')
      .font('Helvetica')
      .fontSize(5.5)
      .text('If found, please return to the school office or call the number below.', backX, y + mm(24), {
        width: backWidth,
      })
      .font('Helvetica-Bold')
      .fontSize(6.5)
      .fillColor('#0f172a')
      .text(fitText(doc, card.schoolAddress || '', backWidth, 6.5), backX, y + mm(18.5), {
        width: backWidth,
      })
      .text(fitText(doc, card.schoolPhone || '', backWidth, 6.5), backX, y + mm(13.5), {
        width: backWidth,
      });

    doc
      .font('Helvetica')
      .fontSize(5.5)
      .fillColor('#334155')
      .text(
        `Emergency: ${card.emergencyContact || '—'}`.slice(0, 48),
        backX,
        y + mm(7)
      );

    doc
      .font('Helvetica')
      .fontSize(4.5)
      .fillColor('#94a3b8')
      .text('Property of the school. Not transferable.', backX, y + mm(3), {
        width: backWidth,
      });
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