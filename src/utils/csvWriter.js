/**
 * Minimal CSV streaming writer.
 *
 * `streamCsv` writes a header row followed by data rows directly to the
 * Express `res` stream.  It is used by the Audit Log export and the QR-links
 * export endpoints so large result sets are sent without buffering the entire
 * file in memory.
 *
 * Formula injection is mitigated by prefixing any cell whose first character
 * is =, +, -, @, \t, or \r with a single quote, matching the strategy in
 * `utils/reportExport.js`.
 */

const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

const escapeCsvCell = (value) => {
  if (value === null || value === undefined) return "";
  let str = value instanceof Date ? value.toISOString() : String(value);
  if (str.length && FORMULA_PREFIXES.includes(str[0])) str = `'${str}`;
  if (/[",\n\r]/.test(str)) str = `"${str.replace(/"/g, '""')}"`;
  return str;
};

/**
 * @param {import('express').Response} res
 * @param {Array<{key:string, header:string}>} columns  e.g. [{ key: "action", header: "Action" }]
 * @param {Array<object>} rows
 */
export const streamCsv = (res, columns, rows) => {
  const headers = columns.map((c) => c.header).map(escapeCsvCell).join(",");
  res.write(`${headers}\n`);

  for (const row of rows) {
    const line = columns
      .map((c) => escapeCsvCell(row[c.key] !== undefined ? row[c.key] : ""))
      .join(",");
    res.write(`${line}\n`);
  }

  res.end();
};

export default { streamCsv };
