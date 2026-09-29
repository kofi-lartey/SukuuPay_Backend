// Live Arkesel send test. Sends ONE real SMS to the number given on the command
// line and reports exactly what the provider said.
//
//   node scripts/test-sms.js 233557655008 "optional message"
//
// This spends a real credit and delivers a real message to a real handset. It is
// a script rather than a test case because it has a side effect on the outside
// world — `npm test` must stay free of that.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { sendArkeselSms, getArkeselConfigStatus, validateSenderId } from '../src/utils/arkeselApi.js';
import { sendSms } from '../src/utils/smsService.js';
import { School } from '../src/models/schoolModel.js';
import { toGhanaE164 } from '../src/utils/phoneNumbers.js';
import { ARKESEL_API_URL, ARKESEL_SENDER_ID } from '../src/config/env.js';

dotenv.config({ quiet: true });

const to = process.argv[2];
const customMessage = process.argv[3];

if (!to) {
  console.error('usage: node scripts/test-sms.js <msisdn> [message]');
  process.exit(1);
}

const normalised = toGhanaE164(to);
console.log('=== Arkesel live send test ===');
console.log('recipient   :', to, '->', normalised.e164, normalised.valid ? '(valid)' : `(INVALID: ${normalised.reason})`);
console.log('endpoint    :', ARKESEL_API_URL);
console.log('sender id   :', ARKESEL_SENDER_ID, '->', JSON.stringify(validateSenderId(ARKESEL_SENDER_ID)));
console.log('config      :', JSON.stringify(getArkeselConfigStatus(), null, 2));

if (!normalised.valid) {
  console.log('\nABORTED: recipient is not a valid Ghanaian MSISDN. Nothing was sent.');
  process.exit(1);
}

const message = customMessage || 'SukuuPay SMS test: your messaging gateway is working.';

// Balance check before spending anything.
//
// `main_balance` / `sms_balance` in the send response are the only balance
// figures Arkesel exposes on this path, and they are returned AFTER a send is
// accepted — so an exhausted account is discovered by sending, not by asking.
// The V2 balance route is not publicly documented (GET /api/v2/sms/balance
// answers 405 for POST and 404 does not exist), so there is no pre-flight
// option. This block therefore reads the balances from a send response and
// reports them, rather than pretending to a pre-flight check it cannot do.
console.log('\n--- 0. balance note ---');
console.log('  Arkesel exposes no documented pre-flight balance endpoint on V2.');
console.log('  Balances below are read from the send response after the fact.');

console.log('\n--- 1. direct provider call ---');
try {
  const result = await sendArkeselSms({
    to: normalised.e164,
    message,
    senderId: ARKESEL_SENDER_ID,
  });
  console.log('ACCEPTED');
  console.log('  providerMessageId :', result.providerMessageId);
  console.log('  creditsUsed       :', result.creditsUsed);
  console.log('  raw response      :', JSON.stringify(result.raw));

  // Arkesel returns account balances on the send response. Worth surfacing: the
  // response also echoes the recipient in NATIONAL format ("233557655008", no
  // leading +) even though we sent E.164, so this doubles as confirmation that
  // the number we normalised is the number Arkesel holds.
  const raw = result.raw || {};
  if (raw.sms_balance !== undefined || raw.main_balance !== undefined) {
    console.log('  sms_balance       :', raw.sms_balance);
    console.log('  main_balance      :', raw.main_balance);
    if (Number(raw.sms_balance) <= 5) {
      console.log('  WARNING           : sms_balance is low — sends will start failing once it hits 0');
    }
  }
  const echoed = Array.isArray(raw.data) ? raw.data[0]?.recipient : null;
  if (echoed) {
    console.log('  recipient echoed  :', echoed, '(national format)');
  }
} catch (error) {
  console.log('FAILED');
  console.log('  code       :', error.code);
  console.log('  message    :', error.message);
  console.log('  httpStatus :', error.providerStatus);
  console.log('  body       :', JSON.stringify(error.providerBody));
}

console.log('\n--- 2. through sendSms (the real call path, writes an SmsMessage row) ---');
await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
const school = await School.findOne({});
if (!school) {
  console.log('  skipped: no school in the database. Run `npm run seed:apply` first.');
} else {
  const result = await sendSms({
    to: normalised.e164,
    message: `${message} (via sendSms)`,
    school,
    purpose: 'general',
  });
  console.log('  sent             :', result.sent);
  console.log('  provider         :', result.provider);
  console.log('  providerMessageId:', result.providerMessageId);
  console.log('  reason           :', result.reason || '(none)');

  if (result.messageId) {
    const { SmsMessage } = await import('../src/models/smsMessageModel.js');
    const row = await SmsMessage.findById(result.messageId);
    console.log('  persisted row    :', row ? `status=${row.status} provider=${row.provider} id=${row.providerMessageId}` : 'NOT FOUND');
    console.log('  (status stays "submitted" until the DLR webhook confirms delivery)');
  }
}

await mongoose.disconnect();
console.log('\ndone. The delivery report will arrive on the Arkesel DLR webhook once the carrier responds.');
