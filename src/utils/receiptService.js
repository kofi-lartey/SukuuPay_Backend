import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSETS = path.resolve(__dirname, "../../assets/fonts");

const FONTS = {
  poppinsLight: "Poppins-Light",
  poppinsRegular: "Poppins-Regular",
  poppinsBold: "Poppins-Bold",
  notoRegular: "NotoSans-Regular",
  notoBold: "NotoSans-Bold",
};

function fontPath(name) {
  return path.join(ASSETS, name);
}

let fontsLoaded = false;

function tryLoadFonts(doc) {
  try {
    if (
      fs.existsSync(fontPath("Poppins-Light.ttf")) &&
      fs.existsSync(fontPath("Poppins-Regular.ttf")) &&
      fs.existsSync(fontPath("Poppins-Bold.ttf")) &&
      fs.existsSync(fontPath("NotoSans-Regular.ttf")) &&
      fs.existsSync(fontPath("NotoSans-Bold.ttf"))
    ) {
      doc.registerFont(FONTS.poppinsLight, fontPath("Poppins-Light.ttf"));
      doc.registerFont(FONTS.poppinsRegular, fontPath("Poppins-Regular.ttf"));
      doc.registerFont(FONTS.poppinsBold, fontPath("Poppins-Bold.ttf"));
      doc.registerFont(FONTS.notoRegular, fontPath("NotoSans-Regular.ttf"));
      doc.registerFont(FONTS.notoBold, fontPath("NotoSans-Bold.ttf"));
      fontsLoaded = true;
    } else {
      fontsLoaded = false;
    }
  } catch (e) {
    fontsLoaded = false;
  }
  return fontsLoaded;
}

// ──────────────────── public helpers (unchanged API) ────────────────────

export const normaliseBreakdown = (feesBreakdown, fallbackAmount) => {
  const lines = (Array.isArray(feesBreakdown) ? feesBreakdown : [])
    .map((part) => ({
      label: String(part?.label || part?.description || "").trim(),
      amount: Number(part?.amount ?? part?.markupAmount ?? 0),
    }))
    .filter((line) => line.label && Number.isFinite(line.amount) && line.amount !== 0);

  if (!lines.length) {
    return [{ label: "School fees", amount: Number(fallbackAmount) || 0 }];
  }
  return lines;
};

export const receiptFilename = (receiptNumber, paymentId) => {
  const stem = String(receiptNumber || paymentId || "receipt").replace(/[^a-zA-Z0-9._-]/g, "");
  return `${stem || "receipt"}.pdf`;
};

// ──────────────────── formatters ────────────────────

function money(value, useCedi = fontsLoaded) {
  const cedi = useCedi ? "GH₵" : "GHc";
  return `${cedi} ${((Number(value) || 0) / 100).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(value) {
  const d = value ? new Date(value) : new Date();
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function uiFont(bold) {
  return fontsLoaded ? (bold ? FONTS.poppinsBold : FONTS.poppinsRegular) : bold ? "Helvetica-Bold" : "Helvetica";
}

function amtFont(bold) {
  return fontsLoaded ? (bold ? FONTS.notoBold : FONTS.notoRegular) : bold ? "Helvetica-Bold" : "Helvetica";
}

// Ellipsize `str` so it fits within `width` pt at the current font settings.
function fitText(doc, str, width) {
  if (doc.widthOfString(str) <= width) return str;
  let trimmed = str;
  while (trimmed.length > 0 && doc.widthOfString(trimmed + "…") > width) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed + "…";
}

// ──────────────────── main render ────────────────────

export const generateReceiptPdf = async (payment = {}, { student, school } = {}) => {
  const p = payment || {};
  const s = student || {};
  const sch = school || {};

  const amount = Number(p.amount ?? 0);
  // Preview (buildReceiptHtml) totals logic — do not "fix" it.
  const totalFees = Number(p.totalFees ?? s.totalOwed ?? amount);
  const amountAlreadyPaid = Number(s.totalPaid ?? p.paidToDate ?? 0);
  const amountLeftToPay = Math.max(0, totalFees - amountAlreadyPaid);
  const amountPaidToday = amount;
  const balance = Math.max(0, amountLeftToPay - amountPaidToday);

  const dateStr = fmtDate(p.date || p.completedAt || p.createdAt);

  const rawMethod = String(p.paymentMethod || p.method || "");
  let methodLabel;
  const m = rawMethod.toLowerCase();
  if (m === "momo") methodLabel = "Mobile Money";
  else if (m === "cash") methodLabel = "Cash";
  else if (m.includes("bank")) methodLabel = "Bank Transfer";
  else if (m === "other") methodLabel = "Other";
  else methodLabel = rawMethod || "Mobile Money";

  const description = p.description || p.notes || "School Fee Payment";
  const studentName = s.studentName || s.name || "—";
  const studentId = s.studentId || "";
  const studentClass = s.studentClass || s.className || "";
  const schoolName = sch.name || "School";
  const schoolAddress = [sch.address, sch.city].filter(Boolean).join(", ");

  const receiptNumber = p.receiptNumber || "";
  const paymentId = p.paymentId || "";

  const breakdown = normaliseBreakdown(p.feesBreakdown, amount);

  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: true });
  tryLoadFonts(doc);

  const chunks = [];
  doc.on("data", (c) => chunks.push(c));

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const PAD_TOP = 51.0;
  const PAD_BOTTOM = 51.0;
  const PAD_X = 45.35;
  const CONTENT_W = PAGE_W - PAD_X * 2; // 504.58
  const BOTTOM = PAGE_H - PAD_BOTTOM;

  let y = PAD_TOP;

  function ensureSpace(h) {
    if (y + h > BOTTOM) {
      doc.addPage();
      y = PAD_TOP;
    }
  }

  function hline(x, yy, w, color, thickness) {
    doc.save().strokeColor(color).lineWidth(thickness).moveTo(x, yy).lineTo(x + w, yy).stroke().restore();
  }

  // ──────── 1. HEADER ────────
  // "RECEIPT" 39pt light weight, 6pt letter spacing; 60pt circle logo/initials on right.
  ensureSpace(70);
  doc.font(uiFont(false)).fontSize(39).fillColor("#4a5a52");
  doc.text("RECEIPT", PAD_X, y, { lineBreak: false, characterSpacing: 6 });

  const circleR = 30;
  const cx = PAGE_W - PAD_X - circleR;
  const cy = y + circleR;

  let logoDrawn = false;
  const logo = sch.logo;
  if (typeof logo === "string" && logo.length) {
    try {
      if (logo.startsWith("data:")) {
        const comma = logo.indexOf(",");
        const base64 = comma === -1 ? logo.slice(5) : logo.slice(comma + 1);
        const buf = Buffer.from(base64, "base64");
        const ct = logo.slice(5, comma === -1 ? undefined : comma).toLowerCase();
        const isImg = /^(image\/(png|jpeg|jpg))(;|$)/.test(ct);
        if (isImg) {
          doc.save();
          doc.circle(cx, cy, circleR).clip();
          doc.image(buf, cx - circleR, cy - circleR, { fit: [60, 60], align: "center", valign: "center" });
          doc.restore();
          logoDrawn = true;
        }
      } else {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(logo, { signal: ctrl.signal });
        clearTimeout(timer);
        if (res.ok) {
          const ct = (res.headers.get("content-type") || "").toLowerCase();
          const isImg = /^image\/(png|jpeg|jpg)(;|$)/.test(ct);
          if (isImg) {
            const ab = await res.arrayBuffer();
            const buf = Buffer.from(ab);
            doc.save();
            doc.circle(cx, cy, circleR).clip();
            doc.image(buf, cx - circleR, cy - circleR, { fit: [60, 60], align: "center", valign: "center" });
            doc.restore();
            logoDrawn = true;
          }
        }
      }
    } catch {
      logoDrawn = false;
    }
  }

  if (!logoDrawn) {
    doc.save().fillColor("#c9dcc4").circle(cx, cy, circleR).fill().restore();
    const initials = schoolName.slice(0, 3).toUpperCase();
    doc.font(uiFont(true)).fontSize(16).fillColor("#4a5a52");
    const tw = doc.widthOfString(initials);
    doc.text(initials, cx - tw / 2, cy - 8, { lineBreak: false });
  }

  y += 70;

  // ──────── 2. BAR ────────
  // light-green strip, margin 22px above (already in y), 18px below.
  const barH = 15.75; // 5px + 11px text + 5px padding approx
  doc.save().fillColor("#c9dcc4").rect(PAD_X, y, CONTENT_W, barH).fill().restore();
  doc.font(uiFont(true)).fontSize(8.25).fillColor("#4a5a52");
  doc.text(`RECEIPT REF.  ${receiptNumber}`, PAD_X + 6, y + 3.75, { lineBreak: false, characterSpacing: 0.75 });
  const dateLabel = `DATE:  ${dateStr}`;
  const dw = doc.widthOfString(dateLabel);
  doc.text(dateLabel, PAGE_W - PAD_X - 6 - dw, y + 3.75, { lineBreak: false });
  y += barH + 13.5; // 18px below

  // ──────── 3. THREE COLUMNS ────────
  const colGap = 18;
  const colW = (CONTENT_W - colGap * 2) / 3;
  const col1X = PAD_X;
  const col2X = PAD_X + colW + colGap;
  const col3X = PAD_X + (colW + colGap) * 2;

  const lineH = 9 * 1.7; // font 9pt × line-height 1.7

  let cy3 = y;
  // Col A: school
  doc.font(uiFont(true)).fontSize(8.25).fillColor("#4a5a52");
  doc.text(fitText(doc, schoolName.toUpperCase(), colW), col1X, cy3, { lineBreak: false, characterSpacing: 1.5 });
  cy3 += 3 + 8.25 + 4; // h4 margin-bottom 4px + font height
  doc.fillColor("#6e7b75").opacity(0.8);
  doc.font(uiFont(false)).fontSize(9);
  doc.text(fitText(doc, schoolAddress, colW), col1X, cy3, { lineBreak: false });
  doc.opacity(1).fillColor("#4a5a52");
  cy3 += lineH;

  // Col B: paid to
  let cyB = y;
  doc.font(uiFont(true)).fontSize(8.25).fillColor("#4a5a52");
  doc.text("PAID TO", col2X, cyB, { lineBreak: false, characterSpacing: 1.5 });
  cyB += 3 + 8.25 + 4;
  doc.font(uiFont(false)).fontSize(9).fillColor("#4a5a52");
  doc.text(fitText(doc, studentName, colW), col2X, cyB, { lineBreak: false });
  cyB += lineH;
  const idLine = studentId ? `ID: ${studentId}${studentClass ? " • " + studentClass : ""}` : studentClass;
  doc.fillColor("#6e7b75").opacity(0.8);
  doc.font(uiFont(false)).fontSize(9);
  doc.text(fitText(doc, idLine, colW), col2X, cyB, { lineBreak: false });
  doc.opacity(1).fillColor("#4a5a52");
  cyB += lineH;

  // Col C: payment method — X on the selected line only.
  let cyC = y;
  doc.font(uiFont(true)).fontSize(8.25).fillColor("#4a5a52");
  doc.text("PAYMENT METHOD", col3X, cyC, { lineBreak: false, characterSpacing: 1.5 });
  cyC += 3 + 8.25 + 4;
  const methods = ["Mobile Money", "Cash", "Bank Transfer", "Other"];
  methods.forEach((mName) => {
    const indent = 12;
    const isSelected = mName === methodLabel;
    doc.font(uiFont(isSelected)).fontSize(9).fillColor("#4a5a52");
    if (isSelected) {
      doc.text("X", col3X + 2, cyC, { lineBreak: false });
    }
    doc.font(uiFont(false)).fontSize(9).fillColor("#4a5a52");
    doc.text(mName, col3X + indent, cyC, { lineBreak: false });
    cyC += lineH;
  });

  y = Math.max(cy3, cyB, cyC) + 19.5; // 26px margin-top before table

  // ──────── 4. TABLE ────────
  ensureSpace(60);
  // top rule 2.25pt
  hline(PAD_X, y, CONTENT_W, "#c9dcc4", 2.25);
  y += 6;
  const headerY = y;
  const noW = CONTENT_W * 0.08;
  const descW = CONTENT_W * 0.46;
  const qtyW = CONTENT_W * 0.10;
  const priceW = CONTENT_W * 0.18;
  const totalW = CONTENT_W * 0.18;
  const xNo = PAD_X;
  const xDesc = PAD_X + noW;
  const xQty = xDesc + descW;
  const xPrice = xQty + qtyW;
  const xTotal = xPrice + priceW;

  doc.font(uiFont(true)).fontSize(8.25).fillColor("#4a5a52");
  doc.text("NO.", xNo, headerY, { lineBreak: false, characterSpacing: 1.125, width: noW, align: "left" });
  doc.text("DESCRIPTION", xDesc, headerY, { lineBreak: false, characterSpacing: 1.125, width: descW, align: "left" });
  doc.text("QTY", xQty, headerY, { lineBreak: false, characterSpacing: 1.125, width: qtyW, align: "right" });
  doc.text("PRICE", xPrice, headerY, { lineBreak: false, characterSpacing: 1.125, width: priceW, align: "right" });
  doc.text("TOTAL", xTotal, headerY, { lineBreak: false, characterSpacing: 1.125, width: totalW, align: "right" });
  y = headerY + 8.25 + 6;
  hline(PAD_X, y, CONTENT_W, "#c9dcc4", 2.25);

  const rowH = 7.5 + 9 + 7.5; // 24pt
  const rows = [];
  breakdown.forEach((b, i) => {
    rows.push({ no: i + 1, desc: b.description || b.label, qty: 1, price: b.amount, total: b.amount });
  });
  if (rows.length === 0) {
    rows.push({ no: 1, desc: description, qty: 1, price: amount, total: amount });
  }
  for (let i = 0; i < 3; i++) rows.push({ no: "", desc: "", qty: "", price: "", total: "" });

  for (const r of rows) {
    ensureSpace(rowH + 2);
    const ry = y + 7.5;
    const hasDesc = String(r.desc).length > 0;
    if (hasDesc) {
      doc.font(uiFont(false)).fontSize(9).fillColor("#4a5a52");
      doc.text(String(r.no), xNo, ry, { lineBreak: false, width: noW, align: "left" });
      doc.text(fitText(doc, String(r.desc), descW), xDesc, ry, { width: descW });
      doc.text(String(r.qty), xQty, ry, { lineBreak: false, width: qtyW, align: "right" });
      doc.font(amtFont(false)).fontSize(9).fillColor("#4a5a52");
      doc.text(money(r.price), xPrice, ry, { lineBreak: false, width: priceW, align: "right" });
      doc.text(money(r.total), xTotal, ry, { lineBreak: false, width: totalW, align: "right" });
    }
    y += rowH;
    hline(PAD_X, y, CONTENT_W, "#c9dcc4", 0.75);
  }

  y += 13.5; // 18px margin before totals

  // ──────── 5. TOTALS BLOCK ────────
  // right-aligned, 60% of content width.
  ensureSpace(120);
  const blockW = CONTENT_W * 0.6;
  const blockX = PAGE_W - PAD_X - blockW;
  const valueRight = PAGE_W - PAD_X;

  const totals = [
    ["TOTAL FEES", money(totalFees)],
    ["AMOUNT ALREADY PAID", money(amountAlreadyPaid)],
    ["AMOUNT LEFT TO PAY", money(amountLeftToPay)],
    ["AMOUNT PAID TODAY", money(amountPaidToday)],
  ];
  for (const [lab, val] of totals) {
    doc.font(uiFont(false)).fontSize(9).fillColor("#4a5a52");
    doc.text(fitText(doc, lab, blockW * 0.6), blockX, y, { lineBreak: false });
    doc.font(amtFont(false)).fontSize(9).fillColor("#4a5a52");
    const vw = doc.widthOfString(val);
    doc.text(val, valueRight - vw, y, { lineBreak: false });
    y += lineH;
  }
  y += 4.5; // gap above balance band
  const bandH = lineH;
  doc.save().fillColor("#4a5a52").rect(blockX, y, blockW, bandH).fill().restore();
  doc.font(uiFont(true)).fontSize(9).fillColor("#ffffff");
  doc.text("REMAINING BALANCE", blockX + 6, y + 2, { lineBreak: false });
  doc.font(amtFont(true)).fontSize(9).fillColor("#ffffff");
  const bv = money(balance);
  const bw = doc.widthOfString(bv);
  doc.text(bv, valueRight - bw - 6, y + 2, { lineBreak: false });
  y += bandH;

  // ──────── 6. NOTES ────────
  y += 19.5; // 26px margin-top
  ensureSpace(60);
  doc.font(uiFont(true)).fontSize(8.625).fillColor("#4a5a52");
  doc.text("Notes", PAD_X, y, { lineBreak: false });
  y += 8.625 + 4;
  const part = balance > 0 ? "part payment" : "full settlement";
  const noteText = `Thank you for your payment. This receipt confirms ${part}. The remaining balance is shown above.`;
  doc.font(uiFont(false)).fontSize(8.625).fillColor("#4a5a52");
  doc.text(noteText, PAD_X, y, { width: CONTENT_W, lineGap: 1.6 * 8.625 - 8.625 });

  // ──────── 7. FOOTER ────────
  y += 37.5 + 8.625 * 1.6; // 50px margin-top + notes height approx
  ensureSpace(30);
  doc.font(uiFont(false)).fontSize(15).fillColor("#4a5a52");
  const tstr = "THANK YOU";
  const tw = doc.widthOfString(tstr);
  doc.text(tstr, (PAGE_W - tw) / 2, y, { lineBreak: false, characterSpacing: 3.75 });

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
};

export default { generateReceiptPdf, normaliseBreakdown, receiptFilename };
