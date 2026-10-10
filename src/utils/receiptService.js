import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

/**
 * PDF receipts — a printed financial document, not a web page.
 *
 * ## The modal and this file render the same document
 *
 * `ReceiptDialog.jsx` on the frontend and this module on the backend share a
 * visual grammar, section for section:
 *
 *   1. Top header — logo, school name, address, with RECEIPT title and date
 *   2. Receipt reference and "Paid To" metadata block
 *   3. Fee breakdown table with DESCRIPTION / QTY / PRICE / TOTAL columns
 *   4. Payment method, notes, and totals summary
 *   5. Grand total badge in brand color
 *   6. SukuuPay publisher's imprint with logo mark
 *
 * The document uses the system's green brand palette for accents:
 * brand-500 (#22C55E) for accent shapes and brand-600 (#16A34A) for the
 * grand total badge. Ink is #0F172A, muted text is #64748B, and labels
 * are #94A3B8. Rules are hairlines in #E2E8F0.
 */

// ──────────────────── Geometry & palette ────────────────────

const PESEWAS_PER_CEDI = 100;

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2; // 483.28pt

// System palette — green brand
const INK = "#0F172A";           // slate-900
const MUTED = "#64748B";         // slate-500
const LABEL = "#94A3B8";         // slate-400
const RULE = "#E2E8F0";          // slate-200
const RULE_STRONG = "#CBD5E1";   // slate-300
const BRAND_500 = "#22C55E";     // green-500
const BRAND_600 = "#16A34A";     // green-600 (darker)
const WHITE = "#FFFFFF";

/** Accent shape geometry. */
const ACCENT_TOP_RIGHT_SIZE = 96;
const ACCENT_BOTTOM_LEFT_SIZE = 80;
const LEFT_BAR_WIDTH = 12;

/** Path to the SukuuPay logo mark asset. */
const SUKUUPAY_MARK_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public/images/sukuupay-mark.png"
);

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ──────────────────── Fonts ────────────────────

const registerFonts = (doc) => {
  const regularPath = path.join(HERE, "../../public/fonts/Inter-Regular.ttf");
  const boldPath = path.join(HERE, "../../public/fonts/Inter-SemiBold.ttf");

  if (!fs.existsSync(regularPath) || !fs.existsSync(boldPath)) {
    console.warn("[receipt] Inter fonts missing — using Helvetica + GHS code");
    return {
      regular: "Helvetica",
      bold: "Helvetica-Bold",
      italic: "Helvetica-Oblique",
      symbol: "GHS",
    };
  }

  doc.registerFont("Body", regularPath);
  doc.registerFont("BodyBold", boldPath);
  doc.registerFont("BodyItalic", regularPath);
  return {
    regular: "Body",
    bold: "BodyBold",
    italic: "BodyItalic",
    symbol: "GH₵",
  };
};

// ──────────────────── Formatting ────────────────────

const cedi = (pesewas, symbol) => {
  const value = (Number(pesewas) || 0) / PESEWAS_PER_CEDI;
  const formatted = value.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol} ${formatted}`;
};

const shortDate = (value) => {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

export const normaliseBreakdown = (feesBreakdown, fallbackAmount) => {
  const lines = (Array.isArray(feesBreakdown) ? feesBreakdown : [])
    .map((part) => ({
      label: String(part?.label || part?.description || "").trim(),
      amount: Number(part?.amount ?? part?.markupAmount ?? 0),
    }))
    .filter(
      (line) => line.label && Number.isFinite(line.amount) && line.amount !== 0
    );

  if (!lines.length) {
    return [{ label: "School fees", amount: Number(fallbackAmount) || 0 }];
  }
  return lines;
};

export const receiptFilename = (receiptNumber, paymentId) => {
  const stem = String(receiptNumber || paymentId || "receipt")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 60);
  return `${stem || "receipt"}.pdf`;
};

// ──────────────────── School logo ────────────────────

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

const drawLogo = (doc, school, logoBuffer, x, y, size) => {
  if (logoBuffer) {
    try {
      doc.save();
      doc.roundedRect(x, y, size, size, 8).clip();
      doc.image(logoBuffer, x, y, {
        fit: [size, size],
        align: "center",
        valign: "center",
      });
      doc.restore();
      return;
    } catch {
      doc.restore();
    }
  }

  doc
    .roundedRect(x, y, size, size, 6)
    .fillColor(INK)
    .fill();

  const initial = (String(school?.name || "").trim().charAt(0) || "S").toUpperCase();
  doc.font("Helvetica-Bold").fontSize(18).fillColor(WHITE);
  const initialWidth = doc.widthOfString(initial);
  const initialHeight = doc.heightOfString(initial);
  doc.text(
    initial,
    x + (size - initialWidth) / 2,
    y + (size - initialHeight) / 2,
    { width: size, lineBreak: false }
  );
};

// ──────────────────── SukuuPay logo mark ────────────────────

const drawSukuuPayMark = (doc, x, y, size) => {
  if (fs.existsSync(SUKUUPAY_MARK_PATH)) {
    try {
      doc.image(SUKUUPAY_MARK_PATH, x, y, {
        fit: [size, size],
        align: "center",
        valign: "center",
      });
      return;
    } catch (err) {
      console.warn(
        "[receipt] SukuuPay mark failed to render, using fallback:",
        err.message
      );
    }
  }

  // Procedural fallback
  const radius = size * 0.22;
  doc
    .roundedRect(x, y, size, size, radius)
    .fillColor(BRAND_600)
    .fill();

  const glyph = "S";
  doc.font("Helvetica-Bold").fontSize(size * 0.62).fillColor(WHITE);
  const glyphWidth = doc.widthOfString(glyph);
  const glyphHeight = doc.heightOfString(glyph);
  doc.text(glyph, x + (size - glyphWidth) / 2, y + (size - glyphHeight) / 2 - 1, {
    width: size,
    align: "center",
    lineBreak: false,
  });
};

// ──────────────────── Layout primitives ────────────────────

const drawDivider = (doc, y, { color = RULE, width = 0.5, x = MARGIN, w = CONTENT_WIDTH } = {}) => {
  doc
    .moveTo(x, y)
    .lineTo(x + w, y)
    .lineWidth(width)
    .strokeColor(color)
    .stroke();
  return y + 1;
};

// ──────────────────── Accent shapes ────────────────────

const drawAccentShapes = (doc) => {
  // Top-right triangle (brand-500)
  doc
    .save()
    .moveTo(PAGE_WIDTH, 0)
    .lineTo(PAGE_WIDTH - ACCENT_TOP_RIGHT_SIZE, 0)
    .lineTo(PAGE_WIDTH, ACCENT_TOP_RIGHT_SIZE)
    .closePath()
    .fillColor(BRAND_500)
    .fill()
    .restore();

  // Bottom-left triangle (brand-500)
  doc
    .save()
    .moveTo(0, PAGE_HEIGHT)
    .lineTo(ACCENT_BOTTOM_LEFT_SIZE, PAGE_HEIGHT)
    .lineTo(0, PAGE_HEIGHT - ACCENT_BOTTOM_LEFT_SIZE)
    .closePath()
    .fillColor(BRAND_500)
    .fill()
    .restore();

  // Left vertical bar (slate-900)
  doc
    .save()
    .rect(0, 0, LEFT_BAR_WIDTH, PAGE_HEIGHT)
    .fillColor(INK)
    .fill()
    .restore();
};

// ──────────────────── Receipt ────────────────────

export const generateReceiptPdf = async (payment, { student, school } = {}) => {
  const lines = normaliseBreakdown(payment.feesBreakdown, payment.amount);

  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
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
  console.log("[receipt] rendering PDF — fonts:", fonts.symbol);

  const logoBuffer = await fetchLogoBuffer(school?.logo);

  // Draw decorative accent shapes first (behind everything else)
  drawAccentShapes(doc);

  // Content starts after the left bar
  const CONTENT_X = MARGIN + LEFT_BAR_WIDTH - 4;
  const CONTENT_W = CONTENT_WIDTH - LEFT_BAR_WIDTH + 4;

  // Starting Y — pushed down a bit more for breathing room
  let y = MARGIN + 20;

  // ─── 1. TOP HEADER ───
  // School brand/logo on the left — bigger
  const LOGO_SIZE = 52;
  drawLogo(doc, school, logoBuffer, CONTENT_X, y, LOGO_SIZE);

  // School name and address beside the logo
  const headerTextX = CONTENT_X + LOGO_SIZE + 16;
  const headerTextW = CONTENT_W - LOGO_SIZE - 16 - 150;

  const schoolName = String(school?.name || "School Name").trim();
  doc.font(fonts.bold).fontSize(16).fillColor(INK);
  doc.text(schoolName, headerTextX, y + 4, {
    width: headerTextW,
    lineBreak: true,
  });

  const schoolAddress = [school?.address, school?.city, school?.region]
    .filter(Boolean)
    .join(" · ");
  if (schoolAddress) {
    doc.font(fonts.regular).fontSize(9.5).fillColor(MUTED);
    doc.text(schoolAddress, headerTextX, y + 26, {
      width: headerTextW,
      lineBreak: true,
    });
  }

  // RECEIPT title and date on the right — green
  const titleX = CONTENT_X + CONTENT_W - 150;
  doc.font(fonts.bold).fontSize(24).fillColor(BRAND_600);
  doc.text("RECEIPT", titleX, y, {
    width: 150,
    align: "right",
    lineBreak: false,
    characterSpacing: 1.5,
  });

  const receiptDateText = shortDate(payment.completedAt || payment.createdAt);
  doc.font(fonts.regular).fontSize(10.5).fillColor(MUTED);
  doc.text(receiptDateText, titleX, y + 30, {
    width: 150,
    align: "right",
    lineBreak: false,
  });

  y += LOGO_SIZE + 32;

  // ─── 2. METADATA BLOCK ───
  const metaY = y;

  // Left: Receipt reference
  doc.font(fonts.bold).fontSize(7.5).fillColor(LABEL);
  doc.text("NO / RECEIPT REF.", CONTENT_X, metaY, {
    width: CONTENT_W / 2,
    lineBreak: false,
    characterSpacing: 1.1,
  });

  const refText = payment.receiptNumber || payment.reference || "—";
  doc.font(fonts.bold).fontSize(11.5).fillColor(INK);
  doc.text(refText, CONTENT_X, metaY + 13, {
    width: CONTENT_W / 2,
    lineBreak: false,
  });

  // Right: Paid To
  const paidToX = CONTENT_X + CONTENT_W / 2;
  doc.font(fonts.bold).fontSize(7.5).fillColor(LABEL);
  doc.text("PAID TO", paidToX, metaY, {
    width: CONTENT_W / 2,
    align: "right",
    lineBreak: false,
    characterSpacing: 1.1,
  });

  const studentName = student?.studentName || "—";
  doc.font(fonts.bold).fontSize(12.5).fillColor(INK);
  doc.text(studentName, paidToX, metaY + 13, {
    width: CONTENT_W / 2,
    align: "right",
    lineBreak: false,
  });

  const idClass = [
    student?.studentId ? `ID: ${student.studentId}` : null,
    student?.studentClass || null,
  ]
    .filter(Boolean)
    .join(" • ");
  if (idClass) {
    doc.font(fonts.regular).fontSize(9.5).fillColor(MUTED);
    doc.text(idClass, paidToX, metaY + 30, {
      width: CONTENT_W / 2,
      align: "right",
      lineBreak: false,
    });
  }

  y = metaY + 58;

  // ─── 3. FEE BREAKDOWN TABLE ───
  y += 12;

  const colDescX = CONTENT_X;
  const colQtyX = CONTENT_X + CONTENT_W - 200;
  const colPriceX = CONTENT_X + CONTENT_W - 140;
  const colTotalX = CONTENT_X + CONTENT_W - 70;

  // Header rule (strong)
  doc
    .moveTo(CONTENT_X, y)
    .lineTo(CONTENT_X + CONTENT_W, y)
    .lineWidth(1.5)
    .strokeColor(INK)
    .stroke();

  y += 10;

  doc.font(fonts.bold).fontSize(8).fillColor(INK);
  doc.text("DESCRIPTION", colDescX, y, { width: 200, lineBreak: false });
  doc.text("QTY", colQtyX, y, { width: 60, align: "center", lineBreak: false });
  doc.text("PRICE", colPriceX, y, { width: 70, align: "right", lineBreak: false });
  doc.text("TOTAL", colTotalX, y, { width: 70, align: "right", lineBreak: false });

  y += 16;

  // Header rule (bottom)
  doc
    .moveTo(CONTENT_X, y)
    .lineTo(CONTENT_X + CONTENT_W, y)
    .lineWidth(1.5)
    .strokeColor(INK)
    .stroke();

  y += 10;

  // Table rows — more spacing
  const ROW_HEIGHT = 34;
  const rowLines = lines.length > 0 ? lines : [{ label: "School fees", amount: payment.amount }];

  for (let i = 0; i < rowLines.length; i += 1) {
    const line = rowLines[i];

    if (i > 0) {
      doc
        .moveTo(CONTENT_X, y)
        .lineTo(CONTENT_X + CONTENT_W, y)
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke();
    }

    const rowTextY = y + 10;

    doc.font(fonts.regular).fontSize(10.5).fillColor(INK);
    doc.text(line.label, colDescX, rowTextY, {
      width: 200,
      lineBreak: true,
    });

    doc.font(fonts.regular).fontSize(10.5).fillColor(MUTED);
    doc.text("1", colQtyX, rowTextY, {
      width: 60,
      align: "center",
      lineBreak: false,
    });

    const amountText = cedi(line.amount, fonts.symbol);
    doc.font(fonts.regular).fontSize(10.5).fillColor(MUTED);
    doc.text(amountText, colPriceX, rowTextY, {
      width: 70,
      align: "right",
      lineBreak: false,
    });

    doc.font(fonts.bold).fontSize(10.5).fillColor(INK);
    doc.text(amountText, colTotalX, rowTextY, {
      width: 70,
      align: "right",
      lineBreak: false,
    });

    y += ROW_HEIGHT;
  }

  // Bottom rule (strong)
  doc
    .moveTo(CONTENT_X, y)
    .lineTo(CONTENT_X + CONTENT_W, y)
    .lineWidth(1.5)
    .strokeColor(INK)
    .stroke();

  y += 20;

  // ─── 4. TOTALS & PAYMENT DETAILS ───
  const totalsY = y;
  const leftColW = CONTENT_W * 0.45;
  const rightColW = CONTENT_W * 0.45;
  const rightColX = CONTENT_X + CONTENT_W - rightColW;

  // Left: Payment method and notes
  doc.font(fonts.bold).fontSize(7.5).fillColor(INK);
  doc.text("PAYMENT METHOD", CONTENT_X, totalsY, {
    width: leftColW,
    lineBreak: false,
    characterSpacing: 0.8,
  });

  const methodText =
    payment.paymentMethod === "momo"
      ? "Mobile Money"
      : payment.paymentMethod || "Standard";
  doc.font(fonts.regular).fontSize(10.5).fillColor(MUTED);
  doc.text(methodText, CONTENT_X, totalsY + 14, {
    width: leftColW,
    lineBreak: true,
  });

  doc.font(fonts.bold).fontSize(7.5).fillColor(INK);
  doc.text("NOTES", CONTENT_X, totalsY + 38, {
    width: leftColW,
    lineBreak: false,
    characterSpacing: 0.8,
  });

  doc.font(fonts.regular).fontSize(9.5).fillColor(MUTED);
  const notesText =
    "Thank you for your payment. This receipt confirms full settlement for the fees listed above.";
  doc.text(notesText, CONTENT_X, totalsY + 52, {
    width: leftColW,
    lineBreak: true,
  });

  // Right: Calculation summary
  let calcY = totalsY;

  // Sub Total
  doc.font(fonts.regular).fontSize(10.5).fillColor(MUTED);
  doc.text("Sub Total", rightColX, calcY, {
    width: rightColW - 80,
    lineBreak: false,
  });
  doc.font(fonts.bold).fontSize(10.5).fillColor(INK);
  doc.text(cedi(payment.amount, fonts.symbol), rightColX + rightColW - 80, calcY, {
    width: 80,
    align: "right",
    lineBreak: false,
  });

  calcY += 22;

  // Tax / Discount
  doc.font(fonts.regular).fontSize(10.5).fillColor(MUTED);
  doc.text("Tax / Discount", rightColX, calcY, {
    width: rightColW - 80,
    lineBreak: false,
  });
  doc.font(fonts.regular).fontSize(10.5).fillColor(MUTED);
  doc.text(cedi(0, fonts.symbol), rightColX + rightColW - 80, calcY, {
    width: 80,
    align: "right",
    lineBreak: false,
  });

  calcY += 26;

  // Grand Total badge (green)
  const badgeHeight = 36;
  const badgeWidth = rightColW;
  const badgeX = rightColX;

  doc
    .roundedRect(badgeX, calcY, badgeWidth, badgeHeight, 6)
    .fillColor(BRAND_600)
    .fill();

  doc.font(fonts.bold).fontSize(9).fillColor(WHITE);
  doc.text("GRAND TOTAL", badgeX + 12, calcY + 13, {
    width: badgeWidth - 130,
    lineBreak: false,
    characterSpacing: 0.8,
  });

  doc.font(fonts.bold).fontSize(15).fillColor(WHITE);
  doc.text(cedi(payment.amount, fonts.symbol), badgeX + badgeWidth - 140, calcY + 10, {
    width: 128,
    align: "right",
    lineBreak: false,
  });

  y = Math.max(totalsY + 110, calcY + badgeHeight) + 40;

  // ─── 5. FOOTER WITH SUKUUPAY LOGO ───
  const FOOTER_Y = PAGE_HEIGHT - 90;

  if (y > FOOTER_Y - 20) {
    y = Math.min(y, PAGE_HEIGHT - 70);
  } else {
    y = FOOTER_Y;
  }

  // Hairline rule above footer
  doc
    .moveTo(CONTENT_X, y)
    .lineTo(CONTENT_X + CONTENT_W, y)
    .lineWidth(0.5)
    .strokeColor(RULE)
    .stroke();

  y += 20;

  // SukuuPay logo mark + wordmark — same baseline, 50pt mark
  const MARK_SIZE = 50;
  const WORDMARK_GAP = 14;

  drawSukuuPayMark(doc, CONTENT_X, y, MARK_SIZE);

  // Vertically center the wordmark against the 50pt mark.
  // The bold 16pt wordmark's cap height is roughly 11.6pt, so its baseline
  // should sit near the vertical middle of the mark.
  const WORDMARK_SIZE = 16;
  doc.font(fonts.bold).fontSize(WORDMARK_SIZE).fillColor(INK);
  const wordmarkHeight = doc.heightOfString("SukuuPay", {
    lineBreak: false,
  });
  const wordmarkY = y + (MARK_SIZE - wordmarkHeight) / 2;

  doc.text("SukuuPay", CONTENT_X + MARK_SIZE + WORDMARK_GAP, wordmarkY, {
    width: CONTENT_W / 2,
    lineBreak: false,
  });

  // Tagline on the right — vertically aligned with the wordmark
  doc.font(fonts.italic).fontSize(10).fillColor(MUTED);
  const taglineHeight = doc.heightOfString("Sukuu Sika Mu Nti", {
    lineBreak: false,
  });
  const taglineY = y + (MARK_SIZE - taglineHeight) / 2;

  doc.text("Sukuu Sika Mu Nti", CONTENT_X + CONTENT_W / 2, taglineY, {
    width: CONTENT_W / 2,
    align: "right",
    lineBreak: false,
  });

  doc.end();
  return done;
};

export default { generateReceiptPdf, normaliseBreakdown, receiptFilename };