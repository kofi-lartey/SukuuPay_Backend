import PDFDocument from "pdfkit";

// ─────────────────────────────────────────────
// Report → PDF (table serialiser)
// ─────────────────────────────────────────────
// A second PDF path from `generatePdfFromTemplate`, which lays out ID cards from a
// fixed template. This one is the opposite problem: an arbitrary, column-shaped
// report whose width nobody designed in advance. So it measures the page, derives
// column widths from the content, and paginates — rather than assuming anything
// about the report.
//
// Everything here is derived from `sections`, the same array `csvFor` and
// `workbookFor` consume. That is deliberate: a report is built once in the service
// layer and serialised three ways, so the file a user downloads always contains
// exactly the rows they saw on screen. A fourth path that re-derived the rows would
// be able to disagree with the other three.

const PAGE_MARGIN = 40;
const FONT_SIZE = 7;
const HEADER_FONT_SIZE = 7.5;
const ROW_PADDING = 4;
const MAX_ROWS = 5000;

/**
 * Column widths as proportions of the printable width.
 *
 * Proportional rather than measured in characters because `pdfkit` has no text
 * measurement without a font — and a report's columns are not equally
 * informative. A `schoolName` at 40% and five numeric columns sharing the other 60%
 * is roughly right for every report this console produces; equal-width columns are
 * right for none of them, because a ced i column needs a fifth of the space a name
 * does and renders as `########` otherwise.
 *
 * Capped so one long text column cannot squeeze every numeric one below
 * legibility. `MIN_SHARE` is what stops that: a report with one wide description
 * column would otherwise divide the remainder into slivers.
 */
const MIN_SHARE = 0.06;

const weightFor = (key, header) => {
  const key3 = String(key || "").toLowerCase();
  const header3 = String(header || "").toLowerCase();

  // Money gets a fixed, narrow width. It is the column a reader scans, and it is
  // right-aligned, so the digits must line up rather than each sharing the page.
  if (/(amount|revenue|fee|total|owe|paid|cost|value|balance|price)/.test(key3 + header3)) {
    return 1.15;
  }
  // Dates are long and never need truncating in practice.
  if (/(date|at|period|start|end)/.test(key3) && !/(updated|created)/.test(key3)) return 0.95;
  // Identifiers are long and are fine to truncate — the reader recognises the prefix.
  if (/(id|code|reference|receipt|invoice|phone|email)/.test(key3)) return 1.3;
  // Names, labels and free text.
  return 1.6;
};

const proportionFor = (sections) => {
  const first = sections.find((s) => s.columns?.length);
  if (!first) return [];

  const weights = first.columns.map((c) => weightFor(c.key, c.header));
  const total = weights.reduce((a, b) => a + b, 0) || 1;

  return weights.map((w) => Math.max(MIN_SHARE, w / total));
};

const fmtCell = (value) => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

/**
 * Truncate to fit a column, with an ellipsis.
 *
 * `pdfkit` does not wrap inside a table cell and will happily run text past the page
 * edge, producing a row that is silently unreadable on the right. Truncating with an
 * ellipsis is worse than wrapping only in the sense that the last characters are
 * lost — and it is what a spreadsheet export looks like anyway, so the two formats
 * agree about what the reader sees.
 */
const fit = (text, width, doc, fontSize) => {
  if (doc.widthOfString(text, { size: fontSize }) <= width) return text;
  let cut = text.length;
  while (cut > 1 && doc.widthOfString(`${text.slice(0, cut)}…`, { size: fontSize }) > width) {
    cut -= 1;
  }
  return `${text.slice(0, cut)}…`;
};

/**
 * Render `sections` into a PDF buffer.
 *
 * Bounded by `MAX_ROWS` for the same reason the CSV exports are: an unbounded
 * report is a multi-hundred-megabyte stream and a hung request, and this is a
 * document a person reads rather than a dataset they load. The truncation is stated
 * on the page, because a report that quietly stops at 5,000 rows reads as a complete
 * one.
 */
export const pdfFor = (sections, { title = "Report", subtitle = "" } = {}) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: PAGE_MARGIN });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const contentWidth = doc.page.width - PAGE_MARGIN * 2;
    const proportions = proportionFor(sections);

    doc.font("Helvetica-Bold").fontSize(13).text(title, { align: "left" });
    if (subtitle) {
      doc.moveDown(0.2).font("Helvetica").fontSize(8).fillColor("#555555").text(subtitle);
    }
    doc.moveDown(0.6);

    let totalRows = 0;
    let truncated = false;

    for (const section of sections) {
      const columns = section.columns || [];
      if (!columns.length) continue;

      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000000").text(section.title || "");
      doc.moveDown(0.3);

      const widths = proportions.length === columns.length
        ? proportions.map((p) => p * contentWidth)
        : columns.map(() => contentWidth / columns.length);

      const money = columns.map((c) =>
        /(amount|revenue|fee|total|owe|paid|cost|value|balance|price)/.test(
          String(c.key || "").toLowerCase() + String(c.header || "").toLowerCase()
        )
      );

      const drawRow = (cells, isHeader) => {
        const fontSize = isHeader ? HEADER_FONT_SIZE : FONT_SIZE;
        const height =
          Math.max(
            fontSize + ROW_PADDING,
            ...cells.map((cell, i) => doc.heightOfString(fit(cell, widths[i] - 6, doc, fontSize), { size: fontSize }) + ROW_PADDING)
          ) + 2;

        if (doc.y + height > doc.page.height - PAGE_MARGIN) {
          doc.addPage();
        }

        const top = doc.y;
        let x = PAGE_MARGIN;

        if (isHeader) {
          doc
            .save()
            .rect(PAGE_MARGIN, top, contentWidth, height)
            .fill("#f1f5f9")
            .restore();
        }

        cells.forEach((cell, i) => {
          doc
            .font(isHeader ? "Helvetica-Bold" : "Helvetica")
            .fontSize(fontSize)
            .fillColor("#0f172a")
            .text(fit(cell, widths[i] - 6, doc, fontSize), x + 3, top + ROW_PADDING / 2, {
              width: widths[i] - 6,
              // Money right-aligned so the digits form a column a reader can scan
              // vertically; everything else left. This is the only reason the export
              // is legible at 7pt.
              align: money[i] ? "right" : "left",
              lineBreak: false,
              ellipsis: true,
            });
          x += widths[i];
        });

        doc.y = top + height;
        doc.x = PAGE_MARGIN;
      };

      drawRow(columns.map((c) => String(c.header || c.key || "")), true);

      const rows = section.rows || [];
      const shown = Math.min(rows.length, Math.max(0, MAX_ROWS - totalRows));
      if (shown < rows.length) truncated = true;

      for (let i = 0; i < shown; i += 1) {
        drawRow(columns.map((c) => fmtCell(rows[i][c.key])), false);
        totalRows += 1;
      }

      doc.moveDown(0.7);
    }

    if (truncated) {
      doc
        .moveDown(0.3)
        .font("Helvetica-Bold")
        .fontSize(7.5)
        .fillColor("#b45309")
        .text(
          `NOTE: this report was truncated at ${MAX_ROWS} rows. Narrow the date range to see the rest.`,
          PAGE_MARGIN,
          doc.y,
          { width: contentWidth }
        );
    }

    doc.end();
  });
};

export { pdfFor as default, MAX_ROWS as PDF_REPORT_ROW_CAP };