/**
 * Confirms `returnDocument: 'after'` behaves as `new: true` did on this mongoose version.
 *
 * Run: node scripts/check-return-document.mjs
 *
 * The codebase used `new: true` in thirteen `findOneAndUpdate`/`findOneAndReplace` call
 * sites and mongoose 9 deprecated it. The replacement is only safe if it is genuinely
 * equivalent — if it silently returned the *pre*-update document, every one of those
 * thirteen sites would keep working and start returning stale data, which is the worst
 * possible outcome from a "just silence the warning" change.
 *
 * Needs a live MongoDB, so it is not part of `npm test`.
 */
import mongoose from 'mongoose';

const MONGO = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/deprec_check';

const schema = new mongoose.Schema({ n: Number });
const Probe = mongoose.model('ReturnDocumentProbe', schema);

let failed = false;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failed = true;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${actual} (want ${expected})`);
};

try {
  await mongoose.connect(MONGO);
  await Probe.deleteMany({});

  await Probe.create({ n: 1 });

  const after = await Probe.findOneAndUpdate(
    { n: 1 },
    { $set: { n: 2 } },
    { returnDocument: 'after' }
  );
  check("returnDocument:'after' returns the updated document", after?.n, 2);

  const before = await Probe.findOneAndUpdate(
    { n: 2 },
    { $set: { n: 3 } },
    { returnDocument: 'before' }
  );
  check("returnDocument:'before' returns the original", before?.n, 2);

  const legacy = await Probe.findOneAndUpdate({ n: 3 }, { $set: { n: 4 } }, { new: true });
  check('new:true still works (it is deprecated, not removed)', legacy?.n, 4);

  await Probe.deleteMany({});
} catch (error) {
  console.error('Could not run the probe:', error.message);
  failed = true;
} finally {
  await mongoose.disconnect().catch(() => {});
}

process.exit(failed ? 1 : 0);