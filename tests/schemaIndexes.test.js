// Index declarations across every model.
//
//   npm test
//
// Why this suite exists. Mongoose warns "Duplicate schema index on {...}" when a field
// carries `index: true` and the same key is also declared in `schema.index()`, and it
// **keeps the first definition and discards the second's options**. So a duplicate
// does not merely add noise — it silently throws away `sparse`, `unique` or
// `partialFilterExpression`, and the index that gets built is the wrong one.
//
// That is not hypothetical. Four of these were shipped by this work:
//
//   - `Payment.refundOfPaymentId` — the field's bare `index: true` won and
//     `{ sparse: true }` was dropped, so every payment document on the platform got a
//     null entry in an index they never appear in.
//   - `User.authProvider` — the partial filter was dropped, turning an index over the
//     handful of Google-linked accounts into a full one over every user.
//   - `ImpersonationSession.superAdminId` — the partial filter was dropped, and that is
//     the index on the impersonation hot path, whose entire design rationale is that it
//     holds only *open* sessions and so stays tiny.
//   - `School.onboardingCompletedAt` — harmless, but dead weight.
//
// The warning is easy to miss in a long startup log next to other deprecation noise,
// and nothing fails: the model works, the queries work, and the index is quietly the
// wrong one. Hence a test rather than a habit.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const MODELS = [
  '../src/models/paymentModel.js',
  '../src/models/userModel.js',
  '../src/models/schoolModel.js',
  '../src/models/ImpersonationSession.js',
  '../src/models/PlatformLedger.js',
  '../src/models/PlatformAnnouncement.js',
  '../src/models/DisbursementBatch.js',
  '../src/models/studentModel.js',
  '../src/models/AuditLog.js',
];

/** Load a module and pick its exported Mongoose model, whatever that export is called. */
const loadModel = async (specifier) => {
  const module = await import(specifier);
  const name = Object.keys(module).find((key) => module[key]?.schema?.indexes);

  assert.ok(name, `${specifier} exports no Mongoose model`);

  return module[name];
};

describe('no model declares the same index twice', () => {
  for (const specifier of MODELS) {
    test(specifier.replace('../src/models/', ''), async () => {
      const model = await loadModel(specifier);

      const counts = new Map();

      for (const [fields] of model.schema.indexes()) {
        // Keyed on the field set alone, because that is what Mongoose compares: two
        // declarations differing only in options are still the same index, and it is
        // the *options* that get discarded.
        const key = JSON.stringify(fields);
        counts.set(key, (counts.get(key) || 0) + 1);
      }

      const duplicates = [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([key]) => key);

      assert.deepEqual(
        duplicates,
        [],
        `${model.modelName} declares these indexes more than once — Mongoose keeps the first and discards the rest's options (sparse/unique/partialFilterExpression)`
      );
    });
  }
});

describe('the indexes whose options were being lost are intact', () => {
  /**
   * Not a duplicate check — a check that the *option* survived. A model can have one
   * correct declaration and still be missing the constraint, and these three are the
   * ones whose purpose is a constraint rather than speed.
   */
  test('Payment.refundOfPaymentId is sparse', async () => {
    const model = await loadModel('../src/models/paymentModel.js');
    const index = model.schema.indexes().find(([fields]) => fields.refundOfPaymentId === 1);

    assert.ok(index, 'the over-refund guard needs this index');
    assert.equal(index[1].sparse, true, 'without sparse, every payment stores a null in it');
  });

  test('User.providerId is unique AND sparse', async () => {
    const model = await loadModel('../src/models/userModel.js');
    const index = model.schema.indexes().find(([fields]) => fields.providerId === 1);

    assert.ok(index, 'one Google identity must map to one account');
    assert.equal(index[1].unique, true, 'unique is what stops a second account claiming it');
    assert.equal(
      index[1].sparse,
      true,
      'without sparse, the second password-only account ever created collides on null'
    );
  });

  test('User.authProvider is a partial index on google accounts', async () => {
    const model = await loadModel('../src/models/userModel.js');
    const index = model.schema.indexes().find(
      ([fields, options]) => fields.authProvider === 1 && options?.partialFilterExpression
    );

    assert.ok(index, 'the console filters by provider; the partial filter is what keeps it small');
    assert.equal(index[1].partialFilterExpression.authProvider, 'google');
  });

  test('ImpersonationSession.superAdminId is partial on open sessions', async () => {
    const model = await loadModel('../src/models/ImpersonationSession.js');
    const index = model.schema.indexes().find(
      ([fields, options]) =>
        fields.superAdminId === 1 && options?.partialFilterExpression
    );

    // This is the impersonation hot path: the middleware resolves the live session on
    // every authenticated admin request. The index is only cheap because it holds
    // open sessions, and normally there are zero or one.
    assert.ok(index, 'the live-session lookup needs this index');
    assert.deepEqual(index[1].partialFilterExpression, { endedAt: null });
  });
});