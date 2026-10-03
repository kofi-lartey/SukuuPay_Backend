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
 * Money is printed in cedis from pesewas, in the same order `formatCedi` uses on
 * screen, so a figure in the PDF and the same figure in the app are the same string.
 */

const PESEWAS_PER_CEDI = 100;
const GHANA_CEDI = "GH₵";

const cedi = (pesewas, { decimals = true } = {}) => {
  const value = (Number(pesewas) || 0) / PESEWAS_PER_CEDI;
  const formatted = decimals
    ? value.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : value.toLocaleString("en-GH", { maximumFractionDigits: 0 });
  return `${GHANA_CEDI} ${formatted}`;
};

/** `2026-10-29T10:42:00Z` → `29 Oct 2026, 10:42`. */
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

  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  // The breakdown sums to the amount charged. When it does not — a legacy row, or a
  // school that waived part of the fee — the receipt says so on its face rather
  // than showing a total that contradicts its own lines.
  const reconciles = total === (Number(payment.amount) || 0);
  const grandTotal = reconciles ? total : Number(payment.amount) || total;

  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const INK = '#0F172A';
  const MUTED = '#64748B';
  const RULE = '#CBD5E1';
  const BRAND = school?.brandColor || '#0A5C36';

  let y = 48;

  // ── Header ──
  doc.rect(0, 0, doc.page.width, 8).fill(BRAND);
  y = 56;

  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(school?.name || 'School Fees', 48, y, {
    width: doc.page.width - 96,
  });
  y = doc.y + 4;

  doc.font('Helvetica').fontSize(11).fillColor(MUTED).text('Official Fee Payment Receipt', 48, y);
  y = doc.y + 16;

  // The receipt number in a box, because it is the one thing a bursar types when a
  // parent walks in with a photograph of this page.
  doc
    .roundedRect(48, y, doc.page.width - 96, 52, 6)
    .lineWidth(1)
    .strokeColor(RULE)
    .stroke();
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('RECEIPT NUMBER', 60, y + 9);
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(INK)
    .text(payment.receiptNumber || '—', 60, y + 24);
  y += 68;

  // ── Details ──
  const left = 48;
  const column = doc.page.width / 2 - 12;

  const row = (label, value, atX, atY, width) => {
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(String(label).toUpperCase(), atX, atY, { width });
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(INK)
      .text(value || '—', atX, atY + 12, { width });
    return atY + 32;
  };

  doc.moveTo(48, y).lineTo(doc.page.width - 48, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 16;

  let leftY = y;
  let rightY = y;

  leftY = row('Student', student?.studentName, left, leftY, column);
  leftY = row('Student ID', student?.studentId, left, leftY, column);
  leftY = row('Class', student?.studentClass, left, leftY, column);

  const midX = doc.page.width / 2 + 4;
  rightY = row('Date & time', humanDate(payment.completedAt || payment.createdAt), midX, rightY, column);
  rightY = row('Payment method', payment.paymentMethod === 'momo' ? 'Mobile Money' : payment.paymentMethod, midX, rightY, column);
  rightY = row('Reference', payment.reference || payment.paymentId, midX, rightY, column);

  y = Math.max(leftY, rightY) + 8;

  // ── Fee lines ──
  doc.moveTo(48, y).lineTo(doc.page.width - 48, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 16;

  doc.font('Helvetica-Bold').fontSize(10).fillColor(MUTED).text('DESCRIPTION', 48, y);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(MUTED).text('AMOUNT', 300, y, {
    width: doc.page.width - 348,
    align: 'right',
  });
  y = doc.y + 8;

  for (const line of lines) {
    doc.moveTo(48, y).lineTo(doc.page.width - 48, y).lineWidth(0.5).strokeColor('#E2E8F0').stroke();
    y += 8;

    doc.font('Helvetica').fontSize(11).fillColor(INK).text(line.label, 48, y, { width: 240 });
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor(INK)
      .text(cedi(line.amount), 300, y, { width: doc.page.width - 348, align: 'right' });
    y = Math.max(doc.y, y + 18) + 6;
  }

  // ── Total ──
  doc.moveTo(48, y).lineTo(doc.page.width - 48, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 14;

  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text('TOTAL PAID', 48, y);
  doc
    .font('Helvetica-Bold')
    .fontSize(17)
    .fillColor(BRAND)
    .text(cedi(grandTotal), 300, y - 2, { width: doc.page.width - 348, align: 'right' });
  y = doc.y + 12;

  if (!reconciles) {
    // Said plainly rather than silently corrected: if a bursar is reconciling this
    // against the ledger, a discrepancy they cannot see is worse than one they can.
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        `Note: the fee lines above total ${cedi(total)}, which differs from the amount charged.`,
        48,
        y,
        { width: doc.page.width - 96 }
      );
    y = doc.y + 8;
  }

  // ── Footer ──
  const footerY = doc.page.height - 110;
  doc.moveTo(48, footerY).lineTo(doc.page.width - 48, footerY).lineWidth(1).strokeColor(RULE).stroke();

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      'Generated by SukuuPay — Ghana Interbank Payment & Settlement Systems. This receipt confirms the payment above was collected.',
      48,
      footerY + 12,
      { width: doc.page.width - 96, align: 'center' }
    );
  doc
    .fontSize(8)
    .fillColor(MUTED)
    .text('Sukuu Sika Mu Nti', 48, footerY + 40, { width: doc.page.width - 96, align: 'center' });

  doc.end();
  return done;
};

export default { generateReceiptPdf, normaliseBreakdown, receiptFilename };