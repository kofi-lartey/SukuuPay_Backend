import XLSX from "xlsx";

// ─────────────────────────────────────────────
// Report file serialisers (csv / excel / pdf)
// ─────────────────────────────────────────────
// A report is built once in the service layer and serialised here, so the file
// a user downloads always contains exactly the rows they saw on screen.
//
// PDF is not yet supported: no PDF library is a dependency of this project
// (package.json). `format=pdf` is validated as a legal value and the branch
// throws a clear 501 rather than silently returning the wrong file type. See
// docs/reports-api-spec.md §2.

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
 */
export const sendReportFile = (res, { report, schoolId, format, sections }) => {
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
    throw fail(
      501,
      "PDF_EXPORT_UNAVAILABLE",
      "PDF export is not yet available. Use format=csv or format=excel, or add a PDF dependency (e.g. pdfkit)."
    );
  }

  throw fail(400, "UNSUPPORTED_FORMAT", `Unsupported report format: ${format}`);
};

export { escapeCsvCell, csvFor, workbookFor };
