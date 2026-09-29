// SMS delivery diagnostic. Read-only: inspects stored SmsMessage rows and reports
// where in the pipeline each send stopped.
//
//   node scripts/diag-sms.js [msisdn]
//
// Sends nothing and spends no credits. A send that is genuinely missing from the
// database is a different problem from one stuck in `submitted`, and this
// separates the two before anyone spends a credit re-testing.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { SmsMessage } from '../src/models/smsMessageModel.js';
import { toGhanaE164 } from '../src/utils/phoneNumbers.js';

dotenv.config({ quiet: true });

const arg = process.argv[2];
const target = arg ? toGhanaE164(arg).e164 : null;

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

const filter = target ? { to: target } : {};
const rows = await SmsMessage.find(filter).sort({ createdAt: -1 }).limit(20);

console.log(`=== SmsMessage rows${target ? ` for ${target}` : ' (all)'} ===`);
if (rows.length === 0) console.log('(none - nothing was ever recorded)');

for (const m of rows) {
  const ageMin = ((Date.now() - m.createdAt.getTime()) / 60000).toFixed(0);
  console.log('');
  console.log(`  created    : ${m.createdAt?.toISOString()}  (${ageMin} min ago)`);
  console.log(`  status     : ${m.status}`);
  console.log(`  provider   : ${m.provider}`);
  console.log(`  msg id     : ${m.providerMessageId || '(none - gateway never returned one)'}`);
  console.log(`  to         : ${m.to}`);
  console.log(`  delivered  : ${m.deliveredAt ? m.deliveredAt.toISOString() : '(never)'}`);
  console.log(`  failReason : ${m.failureReason || '(none)'}`);
  console.log(`  body       : ${String(m.message || '').slice(0, 90)}`);
  console.log(`  segments   : ${m.segments}`);
}

console.log('\n=== status distribution (all rows) ===');
const dist = await SmsMessage.aggregate([
  { $group: { _id: '$status', count: { $sum: 1 } } },
  { $sort: { count: -1 } },
]);
if (dist.length === 0) console.log('(none)');
for (const s of dist) console.log(`  ${String(s._id).padEnd(12)} ${s.count}`);

console.log('\n=== rows with no providerMessageId ===');
const noId = await SmsMessage.countDocuments({ providerMessageId: null });
console.log(`  ${noId} - these never reached the gateway`);

console.log('\n=== stuck in submitted (awaiting DLR webhook) ===');
const stuck = await SmsMessage.find({ status: 'submitted' }).sort({ createdAt: -1 }).limit(10);
if (stuck.length === 0) console.log('  (none)');
for (const m of stuck) {
  const ageMin = ((Date.now() - m.createdAt.getTime()) / 60000).toFixed(0);
  console.log(`  ${m.providerMessageId?.slice(0, 8)}  ${ageMin} min  ${m.status}`);
}

await mongoose.disconnect();
