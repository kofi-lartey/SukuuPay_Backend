import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { install } from "@puppeteer/browsers";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const COMMON_CHROME_PATHS =
  process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
      ];

const getChromeExecutablePath = async () => {
  for (const env of [
    "PUPPETEER_EXECUTABLE_PATH",
    "CHROME_PATH",
    "GOOGLE_CHROME_BIN",
    "CHROME_EXECUTABLE",
  ]) {
    const value = process.env[env];
    if (value && fs.existsSync(value)) return value;
  }
  for (const candidate of COMMON_CHROME_PATHS) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }

  const { executablePath } = await install({
    browser: "chrome",
    buildId: "latest",
  });
  return executablePath;
};

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

const money = (value) => `GH₵ ${((Number(value) || 0) / 100).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${receiptRef}</title><style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Century Gothic", "Futura", "Segoe UI", Arial, sans-serif; color: #4a5a52; background: #fff; }
  .page { width: 210mm; min-height: 297mm; padding: 18mm 16mm; position: relative; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; }
  h1 { font-size: 52px; font-weight: 300; letter-spacing: 8px; margin: 0; }
  .logo { width: 80px; height: 80px; border-radius: 50%; background: #c9dcc4; display: flex; align-items: center; justify-content: center; font-size: 11px; overflow: hidden; }
  .logo img { width: 100%; height: 100%; object-fit: cover; }
  .bar { background: #c9dcc4; display: flex; justify-content: space-between; padding: 5px 8px; margin: 22px 0 18px; font-size: 11px; letter-spacing: 1px; }
  .bar b { font-weight: 700; }
  .cols { display: flex; gap: 24px; font-size: 12px; line-height: 1.7; }
  .cols > div { flex: 1; }
  .cols h4 { margin: 0 0 4px; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; }
  .muted { opacity: .8; }
  .pm span { display: block; padding-left: 16px; position: relative; }
  .pm span.on::before { content: "X"; position: absolute; left: 0; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin-top: 26px; font-size: 12px; }
  thead th { text-align: left; font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; padding: 8px 6px; border-top: 3px solid #c9dcc4; border-bottom: 3px solid #c9dcc4; }
  td { padding: 10px 6px; border-bottom: 1px solid #c9dcc4; }
  .c-no { width: 8%; }
  .c-num, th.c-num { text-align: right; }
  .totals { margin: 18px 0 0 auto; width: 60%; font-size: 12px; }
  .totals div { display: flex; justify-content: space-between; padding: 4px 8px; }
  .totals .grand { background: #c9dcc4; font-weight: 700; letter-spacing: 1px; }
  .totals .balance { background: #4a5a52; color: #fff; font-weight: 700; letter-spacing: 1px; margin-top: 6px; }
  .notes { margin-top: 26px; font-size: 11.5px; line-height: 1.6; }
  .thanks { text-align: center; letter-spacing: 5px; font-size: 20px; margin-top: 50px; }
  @media print { .page { box-shadow: none; } }
  </style></head><body><div class="page">
  <div class="head"><h1>RECEIPT</h1>${school?.logo ? `<div class="logo"><img src="${school.logo}" alt="logo" /></div>` : '<div class="logo">LOGO</div>'}</div>
  <div class="bar"><span><b>RECEIPT REF.</b> ${receiptRef}</span><span><b>DATE:</b> ${dateStr}</span></div>
  <div class="cols">
    <div><h4>${schoolName}</h4><div class="muted">${schoolAddress}</div></div>
    <div><h4>Paid To</h4><div>${studentName}</div><div class="muted">ID: ${studentId} • ${className}</div></div>
    <div class="pm"><h4>Payment Method</h4><span class="on">${method}</span><span>Cash</span><span>Bank Transfer</span><span>Other</span></div>
  </div>
  <table><thead><tr><th>No.</th><th>Description</th><th class="c-num">Qty</th><th class="c-num">Price</th><th class="c-num">Total</th></tr></thead><tbody>
  <tr><td class="c-no">1</td><td>${description}</td><td class="c-num">1</td><td class="c-num">${money(amount)}</td><td class="c-num">${money(amount)}</td></tr>
  </tbody></table>
  <div class="totals">
    <div><span>SUB TOTAL</span><span>${money(amount)}</span></div>
    <div><span>TAX / DISCOUNT</span><span>GH₵ 0.00</span></div>
    <div class="grand"><span>GRAND TOTAL</span><span>${money(amount)}</span></div>
    <div><span>TOTAL FEES</span><span>${money(totalFees)}</span></div>
    <div><span>PAID TO DATE</span><span>${money(paidToDate)}</span></div>
    <div class="balance"><span>REMAINING BALANCE</span><span>${money(balance)}</span></div>
  </div>
  <div class="notes"><b>Notes</b><br>Thank you for your payment. This receipt confirms ${balance > 0 ? "part payment" : "full settlement"}. The remaining balance is shown above.</div>
  <div class="thanks">THANK YOU</div>
</div></body></html>`;

  const executablePath = await getChromeExecutablePath();
  const browser = await puppeteer.launch({ headless: "new", executablePath });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  await browser.close();
  // Puppeteer resolves `page.pdf()` to a `Uint8Array`, but Brevo's attachment
  // boundary requires a `Buffer` (or base64 string). Coerce it here so every
  // caller — download, email, WhatsApp — receives a real Buffer.
  return Buffer.from(pdf);
};

export default { generateReceiptPdf, normaliseBreakdown, receiptFilename };
