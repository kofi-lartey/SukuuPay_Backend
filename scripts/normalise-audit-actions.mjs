/**
 * Renames non-enum audit action literals to their dotted-lowercase equivalents.
 *
 * Run: node scripts/normalise-audit-actions.mjs [--dry]
 *
 * ## The bug
 *
 * `utils/auditService.log` catches a Mongoose ValidationError and logs it. So an `action`
 * outside the `AuditLog.action` enum fails *silently*: the request succeeds, the audit row
 * does not exist, and the only trace is a line in the console that nobody reads. There
 * were **53** such literals — `CREATE`, `UPDATE`, `REMOVE`, `BULK_ARCHIVE`,
 * `ANALYTICS_READ`, `PROVISION_SCHOOL` and so on, in UPPER_SNAKE while the vocabulary is
 * dotted lowercase.
 *
 * ## Why rename rather than add
 *
 * Adding 53 UPPER_SNAKE values to the enum would silence the warning and leave a codebase
 * with two action vocabularies, one dotted and one shouting. The parity test in
 * `contractTests.test.js` would then pass on a vocabulary nobody would have written on
 * purpose, and the next reader would have to guess which convention a new action should
 * follow.
 *
 * The mapping below is deliberately mechanical and one-to-one, with two kinds of
 * judgement recorded inline:
 *
 *  - **Collisions.** `CREATE`/`UPDATE`/`REMOVE` in `student.service.js` become
 *    `student.create`/`student.update`/`student.delete`, which already exist — the bug
 *    was that the call site used the bare word instead of the action that meant it.
 *  - **False positives.** `created` and `none` are not audit actions (they are a return
 *    value in `ensureSuperAdmin.js`), so they are left alone and reported as skipped.
 *
 * Run `find-invalid-audit-actions.mjs` afterwards; it should print zero.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRY = process.argv.includes('--dry');

/**
 * bare literal → dotted action.
 *
 * Keyed by the literal alone, which is safe only because every collision is a bare
 * generic verb that means the same thing wherever it appears (`ARCHIVE` on a school and on
 * a student both archive). Where a literal is genuinely ambiguous it is listed in
 * AMBIGUOUS and left for a human.
 */
const MAP = {
  // ── Student ──
  CREATE: 'student.create',
  UPDATE: 'student.update',
  REMOVE: 'student.delete',
  ARCHIVE: 'student.archive',
  RESTORE: 'student.restore',
  SUSPEND: 'student.suspend',
  UNSUSPEND: 'student.unsuspend',
  REACTIVATE: 'student.reactivate',
  PROMOTE: 'student.promote',
  GRADUATE: 'student.graduate',
  REPEAT: 'student.repeat_flag',
  CLEAR_REPEAT: 'student.repeat_clear',
  TRANSFER_CLASS: 'student.transfer_class',
  TRANSFER_OUT: 'student.transfer_out',
  REGENERATE_PAY_LINK: 'student.pay_link_regenerate',
  ADD_PARENT: 'student.parent_add',
  UPDATE_PARENT: 'student.parent_update',
  REMOVE_PARENT: 'student.parent_remove',
  SET_PRIMARY_PARENT: 'student.parent_primary_set',

  // ── Student bulk ──
  // Prefixed `bulk.` rather than `student.bulk_` so a bulk operation is greppable as one
  // family — the question asked of an audit log is usually "was this one student or the
  // whole school", and that is a prefix away.
  BULK_CREATE: 'bulk.student_create',
  BULK_UPDATE: 'bulk.student_update',
  BULK_ARCHIVE: 'bulk.student_archive',
  BULK_GRADUATE: 'bulk.student_graduate',
  BULK_PROMOTE: 'bulk.student_promote',
  BULK_VALIDATE: 'bulk.student_validate',
  BULK_STATUS: 'bulk.student_status',
  BULK_REGENERATE_PAY_LINK: 'bulk.student_pay_link_regenerate',

  // ── Payment plan ──
  CREATE_PAYMENT_PLAN: 'plan.create',
  UPDATE_PAYMENT_PLAN: 'plan.update',
  ACCEPT_PAYMENT_PLAN: 'plan.accept',
  CANCEL_PAYMENT_PLAN: 'plan.cancel',
  PREPAY_PAYMENT_PLAN: 'plan.prepay',
  APPLY_PAYMENT_TO_PLAN: 'plan.payment_applied',
  UPDATE_INSTALLMENT: 'plan.installment_update',
  REQUEST_PAYMENT_PLAN: 'plan.request',

  // ── Payment ──
  INITIATE_PAYMENT: 'payment.initiate',
  RECORD_MANUAL_PAYMENT: 'payment.record_manual',
  APPLY_PAYMENT_SETTLEMENT: 'payment.settlement_applied',

  // ── Analytics ──
  // A report being opened is a read, and the vocabulary already had `report.viewed` for
  // exactly this. Ten call sites had been inventing their own word for it.
  ANALYTICS_READ: 'report.viewed',

  // ── Email ──
  SEND_EMAIL: 'email.send',
  BULK_EMAIL: 'email.bulk_send',
  CANCEL_EMAIL_JOB: 'email.job_cancel',

  // ── School ──
  PROVISION: 'school.provision',
  PROVISION_SCHOOL: 'school.provision',
  JOIN_REQUEST: 'school.join_request',
  JOIN_APPROVED: 'school.join_approved',
  JOIN_REJECTED: 'school.join_rejected',

  // ── Assets ──
  // `settings.update` already existed and means "a platform setting changed"; a school's
  // logo is not a platform setting, and conflating the two makes the settings audit
  // answer a question it was never asked.
  UPDATE_LOGO: 'school.logo_update',
  UPDATE_STAMP: 'school.stamp_update',

  // Already dotted and valid, but spelled in a different case in places.
  WEBHOOK_RECEIVED: 'webhook.received',
};

/**
 * Per-file overrides, for the literals whose meaning depends on which service uses them.
 *
 * `ARCHIVE` appears in both `student.service.js` and `school.service.js`, and the bare
 * word is genuinely ambiguous between them. Keying the map by the literal alone sent
 * **both** to `student.archive`, which would have made an archived school indistinguishable
 * from an archived student in the audit log — the one thing an audit log exists to
 * prevent, introduced by the fix for it.
 *
 * So the override is keyed by file path, and it wins over `MAP`.
 */
const FILE_OVERRIDES = {
  'src/services/school.service.js': {
    ARCHIVE: 'school.archive',
  },
};

/**
 * Matched but deliberately not rewritten, with the reason. Listed rather than ignored so
 * a sweep that stops reporting them has to be a decision.
 */
const SKIP = {
  created: 'a return value in ensureSuperAdmin.js, not an audit action',
  none: 'a return value, not an audit action',
  plan_accept: 'a return value in whatsapp.service.js, not an audit action',
};

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
};

let total = 0;
const touched = [];
const skipped = new Set();

for (const file of walk(join(ROOT, 'src'))) {
  let source = readFileSync(file, 'utf8');
  const original = source;
  let count = 0;

  const relativePath = relative(ROOT, file).replace(/\\/g, '/');
  const overrides = FILE_OVERRIDES[relativePath] || {};

  for (const [from, to] of Object.entries(MAP)) {
    // `action: "X"` or `action: 'X'` or a backtick template with no interpolation.
    const pattern = new RegExp(
      `(action:\\s*)(['"\`])(${from})\\2(?![A-Za-z_])`,
      'g'
    );
    // Count the matches *before* rewriting. An earlier version incremented once per map
    // entry per file, which reported "50 substitutions" for a file with four of them —
    // a count that is wrong in the direction that makes a sweep look thorough.
    const hits = source.match(pattern);
    if (!hits) continue;

    const target = overrides[from] || to;
    count += hits.length;
    source = source.replace(pattern, (_match, lead, quote) => `${lead}${quote}${target}${quote}`);
  }

  for (const literal of Object.keys(SKIP)) {
    if (new RegExp(`action:\\s*['"\`]${literal}['"\`]`).test(source)) skipped.add(literal);
  }

  if (source !== original) {
    if (!DRY) writeFileSync(file, source, 'utf8');
    total += count;
    touched.push([relative(ROOT, file).replace(/\\/g, '/'), count]);
  }
}

console.log(`${DRY ? '[dry] ' : ''}${total} substitution(s) across ${touched.length} file(s):`);
for (const [name, count] of touched) console.log(`  ${name} — ${count}`);

if (skipped.size) {
  console.log('\nDeliberately skipped (not audit actions):');
  for (const literal of skipped) console.log(`  ${literal} — ${SKIP[literal]}`);
}