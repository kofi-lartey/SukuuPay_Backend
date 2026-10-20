// `applyPaymentToStudent` — the one place that decides what "settled" means.
//
//   npm test
//
// The bug this guards against was invisible in the unit tests and obvious in
// the database: `findByIdAndUpdate` does not run the Student model's
// `pre("save")` hook, so the `balance = totalOwed - totalPaid` recompute
// never happened on the payment path. The old code wrote `balance` back only
// when it went *negative* — the clamp case — so on an ordinary payment the
// balance was computed and then discarded.
//
// The visible effect: a parent paid GH¢25, and the portal went on showing
// GH¢100 owing, on every gateway.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

const { Student } = await import('../src/models/studentModel.js');
const { applyPaymentToStudent } = await import('../src/services/paymentApplication.service.js');

const originalFindByIdAndUpdate = Student.findByIdAndUpdate;
const originalUpdateOne = Student.updateOne;

after(() => {
  Student.findByIdAndUpdate = originalFindByIdAndUpdate;
  Student.updateOne = originalUpdateOne;
});

/**
 * Captures the update that `applyPaymentToStudent` sends, and answers with a
 * document as MongoDB would after applying it.
 */
const captureUpdate = (document) => {
  const captured = { filter: null, update: null, options: null };
  Student.findByIdAndUpdate = async (filter, update, options) => {
    captured.filter = filter;
    captured.update = update;
    captured.options = options;
    return document;
  };
  Student.updateOne = async () => ({ nModified: 0 });
  return captured;
};

describe('applyPaymentToStudent', () => {
  test('the balance is written in the same update as totalPaid', async () => {
    // The regression: the balance must be *persisted*, not merely computed.
    // A pipeline update is the only way to do both atomically — a second
    // write would leave a window where totalPaid and balance disagree.
    const captured = captureUpdate({
      balance: 7500,
      totalPaid: 2500,
      totalOwed: 10000,
    });

    await applyPaymentToStudent('student-1', 2500);

    assert.ok(Array.isArray(captured.update), 'the update is a pipeline');
    assert.equal(captured.options.updatePipeline, true, 'and is declared as one');

    const set = captured.update[0].$set;
    assert.ok(set.totalPaid, 'totalPaid is set');
    assert.ok(set.balance, 'balance is set');
  });

  test('the balance is recomputed from totalOwed and totalPaid, not decremented', async () => {
    // A stored balance that is already stale cannot be decremented into the
    // right answer. Recomputing from the source-of-truth fields is what the
    // Student model does on every other write, and it self-heals.
    const captured = captureUpdate({ balance: 7500, totalPaid: 2500, totalOwed: 10000 });

    await applyPaymentToStudent('student-1', 2500);

    const balance = captured.update[0].$set.balance;
    // The expression is a pipeline, not a value, so it is asserted
    // structurally: it subtracts the new totalPaid from totalOwed, and floors
    // at zero.
    const serialised = JSON.stringify(balance);
    assert.match(serialised, /totalOwed/, 'it reads totalOwed');
    assert.match(serialised, /totalPaid/, 'it reads totalPaid');
    assert.match(serialised, /\$max/, 'and it is clamped at zero');
  });

  test('an overpayment settles the fees and leaves the surplus visible', async () => {
    // totalOwed 10000, but 12000 paid: the fees are settled, the balance is
    // zero, and the extra 2000 is still in totalPaid where a bursar can see
    // it — rather than silently discarded.
    const captured = captureUpdate({ balance: 0, totalPaid: 12000, totalOwed: 10000 });

    const result = await applyPaymentToStudent('student-1', 12000);

    assert.equal(result.clampedAtZero, true);
    assert.equal(result.after.balance, 0);
    assert.equal(result.after.totalPaid, 12000);
    assert.ok(captured.update, 'the update was sent');
  });

  test('a refund moves totalPaid back down', async () => {
    // A refund row carries a negative amount, and must move `totalPaid` back
    // down and the balance back up.
    //
    // The assertion is on the update expression, not on the returned
    // document: the stub does not run MongoDB's pipeline, so the document it
    // hands back says nothing about what the database would have computed.
    const captured = captureUpdate({ balance: 10000, totalPaid: 0, totalOwed: 10000 });

    await applyPaymentToStudent('student-1', -2500);

    const set = captured.update[0].$set;
    assert.match(
      JSON.stringify(set.totalPaid),
      /-2500/,
      'the signed amount is carried into the update'
    );
  });

  test('a zero amount does nothing at all', async () => {
    const captured = captureUpdate({ balance: 10000, totalPaid: 0, totalOwed: 10000 });

    const result = await applyPaymentToStudent('student-1', 0);

    assert.equal(result, null);
    assert.equal(captured.update, null, 'no update was sent');
  });

  test('a missing student is not an error', async () => {
    Student.findByIdAndUpdate = async () => null;
    Student.updateOne = async () => ({ nModified: 0 });

    const result = await applyPaymentToStudent('student-1', 2500);

    assert.equal(result, null);
  });
});
