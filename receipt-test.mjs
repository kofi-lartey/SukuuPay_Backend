import { generateReceiptPdf } from "./src/utils/receiptService.js";
import fs from "fs";
import path from "path";
import zlib from "zlib";

const OUT = "/tmp/receipt-test.pdf";

const payment = {
  receiptNumber: "RCP-MAN-1793094553369",
  paymentId: "PAY-TEST",
  amount: 85000,
  totalFees: 85000,
  paidToDate: 170000,
  paymentMethod: "cash",
  completedAt: "2026-10-27T10:42:00.000Z",
  feesBreakdown: [{ label: "School Fee", amount: 85000 }],
};

const student = {
  studentName: "Abena Ampofo",
  studentId: "PBD001-2026-0065",
  studentClass: "JHS 1A",
  balance: -85000,
  totalOwed: 85000,
  totalPaid: 170000,
};

const school = {
  name: "Prampram Bole D/A",
  address: "Prampram- Mandela",
  city: "PR/MD/057",
  region: "Greater Accra",
  logo: null,
};

// ---- build CID->unicode maps from each font's ToUnicode stream ----
function buildCidMaps(pdf) {
  const s = pdf.toString("latin1");
  const cidMaps = {}; // fontNameRef (e.g. "8") -> Map<cid, unicode>

  // font objects: /Type /Font ... /BaseFont ... /ToUnicode N 0 R
  const fontObjRe = /(\d+) 0 obj\n<<([\s\S]*?)\n>>\nendobj/g;
  let fm;
  while ((fm = fontObjRe.exec(s)) !== null) {
    const objId = fm[1];
    const body = fm[2];
    const isFont = /\/Type\s*\/Font/.test(body);
    if (!isFont) continue;
    const tuMatch = body.match(/\/ToUnicode\s*(\d+)\s*0 R/);
    if (!tuMatch) continue;
    const tuId = tuMatch[1];

    // find the ToUnicode object stream
    const tuRe = new RegExp(tuId + ` 0 obj\\n<<[\\s\\S]*?>>\\nstream\\n([\\s\\S]*?)\\nendstream`);
    const tum = s.match(tuRe);
    if (!tum) continue;
    try {
      const dec = zlib.inflateSync(Buffer.from(tum[1], "latin1")).toString("utf8");
      const map = new Map();
      // parse beginbfrange: <start> <end> [ <uni> <uni> ... ]
      const brRe = /beginbfrange([\s\S]*?)endbfrange/g;
      let bm;
      while ((bm = brRe.exec(dec)) !== null) {
        const block = bm[1];
        const range = block.match(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4})>\s*\[([\s\S]*?)\]/);
        if (!range) continue;
        const start = parseInt(range[1], 16);
        const end = parseInt(range[2], 16);
        const unis = range[3].match(/<([0-9A-Fa-f]{4})>/g).map((h) => parseInt(h.slice(1, -1), 16));
        for (let i = 0; i <= end - start; i++) {
          if (unis[i] !== undefined) map.set(start + i, unis[i]);
        }
      }
      cidMaps[objId] = map;
    } catch {
      // ignore
    }
  }
  return cidMaps;
}

// map resource font name (F2, F3...) -> obj id, from /Resources /Font
function buildFontRefs(pdf) {
  const s = pdf.toString("latin1");
  const refs = {};
  const fontRe = /\/Font\s*<<([\s\S]*?)>>\s*\n\/ExtGState/;
  const m = s.match(fontRe);
  if (!m) return refs;
  const inner = m[1];
  const pairRe = /\/F(\d+)\s*(\d+)\s*0 R/g;
  let pm;
  while ((pm = pairRe.exec(inner)) !== null) {
    refs["F" + pm[1]] = pm[2];
  }
  return refs;
}

function hexToCids(hex) {
  const cids = [];
  for (let i = 0; i + 3 < hex.length; i += 4) {
    cids.push(parseInt(hex.slice(i, i + 4), 16));
  }
  return cids;
}

function extractText(pdf, cidMaps, fontRefs) {
  const s = pdf.toString("latin1");
  // find all content streams and decompress
  const streamRe = /(\d+) 0 obj\n<<([\s\S]*?)\n>>\nstream\n([\s\S]*?)\nendstream/g;
  const parts = [];
  let sm;
  while ((sm = streamRe.exec(s)) !== null) {
    const body = sm[2];
    const compressed = sm[3];
    const isFlate = /\/Filter\s*\/\s*FlateDecode/.test(body);
    let dec;
    try {
      dec = isFlate ? zlib.inflateSync(Buffer.from(compressed, "latin1")).toString("utf8") : compressed;
    } catch {
      continue;
    }
    // only process streams that contain text-showing operators
    if (!/Tj|TJ/.test(dec)) continue;

    let currentFont = null;
    let out = "";
    // tokenize: Tf font ops and TJ arrays
    const lines = dec.split(/[\r\n]+/);
    for (const line of lines) {
      const tf = line.match(/\/F(\d+)\s+\d+(\.\d+)?\s*Tf/);
      if (tf) {
        const objId = fontRefs["F" + tf[1]];
        currentFont = objId ? cidMaps[objId] : null;
        continue;
      }
      const tjMatch = line.match(/\[([\s\S]*?)\]\s*TJ/);
      if (tjMatch && currentFont) {
        const arr = tjMatch[1];
        const hexes = arr.match(/<([0-9A-Fa-f]+)>/g);
        if (hexes) {
          for (const h of hexes) {
            const inner = h.slice(1, -1);
            const cids = hexToCids(inner);
            for (const cid of cids) {
              const u = currentFont.get(cid);
              out += u !== undefined ? String.fromCodePoint(u) : "";
            }
          }
        }
      }
    }
    if (out) parts.push(out);
  }
  return parts.join("\n");
}

async function main() {
  const pdfBytes = await generateReceiptPdf(payment, { student, school });

  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, pdfBytes);

  const size = pdfBytes.length;
  const startsWithPDF = Buffer.from(pdfBytes.slice(0, 5)).toString("latin1") === "%PDF-";

  const cidMaps = buildCidMaps(pdfBytes);
  const fontRefs = buildFontRefs(pdfBytes);
  const text = extractText(pdfBytes, cidMaps, fontRefs);

  const targets = ["OUTSTANDING BALANCE", "GH₵ -850.00", "Powered by SukuuPay"];
  const results = {};
  for (const t of targets) results[t] = text.includes(t);

  console.log("FILE:", OUT);
  console.log("SIZE_BYTES:", size);
  console.log("SIZE_ABOVE_500:", size > 500);
  console.log("STARTS_WITH_PDF:", startsWithPDF);
  console.log("TARGETS_FOUND:", JSON.stringify(results));
  console.log("--- extracted text ---");
  console.log(text);
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
