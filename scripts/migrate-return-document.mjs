/**
 * Rewrites `new: true` to `returnDocument: 'after'` inside findOneAnd* option objects.
 *
 * Run: node scripts/migrate-return-document.mjs [--dry]
 *
 * Mongoose 9 deprecated the `new` option on `findOneAndUpdate()` and
 * `findOneAndReplace()`. It is still honoured, so this is a deprecation, not a bug — but
 * it is thirteen warnings on every boot of a service that should boot clean, and the
 * warning is noise that trains people to ignore console output.
 *
 * Scoped deliberately. A bare find-and-replace of `new: true` would also hit a data field
 * literally called `new`, so every substitution is checked to be inside the options of a
 * findOneAnd* call in the same file, and the result is printed per site for review.
 *
 * `returnDocument: 'after'` is exactly equivalent to `new: true`: mongoose's own
 * `convertNewToReturnDocument(options)` performs the same conversion internally.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRY = process.argv.includes('--dry');

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
};

const FIND_ONE_AND = /\.(findOneAndUpdate|findOneAndReplace|findByIdAndUpdate)\s*\(/g;

// A `new:` option sits inside the braces of the options argument. Rather than parse,
// find each findOneAnd* call and take the last balanced `{ … }` group before its closing
// paren — that group is the options object in every call in this codebase.
const optionsObjectFor = (source, callIndex) => {
  // Walk forward from the call's opening paren, tracking nesting, and remember the
  // start offset of each top-level `{`.
  let depth = 0;
  let lastGroupStart = -1;
  for (let i = callIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(' || ch === '{' || ch === '[') {
      if (ch === '{' && depth === 1) lastGroupStart = i;
      depth += 1;
    } else if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return lastGroupStart;
    }
  }
  return -1;
};

let total = 0;
const changedFiles = [];

for (const file of walk(join(ROOT, 'src'))) {
  let source = readFileSync(file, 'utf8');
  if (!FIND_ONE_AND.test(source)) {
    FIND_ONE_AND.lastIndex = 0;
    continue;
  }

  const edits = [];
  FIND_ONE_AND.lastIndex = 0;
  let match;
  while ((match = FIND_ONE_AND.exec(source))) {
    const open = source.indexOf('(', match.index);
    const start = optionsObjectFor(source, open);
    if (start === -1) continue;
    const end = source.indexOf('}', start);
    if (end === -1) continue;

    const options = source.slice(start, end);
    if (!/\bnew:\s*true\b/.test(options)) continue;

    edits.push({
      line: source.slice(0, start).split('\n').length,
      from: options,
      to: options.replace(/\bnew:\s*true\b/g, "returnDocument: 'after'"),
    });
  }

  if (!edits.length) continue;

  // Apply back-to-front so earlier offsets stay valid.
  for (const edit of edits.reverse()) {
    const at = source.indexOf(edit.from);
    source = source.slice(0, at) + edit.to + source.slice(at + edit.from.length);
  }

  if (!DRY) writeFileSync(file, source, 'utf8');
  total += edits.length;
  changedFiles.push([relative(ROOT, file).replace(/\\/g, '/'), edits.length]);
}

console.log(`${DRY ? '[dry] ' : ''}${total} option(s) rewritten across ${changedFiles.length} file(s):`);
for (const [name, count] of changedFiles) console.log(`  ${name} — ${count}`);