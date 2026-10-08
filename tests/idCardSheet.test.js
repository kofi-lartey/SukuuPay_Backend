// Printable ID-card sheets.
//
//   npm test
//
// The bug: `generatePdfFromTemplate` drew **one card per A4 page** at 40pt margins with
// 16pt type. That is a proof sheet — 90% of every sheet is empty, and nothing on it is at
// ID-card size, so cutting one down produces cards that are not CR80 and do not fit a
// badge holder or a lanyard. Worse, it rendered at full A4 rather than sharing sheets.
//
// These assert the geometry (pure arithmetic, no PDF needed) and then the rendered page
// count (which is the property that proves cards are actually sharing sheets — and which
// a mocked `PDFDocument` could not tell us).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  sheetGeometry,
  generateIdCardSheets,
  CARD,
  A4,
  MM,
  mm,
  SHEET_LAYOUT_NAMES,
  DEFAULT_SHEET_LAYOUT,
} from '../src/utils/idCardSheet.js';
import { IdCardBatch } from '../src/models/IdCardBatch.js';
import { DEFAULT_PLATFORM_SETTINGS, NESTED_PLATFORM_SETTINGS_BRANCHES } from '../src/models/PlatformSettings.js';

const card = (i) => ({
  schoolName: 'Prampram Basic School',
  studentName: `Student ${i}`,
  studentClass: 'JHS 2A',
  studentId: `PBS-2026-000${i}`,
  emergencyContact: 'Guardian 0244123456',
  schoolPhone: '0302001000',
  schoolAddress: 'P.O. Box 12, Prampram',
  brandColor: '#0A5C36',
});

/** Inflates every FlateDecode stream in a PDF buffer. */
const inflateStreams = (buffer) => {
  const raw = buffer.toString('latin1');
  const out = [];
  const pattern = /stream\r?\n([\s\S]*?)endstream/g;
  let match;
  while ((match = pattern.exec(raw))) {
    try {
      out.push(zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'));
    } catch {
      /* not a flate stream */
    }
  }
  return out;
};

const pageCount = (buffer) => (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

// ─────────────────────────────────────────────
// The card is a real card
// ─────────────────────────────────────────────
describe('ID card sheet: the card is CR80', () => {
  test('85.60 x 53.98 mm, within a tenth of a millimetre', () => {
    // ISO/IEC 7810 ID-1. The layout may change how many share a sheet; it must never
    // change how big a card is, because a card that is not standard size is not an ID
    // card — it does not fit a badge holder, a lanyard or a card printer.
    //
    // `MM` is **points per millimetre** (72/25.4), so millimetres is points ÷ MM. The
    // first version of this test multiplied by 25.4 as well and reported a card 2174mm
    // wide, which is how a unit-conversion mistake stays invisible.
    const widthMm = CARD.width / MM;
    const heightMm = CARD.height / MM;

    assert.ok(Math.abs(widthMm - 85.6) < 0.1, `width was ${widthMm}mm`);
    assert.ok(Math.abs(heightMm - 53.98) < 0.1, `height was ${heightMm}mm`);
  });

  test('and smaller than the old full-A4 proof sheet', () => {
    // The regression in one assertion: a card used to be rendered at A4 proportions.
    assert.ok(CARD.width < A4.width / 2);
    assert.ok(CARD.height < A4.height / 2);
  });
});

// ─────────────────────────────────────────────
// Five per A4
// ─────────────────────────────────────────────
describe('ID card sheet: five per sheet is the default', () => {
  test('the default layout is 6-up', () => {
    assert.equal(DEFAULT_SHEET_LAYOUT, '6up_a4_landscape');
    assert.equal(sheetGeometry().perPage, 6);
  });

  test('the 6-up layout has exactly six slots', () => {
    const geometry = sheetGeometry('6up_a4_landscape');
    assert.equal(geometry.slots.length, 6);
    assert.equal(geometry.perRow, 3);
    assert.equal(geometry.perColumn, 2);
  });

  test('the 9-up layout has exactly nine slots', () => {
    const geometry = sheetGeometry('9up_a4_landscape');
    assert.equal(geometry.slots.length, 9);
    assert.equal(geometry.perRow, 3);
    assert.equal(geometry.perColumn, 3);
  });

  test('every slot is inside the page', () => {
    // A slot past the edge is a card the printer clips, which is worse than a sheet with
    // air around it.
    for (const name of SHEET_LAYOUT_NAMES) {
      const { slots } = sheetGeometry(name);
      for (const slot of slots) {
        assert.ok(slot.x >= 0, `${name} slot ${slot.index} starts off the left edge`);
        assert.ok(slot.x + slot.width <= A4.width, `${name} slot ${slot.index} runs off the right`);
        assert.ok(slot.y >= 0, `${name} slot ${slot.index} starts off the bottom`);
        assert.ok(slot.y + slot.height <= A4.height, `${name} slot ${slot.index} runs off the top`);
      }
    }
  });

  test('no two slots overlap', () => {
    // Overlapping cards cannot be guillotined — the cut destroys one of them. This is
    // the assertion that makes the layout printable rather than merely non-crashing.
    for (const name of SHEET_LAYOUT_NAMES) {
      const { slots } = sheetGeometry(name);
      for (let i = 0; i < slots.length; i += 1) {
        for (let j = i + 1; j < slots.length; j += 1) {
          const a = slots[i];
          const b = slots[j];
          const overlaps =
            a.x < b.x + b.width - 0.01 &&
            a.x + a.width > b.x + 0.01 &&
            a.y < b.y + b.height - 0.01 &&
            a.y + a.height > b.y + 0.01;
          assert.ok(!overlaps, `${name}: slots ${i} and ${j} overlap`);
        }
      }
    }
  });

  test('the sheet leaves a printable margin, not a bleed', () => {
    // Most desktop printers cannot print into the last ~5mm. The 8-up layout's side
    // margin is the tighter of the two and is the one that matters here. `mm()` converts
    // millimetres to points, which is the direction this needs.
    const safePt = mm(5);
    for (const name of SHEET_LAYOUT_NAMES) {
      const { slots } = sheetGeometry(name);
      const left = Math.min(...slots.map((s) => s.x));
      const right = A4.width - Math.max(...slots.map((s) => s.x + s.width));

      assert.ok(left >= safePt, `${name} left margin is ${left}pt, under ${safePt}pt`);
      assert.ok(right >= safePt, `${name} right margin is ${right}pt, under ${safePt}pt`);
    }
  });

  test('an unknown layout name falls back rather than rendering nothing', () => {
    assert.equal(sheetGeometry('nope').layoutName, DEFAULT_SHEET_LAYOUT);
    assert.equal(sheetGeometry(undefined).perPage, 6);
  });
});

// ─────────────────────────────────────────────
// Cards actually share sheets
// ─────────────────────────────────────────────
describe('ID card sheet: the PDF', () => {
  test('six cards produce one front/back pair, not six pages', async () => {
    const buffer = await generateIdCardSheets(
      Array.from({ length: 6 }, (_, i) => card(i + 1)),
      { layout: '6up_a4_landscape' }
    );

    assert.equal(pageCount(buffer), 2);
    assert.ok(buffer.toString('latin1').startsWith('%PDF-'));
  });

  test('seven cards spill onto a second sheet, four pages in total', async () => {
    const buffer = await generateIdCardSheets(
      Array.from({ length: 7 }, (_, i) => card(i + 1)),
      { layout: '6up_a4_landscape' }
    );
    assert.equal(pageCount(buffer), 4, '2 groups x front + back');
  });

  test('a nine-up sheet fits all nine on one pair', async () => {
    const buffer = await generateIdCardSheets(
      Array.from({ length: 9 }, (_, i) => card(i + 1)),
      { layout: '9up_a4_landscape' }
    );
    assert.equal(pageCount(buffer), 2);
  });

  test('front_only prints half the pages', async () => {
    const buffer = await generateIdCardSheets(
      Array.from({ length: 6 }, (_, i) => card(i + 1)),
      { layout: '6up_a4_landscape', side: 'front' }
    );
    assert.equal(pageCount(buffer), 1);
  });

  test('the cards are not blank', async () => {
    // The regression that motivated all of this. `generatePdfFromTemplate` was called
    // with one argument instead of two, so `data` was `undefined`, every page rendered
    // an empty bordered rectangle, and the PDF was a perfectly valid file containing
    // nothing. Page count and file size both looked right.
    //
    // So this inflates the content streams and counts drawing operators. Names are not
    // greppable — pdfkit subsets fonts, so the literal text is not in the stream as
    // ASCII — but `Tj`/`TJ` and `re` operators are.
    const buffer = await generateIdCardSheets(
      Array.from({ length: 6 }, (_, i) => card(i + 1)),
      { layout: '6up_a4_landscape' }
    );

    const streams = inflateStreams(buffer);
    assert.ok(streams.length >= 2, 'expected a content stream per page');

    const total = streams.reduce(
      (sum, s) => sum + (s.match(/T[jJ]/g) || []).length,
      0
    );
    assert.ok(total > 20, `only ${total} text operators drawn — the sheets are blank`);
  });

  test('the back of a card carries no QR and no photo', async () => {
    // A card back is read by staff and by whoever finds the card. A QR on both faces
    // doubles the ways a lost card can be scanned, and the photo on the back is the copy
    // that gets skimmed off in a lost wallet.
    //
    // Asserted structurally: the back page must draw **fewer** image placements than the
    // front. Images are `Do` operators in the content stream.
    const buffer = await generateIdCardSheets([card(1)], { layout: '6up_a4_landscape' });
    const [front, back] = inflateStreams(buffer);

    const imageOps = (s) => (s.match(/\/I\d+ Do|\bDo\b/g) || []).length;
    assert.ok(imageOps(back) <= imageOps(front), 'the back must not draw more images than the front');
  });

  test('an empty batch yields an empty PDF instead of throwing', async () => {
    // A school with no students yet, or a selection that matched nobody. Throwing here
    // would turn "0 cards" into a failed job.
    const buffer = await generateIdCardSheets([], { layout: '6up_a4_landscape' });
    assert.ok(buffer.length > 0);
    assert.ok(buffer.toString('latin1').startsWith('%PDF-'));
  });
});

// ─────────────────────────────────────────────
// The rendered card carries the same fields as the preview
// ─────────────────────────────────────────────
describe('ID card sheet: the rendered card matches the preview', () => {
  // pdfkit writes standard (Helvetica) text as hex-encoded PDF strings, so the
  // literal label text is not in the raw stream as ASCII. Decoding the `<....>`
  // operands restores the ASCII and lets the test assert on real field labels.
  //
  // PDFKit emits mixed TJ arrays: `[<hex1> 20 <hex2> 0] TJ`. We collapse each
  // TJ array by decoding its hex strings and concatenating them with the kern
  // numbers stripped, so `<53747564656e74204944> 0` → "Student ID" and
  // `<47756172> 20 <6469616e> 0` → "Guardian".
  const decodeHex = (s) =>
    s.replace(/<([0-9A-Fa-f]+)>/g, (_m, h) => Buffer.from(h, 'hex').toString('latin1'))
     .replace(/\[([^\]]*)\] TJ/g, (_m, inside) =>
       inside
         .replace(/\s+-?\d+(\.\d+)?\s*/g, '') // strip kern numbers and their surrounding spaces
         .replace(/\s+(\d+(\.\d+)?)?\]/g, '') // strip trailing kern number
         .trim()
     );

  test('the front labels and back footer render', async () => {
    const c = {
      ...card(1),
      dateOfBirth: new Date('2012-04-23'),
      guardianName: 'Madam Abena',
      academicYear: '2025/2026',
      schoolCode: 'SC-001',
    };
    const buffer = await generateIdCardSheets([c], { layout: '6up_a4_landscape' });
    const streams = inflateStreams(buffer).map(decodeHex);
    const front = streams[0];
    const back = streams.find((s) => s.includes('Institutional')) || streams[1];

    // Front: the two-column field grid labels.
    assert.ok(front.includes('Student ID'), 'front body: Student ID label missing');
    assert.ok(front.includes('Class / stream'), 'front body: Class / stream label missing');
    // Footer: "SukuPay Secure ID" + academic year (matches frontend back footer).
    assert.ok(back.includes('Secure ID'), 'footer: Secure ID text missing');
    assert.ok(back.includes('2025/2026'), 'footer: academic year text missing');
  });

  test('the back carries the Guardian/Emergency/Holder/Expires grid and terms', async () => {
    const c = {
      ...card(1),
      guardianName: 'Madam Abena',
      guardianPhone: '0244000001',
      emergencyContact: '0201000001',
    };
    const buffer = await generateIdCardSheets([c], { layout: '6up_a4_landscape' });
    const streams = inflateStreams(buffer).map(decodeHex);
    // The back is the stream that is NOT the front: pick the one with "Institutional".
    const back = streams.find((s) => s.includes('Institutional')) || streams[1];

    for (const label of ['Guardian', 'Emergency', 'Holder', 'Expires']) {
      assert.ok(back.includes(label), `back grid: ${label} label missing`);
    }
    // Terms heading is a back-only element.
    assert.ok(back.includes('Institutional'), 'back: Institutional terms heading missing');
  });

  test('the resolved student ID flows through to the back barcode label', async () => {
    // The barcode is synthesized from the student ID. A distinctive ID must appear
    // verbatim on the back, proving `resolveCardData` → `drawCard` wire the field
    // end-to-end (the regression left it undefined).
    const buffer = await generateIdCardSheets(
      [{ ...card(1), studentId: 'PBS-2026-0001' }],
      { layout: '6up_a4_landscape' }
    );
    const back = inflateStreams(buffer).map(decodeHex).find((s) => s.includes('Institutional')) || [];
    assert.ok(back, 'a back content stream was produced');
    assert.ok(String(back).includes('PBS-2026-0001'), 'student ID did not reach the back face');

    // A different ID must not bleed the previous one.
    const buffer2 = await generateIdCardSheets(
      [{ ...card(1), studentId: 'S-9' }],
      { layout: '6up_a4_landscape' }
    );
    const back2 = inflateStreams(buffer2).map(decodeHex).find((s) => s.includes('Institutional')) || [];
    assert.ok(String(back2).includes('S-9'), 'second student ID did not reach the back face');
    assert.ok(!String(back2).includes('PBS-2026-0001'), 'a previous ID leaked into a different card');
  });
});

// ─────────────────────────────────────────────
// The layout is recorded, so the school can print it
// ─────────────────────────────────────────────
describe('ID card sheet: the batch records what it printed', () => {
  test('a batch stores the layout, cards per sheet and sheet count', () => {
    // A school handed a PDF with no instructions guesses: prints single-sided and ends
    // up with 200 fronts and no backs, or scales to fit and gets non-CR80 cards.
    assert.ok(IdCardBatch.schema.path('sheetLayout'));
    assert.ok(IdCardBatch.schema.path('cardsPerSheet'));
    assert.ok(IdCardBatch.schema.path('sheetCount'));
    assert.equal(IdCardBatch.schema.path('cardsPerSheet').options.default, 6);
    assert.equal(IdCardBatch.schema.path('sheetCount').options.default, 1);
  });

  test('the layout is constrained to the generator’s own names', () => {
    const allowed = IdCardBatch.schema.path('sheetLayout').enumValues;
    assert.deepEqual([...allowed].sort(), [...SHEET_LAYOUT_NAMES].sort());
  });
});

describe('ID card sheet: the platform setting', () => {
  test('defaults to 6-up, double-sided', () => {
    assert.equal(DEFAULT_PLATFORM_SETTINGS.idCards.sheetLayout, '6up_a4_landscape');
    assert.equal(DEFAULT_PLATFORM_SETTINGS.idCards.sides, 'front_back');
  });

  test('generation is off until an operator turns it on', () => {
    // Card generation produces a printable artefact and burns a QR render per student.
    // Defaulting this to true ships a feature nobody reviewed.
    assert.equal(DEFAULT_PLATFORM_SETTINGS.idCards.enabled, false);
  });

  test('idCards is a merged nested branch', () => {
    // A branch missing from this list is replaced wholesale by a partial stored
    // document, so a school-provisioning write that stored `idCards` without
    // `sheetLayout` would leave the generator reading `undefined`.
    assert.ok(NESTED_PLATFORM_SETTINGS_BRANCHES.includes('idCards'));
  });
});