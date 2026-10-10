import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

/**
 * PDF receipts.
 *
 * A receipt is the artefact a parent keeps — printed at the bursar's window,
 * photographed and sent to a spouse abroad, handed to a landlord. It is also the
 * artefact a school reconciles against. So it has to be legible on a black-and-white
 * print in a badly lit office *and* unambiguous enough to settle a dispute, which
 * rules out the two things that would have been quicker: rendering it as an image
 * (a fax-quality school receipt would be unreadable) and omitting the split (a
 * parent who was charged GH₵ 558.25 for a GH₵ 550 bill needs to see why).
 *
 * **Why this is not in `pdfGenerator.js`.** That module renders the *student ID
 * card*: a fixed template driven by a fixed field list, laid out to a fixed 90×40pt
 * logo. A receipt is the opposite — a variable-length table of arbitrary fee lines
 * drawn from `feesBreakdown`, which is `Schema.Types.Mixed` and therefore not
 * knowable at author time. Bolting a variable table onto a template that takes no
 * such thing would mean either bending the card template or branching inside it.
 *
 * The layout mirrors the on-screen `ReceiptDialog.jsx` section for section —
 * brand band, school header with logo, title, amount box, RECEIVED FROM,
 * RECEIPT, fee breakdown, footer — so the PDF a parent downloads and the modal
 * a bursar screenshots are the same document.
 *
 * Money is printed in cedis from pesewas, in the same order `formatCedi` uses on
 * screen, so a figure in the PDF and the same figure in the app are the same string.
 */

// ──────────────────── Geometry & palette ────────────────────

const PESEWAS_PER_CEDI = 100;

// A4 in points. The content width is derived once and reused everywhere rather
// than recomputed per call, so a margin change is a one-line change.
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2; // 499.28pt

const INK = "#0F172A";
const MUTED = "#64748B";
const RULE = "#CBD5E1";
const SOFT_RULE = "#E2E8F0";
const BAND = "#F1F5F9";
const BRAND_DEFAULT = "#0A5C36";

// ESM has no `__dirname`; derived once so the font lookup resolves relative to
// this file no matter where the backend is started from.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ──────────────────── Fonts ────────────────────

/**
 * Registers a Unicode font that carries the cedi sign (₵, U+20B5).
 *
 * PDFKit's built-in Helvetica is the 1985 PostScript base-14 set: it has no
 * code point for ₵, and PDFKit silently substitutes "c", so a receipt would
 * read "GHc 500.00" — a typo to every parent who sees it. Inter has the
 * sign, so it is registered when the files are present. When they are not,
 * the receipt degrades honestly: Helvetica plus the "GHS" ISO code, which
 * Ghanaian bank statements also use. Either way the receipt renders; only
 * the symbol changes.
 *
 * pdfkit registers fonts lazily — `registerFont()` never opens the file, and
 * a missing TTF only surfaces as an ENOENT when the font is first *drawn*,
 * mid-render, where it would abort the receipt. Existence is therefore
 * checked here so the fallback is decided up front.
 */
const registerFonts = (doc) => {
  const regularPath = path.join(HERE, "../../public/fonts/Inter-Regular.ttf");
  const boldPath = path.join(HERE, "../../public/fonts/Inter-SemiBold.ttf");

  if (!fs.existsSync(regularPath) || !fs.existsSync(boldPath)) {
    console.warn("[receipt] Inter fonts not found, falling back to Helvetica");
    return { regular: "Helvetica", bold: "Helvetica-Bold", symbol: "GHS" };
  }

  try {
    doc.registerFont("Body", regularPath);
    doc.registerFont("BodyBold", boldPath);
    console.log("[receipt] registered Inter fonts");
    return { regular: "Body", bold: "BodyBold", symbol: "GH₵" };
  } catch (err) {
    console.warn("[receipt] Inter fonts not found, falling back to Helvetica:", err.message);
    return { regular: "Helvetica", bold: "Helvetica-Bold", symbol: "GHS" };
  }
};

// ──────────────────── Formatting ────────────────────

/**
 * Pesewas → "GH₵ 500.00". The symbol comes from the registered font: Inter
 * carries the cedi sign, the Helvetica fallback does not, so the same figure
 * prints as "GHS 500.00" when the font files are absent.
 */
const cedi = (pesewas, symbol) => {
  const value = (Number(pesewas) || 0) / PESEWAS_PER_CEDI;
  const formatted = value.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol} ${formatted}`;
};

/**
 * `2026-10-29T10:42:00Z` → `29 Oct 2026, 10:42 am`. One date, never a
 * range: a receipt records when the money moved, not how long the row took
 * to appear.
 */
const humanDate = (value) => {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
};

/**
 * The fee lines, normalised out of `feesBreakdown`.
 *
 * `feesBreakdown` is `Schema.Types.Mixed`, so its shape is whatever the checkout
 * wrote — `admin/payments.service.js` reads `part.markupAmount ?? part.amount`, and
 * a row may carry neither. Anything that is not a usable number is dropped rather
 * than rendered as `GH₵ NaN`, and if *nothing* survives the receipt falls back to a
 * single line for the payment amount. A receipt with no lines at all looks like a
 * corrupt file; a receipt with one correct line is just terse.
 */
export const normaliseBreakdown = (feesBreakdown, fallbackAmount) => {
  const lines = (Array.isArray(feesBreakdown) ? feesBreakdown : [])
    .map((part) => ({
      label: String(part?.label || '').trim(),
      amount: Number(part?.amount ?? part?.markupAmount ?? 0),
    }))
    .filter((line) => line.label && Number.isFinite(line.amount) && line.amount !== 0);

  if (!lines.length) {
    return [{ label: 'School fees', amount: Number(fallbackAmount) || 0 }];
  }
  return lines;
};

/** The filename a browser saves a receipt under. Always from the receipt number. */
export const receiptFilename = (receiptNumber, paymentId) => {
  const stem = String(receiptNumber || paymentId || 'receipt')
    // Strip anything that would need quoting in a Content-Disposition header. A
    // receipt number is generated, but a legacy row may carry an operator-typed
    // one, and an injected quote in a header is a response-splitting primitive.
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 60);
  return `${stem || 'receipt'}.pdf`;
};

// ──────────────────── School logo ────────────────────

/**
 * Fetches the school's logo as a Buffer, or null when there is nothing
 * usable. Data URLs are decoded locally; remote URLs get a 5-second cap so
 * a slow CDN cannot hold a receipt hostage. A failed fetch is not an error:
 * the header falls back to the brand-coloured initial tile.
 */
const fetchLogoBuffer = async (url) => {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/);
    return match ? Buffer.from(match[2], "base64") : null;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
};

/**
 * The 48×48 header logo, or the fallback tile.
 *
 * The image is drawn inside a clip so an oversized or oddly proportioned
 * logo cannot overflow its box. A URL that answers 200 with something that
 * is not an image (an error page, a redirect stub) would make `doc.image`
 * throw; that is caught and the tile is used instead — the same honest
 * degradation as a school with no logo at all, rather than a receipt that
 * cannot be generated at all.
 */
const drawLogo = (doc, school, brand, logoBuffer, x, y, size) => {
  if (logoBuffer) {
    try {
      doc.save();
      doc.roundedRect(x, y, size, size, 4).clip();
      doc.image(logoBuffer, x, y, { fit: [size, size], align: "center", valign: "center" });
      doc.restore();
      return;
    } catch {
      // Balance the `save()` above so the clip cannot leak into the rest of
      // the page, then fall through to the tile.
      doc.restore();
    }
  }

  // No usable logo: a brand-coloured rounded square with the school's first
  // initial, so the header still reads as the school's document.
  doc.roundedRect(x, y, size, size, 4).fill(brand);
  const initial = (String(school?.name || "").trim().charAt(0) || "S").toUpperCase();
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#FFFFFF");
  const initialWidth = doc.widthOfString(initial);
  const initialHeight = doc.heightOfString(initial);
  doc.text(initial, x + (size - initialWidth) / 2, y + (size - initialHeight) / 2, {
    width: size,
    lineBreak: false,
  });
};

// ──────────────────── Layout primitives ────────────────────

/**
 * One label-over-value row.
 *
 * The previous version advanced a hardcoded 32pt per row, so any value that
 * wrapped to a second line was overwritten by the row below — the receipt
 * showed three labels with their values stacked twenty lines away. Measuring
 * the wrapped height with `heightOfString` (which reads the font state set
 * just above) makes the row exactly as tall as its content is, and the
 * returned Y is where the next row may safely start.
 */
const drawRow = (doc, fonts, label, value, x, y, width) => {
  const LABEL_SIZE = 8;
  const VALUE_SIZE = 11;
  const ROW_GAP = 8;

  doc.font(fonts.regular).fontSize(LABEL_SIZE);
  const labelText = String(label || "").toUpperCase();
  doc.fillColor(MUTED).text(labelText, x, y, { width, lineBreak: true });
  const labelHeight = doc.heightOfString(labelText, { width });

  const valueY = y + labelHeight + 2;
  doc.font(fonts.bold).fontSize(VALUE_SIZE);
  const valueText = value || "—";
  doc.fillColor(INK).text(valueText, x, valueY, { width, lineBreak: true });
  const valueHeight = doc.heightOfString(valueText, { width });

  return valueY + valueHeight + ROW_GAP;
};

/**
 * An uppercase section heading with the tracking the modal's
 * `tracking-wider` class gives its `<h3>`s. Returns the Y the section's
 * first row may start at.
 */
const drawSectionHeading = (doc, fonts, text, x, y, width) => {
  const heading = String(text || "").toUpperCase();
  doc.font(fonts.bold).fontSize(9);
  doc.fillColor(MUTED).text(heading, x, y, {
    width,
    lineBreak: false,
    characterSpacing: 0.5,
  });
  return y + doc.heightOfString(heading, { width }) + 10;
};

// ──────────────────── Receipt ────────────────────

/**
 * Renders a receipt to a Buffer.
 *
 * @param {object} payment the Payment document
 * @param {{ student?: object, school?: object }} context resolved student and
 *   school. Passed in rather than populated here so the caller has already proved
 *   the payment belongs to the student the caller is allowed to see — this
 *   function must not be the place that decides that, because it is also reachable
 *   from the admin receipt path.
 * @returns {Promise<Buffer>}
 */
export const generateReceiptPdf = async (payment, { student, school } = {}) => {
  const lines = normaliseBreakdown(payment.feesBreakdown, payment.amount);

  const doc = new PDFDocument({
    size: "A4",
    margin: 48,
    info: {
      Title: `Receipt ${payment.receiptNumber || payment.paymentId || ""}`.trim(),
      Author: school?.name || "SukuuPay",
      Subject: "Official fee payment receipt",
    },
  });

  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));

  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const fonts = registerFonts(doc);
  const BRAND = school?.brandColor || BRAND_DEFAULT;

  // One fetch per receipt: the logo is needed before the header can be drawn,
  // and holding it in a local means a single network round-trip for the whole
  // render rather than one per section.
  const logoBuffer = await fetchLogoBuffer(school?.logo);

  let y = MARGIN;

  // ── 1. Brand band ──
  doc.rect(0, 0, doc.page.width, 6).fill(BRAND);

  // ── 2. Header: logo + school identity ──
  const LOGO_SIZE = 48;
  const logoX = MARGIN;
  const logoY = MARGIN + 14;
  drawLogo(doc, school, BRAND, logoBuffer, logoX, logoY, LOGO_SIZE);

  // The text block sits 12pt right of the logo's right edge and is bounded to
  // the remaining content width, so a long school name wraps at a word boundary
  // instead of running off the page.
  const nameX = logoX + LOGO_SIZE + 12;
  const nameWidth = CONTENT_WIDTH - LOGO_SIZE - 12;

  const schoolName = String(school?.name || "").trim() || "School";
  doc.font(fonts.bold).fontSize(14).fillColor(INK);
  doc.text(schoolName, nameX, logoY + 2, { width: nameWidth, lineBreak: true });
  let headerY = logoY + 2 + doc.heightOfString(schoolName, { width: nameWidth }) + 3;

  doc.font(fonts.regular).fontSize(10).fillColor(MUTED);
  const address = String(school?.address || "").trim();
  if (address) {
    doc.text(address, nameX, headerY, { width: nameWidth, lineBreak: true });
    headerY += doc.heightOfString(address, { width: nameWidth }) + 2;
  }
  const cityRegion = [school?.city, school?.region].filter(Boolean).join(", ");
  if (cityRegion) {
    doc.text(cityRegion, nameX, headerY, { width: nameWidth, lineBreak: true });
    headerY += doc.heightOfString(cityRegion, { width: nameWidth });
  }

  // Divider below the whole header block — below the logo if the text block is
  // shorter than the logo, below the text if it is taller.
  y = Math.max(logoY + LOGO_SIZE, headerY) + 12;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_WIDTH, y).lineWidth(0.5).strokeColor(SOFT_RULE).stroke();

  // ── 3. Title ──
  y += 16;
  doc.font(fonts.bold).fontSize(18).fillColor(INK);
  doc.text("Payment receipt", MARGIN, y, { width: CONTENT_WIDTH, lineBreak: false });
  y += doc.heightOfString("Payment receipt") + 4;
  doc.font(fonts.regular).fontSize(10).fillColor(MUTED);
  const receiptLine = `Receipt ${payment.receiptNumber || "—"}`;
  doc.text(receiptLine, MARGIN, y, { width: CONTENT_WIDTH, lineBreak: false });
  y += doc.heightOfString(receiptLine) + 16;

  // ── 4. Amount box ──
  const BOX_HEIGHT = 74;
  const BOX_INSET = 16;
  doc.roundedRect(MARGIN, y, CONTENT_WIDTH, BOX_HEIGHT, 8).fill(BAND);
  doc.font(fonts.regular).fontSize(9).fillColor(MUTED);
  doc.text("AMOUNT RECEIVED", MARGIN + BOX_INSET, y + 16, {
    width: CONTENT_WIDTH - BOX_INSET * 2,
    lineBreak: false,
    characterSpacing: 0.5,
  });
  const amountLabelHeight = doc.heightOfString("AMOUNT RECEIVED");
  doc.font(fonts.bold).fontSize(26).fillColor(INK);
  const amountText = cedi(payment.amount, fonts.symbol);
  doc.text(amountText, MARGIN + BOX_INSET, y + 16 + amountLabelHeight + 6, {
    width: CONTENT_WIDTH - BOX_INSET * 2,
    lineBreak: false,
  });
  y += BOX_HEIGHT + 24;

  // Two columns, each half the content width minus the gap between them.
  const COLUMN_GAP = 8;
  const columnWidth = (CONTENT_WIDTH - COLUMN_GAP) / 2;
  const leftX = MARGIN;
  const rightX = MARGIN + columnWidth + COLUMN_GAP;

  // ── 5. RECEIVED FROM ──
  y = drawSectionHeading(doc, fonts, "Received from", MARGIN, y, CONTENT_WIDTH);
  let leftY = y;
  let rightY = y;
  leftY = drawRow(doc, fonts, "Student", student?.studentName, leftX, leftY, columnWidth);
  leftY = drawRow(doc, fonts, "Class", student?.studentClass, leftX, leftY, columnWidth);
  rightY = drawRow(doc, fonts, "Student ID", student?.studentId, rightX, rightY, columnWidth);
  y = Math.max(leftY, rightY) + 8;

  // ── 6. RECEIPT ──
  y = drawSectionHeading(doc, fonts, "Receipt", MARGIN, y, CONTENT_WIDTH);
  leftY = y;
  rightY = y;
  leftY = drawRow(doc, fonts, "Receipt number", payment.receiptNumber, leftX, leftY, columnWidth);
  // One date, never a range: completedAt is when the money moved, and
  // createdAt is only the fallback for a payment still being settled.
  leftY = drawRow(
    doc,
    fonts,
    "Date",
    humanDate(payment.completedAt || payment.createdAt),
    leftX,
    leftY,
    columnWidth
  );
  rightY = drawRow(doc, fonts, "Payment ref", payment.reference || payment.paymentId, rightX, rightY, columnWidth);
  rightY = drawRow(
    doc,
    fonts,
    "Method",
    payment.paymentMethod === "momo" ? "Mobile Money" : payment.paymentMethod,
    rightX,
    rightY,
    columnWidth
  );
  // Description is the one field that can run long, so it gets the full
  // content width below the two columns rather than a half column.
  y = Math.max(leftY, rightY);
  y = drawRow(doc, fonts, "Description", payment.notes || payment.description, MARGIN, y, CONTENT_WIDTH);
  y += 8;

  // ── 7. Fee breakdown (only when there is more than one line) ──
  if (lines.length > 1) {
    y = drawSectionHeading(doc, fonts, "Fee breakdown", MARGIN, y, CONTENT_WIDTH);
    const total = lines.reduce((sum, line) => sum + line.amount, 0);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (i > 0) {
        doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_WIDTH, y).lineWidth(0.5).strokeColor(SOFT_RULE).stroke();
        y += 10;
      }

      // The amount is measured in the bold face it is drawn in, and the label
      // is bounded to the space left over, so a long label can never run
      // into the right-aligned figure.
      const amount = cedi(line.amount, fonts.symbol);
      doc.font(fonts.bold).fontSize(11);
      const amountWidth = doc.widthOfString(amount);
      const labelWidth = CONTENT_WIDTH - amountWidth - 16;
      doc.font(fonts.regular).fillColor(INK);
      doc.text(line.label, MARGIN, y, { width: labelWidth, lineBreak: true });
      const labelHeight = doc.heightOfString(line.label, { width: labelWidth });
      doc.font(fonts.bold).fillColor(INK);
      doc.text(amount, MARGIN, y, { width: CONTENT_WIDTH, lineBreak: false, align: "right" });
      y += Math.max(labelHeight, 14) + 8;
    }

    // Said plainly rather than silently corrected: if a bursar is reconciling
    // this against the ledger, a discrepancy they cannot see is worse than one
    // they can.
    if (total !== (Number(payment.amount) || 0)) {
      const note = `Note: the fee lines above total ${cedi(total, fonts.symbol)}, which differs from the amount charged.`;
      doc.font(fonts.regular).fontSize(9).fillColor(MUTED);
      doc.text(note, MARGIN, y + 2, { width: CONTENT_WIDTH, lineBreak: true });
      y += doc.heightOfString(note, { width: CONTENT_WIDTH }) + 10;
    }
  }

  // ── 8. Footer ──
  // Fixed to the page rather than to the content, so a short receipt and a
  // long one both carry the same footer in the same place.
  const footerY = PAGE_HEIGHT - 90;
  doc.moveTo(MARGIN, footerY).lineTo(MARGIN + CONTENT_WIDTH, footerY).lineWidth(1).strokeColor(RULE).stroke();
  doc.font(fonts.regular).fontSize(8).fillColor(MUTED);
  const footerLine1 =
    "Generated by SukuuPay — Ghana Interbank Payment & Settlement Systems. This receipt confirms the payment above was collected.";
  doc.text(footerLine1, MARGIN, footerY + 12, { width: CONTENT_WIDTH, lineBreak: true, align: "center" });
  const footerLine1Height = doc.heightOfString(footerLine1, { width: CONTENT_WIDTH });
  doc.text("Sukuu Sika Mu Nti", MARGIN, footerY + 12 + footerLine1Height + 4, {
    width: CONTENT_WIDTH,
    lineBreak: false,
    align: "center",
  });

  doc.end();
  return done;
};

export default { generateReceiptPdf, normaliseBreakdown, receiptFilename };
