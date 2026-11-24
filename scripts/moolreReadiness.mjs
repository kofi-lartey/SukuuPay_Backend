// Moolre readiness check.
//
//   npm run moolre:check
//
// **Present is not working.** A credential in the environment can be wrong,
// unactivated, or issued for a different service, and every one of those looks
// identical to a working credential until something is sent. This script
// asks Moolre what it thinks of the credentials, using read-only endpoints —
// no message is sent, no payment is initiated, nothing is charged.
//
// It answers the four questions that decide whether the integration can go
// live:
//
//   1. Does the wallet exist, is it activated, and does it have a callback?
//   2. Does the payment API key work on the payment endpoints?
//   3. Does the SMS VAS key work on the SMS endpoints?
//   4. Does the WhatsApp VAS key work on the WhatsApp endpoints?
//
// Exit code is 0 when everything is ready, 1 otherwise — so it can gate a
// deploy.
import {
  MOOLRE_ACCOUNT_NUMBER,
  MOOLRE_API_KEY,
  MOOLRE_API_USER,
  MOOLRE_BASE_URL,
  MOOLRE_PUBLIC_KEY,
  MOOLRE_SMS_BASE_URL,
  MOOLRE_SMS_SENDER_ID,
  MOOLRE_SMS_VASKEY,
  MOOLRE_WHATSAPP_VASKEY,
} from '../src/config/env.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const post = async (path, headers, body, base = MOOLRE_BASE_URL) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 200) } };
  }
};

const get = async (path, headers) => {
  const res = await fetch(`${MOOLRE_BASE_URL}${path}`, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 200) } };
  }
};

console.log(`\nMoolre readiness — ${MOOLRE_BASE_URL} — account ${MOOLRE_ACCOUNT_NUMBER}\n`);

// The identifiers to match against the Moolre portal.
//
// Every failure below is a *balance or state* failure, and the balance is
// read from a specific account. If the portal shows credits that the API
// does not, the two are looking at different accounts or different services,
// and the quickest way to settle it is to compare these three values against
// the portal's Services page.
console.log(`  API user        : ${MOOLRE_API_USER}`);
console.log(`  account number  : ${MOOLRE_ACCOUNT_NUMBER}`);
console.log(`  public key      : ${(MOOLRE_PUBLIC_KEY || '').slice(0, 16)}…`);
console.log('');

// ── 1. The wallet ────────────────────────────────────────────────────────
console.log('── Wallet ───────────────────────────────────────────────────────\n');

if (!MOOLRE_ACCOUNT_NUMBER) {
  check('MOOLRE_ACCOUNT_NUMBER is set', false, 'not set');
} else {
  const wallet = await post(
    '/open/account/status',
    { 'X-API-USER': MOOLRE_API_USER || '', 'X-API-PUBKEY': MOOLRE_PUBLIC_KEY || '' },
    { type: 1, accountnumber: MOOLRE_ACCOUNT_NUMBER }
  );

  const found = wallet.body?.code === 'SW01';
  check('the wallet exists and the payment key authenticates', found, wallet.body?.code || wallet.body?.message);

  // `activated` is absent on the sandbox — the sandbox wallet is not gated on
  // activation, so an absent flag is "not applicable" rather than "off". Only
  // an explicit `0` is a failure.
  const activatedFlag = wallet.body?.data?.activated;
  const activated = activatedFlag === undefined || activatedFlag === null
    ? null
    : String(activatedFlag) === '1';
  check(
    'the wallet is activated',
    activated === null || activated,
    activated === null
      ? 'not gated on activation (sandbox)'
      : `activated=${activatedFlag}`
  );

  const callback = String(wallet.body?.data?.callback || '').trim();
  check(
    'a callback URL is registered on the wallet',
    Boolean(callback),
    callback || 'none — Moolre has nowhere to POST payment results'
  );

  const balance = Number(wallet.body?.data?.balance ?? 0);
  check(
    'the wallet has money in it to collect into',
    balance > 0,
    `balance=${balance} — this is the settlement float, NOT a message bundle`
  );
}

// ── 2. Payments ──────────────────────────────────────────────────────────
console.log('\n── Payments ──────────────────────────────────────────────────────\n');

const paymentAuth = await post(
  '/open/transact/status',
  { 'X-API-USER': MOOLRE_API_USER || '', 'X-API-PUBKEY': MOOLRE_PUBLIC_KEY || '' },
  { type: 1, idtype: 1, id: 'READINESS-CHECK-NO-SUCH-REFERENCE', accountnumber: MOOLRE_ACCOUNT_NUMBER }
);
// A bogus reference answers "transaction not found" — which is the proof that
// the endpoint authenticated us.
check(
  'the payment API works with X-API-PUBKEY',
  paymentAuth.body?.code === 'SS07' || paymentAuth.body?.code === 'SS01',
  paymentAuth.body?.code || paymentAuth.body?.message
);

const privateKeyOnPayments = await post(
  '/open/transact/status',
  { 'X-API-USER': MOOLRE_API_USER || '', 'X-API-KEY': MOOLRE_API_KEY || '' },
  { type: 1, idtype: 1, id: 'READINESS-CHECK-NO-SUCH-REFERENCE', accountnumber: MOOLRE_ACCOUNT_NUMBER }
);
// The private key is rejected on the payment endpoints — they are on the
// *public* key. This is informational rather than a pass/fail check, because
// the sandbox accepts both keys: it is the live environment that enforces the
// distinction, and the point of the line is to show which one is in force.
console.log(
  `      -> on ${MOOLRE_BASE_URL.includes('sandbox') ? 'sandbox' : 'live'}, the private key answers ` +
    `${privateKeyOnPayments.body?.code} on /open/transact/status`
);

// The private key has its own job — account updates and transfers — and those
// endpoints are where it either works or does not. `transact/validate` is a
// read-only name lookup, so it is the safe way to ask.
//
// AIN01 (or IN01) means the key is not recognised on this account at all, as
// opposed to SVD09, which means it authenticated and the *name* was not found.
const privateKeyProbe = await post(
  '/open/transact/validate',
  { 'X-API-USER': MOOLRE_API_USER || '', 'X-API-KEY': MOOLRE_API_KEY || '' },
  {
    type: 1,
    receiver: '0240000000',
    channel: 6,
    currency: 'GHS',
    accountnumber: MOOLRE_ACCOUNT_NUMBER,
  }
);
const privateKeyWorks = !['AIN01', 'IN01'].includes(privateKeyProbe.body?.code);
console.log(
  `      -> the private key ${privateKeyWorks ? 'authenticates' : 'is REJECTED (AIN01)'} ` +
    `on this account's account/transfer endpoints`
);
if (!privateKeyWorks) {
  console.log(
    '      -> the private key is only needed for account updates and transfers;' +
      ' payments and status work on the public key alone'
  );
}

const smsKeyRejected = await post(
  '/open/sms/status',
  { 'X-API-VASKEY': MOOLRE_SMS_VASKEY || '' },
  { type: 2 },
  MOOLRE_SMS_BASE_URL
);
if (smsKeyRejected.body?.code !== 'ASMQ03' && MOOLRE_WHATSAPP_VASKEY) {
  const alt = await post(
    '/open/sms/status',
    { 'X-API-VASKEY': MOOLRE_WHATSAPP_VASKEY },
    { type: 2 }
  );
  if (alt.body?.code === 'ASMQ03') {
    console.log(
      '      -> the WhatsApp VAS key DOES work on the SMS endpoint: set MOOLRE_SMS_VASKEY to the same value'
    );
  }
}

// ── 3. SMS ───────────────────────────────────────────────────────────────
console.log('\n── SMS ───────────────────────────────────────────────────────────\n');

if (!MOOLRE_SMS_VASKEY) {
  check('MOOLRE_SMS_VASKEY is set', false, 'not set');
} else {
  const sms = await post('/open/sms/status', { 'X-API-VASKEY': MOOLRE_SMS_VASKEY }, { type: 2 }, MOOLRE_SMS_BASE_URL);
  check(
    'the SMS VAS key authenticates',
    sms.body?.code === 'ASMQ03',
    sms.body?.code || sms.body?.message
  );
  if (sms.body?.code === 'ASMQ03') {
    const balance = Number(sms.body?.data?.balance ?? 0);
    check('this SMS service has message credit', balance > 0, `balance=${balance} — the API reads the balance of the service this VAS key belongs to`);  }
  // The sender ID is checked against Moolre, not against the environment.
  //
  // An env var that holds a sender ID proves nothing: Moolre has to have that
  // ID *registered and approved* for the account, and an unapproved one is not
  // an API error — the carrier drops the message. The earlier version of this
  // check only asked whether the variable was set, and reported "approved" for
  // an ID Moolre had never heard of.
  const senderIdStatus = await post(
    '/open/sms/status',
    { 'X-API-VASKEY': MOOLRE_SMS_VASKEY },
    { type: 1, senderid: MOOLRE_SMS_SENDER_ID },
    MOOLRE_SMS_BASE_URL
  );
  const approval = senderIdStatus.body?.data?.approval;
  check(
    'the sender ID is registered and approved with Moolre',
    approval === 'Approved',
    approval ? `approval=${approval}` : senderIdStatus.body?.code || senderIdStatus.body?.message
  );

  if (approval && approval !== 'Approved') {
    const listed = await post(
      '/open/sms/status',
      { 'X-API-VASKEY': MOOLRE_SMS_VASKEY },
      { type: 7 },
      MOOLRE_SMS_BASE_URL
    );
    const ids = Array.isArray(listed.body?.data) ? listed.body.data : [];
    console.log(
      `      -> this account has ${ids.length} registered sender ID(s)` +
        (ids.length
          ? `: ${ids.map((i) => `${i.senderid} (${i.approval})`).join(', ')}`
          : ' — register "SukuuPay" in the Moolre portal before sending')
    );
  }
}

// ── 4. WhatsApp ──────────────────────────────────────────────────────────
console.log('\n── WhatsApp ──────────────────────────────────────────────────────\n');

if (!MOOLRE_WHATSAPP_VASKEY) {
  check('MOOLRE_WHATSAPP_VASKEY is set', false, 'not set — the WhatsApp service has its own VAS key');
} else {
  const wa = await get('/open/whatsapp/template', { 'X-API-VASKEY': MOOLRE_WHATSAPP_VASKEY });
  check(
    'the WhatsApp VAS key authenticates',
    wa.body?.code === 'WAS200',
    wa.body?.code || wa.body?.message
  );
  if (wa.body?.code === 'WAS200') {
    const templates = Array.isArray(wa.body?.data) ? wa.body.data : [];
    const approved = templates.filter((t) => t?.status === 'APPROVED');
    check(
      'there is at least one approved template',
      approved.length > 0,
      `${approved.length} approved of ${templates.length}`
    );
  }
}

// ── Summary ──────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(62)}`);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nNot ready:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
console.log('');

process.exit(failed.length ? 1 : 0);
