/**
 * Finds mojibake and unexpected non-ASCII characters, printing **ASCII only**.
 *
 * Run:
 *   node scripts/find-non-ascii.mjs            # whole repo, from anywhere
 *   node scripts/find-non-ascii.mjs ../frontend
 *   node scripts/find-non-ascii.mjs --all
 *
 * ## Two things this script gets right that its first version did not
 *
 * **1. It only prints ASCII.** The first version printed the offending characters
 * literally — so on a Windows console with the wrong code page, *the diagnostic itself*
 * displayed as mojibake. Chasing a mojibake report through a terminal that cannot render
 * the character is not a debugging session. Every code point is now printed as `U+XXXX`.
 *
 * **2. The windows-1252 high range is written out by byte value.** The first version
 * built it as a contiguous array and assigned with `arr.forEach((char, i) => set(0x80 +
 * i, char))`. CP1252's 0x80-0x9F range has **gaps** — 0x81, 0x8D, 0x8F, 0x90 and 0x9D are
 * undefined — so every entry after each gap was shifted. Byte 0x94, which is a right
 * double quote, was mapped to the wrong character, and the script reported a codebase
 * with zero corruption as full of it. `repair-mojibake.mjs` carries a self-check for
 * exactly this class of mistake and refuses to run on a table that does not round-trip.
 *
 * Note for anyone documenting a mojibake bug **in this repository**: do not paste the
 * mangled sequence into a comment. This scanner will flag it, `repair-mojibake.mjs` will
 * "fix" it, and your explanation of the bug will be rewritten into the bug. Describe the
 * sequence instead — which bytes map to which characters — rather than reproducing it.
 *
 *
 * ## The distinction that matters
 *
 * Mojibake — a UTF-8 em dash read as windows-1252 — is a **decoding failure**, not a
 * character anyone typed. It has two causes needing opposite fixes:
 *
 *  1. Bytes corrupt **at rest** in a file. Fix: rewrite the file.
 *  2. Valid UTF-8 that something **serves or reads as latin1** — a `Content-Type` without
 *     `charset`, a missing `<meta charset>`, a terminal code page. Fix: declare the
 *     encoding. Deleting the character would treat the symptom and, in case 2, would not
 *     even help: the next accented name or cedi sign renders the same way.
 *
 * That was the actual state of this repo: every file valid, and `index.html` declaring no
 * encoding at all.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const SHOW_ALL = process.argv.includes('--all');
const ROOT = resolve(HERE, args[0] || '..', '..');
const TARGET = relative(process.cwd(), ROOT) || ROOT;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.netlify',
  '.vite', '.mockcheck', 'out', 'out-dashboard', 'out-console', 'out-auth',
]);

const cp = (...codes) => String.fromCodePoint(...codes);
const hex = (char) =>
  'U+' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');

/**
 * The sequences that mean "a UTF-8 byte sequence was decoded as windows-1252".
 *
 * Each is the CP1252 rendering of a real UTF-8 sequence. Em dash is E2 80 94, which
 * CP1252 maps to U+00E2, U+20AC, U+009D.
 */
const MOJIBAKE = [
  [cp(0x00e2, 0x20ac, 0x0094), 'em dash', cp(0x2014)],
  [cp(0x00e2, 0x20ac, 0x0093), 'en dash', cp(0x2013)],
  [cp(0x00e2, 0x20ac, 0x0098), 'left single quote', cp(0x2018)],
  [cp(0x00e2, 0x20ac, 0x0099), 'right single quote / apostrophe', cp(0x2019)],
  [cp(0x00e2, 0x20ac, 0x009c), 'left double quote', cp(0x201c)],
  [cp(0x00e2, 0x20ac, 0x009d), 'right double quote', cp(0x201d)],
  [cp(0x00e2, 0x20ac, 0x00a6), 'ellipsis', cp(0x2026)],
  [cp(0x00e2, 0x80, 0x99), 'right single quote (2-byte form)', cp(0x2019)],
  [cp(0x00e2, 0x80, 0x9c), 'left double quote (2-byte form)', cp(0x201c)],
  [cp(0x00e2, 0x80, 0x9d), 'right double quote (2-byte form)', cp(0x201d)],
  [cp(0x00c2, 0x00a0), 'non-breaking space', cp(0x00a0)],
  [cp(0x00c2, 0x00b0), 'degree sign', cp(0x00b0)],
  [cp(0x00c2, 0x00a3), 'pound sign', cp(0x00a3)],
  [cp(0x00c3, 0x00a9), 'e-acute', cp(0x00e9)],
  [cp(0x00c3, 0x00a3), 'a-tilde', cp(0x00e3)],
];

/**
 * Characters that are legitimate in this codebase.
 *
 * Listed so the report can say "these are fine" rather than leaving a reader to judge
 * each one — and so a genuinely unexpected character is visible against a known-good set
 * instead of lost in a long list.
 */
const ALLOWED = {
  0x20ac: 'euro — but ONLY ever as the middle of a mojibake sequence',
  0x00a3: 'pound',
  0x00ae: 'registered',
  0x00b0: 'degree',
  0x00b7: 'middle dot',
  0x00d7: 'multiplication sign',
  0x00a0: 'non-breaking space',
  0x2013: 'en dash',
  0x2014: 'em dash',
  0x2018: 'left single quote',
  0x2019: 'right single quote',
  0x201c: 'left double quote',
  0x201d: 'right double quote',
  0x2026: 'ellipsis',
  0x2192: 'arrow',
  0x2265: 'greater-or-equal',
  0x2264: 'less-or-equal',
  // Latin-1 letters: names in a Ghanaian school roster and Portuguese loanwords.
  0x00e1: 'a-acute', 0x00e2: 'a-circumflex', 0x00e3: 'a-tilde', 0x00e4: 'a-diaeresis',
  0x00e7: 'c-cedilla', 0x00e8: 'e-grave', 0x00e9: 'e-acute', 0x00ea: 'e-circumflex',
  0x00ed: 'i-acute', 0x00ef: 'i-diaeresis', 0x00f1: 'n-tilde', 0x00f3: 'o-acute',
  0x00f5: 'o-tilde', 0x00f6: 'o-diaeresis', 0x00fa: 'u-acute', 0x00fc: 'u-diaeresis',
  0x00f9: 'u-grave',
};

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx|mjs|ts|tsx|json|css|html|md|toml|webmanifest)$/.test(entry)) out.push(full);
  }
  return out;
};

console.log(`\nScanning: ${TARGET}`);

const sequenceHits = new Map(); // sequence -> locations[]
const charHits = new Map(); // codePoint -> { count, files:Set, samples:[] }
let scanned = 0;

for (const file of walk(ROOT)) {
  scanned += 1;
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const source = readFileSync(file, 'utf8');

  for (const [sequence, , intended] of MOJIBAKE) {
    let at = source.indexOf(sequence);
    while (at !== -1) {
      const line = source.slice(0, at).split('\n').length;
      if (!sequenceHits.has(sequence)) sequenceHits.set(sequence, []);
      sequenceHits.get(sequence).push({ rel, line, intended });
      at = source.indexOf(sequence, at + 1);
    }
  }

  source.split('\n').forEach((text, index) => {
    for (const char of text) {
      const code = char.codePointAt(0);
      if (code < 128) continue;
      if (!charHits.has(code)) charHits.set(code, { count: 0, files: new Set(), samples: [] });
      const entry = charHits.get(code);
      entry.count += 1;
      entry.files.add(rel);
      if (entry.samples.length < 3) entry.samples.push(`${rel}:${index + 1}`);
    }
  });
}

console.log(`  ${scanned} file(s)\n`);

console.log('== MOJIBAKE: file is corrupt at rest ==');
if (!sequenceHits.size) {
  console.log('   none. Every sequence in the tree is a single intentional character.\n');
} else {
  for (const [sequence, hits] of sequenceHits) {
    const first = hits[0];
    console.log(
      `   [${[...sequence].map(hex).join(' ')}]  should be ${hex(first.intended)}  x${hits.length}`
    );
    hits.slice(0, 10).forEach((hit) => console.log(`       ${hit.rel}:${hit.line}`));
  }
  console.log('');
}

console.log('== NON-ASCII CHARACTERS ==');
const codes = [...charHits.keys()].sort((a, b) => a - b);
const unexpected = codes.filter((code) => !ALLOWED[code]);

for (const code of codes) {
  const entry = charHits.get(code);
  const note = ALLOWED[code] || 'UNEXPECTED';
  const flag = ALLOWED[code] ? '   ' : '>> ';
  console.log(
    `  ${flag}${hex(String.fromCodePoint(code))}  ${String(entry.count).padStart(5)}x  ${String(entry.files.size).padStart(4)} file(s)  ${note}`
  );
  if (!ALLOWED[code]) console.log(`          e.g. ${entry.samples.join(', ')}`);
}
if (!SHOW_ALL && !unexpected.length) {
  console.log('  (all expected — run with --all for the full list)');
}

console.log(
  `\n  ${codes.length} distinct character(s), ${unexpected.length} unexpected.`
);
console.log(
  unexpected.length || sequenceHits.size
    ? '  FAIL: something needs fixing.'
    : '  PASS: no corruption, no unexpected characters.'
);