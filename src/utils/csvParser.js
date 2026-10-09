import { parse } from "csv-parse";
import * as XLSX from "xlsx";

/**
 * Parse a CSV buffer into an array of row objects.
 * Headers become the object keys (case-preserved as-is from the file).
 */
export const parseCsv = (buffer) =>
  new Promise((resolve, reject) => {
    const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
    // Strip UTF-8 BOM if present (common when exporting from Excel on Windows)
    const cleanText = text.startsWith("\uFEFF") ? text.slice(1) : text;
    parse(
      cleanText,
      {
        columns: true,
        trim: true,
        skip_empty_lines: true,
        bom: true,
      },
      (error, records) => (error ? reject(error) : resolve(records))
    );
  });

/**
 * Parse an Excel (.xlsx/.xls) buffer into an array of row objects.
 * `raw: false` keeps values as strings so we control date/number coercion
 * ourselves (the file is authored by humans).
 */
export const parseExcel = (buffer) => {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const worksheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(worksheet, { raw: false, defval: "" });
};

const EXCEL_MIMETYPES = [
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export const isExcelFile = (mimetype) =>
  Boolean(mimetype) && EXCEL_MIMETYPES.includes(mimetype);

export const isCsvFile = (mimetype, originalName) =>
  Boolean(mimetype?.includes("csv")) ||
  Boolean(mimetype?.includes("text")) ||
  (originalName || "").toLowerCase().endsWith(".csv");

/**
 * Dispatch CSV vs Excel parsing based on the uploaded file's mimetype/name.
 * Returns { rows: object[], format: "csv" | "xlsx" }.
 *
 * Asynchronous because CSV parsing (csv-parse) is stream/callback based.
 */
export const parseImportFile = async (buffer, mimetype, originalName) => {
  if (isExcelFile(mimetype) || (originalName || "").endsWith(".xlsx") || (originalName || "").endsWith(".xls")) {
    return { rows: parseExcel(buffer), format: "xlsx" };
  }
  return { rows: await parseCsv(buffer), format: "csv" };
};
