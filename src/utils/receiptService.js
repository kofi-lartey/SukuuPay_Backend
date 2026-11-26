import PDFDocument from "pdfkit";

const money = (value) => `GH₵ ${((Number(value) || 0) / 100).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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

export const generateReceiptPdf = async (payment, { student, school } = {}) => {
  const receiptRef = payment?.receiptNumber || payment?.paymentId || "RCP-0000";
  const date = payment?.paymentDate || payment?.createdAt || new Date();
  const d = new Date(date);
  const dateStr = Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const studentName = student?.name || payment?.studentName || "Student";
  const studentId = student?.studentId || payment?.studentId || "";
  const className = student?.className || payment?.className || "";
  const schoolName = school?.name || payment?.schoolName || "School";
  const schoolAddress = school?.address || payment?.schoolAddress || "";
  const method = payment?.paymentMethod || payment?.method || "Mobile Money";
  const amount = Number(payment?.amount ?? payment?.totalAmount ?? 0);
  const totalFees = Number(payment?.totalFees ?? amount);
  const paidToDate = Number(payment?.paidToDate ?? amount);
  const balance = Math.max(0, totalFees - paidToDate);
  const description = payment?.description || "School fees payment";

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Header
      doc.font("Helvetica-Bold").fontSize(40).fillColor("#4a5a52").text("RECEIPT", 50, 40, { align: "left" });
      doc.font("Helvetica").fontSize(10).fillColor("#4a5a52").text(`Receipt Ref: ${receiptRef}`, 50, 95);
      doc.text(`Date: ${dateStr}`, 450, 95, { align: "right" });

      // School info
      doc.font("Helvetica-Bold").fontSize(14).text(schoolName, 50, 125);
      doc.font("Helvetica").fontSize(10).fillColor("#888").text(schoolAddress, 50, 145);

      // Paid to / method
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#4a5a52").text("Paid To", 50, 175);
      doc.font("Helvetica").fontSize(10).fillColor("#4a5a52").text(studentName, 50, 192);
      doc.text(`ID: ${studentId} ${className ? `• ${className}` : ""}`, 50, 207);

      doc.font("Helvetica-Bold").fontSize(12).fillColor("#4a5a52").text("Payment Method", 300, 175);
      doc.font("Helvetica").fontSize(10).fillColor("#4a5a52").text(method, 300, 192);

      // Line separator
      doc.moveTo(50, 225).lineTo(545, 225).strokeColor("#c9dcc4").lineWidth(2).stroke();

      // Table header
      let y = 240;
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#4a5a52");
      doc.text("Description", 50, y);
      doc.text("Qty", 420, y, { width: 40, align: "right" });
      doc.text("Price", 470, y, { width: 60, align: "right" });
      doc.text("Total", 530, y, { width: 60, align: "right" });
      y += 20;
      doc.moveTo(50, y).lineTo(545, y).strokeColor("#c9dcc4").stroke();
      y += 8;

      // Table row
      doc.font("Helvetica").fontSize(9).fillColor("#4a5a52");
      doc.text(description, 50, y);
      doc.text("1", 420, y, { width: 40, align: "right" });
      doc.text(money(amount), 470, y, { width: 60, align: "right" });
      doc.text(money(amount), 530, y, { width: 60, align: "right" });
      y += 30;

      // Totals
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#4a5a52");
      doc.text("SUB TOTAL", 420, y, { width: 120, align: "right" });
      doc.text(money(amount), 530, y, { width: 60, align: "right" });
      y += 18;
      doc.font("Helvetica").fontSize(10).fillColor("#4a5a52");
      doc.text("TAX / DISCOUNT", 420, y, { width: 120, align: "right" });
      doc.text("GH₵ 0.00", 530, y, { width: 60, align: "right" });
      y += 18;
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#4a5a52").fillColor("#c9dcc4");
      doc.rect(420, y, 130, 18).fill();
      doc.fillColor("#4a5a52").text("GRAND TOTAL", 420, y + 4, { width: 120, align: "right" });
      doc.text(money(amount), 530, y + 4, { width: 60, align: "right" });
      y += 28;
      doc.font("Helvetica").fontSize(10).fillColor("#4a5a52");
      doc.text("TOTAL FEES", 420, y, { width: 120, align: "right" });
      doc.text(money(totalFees), 530, y, { width: 60, align: "right" });
      y += 18;
      doc.text("PAID TO DATE", 420, y, { width: 120, align: "right" });
      doc.text(money(paidToDate), 530, y, { width: 60, align: "right" });
      y += 18;
      doc.fillColor("#4a5a52");
      doc.text("REMAINING BALANCE", 420, y, { width: 120, align: "right" });
      doc.text(money(balance), 530, y, { width: 60, align: "right" });

      // Notes
      y += 30;
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#4a5a52").text("Notes", 50, y);
      doc.font("Helvetica").fontSize(9).fillColor("#4a5a52").text(
        `Thank you for your payment. This receipt confirms ${balance > 0 ? "part payment" : "full settlement"}. The remaining balance is shown above.`,
        50, y + 14, { width: 495 }
      );

      // Footer
      doc.font("Helvetica-Bold").fontSize(20).fillColor("#4a5a52").text("THANK YOU", 50, y + 80, { align: "center" });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
};

export default { generateReceiptPdf, normaliseBreakdown, receiptFilename };
