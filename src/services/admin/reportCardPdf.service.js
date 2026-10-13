import PDFDocument from "pdfkit";
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_UPLOAD_FOLDER } from "../../config/env.js";
import { cloudinary } from "../../utils/cloudinary.js";

/**
 * Report-card PDF — the missing half of the parent "Download report card" link.
 *
 * Until now a published card carried `pdfUrl: null` and the parent route
 * (`controllers/parent/parent.controller.js`) fetched that null URL and answered
 * 404 on every download. This renders the one artefact the parent asked for and
 * (best-effort) uploads it so the stored URL resolves.
 *
 * Deliberately a hand-laid-out page rather than the `utils/reportPdf.js`
 * table serialiser: a report card is a fixed document, not an arbitrary
 * column-shaped export, and the parent already has a download-shaped answer
 * that streams the stored bytes. The CSV/PDF trio stays as it is; this is the
 * per-student card.
 */

const isCloudinaryConfigured = () =>
  Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);

const UPLOAD_TIMEOUT_MS = 20000;

const uploadWithTimeout = (promise, timeoutMs = UPLOAD_TIMEOUT_MS) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Cloudinary upload timed out")), timeoutMs)
    ),
  ]);

/**
 * Render one published card to a PDF buffer.
 *
 * Defensive by construction: a student with no remarks, an empty subject row or
 * a missing conduct still produces a valid single page, because every field is
 * written only when it carries a value. A half-empty report is a normal state
 * mid-term; a crash on it would take the whole publish down.
 */
export const generateReportCardPdf = (card, { school, student }) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const contentWidth = doc.page.width - 96;

    // ── Header ──
    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor("#0f172a")
      .text(school?.name || school?.schoolName || "School", { align: "center" });
    doc
      .moveDown(0.2)
      .font("Helvetica")
      .fontSize(11)
      .fillColor("#475569")
      .text(`Terminal Report — ${card.term || ""} ${card.academicYear || ""}`, {
        align: "center",
      });
    doc.moveDown(0.6);

    doc
      .moveTo(48, doc.y)
      .lineTo(doc.page.width - 48, doc.y)
      .strokeColor("#e2e8f0")
      .stroke();
    doc.moveDown(0.6);

    // ── Identity block ──
    const identity = [
      ["Student", student?.studentName || "—", "Class", card.className || "—"],
      [
        "Student ID",
        student?.studentId || "—",
        "Average",
        `${card.average ?? 0}%  (${card.grade || "—"})`,
      ],
      [
        "Position",
        card.position != null && card.classSize
          ? `${card.position} of ${card.classSize}`
          : "—",
        "Attendance",
        card.attendance?.total
          ? `${card.attendance.present} of ${card.attendance.total}`
          : "—",
      ],
    ];
    for (const [l1, v1, l2, v2] of identity) {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#334155").text(l1, 48, y, { width: 80 });
      doc.font("Helvetica").fontSize(10).fillColor("#0f172a").text(String(v1), 128, y, { width: 180 });
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#334155").text(l2, 320, y, { width: 80 });
      doc.font("Helvetica").fontSize(10).fillColor("#0f172a").text(String(v2), 400, y, { width: contentWidth - 352 });
      doc.moveDown(0.5);
    }
    doc.moveDown(0.4);

    // ── Subjects table ──
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a").text("Subjects");
    doc.moveDown(0.3);

    const cols = [
      { label: "Subject", x: 48, w: contentWidth - 200, align: "left" },
      { label: "Score", x: doc.page.width - 48 - 160, w: 70, align: "right" },
      { label: "Max", x: doc.page.width - 48 - 84, w: 40, align: "right" },
      { label: "Grade", x: doc.page.width - 48 - 40, w: 40, align: "right" },
    ];

    const tableTop = doc.y;
    doc.save().rect(48, tableTop, contentWidth, 18).fill("#f1f5f9").restore();
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
    for (const c of cols) doc.text(c.label, c.x, tableTop + 5, { width: c.w, align: c.align });
    doc.moveDown(0.4);

    let y = doc.y;
    doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
    for (const s of card.subjects || []) {
      if (y > doc.page.height - 140) {
        doc.addPage();
        y = 48;
      }
      const score = `${s.score ?? 0} / ${s.maxScore ?? 100}`;
      doc.text(s.subject || "—", 48, y, { width: contentWidth - 200 });
      doc.text(String(s.grade || "—"), doc.page.width - 48 - 40, y, { width: 40, align: "right" });
      doc.text(String(s.maxScore ?? 100), doc.page.width - 48 - 84, y, { width: 40, align: "right" });
      doc.text(String(s.score ?? 0), doc.page.width - 48 - 160, y, { width: 70, align: "right" });
      y += 15;
      doc.moveTo(48, y - 4).lineTo(doc.page.width - 48, y - 4).strokeColor("#eef2f6").stroke();
    }

    // ── Remarks ──
    doc.y = y + 8;
    if (card.teacherRemark?.text) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#334155").text("Class teacher's remark");
      doc.font("Helvetica").fontSize(9).fillColor("#0f172a").text(card.teacherRemark.text);
      doc.moveDown(0.4);
    }
    if (card.headRemark?.text) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#334155").text("Head teacher's remark");
      doc.font("Helvetica").fontSize(9).fillColor("#0f172a").text(card.headRemark.text);
      doc.moveDown(0.4);
    }
    if (card.conduct) {
      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .fillColor("#334155")
        .text(`Conduct / interest: ${card.conduct}`);
    }

    // ── Footer ──
    doc
      .moveDown(1)
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#94a3b8")
      .text(
        card.publishedAt
          ? `Published ${new Date(card.publishedAt).toISOString().slice(0, 10)}`
          : "Draft",
        { align: "center" }
      );

    doc.end();
  });
};

/**
 * Upload a rendered card to Cloudinary as a raw asset.
 *
 * `resource_type: "raw"` is what keeps the PDF byte-for-byte rather than letting
 * Cloudinary treat it as an image and rasterise the first page — the parent
 * route streams these bytes straight back. Best-effort: the caller wraps this so
 * a missing or failing Cloudinary config never fails a publish.
 */
export const uploadReportCardPdf = async (buffer, { student, term, academicYear }) => {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Report card PDF buffer is empty");
  }
  if (!isCloudinaryConfigured()) {
    throw new Error("Cloudinary is not configured");
  }

  const publicId = `report-card-${student?.studentId || "student"}-${String(
    term || "term"
  )
    .replace(/\s/g, "")
    .toLowerCase()}-${String(academicYear || "").replace(/\//g, "")}-${Date.now()}`;

  const result = await uploadWithTimeout(
    new Promise((resolve, reject) => {
      cloudinary.v2.uploader.upload(
        `data:application/pdf;base64,${buffer.toString("base64")}`,
        {
          folder: CLOUDINARY_UPLOAD_FOLDER,
          public_id: publicId,
          resource_type: "raw",
          type: "upload",
          overwrite: true,
        },
        (error, res) => (error ? reject(error) : resolve(res))
      );
    })
  );

  return { url: result.secure_url, publicId: result.public_id };
};
