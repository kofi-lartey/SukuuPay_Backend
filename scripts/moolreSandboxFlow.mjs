// The Moolre payment flow, end to end, against the sandbox.
//
//   node scripts/moolreSandboxFlow.mjs
//
// The live wallet is not activated, so the sandbox is where this can be
// proved. The sandbox wallet has test credit, a registered callback, and
// `active: 1`.
//
// It runs the real client — `utils/moolreClient.js` — not a hand-rolled
// request, so what is exercised is the code the platform will actually use.
//
// Nothing is delivered to a handset: the sandbox simulates the OTP and the
// USSD prompt, and the number below is a synthetic one.
import {
  initiatePayment,
  verifyTransaction,
  createCheckoutSession,
  normaliseChannel,
} from '../src/utils/moolreClient.js';
import { MOOLRE_ACCOUNT_NUMBER, MOOLRE_BASE_URL } from '../src/config/env.js';

const PAYER = process.env.SANDBOX_PAYER_PHONE || '0240000000';
const AMOUNT = '25.00';

const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

console.log(`\nMoolre sandbox flow — ${MOOLRE_BASE_URL} — account ${MOOLRE_ACCOUNT_NUMBER}`);
console.log(`Payer ${PAYER}, amount GH₵ ${AMOUNT}\n`);

const stamp = Date.now().toString(36).toUpperCase();

// ── 1. The channel the parent picked maps to a code Moolre routes ────────
console.log('── 1. Channel ──────────────────────────────────────────────────────\n');

for (const [name, code] of [['MTN', '13'], ['Telecel', '6'], ['AirtelTigo', '7']]) {
  check(`${name} → ${code}`, normaliseChannel(name) === code);
}

// ── 2. The USSD push ─────────────────────────────────────────────────────
console.log('\n── 2. USSD push ───────────────────────────────────────────────────\n');

const refDirect = `SUK-SBX-DIRECT-${stamp}`;
let initiated = null;

try {
  initiated = await initiatePayment({
    amount: Number(AMOUNT),
    phone: PAYER,
    network: 'MTN',
    reference: refDirect,
    description: 'SukuuPay sandbox check',
    // Sandbox only, and the client enforces that from the base URL. The
    // sandbox OTP is a *simulation* with no code to submit, so this is the
    // documented way to reach the prompt.
    skipOtp: true,
  });
  check(
    'the prompt was requested',
    initiated.status === 'requested',
    `status=${initiated.status} transactionId=${initiated.transactionId}`
  );
} catch (error) {
  check('the prompt was requested', false, error.message);
}

// ── 3. The status lookup on that reference ───────────────────────────────
console.log('\n── 3. Status lookup ───────────────────────────────────────────────\n');

if (initiated?.transactionId) {
  try {
    const verification = await verifyTransaction({ reference: refDirect });
    check(
      'the status lookup answers',
      ['pending', 'success', 'failed'].includes(verification.status),
      `status=${verification.status} txstatus=${verification.txStatus} amount=${verification.amount}`
    );
  } catch (error) {
    check('the status lookup answers', false, error.message);
  }
}

// ── 4. The OTP path: the real flow a parent goes through ────────────────
console.log('\n── 4. OTP path (the real parent flow) ────────────────────────────\n');

const refOtp = `SUK-SBX-OTP-${stamp}`;

try {
  const first = await initiatePayment({
    amount: Number(AMOUNT),
    phone: PAYER,
    network: 'MTN',
    reference: refOtp,
    description: 'SukuuPay sandbox check',
  });
  check(
    'the first call asks for phone verification',
    first.status === 'otp_required',
    `status=${first.status} — Moolre wants the OTP before it will send the prompt`
  );

  // The sandbox simulates the OTP, so any code is accepted here. In production
  // this is the code Moolre texted to the payer.
  const second = await initiatePayment({
    amount: Number(AMOUNT),
    phone: PAYER,
    network: 'MTN',
    reference: refOtp,
    description: 'SukuuPay sandbox check',
    otpCode: '123456',
  });
  check(
    'the code is accepted and the prompt goes out',
    second.status === 'requested',
    `status=${second.status} transactionId=${second.transactionId}`
  );
} catch (error) {
  check('the OTP path completes', false, error.message);
}

// ── 5. The hosted-checkout fallback ──────────────────────────────────────
console.log('\n── 5. Hosted checkout ─────────────────────────────────────────────\n');

try {
  const session = await createCheckoutSession({
    amount: Number(AMOUNT),
    reference: `SUK-SBX-LINK-${stamp}`,
    redirectUrl: 'https://sukuupay.netlify.app/pay/STU-SANDBOX',
    email: 'sandbox@sukuupay.test',
    callbackUrl: 'https://sukuupay-backend.onrender.com/api/pay/webhook/moolre',
  });
  check(
    'a checkout URL is returned',
    typeof session.checkoutUrl === 'string' && session.checkoutUrl.startsWith('https://'),
    session.checkoutUrl
  );
} catch (error) {
  check('a checkout URL is returned', false, error.message);
}

// ── 6. A duplicate reference is refused ──────────────────────────────────
console.log('\n── 6. Idempotency ────────────────────────────────────────────────\n');

try {
  await initiatePayment({
    amount: Number(AMOUNT),
    phone: PAYER,
    network: 'MTN',
    reference: refDirect, // already used above
    description: 'SukuuPay sandbox check',
  });
  check('a duplicate reference is refused', false, 'Moolre accepted a used reference');
} catch (error) {
  check(
    'a duplicate reference is refused',
    /unique|duplicate|exists/i.test(error.message),
    error.message
  );
}

console.log('');
