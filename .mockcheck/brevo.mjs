// Checks the Brevo credential guard.
//
// The bug this exists to prevent: a Brevo SMTP key (xsmtps-…) pasted into
// BREVO_API_KEY. The v3 REST API answers that with a bare
// `401 {"message":"Key not found"}`, which reads exactly like an expired key and
// sends you hunting through the deployment's environment settings instead of
// telling you the credential is the wrong kind.
//
// `validateBrevoApiKey` is tested directly rather than through `sendEmail`,
// because importing the service re-reads `.env` and would swap the value under
// test back to the live one.
import { validateBrevoApiKey } from '../src/services/emailService.js';

let pass = 0;
let fail = 0;

const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  OK   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const rejected = [
  { name: 'undefined key', key: undefined, expected: 'EMAIL_NOT_CONFIGURED' },
  { name: 'null key', key: null, expected: 'EMAIL_NOT_CONFIGURED' },
  { name: 'empty key', key: '', expected: 'EMAIL_NOT_CONFIGURED' },
  {
    // The live key, with its real `xsmtpsib-` prefix. An earlier guard tested
    // for `xsmtps-` and so missed this, downgrading a precise diagnosis to
    // "malformed" — the exact outcome the check exists to prevent. Keep this
    // case: it is the one that actually shipped.
    name: 'SMTP key, real xsmtpsib- prefix',
    key: 'xsmtpsib-ib9d881afaf3-b0f1c73cf1b2a17e2ac91-abcdefghijklmnop',
    expected: 'EMAIL_KEY_IS_SMTP_NOT_API',
  },
  {
    name: 'SMTP key, xsmtps- prefix',
    key: 'xsmtps-ib9d881afaf3-b0f1c73cf1b2a17e2ac91-H2X9k2LpQ',
    expected: 'EMAIL_KEY_IS_SMTP_NOT_API',
  },
  { name: 'SMTP key, uppercase prefix', key: 'XSMTPSIB-abc123', expected: 'EMAIL_KEY_IS_SMTP_NOT_API' },
  { name: 'SendGrid key', key: 'SG.abc123.def456', expected: 'EMAIL_KEY_MALFORMED' },
  { name: 'bare token', key: '1234567890abcdef', expected: 'EMAIL_KEY_MALFORMED' },
  { name: 'placeholder from .env template', key: 'your-brevo-api-key', expected: 'EMAIL_KEY_MALFORMED' },
];

for (const { name, key, expected } of rejected) {
  const result = validateBrevoApiKey(key);
  if (!result) {
    check(name, false, 'accepted a key it should have rejected');
    continue;
  }
  check(name, result.code === expected, `got ${result.code}, expected ${expected}`);
  // A diagnostic that echoes the secret is worse than no diagnostic.
  if (key && String(result.message).includes(key)) {
    check(`${name} — message does not leak the key`, false, 'secret echoed in the message');
  }
}

const accepted = [
  { name: 'well-formed API key', key: 'xkeys-abc123-real-looking-key' },
  { name: 'API key with the full shape', key: 'xkeys-1a2b3c4d5e6f-real-key-value-0123456789abcdef' },
];

for (const { name, key } of accepted) {
  const result = validateBrevoApiKey(key);
  check(name, result === null, result ? `wrongly rejected with ${result.code}` : '');
}

// Every rejection must carry an actionable message, since this text is the only
// clue an operator gets before the provider's own 401.
for (const { name, key } of rejected) {
  const result = validateBrevoApiKey(key);
  check(`${name} — message is actionable`, (result?.message?.length ?? 0) > 30);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
