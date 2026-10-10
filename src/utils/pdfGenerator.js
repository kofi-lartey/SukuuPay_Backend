import PDFDocument from "pdfkit";

/**
 * Generates a PDF from template data using pdfkit.
 *
 * `template` is a string name (e.g. "idCard") used to select the layout.
 * `data` carries either `{ pages: [...] }` (multi-page) or a single page object.
 *
 * Each page object fields:
 *   schoolName, schoolLogo, schoolStamp, brandColor,
 *   studentName, studentClass, studentId, studentImage,
 *   payLink, qrCodeUrl, emergencyContact
 *
 * Images referenced by URL are fetched and embedded into the PDF.
 */
export const generatePdfFromTemplate = async (template, data) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pages = Array.isArray(data?.pages) ? data.pages : [data];

    const renderNext = async (index) => {
      if (index >= pages.length) {
        doc.end();
        return;
      }

      const pageData = pages[index];
      doc.addPage({ size: "A4", margin: 40 });

      try {
        await renderPage(doc, pageData);
      } catch (renderError) {
        // Do not let a single bad image block the whole batch; render
        // remaining pages and embed an error note instead.
        doc
          .fillColor("#ef4444")
          .fontSize(8)
          .text(`[image failed: ${renderError.message}]`, { align: "center" });
      }

      // Defer to the next tick so the stream can flush between pages,
      // keeping memory bounded for large batches.
      setImmediate(() => renderNext(index + 1));
    };

    setImmediate(() => renderNext(0));
  });
};

const renderPage = async (doc, pageData) => {
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 40;

  // Background border
  // Neutral charcoal, not the navy the template used to carry: ID cards are
  // monochrome now, so a blue border here is a blue credential.
  doc
    .rect(margin, margin, pageWidth - margin * 2, pageHeight - margin * 2)
    .lineWidth(2)
    .strokeColor("#0F172A")
    .stroke();

  // School logo (top-left)
  if (pageData.schoolLogo) {
    const logoImg = await fetchImage(pageData.schoolLogo);
    if (logoImg) {
      doc
        .image(logoImg, margin + 10, margin + 10, { width: 40, height: 40 });
    }
  }

  // School name (centered header)
  doc
    .fontSize(16)
    .font("Helvetica-Bold")
    .fillColor("#111827")
    .text(pageData.schoolName || "Sukuupay School", margin, margin + 60, {
      align: "center",
      width: pageWidth - margin * 2,
    });

  doc
    .fontSize(12)
    .font("Helvetica")
    .fillColor("#6b7280")
    .text("Student ID Card", margin, doc.y, {
      align: "center",
      width: pageWidth - margin * 2,
    });

  doc.moveDown(3);

  // Student photo (left)
  const bodyTop = doc.y;
  if (pageData.studentImage) {
    const photoImg = await fetchImage(pageData.studentImage);
    if (photoImg) {
      doc
        .image(photoImg, margin + 10, bodyTop, { width: 90, height: 90 });
    }
  }

  // Student info (right of photo)
  const infoX = margin + 110;
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#111827")
    .text(`Student ID: ${pageData.studentId || ""}`, infoX, bodyTop)
    .text(`Name: ${pageData.studentName || ""}`, infoX, doc.y + 4)
    .text(`Class: ${pageData.studentClass || ""}`, infoX, doc.y + 4)
    .text(
      `Emergency: ${pageData.emergencyContact || "N/A"}`,
      infoX,
      doc.y + 4
    );

  doc.moveDown(4);

  // QR code (bottom-right)
  if (pageData.qrCodeUrl) {
    const qrImg = await fetchImage(pageData.qrCodeUrl);
    if (qrImg) {
      doc
        .image(qrImg, pageWidth - margin - 80, doc.y, { width: 70, height: 70 });
    }
  }

  // Footer
  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor("#9ca3af")
    .text("Scan QR code to pay school fees securely", pageWidth / 2, pageHeight - 30, {
      align: "center",
      width: pageWidth - margin * 2,
    });
};

// Fetches an image as a Buffer.  Supports HTTP(S) URLs and data: URLs.
const fetchImage = async (url) => {
  if (!url || typeof url !== "string") return null;

  if (url.startsWith("data:")) {
    // data:image/png;base64,...
    const matches = url.match(/^data:([a-zA-Z]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!matches) return null;
    return Buffer.from(matches[2], "base64");
  }

  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error("[PDF] Failed to fetch image:", url, error.message);
    return null;
  }
};

export default { generatePdfFromTemplate };
