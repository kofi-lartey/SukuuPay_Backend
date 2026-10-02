import XLSX from "xlsx";
import { pdfFor } from "./reportPdf.js";

// ─────────────────────────────────────────────
// Report file serialisers (csv / excel / pdf)
// ─────────────────────────────────────────────
// A report is built once in the service layer and serialised here, so the file
// a user downloads always contains exactly the rows they saw on screen.
//
// **PDF is supported**, via `utils/reportPdf.js`. It was not for most of this
// project's life, and the 501 it used to throw was correct at the time: `pdfkit` is
// a dependency but `utils/pdfGenerator.js` renders ID cards from a fixed template,
// not tables of arbitrary columns, and a report's columns are not a shape anybody
// designed in advance. `reportPdf.js` is that second path — it derives column
// widths from the content and paginates.
//
// The stale version of this comment claimed no PDF library was a dependency. There
// was one; there just was no code path from a report to it.

// Spreadsheet apps treat a leading =, +, -, @, tab or CR as a formula, so a
// user-supplied cell value (a description, a parent name) is prefixed to keep
// it inert rather than executed when the export is opened.
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

const escapeCsvCell = (value) => {
  if (value === null || value === undefined) return "";
  let str = value instanceof Date ? value.toISOString() : String(value);
  if (str.length && FORMULA_PREFIXES.includes(str[0])) str = `'${str}`;
  if (/[",\n\r]/.test(str)) str = `"${str.replace(/"/g, '""')}"`;
  return str;
};

const csvFor = (sections) =>
  sections
    .map((section) => {
      const keys = section.columns.map((c) => c.key);
      const header = [section.title, ...keys]
        .map(escapeCsvCell)
        .join(",");
      const body = section.rows
        .map((row) =>
          [section.title, ...keys.map((k) => row[k])].map(escapeCsvCell).join(",")
        )
        .join("\n");
      return `${header}\n${body}`;
    })
    .join("\n\n");

const workbookFor = (sections) => {
  const workbook = XLSX.utils.book_new();
  for (const section of sections) {
    const keys = section.columns.map((c) => c.key);
    const headerRow = section.columns.map((c) => c.header);
    const dataRows = section.rows.map((row) => keys.map((k) => row[k] ?? ""));
    const worksheet = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
    worksheet["!cols"] = section.columns.map((c) => ({
      wch: c.width || Math.max(c.header.length + 2, 12),
    }));
    XLSX.utils.book_append_sheet(workbook, worksheet, section.name.slice(0, 31));
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
};

const timestampFor = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

const fail = (status, code, message) => {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
};

/**
 * Sends a report as a file download. `sections` mirrors the report's
 * structure: the summary block first, then the detail rows, then any
 * report-specific sections such as the term report's monthly trend.
 *
 * **`format=excel` is the name, not `xlsx`.** Deliberate and load-bearing:
 * `sendReportFile` rejects anything it does not recognise with
 * `UNSUPPORTED_FORMAT`, so a caller sending `xlsx` — the extension, which is what
 * every frontend naturally reaches for — gets a 400 for asking the same thing in a
 * different word. The callers translate.
 *
 * PDF is **asynchronous** where the other two are synchronous, because `pdfkit`
 * streams: the buffer only exists once the document has ended. That is why this
 * function is `async` and why a `csv` call still returns its string directly — a
 * caller that forgot to await a `csv` gets its file either way, and one that
 * mistakenly awaits gets the same. The asymmetry is unavoidable, and the comment is
 * here so it is not mistaken for an accident.
 */
export const sendReportFile = async (res, { report, schoolId, format, sections }) => {
  const base = `${report}-${schoolId}-${timestampFor()}`;

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
    return res.send(csvFor(sections));
  }

  if (format === "excel") {
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${base}.xlsx"`);
    return res.send(workbookFor(sections));
  }

  if (format === "pdf") {
    const buffer = await pdfFor(sections, {
      title: `${report} — ${schoolId}`,
      subtitle: `Generated ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.pdf"`);
    return res.send(buffer);
  }

  throw fail(400, "UNSUPPORTED_FORMAT", `Unsupported report format: ${format}`);
};

export { escapeCsvCell, csvFor, workbookFor };
