/**
 * Scans for `action:` string literals passed to the audit service and reports which are
 * not in the `AuditLog.action` enum.
 *
 * Thrown away after running — a diagnostic, not a shipped test. Run it after changing
 * either enum:
 *
 *   node scripts/find-invalid-audit-actions.mjs
 *
 * `utils/auditService.log` catches a Mongoose ValidationError and logs it, so an action
 * outside the enum fails *silently*: the request succeeds, the audit row does not exist,
 * and nothing else notices. That is why this needs a sweep rather than an incident
 * report.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
};

const { AuditLog } = await import('../src/models/AuditLog.js');
const { AUDIT_ACTIONS } = await import('../src/config/constants.js');

const allowed = new Set(AuditLog.schema.path('action').enumValues);
const mapped = new Set(Object.values(AUDIT_ACTIONS));

const found = new Map();
// `action:` followed by a quoted literal. Deliberately naive — it will also match a
// comment or an unrelated object property, which is why the result is reviewed by eye
// rather than trusted as an exact count.
const pattern = /action:\s*['"]([A-Za-z_.]+)['"]/g;

for (const file of walk(join(ROOT, 'src'))) {
  const source = readFileSync(file, 'utf8');
  let match;
  while ((match = pattern.exec(source))) {
    const action = match[1];
    if (!found.has(action)) found.set(action, []);
    found.get(action).push(relative(ROOT, file).replace(/\\/g, '/'));
  }
}

const invalid = [...found.keys()].filter((action) => !allowed.has(action)).sort();
const valid = [...found.keys()].filter((action) => allowed.has(action)).sort();

console.log(`\n${invalid.length} INVALID action literal(s) — these write NO audit row:\n`);
for (const action of invalid) {
  const viaMap = mapped.has(action) ? '' : '  (not in AUDIT_ACTIONS either)';
  console.log(`  ${action}${viaMap}`);
  console.log(`      ${found.get(action).join('\n      ')}`);
}

console.log(`\n${valid.length} valid action literal(s) in use.`);
console.log(
  `\n${Object.keys(AUDIT_ACTIONS).length} keys in AUDIT_ACTIONS, ${mapped.size} distinct values in the schema enum.`
);