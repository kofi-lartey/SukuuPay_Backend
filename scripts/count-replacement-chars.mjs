/**
 * Counts U+FFFD (the Unicode replacement character) in the source tree.
 *
 * Run: node scripts/count-replacement-chars.mjs [dir]
 *
 * ## Why this exists as its own file
 *
 * Every previous attempt to check this was written inline as `node -e "..."`, and every
 * one of them produced a *different, wrong* answer — reporting replacement characters in
 * files that a direct read shows are clean.
 *
 * The cause is the shell, not the code. The check needs a literal U+FFFD in the source,
 * and passing it through a PowerShell command line means it gets re-encoded on the way
 * in — so the script searches for a mangled string and finds nothing, or finds something
 * else entirely. One inline version reported 159 replacement characters and pointed at a
 * regular expression that a plain `read` of the file showed to be intact.
 *
 * A file on disk has no such problem. `String.fromCharCode(0xfffd)` is constructed at
 * runtime from a number that no code page can reinterpret, and every path is read through
 * the same `fs` call. So the rule here is: anything that needs a specific non-ASCII code
 * point gets a file, never `-e`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.netlify',
  '.vite', '.mockcheck', 'out', 'out-dashboard', 'out-console', 'out-auth',
]);

const FFFD = String.fromCodePoint(0xfffd);
const BOM = String.fromCodePoint(0xfeff);

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx|mjs|ts|tsx|json|css|html|md|toml|webmanifest)$/.test(entry)) out.push(full);
  }
  return out;
};

const escape = (text) =>
  [...text]
    .map((char) => {
      const code = char.codePointAt(0);
      if (code === 0xfffd) return '<FFFD>';
      if (code === 0xfeff) return '<BOM>';
      return code < 128 ? char : `<${code.toString(16).toUpperCase().padStart(4, '0')}>`;
    })
    .join('');

let fffdTotal = 0;
let bomTotal = 0;
const hits = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const source = readFileSync(file, 'utf8');

  const fffd = source.split(FFFD).length - 1;
  const bom = source.split(BOM).length - 1;
  fffdTotal += fffd;
  bomTotal += bom;

  if (!fffd && !bom) continue;

  source.split('\n').forEach((line, index) => {
    if (line.includes(FFFD) || line.includes(BOM)) {
      hits.push({ rel, line: index + 1, text: escape(line.trim().slice(0, 100)), fffd, bom });
    }
  });
}

console.log(`\nScanned ${walk(ROOT).length} file(s) under ${ROOT}\n`);
console.log(`  U+FFFD replacement characters: ${fffdTotal}`);
console.log(`  U+FEFF byte order marks     : ${bomTotal}`);

if (!hits.length) {
  console.log('\n  Clean: no replacement characters, no BOMs.\n');
} else {
  console.log('');
  for (const hit of hits) {
    console.log(`  ${hit.rel}:${hit.line}`);
    console.log(`      ${hit.text}`);
  }
  console.log('');
}

process.exit(fffdTotal || bomTotal ? 1 : 0);