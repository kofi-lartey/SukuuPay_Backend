// Boot migrations that repair live indexes.
//
//   npm test
//
// Why this suite exists. Mongoose matches indexes by **name**. `autoIndex`
// creates an index that is missing and leaves alone one that already exists
// under that name — even when the options are completely different. So a model
// that declares `{ sparse: true }` over a field whose live index is a plain
// full index keeps the plain one, forever, and the constraint the model
// believes in is not the one the database enforces.
//
// Worse, the mismatch is not inert. MongoDB refuses to create an index whose
// name already exists with different options — code 86 — and Mongoose builds a
// model's indexes one at a time, stopping at the first failure. So a single
// stale index does not merely go unrepaired: it blocks every index after it in
// the declaration order from ever being created, on every boot, with the error
// swallowed by `model.init().catch(function $modelInitNoop() {})`.
//
// That is how `users.providerId_1` came to be missing entirely from a live
// database while the model declared it. The declaration was
// `{ $exists: true, $ne: null }`, which MongoDB rejects outright (code 67,
// `Expression not supported in partial index: $not`), and the neighbouring
// `authProvider_1` conflict stopped the build before it got there. The "one
// Google identity = one account" guarantee was not being enforced, and nothing
// said so.
//
// These tests are unit tests over the helper — no database involved — because
// the helper's decisions are what has to be right.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  declaredOptionsFor,
  indexNameFor,
  liveIndexMatchesDeclared,
  ensureIndexMatchesDeclaration,
} from '../src/boot/indexSpec.js';

/** A model stand-in: just the two surfaces the helper touches. */
const fakeModel = (declared, live = []) => {
  const calls = { dropped: [], created: [] };

  return {
    calls,
    model: {
      collection: {
        collectionName: 'fakes',
        // Mongoose's `listIndexes()` returns a cursor, not an array.
        listIndexes: () => ({ toArray: async () => live }),
        dropIndex: async (name) => {
          calls.dropped.push(name);
        },
        createIndex: async (fields, options) => {
          calls.created.push({ fields, options });
          return 'created';
        },
      },
      schema: {
        indexes: () => declared.map(([fields, options]) => [fields, options]),
      },
    },
  };
};

describe('the index name MongoDB will use', () => {
  test('joins the fields and suffixes each with its direction', () => {
    assert.equal(indexNameFor({ providerId: 1 }), 'providerId_1');
    assert.equal(indexNameFor({ createdAt: -1 }), 'createdAt_-1');
    assert.equal(
      indexNameFor({ schoolId: 1, status: 1, createdAt: -1 }),
      'schoolId_1_status_1_createdAt_-1'
    );
  });

  test('keeps a dotted path dotted', () => {
    // The SMS purchase request indexes a nested field, and the server names
    // that index `payment.reference_1` — not `payment_reference_1`.
    assert.equal(indexNameFor({ 'payment.reference': 1 }), 'payment.reference_1');
  });
});

describe('deciding whether a live index matches the declaration', () => {
  const declared = { unique: true, partialFilterExpression: { x: { $type: 'string' } } };

  test('an exact match is a match', () => {
    assert.equal(
      liveIndexMatchesDeclared(
        { unique: true, partialFilterExpression: { x: { $type: 'string' } } },
        declared
      ),
      true
    );
  });

  test('a missing partial filter is not a match', () => {
    assert.equal(liveIndexMatchesDeclared({ unique: true }, declared), false);
  });

  test('a different partial filter is not a match', () => {
    assert.equal(
      liveIndexMatchesDeclared(
        { unique: true, partialFilterExpression: { x: { $type: 'objectId' } } },
        declared
      ),
      false
    );
  });

  test('a non-unique live index is not a match', () => {
    assert.equal(
      liveIndexMatchesDeclared(
        { unique: false, partialFilterExpression: { x: { $type: 'string' } } },
        declared
      ),
      false
    );
  });

  test('a live index missing the declared sparse flag is not a match', () => {
    assert.equal(
      liveIndexMatchesDeclared(
        { unique: false, sparse: false, partialFilterExpression: null },
        { sparse: true }
      ),
      false
    );
  });
});

describe('reconciling a live index against the declaration', () => {
  test('an index that already matches is left alone', async () => {
    const { model, calls } = fakeModel(
      [[{ providerId: 1 }, { unique: true, partialFilterExpression: { providerId: { $type: 'string' } } }]],
      [
        {
          name: 'providerId_1',
          unique: true,
          partialFilterExpression: { providerId: { $type: 'string' } },
        },
      ]
    );

    const result = await ensureIndexMatchesDeclaration(model, { providerId: 1 });

    assert.equal(result.outcome, 'ok');
    assert.deepEqual(calls.dropped, [], 'a matching index must not be dropped');
    assert.deepEqual(calls.created, [], 'a matching index must not be rebuilt');
  });

  test('a drifted index is dropped and the declared one created', async () => {
    const declared = {
      unique: true,
      partialFilterExpression: { providerId: { $type: 'string' } },
    };
    const { model, calls } = fakeModel(
      [[{ providerId: 1 }, declared]],
      [{ name: 'providerId_1', unique: true, partialFilterExpression: null }]
    );

    const result = await ensureIndexMatchesDeclaration(model, { providerId: 1 });

    assert.equal(result.outcome, 'replaced');
    assert.deepEqual(calls.dropped, ['providerId_1']);
    assert.equal(calls.created.length, 1);
    assert.deepEqual(calls.created[0].fields, { providerId: 1 });
    assert.deepEqual(calls.created[0].options, declared);
  });

  test('a missing index is created without dropping anything', async () => {
    const declared = { unique: true, partialFilterExpression: { providerId: { $type: 'string' } } };
    const { model, calls } = fakeModel([[{ providerId: 1 }, declared]], []);

    const result = await ensureIndexMatchesDeclaration(model, { providerId: 1 });

    assert.equal(result.outcome, 'created');
    assert.deepEqual(calls.dropped, []);
    assert.equal(calls.created.length, 1);
  });

  test('a model that declares no such index is an error, not a silent no-op', async () => {
    // Silently doing nothing here is how a missing constraint stays missing.
    const { model } = fakeModel([], []);

    await assert.rejects(
      () => ensureIndexMatchesDeclaration(model, { providerId: 1 }),
      /declares no index/
    );
  });
});

describe('what the schema declares', () => {
  test('is read from the model, not hard-coded', async () => {
    const { User } = await import('../src/models/userModel.js');

    const declared = declaredOptionsFor(User, { providerId: 1 });

    assert.ok(declared, 'User declares a providerId index');
    assert.equal(declared.unique, true);
    assert.deepEqual(declared.partialFilterExpression, { providerId: { $type: 'string' } });
  });

  test('the payment receipt index is unique and partial', async () => {
    const { Payment } = await import('../src/models/paymentModel.js');

    const declared = declaredOptionsFor(Payment, { receiptNumber: 1 });

    assert.ok(declared, 'Payment declares a receiptNumber index');
    assert.equal(declared.unique, true);
    assert.deepEqual(declared.partialFilterExpression, { receiptNumber: { $type: 'string' } });
  });
});
