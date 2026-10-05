/**
 * Repairs mojibake (UTF-8 bytes decoded as windows-1252) in source files.
 *
 * Run:
 *   node scripts/repair-mojibake.mjs            # whole repo
 *   node scripts/repair-mojibake.mjs --dry
 *   node scripts/repair-mojibake.mjs ../frontend
 *
 * ## What mojibake is, and why it is reversible
 *
 * UTF-8 encodes an em dash as the three bytes `E2 80 94`. Decoded as windows-1252 those
 * three bytes become three *characters*: a circumflex-accented a, a euro sign, and a
 * right double quote — which is what you see when it renders, and why it reads as a
 * handful of odd symbols rather than as one broken character. It survives so long in a
 * codebase precisely because it does not look like a character that failed.
 *
 * (Described rather than pasted. Writing the three characters here is the exact trap —
 * `find-non-ascii.mjs` scans for that sequence and this file keeps getting "repaired",
 * which turns a note about the bug back into the bug. An earlier version of this
 * paragraph did exactly that.)
 *
 * The transformation is a bijection on the bytes, so it is exactly reversible: encode the
 * string back to windows-1252 to recover the original bytes, then decode those as UTF-8.
 * `Buffer.from(text, 'latin1')` is that first half.
 *
 * ## Why sequences can be *doubly* encoded
 *
 * Repairing once is sometimes not enough. A file can be read as windows-1251 —2 and
 * written back out, applying the damage a second time:
 *
 *     U+2014  --UTF-8-->  E2 80 94  --CP1252-->  U+00E2 U+20AC U+201D
 *              --UTF-8-->  C3 A2 E2 82 AC E2 80 9D  --CP1252-->  U+00E2 U+20AC U+00E2 U+20AC U+009D
 *
 * Note the third step decodes as UTF-8 again, not windows-1252 — that is the second
 * application of the damage, and it is why the corruption grows rather than merely
 * looking wrong.
 *
 * That third state is what `SchoolsList.jsx` contains, in a column heading reading
 * `Collected (GH <mangled>)` where the intent was the **cedi sign** — a currency symbol,
 * on a screen a bursar reads. So this repairs iteratively, and stops as soon as a pass
 * would introduce a replacement
 * character (which is how a valid string gets damaged by being "repaired" twice).
 *
 * ## Why it is targeted rather than a blanket re-decode
 *
 * The repair is applied **only to exact known sequences**, never to whole lines or whole
 * files. A blanket `Buffer.from(text, 'latin1').toString('utf8')` over a file that is
 * *already* valid UTF-8 turns every correct character into mojibake — and this codebase
 * has legitimate non-ASCII in it that must survive: the **GSM 03.38 extension set** in
 * `sms.service.js` (`£$¥èéùìòÇØøÅå`, used for SMS character counting), `&copy;` → `©` in
 * `htmlToText.js`, `© 2026 SukuuPay` in the footer, and `±` in the audit-log window. Those
 * are correct code, and a blanket pass would have destroyed all of it.
 *
 * ## Do not paste a mangled sequence into a comment here
 *
 * This tool will read your example as a real defect and rewrite it. Two earlier passes of
 * this file did exactly that, and the index.html comment explaining the missing charset
 * kept getting "repaired" — a note about the bug turned back into the bug. Describe the
 * bytes and the character they should decode to; do not reproduce the sequence.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const DRY = args.includes('--dry') || process.argv.includes('--dry');
const ROOT = resolve(HERE, args[0] || '..', '..');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.netlify',
  '.vite', '.mockcheck', 'out', 'out-dashboard', 'out-console', 'out-auth',
]);

/**
 * Byte → windows-1252 character, written out **explicitly by byte value**.
 *
 * An earlier version built this as a contiguous array of characters and assigned them
 * with `HIGH.forEach((char, i) => set(0x80 + i, char))`. That is wrong twice:
 *
 *  1. It started the array with the byte `0x80` instead of the character `U+20AC`, so
 *     `0x80` mapped to itself.
 *  2. **CP1252's 0x80-0x9F range has gaps.** 0x81, 0x8D, 0x8F, 0x90 and 0x9D are
 *     undefined, and everything after each gap shifts. With a contiguous array, byte
 *     0x94 (`”`) was mapped to whatever sat 19 slots in — which is how an em dash
 *     "corrupted" to a sequence containing a right double quote, and why the first two
 *     versions of this repair found nothing to fix.
 *
 * Written as an explicit map so the gaps are visible and a typo cannot silently shift
 * twenty-eight entries.
 */
const CP1252_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d,
  0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161,
  0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const CP1252_FROM_BYTE = (() => {
  const table = new Map();
  // 0x00-0x7F and 0xA0-0xFF are identical to latin1.
  for (let byte = 0; byte < 0x80; byte += 1) table.set(byte, String.fromCodePoint(byte));
  for (let byte = 0xa0; byte <= 0xff; byte += 1) table.set(byte, String.fromCodePoint(byte));
  for (const [byte, code] of Object.entries(CP1252_HIGH)) {
    table.set(Number(byte), String.fromCodePoint(code));
  }
  return table;
})();

/** The exact character sequence one round of mojibake produces for `text`. */
const mojibakeOnce = (text) =>
  [...Buffer.from(text, 'utf8')]
    .map((byte) => CP1252_FROM_BYTE.get(byte) ?? String.fromCodePoint(byte))
    .join('');

/**
 * Reverses one round of damage, for verification only.
 *
 * Used to prove the forward table is right: `unmangle(mangle(x)) === x`. Without this
 * check a wrong table still produces plausible-looking output, which is how two broken
 * versions of this file shipped a "no repairs needed" result.
 */
const unmangleOnce = (text) =>
  Buffer.from(
    [...text].map((char) => {
      const byte = [...CP1252_FROM_BYTE.entries()].find(
        ([, value]) => value === char
      );
      return byte ? byte[0] : char.codePointAt(0) & 0xff;
    })
  ).toString('utf8');

/**
 * The characters this codebase plausibly contains, and the mojibake each becomes.
 *
 * The list is the *vocabulary of this repository*, not a general charset — a repair tool
 * that mangles anything outside it would be dangerous on a file it has not read. Two
 * entries here were added after a sweep found real corruption the first list missed:
 * `U+2500` (box-drawing horizontal, used as a `──` separator in comments) and `U+22EF`
 * (midline horizontal ellipsis, the standard "row actions" menu icon). Both had been
 * encoded once and were rendering as three nonsense characters each.
 */
const CANDIDATES = [
  0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026,
  0x20b5, // cedi sign
  0x22ef, // midline horizontal ellipsis — the row-actions menu glyph
  0x2500, // box drawing horizontal, used as a separator in comments
  0x00b0, 0x00a3, 0x00a9, 0x00b1, 0x00d7, 0x00b7, 0x2192,
  0x00e9, 0x00e8, 0x00fc, 0x00f6, 0x00e7, 0x00e0, 0x00e5, 0x00f8, 0x00d8,
  0xfeff, // BOM
];

/**
 * Build the repair table: mojibake-sequence → intended character, for one, two and
 * three levels of damage. Keyed longest-first so the longest match wins.
 */
const buildTable = () => {
  const table = new Map();

  for (const code of CANDIDATES) {
    const intended = String.fromCodePoint(code);

    let level = intended;
    for (let depth = 1; depth <= 3; depth += 1) {
      // One more round of damage: take the current text as UTF-8 bytes and read those
      // bytes as windows-1252. When those bytes are themselves multi-byte (which is the
      // case from the second round onward) the result is itself mostly non-ASCII, and
      // encoding *it* produces the triple-encoded form.
      const next = mojibakeOnce(level);
      if (next === level) break;
      if (!table.has(next)) table.set(next, intended);
      level = next;
    }
  }

  return [...table.entries()].sort((a, b) => b[0].length - a[0].length);
};

/**
 * Exact, hand-decided repairs for the replacement characters that survived the
 * standalone rule.
 *
 * Each entry states the evidence for what the original was. None is a guess in the usual
 * sense: a replacement character has destroyed the bytes, but the surrounding code either
 * carries a canonical copy of the same value elsewhere or makes the intent unambiguous.
 * Where that was not true, the character was left in place for a human rather than
 * substituted.
 */
const FFFD_CH = String.fromCodePoint(0xfffd);
const f = (count) => FFFD_CH.repeat(count);

/** The GSM 03.38 extension table — the characters that cost one segment, not two. */
const GSM7_EXTENSION = '£$¥èéùìòÇØøÅå';

const EXACT_REPLACEMENTS = [
  {
    // ── The mock's GSM-7 test ──
    //
    // Its character class had been destroyed — twelve replacement characters, with a `$`
    // surviving in the middle — while the identical regex in `sms.service.js`,
    // `services/sms.js` and `useSmsReminders.js` all survived intact. Restored from the
    // backend's copy, so the mock counts segments the way the server does.
    //
    // This is the one that mattered: a fee reminder containing a cedis sign counted as
    // UCS-2 (70 chars/segment) under mock and GSM-7 (160) under the real API, so the
    // same message reported a different segment count depending on which was running.
    //
    // Matched with a regex rather than a literal because the damage was partial — a
    // literal expecting twelve replacement characters in a row would have found nothing,
    // and silently repairing nothing looks exactly like repairing nothing.
    // The leading `@` is **outside** the match on purpose. The character class in the
    // source is `[\x20-\x7E\n\r@…]`, so including it in the pattern and re-emitting it
    // in the replacement produced `@@£$¥…` — an `@` that matches no character in
    // GSM 03.38 and silently fails every message containing a cedis sign.
    pattern: new RegExp(FFFD_CH + '\\$?' + FFFD_CH + '*\\]', 'g'),
    replace: GSM7_EXTENSION + ']',
    why: 'the mock GSM-7 character class, restored from the backend copy',
  },

  {
    // ── The mock's masked phone number ──
    //
    // `maskContact` in `pay.service.js` returns `•••• 1234`: everything but the last four
    // digits, and nothing else. The mock had reconstructed it as `slice(0, 6)` + five
    // destroyed characters + `slice(-3)` — so it displayed **six digits the real API
    // masks** and one digit fewer of the part that is allowed.
    //
    // A mock that is more permissive than the API it stands in for, on the one field
    // where the difference is a parent's privacy, is worse than no mock: the bug is
    // invisible in development and fixed in production.
    //
    // The replacement restores the **whole expression**, mask characters included —
    // the first attempt replaced only `slice(0, 6)} … slice(-3)` with `slice(-4)`,
    // which dropped the `••••` prefix and left the mock displaying a bare four-digit
    // suffix. Less data is not the same as correctly-masked data.
    pattern: /`\$\{String\(recipients\[0\]\.phone\)\.slice\(0, 6\)\}[\s\S]{0,40}?slice\(-3\)`/g,
    replace: '`•••• ${String(recipients[0].phone).slice(-4)}`',
    why: 'masked phone now matches maskContact() — six digits were being exposed',
  },

  {
    // En dash in a grade range. `1–12` is the conventional way to write it and the only
    // sensible reading of `grades 1<FFFD>12`.
    find: `grades 1${f(1)}12`,
    replace: 'grades 1–12',
    why: 'grade range in ad fixtures',
  },

  {
    // Typographic quotes around a word being criticised: `and "free" needs a stated rule`.
    // Both quotes are destroyed, so both are restored together.
    find: `and ${f(1)}free${f(1)} needs`,
    replace: 'and “free” needs',
    why: 'quotation marks in a rejection reason',
  },

  {
    // A literal `0` in a code sample being quoted in a comment. The sentence is explaining
    // that the server's `if (query.minAmount || 0)` ignores an explicit zero — the `0` is
    // the entire subject of the sentence, so it cannot have been anything else.
    find: `query.minAmount || ${f(1)}`,
    replace: 'query.minAmount || 0',
    why: 'the literal being explained in the comment',
  },

  {
    // The route this comment is describing. `/schools/me/` with nothing after it is not a
    // route; the sibling comment names it in full.
    find: `/schools/me/${f(1)}`,
    replace: '/schools/me/ad-requests',
    why: 'the route the comment documents',
  },

  {
    // An em dash in quotes, in a sentence about a tile rendering as a placeholder glyph.
    find: `read "${f(1)}".`,
    replace: 'read "—".',
    why: 'the placeholder the comment describes',
  },

  {
    // A route name in backticks, directly abutting an em dash — the dash was the only
    // separator and it is the only thing destroyed, so the fix is to put it back.
    //
    // Written with a character class rather than a backtick in the pattern on purpose:
    // every attempt to pass a literal backtick through a shell command line mangled it,
    // so this rule could not be written inline at all. A file cannot be re-encoded on
    // the way in.
    pattern: new RegExp('(`/id-cards/:studentId`)' + FFFD_CH, 'g'),
    replace: '$1 —',
    why: 'em dash after a route name in a comment',
  },

  {
    // A box-drawing separator rule where three characters were destroyed mid-line.
    // Rebuilt as a plain run rather than patched, because a separator has no content to
    // preserve and guessing its exact length would be false precision.
    //
    // `^\s*` because these rules are written flush-left *inside* functions and classes,
    // so they carry the current indentation.
    pattern: new RegExp(
      '^(\\s*// )' + String.fromCodePoint(0x2500) + '{2,}' + FFFD_CH + '+.*$',
      'm'
    ),
    replace: (_match) =>
      '// ' + String.fromCodePoint(0x2500).repeat(69),
    why: 'a comment separator rule, rebuilt',
  },

  {
    // A trailing replacement character is a sentence that wrapped: `... this can never be
    // a partial patch —`. Nothing follows it, so the em dash went at the end.
    // Handled as a rule rather than per-line, because there are eight of them and they
    // are all the same shape.
    find: null,
    replace: null,
    why: 'see TRAILING below',
  },
];

const REPAIRS = buildTable();
const hex = (char) =>
  'U+' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');

const FFFD = String.fromCodePoint(0xfffd);

/**
 * Standalone U+FFFD → em dash.
 *
 * A replacement character is what a decoder leaves behind when the bytes it was given
 * are not valid UTF-8 — so unlike mojibake, the original is **gone** and cannot be
 * recovered by reversing anything. There were 159 of them across the tree.
 *
 * The rule is deliberately narrow: only a U+FFFD that stands **alone between two spaces**
 * is replaced. That shape is a punctuation mark lost at a sentence break, and this
 * codebase's comment voice uses an em dash there almost everywhere, so the intent is
 * unambiguous even though the character is not recoverable.
 *
 * A replacement character *adjacent* to other characters is a different failure — a
 * whole word or symbol destroyed, where guessing would invent data. Those are left alone
 * and reported, because the right fix is a human reading the line. The count below is the
 * honest measure of what is left to decide, rather than a tool confidently substituting a
 * guess into somebody's regex.
 */
const repairStandaloneReplacementChars = (text) => {
  let count = 0;
  const repaired = text.replace(
    new RegExp(` ${FFFD} `, 'g'),
    () => {
      count += 1;
      return ' — ';
    }
  );
  return { text: repaired, count };
};

/**
 * The self-check.
 *
 * Two broken versions of this script produced an empty or wrong table and reported
 * "0 fixes, nothing to do" — indistinguishable from a clean repository, which is the worst
 * thing a repair tool can do. So the forward table is verified against its own inverse
 * before a single file is touched, and a mismatch aborts.
 */
{
  const probes = ['—', '–', '’', '‘', '“', '”', '…', '₵', '°', '£', 'é', '×'];
  const broken = probes.filter((probe) => {
    const mangled = mojibakeOnce(probe);
    const restored = unmangleOnce(mangled);
    return restored !== probe || !REPAIRS.some(([bad, good]) => bad === mangled && good === probe);
  });

  if (broken.length) {
    console.error(
      `\nABORT: the mojibake table does not round-trip for ${broken.map(hex).join(', ')}.`
    );
    console.error('Refusing to touch any file — a wrong table would corrupt valid text.');
    process.exit(1);
  }
  console.log(`\nSelf-check: table round-trips for ${probes.length} probe characters.`);
}

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx|mjs|ts|tsx|json|css|html|md|toml|webmanifest)$/.test(entry)) out.push(full);
  }
  return out;
};

console.log(`\nRepair table: ${REPAIRS.length} sequence(s). Longest first.\n`);
for (const [bad, good] of REPAIRS.slice(0, 6)) {
  console.log(`  [${[...bad].map(hex).join(' ')}] -> ${hex(good)}`);
}
if (REPAIRS.length > 6) console.log(`  ... and ${REPAIRS.length - 6} more`);

let totalFixes = 0;
let totalReplacementFixes = 0;
let filesChanged = 0;
const report = [];
const unrepaired = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const original = readFileSync(file, 'utf8');
  let text = original;
  const hits = [];

  for (const [bad, good] of REPAIRS) {
    let at = text.indexOf(bad);
    while (at !== -1) {
      const line = text.slice(0, at).split('\n').length;
      hits.push({ line, from: bad, to: good });
      at = text.indexOf(bad, at + bad.length);
    }
  }

  if (!hits.length) continue;

  // Apply longest-first; because the table is sorted longest-first and replacement is
  // done in that order, a triple-encoded sequence is consumed before its double- and
  // single-encoded prefixes can match inside it.
  for (const [bad, good] of REPAIRS) {
    if (text.includes(bad)) text = text.split(bad).join(good);
  }

  if (text === original) continue;

  totalFixes += hits.length;
  filesChanged += 1;
  report.push({ rel, hits });

  if (!DRY) writeFileSync(file, text, 'utf8');
}

// Second pass: replacement characters, tracked separately so the report does not imply
// a mojibake sequence was found where a destroyed character was.
//
// Three rules, in order of how much they can safely assume:
//   1. ` <FFFD> `  — standalone between spaces. A lost punctuation mark at a sentence
//      break, and this codebase's comment voice uses an em dash there.
//   2. The exact cases below, each with its evidence recorded.
//   3. Trailing `<FFFD>` — a sentence that wrapped, so the dash went at the end.
// Anything still standing is a destroyed word or symbol, and is reported rather than
// guessed at.
const exactFixes = [];
const trailingFixes = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const original = readFileSync(file, 'utf8');
  let text = original;

  const { text: afterStandalone, count: standaloneCount } =
    repairStandaloneReplacementChars(text);
  text = afterStandalone;
  if (standaloneCount) totalReplacementFixes += standaloneCount;

  for (const rule of EXACT_REPLACEMENTS) {
    if (!rule.find && !rule.pattern) continue;
    let hits = 0;

    if (rule.pattern) {
      // Counted from a fresh regex, because `split().join()` with no match is a silent
      // no-op — reporting it as a repair would claim 200 files were fixed when none were.
      // An earlier version set the count unconditionally and listed every file in the
      // repository under both rules.
      const counter = new RegExp(rule.pattern.source, rule.pattern.flags);
      hits = (text.match(counter) || []).length;
      if (!hits) continue;

      // `split`/`join` rather than `String.replace`, because a replacement *string*
      // containing `$` is a capture-group reference — and the GSM-7 table legitimately
      // contains a dollar sign. Substituting the wrong character here would be the exact
      // failure this script exists to repair.
      //
      // A function replacement cannot go through `split`/`join` at all, so those rules
      // take the `replace` path with a replacer function.
      text =
        typeof rule.replace === 'function'
          ? text.replace(rule.pattern, rule.replace)
          : text.split(rule.pattern).join(rule.replace);
    } else {
      while (text.includes(rule.find)) {
        text = text.replace(rule.find, rule.replace);
        hits += 1;
      }
    }

    if (hits) {
      exactFixes.push({ rel, hits, why: rule.why });
      totalReplacementFixes += hits;
    }
  }

  let trailing = 0;
  text = text.replace(new RegExp(`${String.fromCodePoint(0xfffd)}[ \\t]*$`, 'gm'), () => {
    trailing += 1;
    return '—';
  });
  if (trailing) {
    trailingFixes.push({ rel, hits: trailing });
    totalReplacementFixes += trailing;
  }

  if (text !== original && !DRY) writeFileSync(file, text, 'utf8');

  const remaining = text.split(FFFD).length - 1;
  if (remaining) unrepaired.push({ rel, remaining });
}

for (const { rel, hits } of report) {
  console.log(`\n  ${rel} — ${hits.length} fix(es)`);
  for (const hit of hits.slice(0, 6)) {
    console.log(
      `      line ${hit.line}: [${[...hit.from].map(hex).join(' ')}] -> ${hex(hit.to)}`
    );
  }
}

console.log(
  `\n${DRY ? '[dry] ' : ''}${totalFixes} mojibake fix(es) across ${filesChanged} file(s).`
);
console.log(
  `${DRY ? '[dry] ' : ''}${totalReplacementFixes} standalone replacement character(s) repaired.`
);

if (exactFixes.length || trailingFixes.length) {
  console.log('\n  Exact repairs:');
  for (const { rel, hits, why } of exactFixes) {
    console.log(`    ${rel} — ${hits}x  ${why}`);
  }
  for (const { rel, hits } of trailingFixes) {
    console.log(`    ${rel} — ${hits}x  trailing em dash on a wrapped sentence`);
  }
}

if (unrepaired.length) {
  const left = unrepaired.reduce((sum, entry) => sum + entry.remaining, 0);
  console.log(
    `\n${left} replacement character(s) still adjacent to other text — NOT auto-repaired.`
  );
  console.log(
    'These destroyed a word or symbol rather than a punctuation mark, so the original is'
  );
  console.log('unrecoverable and guessing would invent data. Each needs a human to read it:');
  for (const entry of unrepaired) console.log(`  ${entry.rel} — ${entry.remaining}`);
}
console.log('');