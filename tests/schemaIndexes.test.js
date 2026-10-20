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

import { readdirSync } from 'node:fs';

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
  '../src/models/Attendance.js',
  '../src/models/ReportCard.js',
  '../src/models/Timetable.js',
  '../src/models/ParentPortalReadState.js',
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

  test('User.providerId is unique AND partial (excludes null)', async () => {
    const model = await loadModel('../src/models/userModel.js');
    const index = model.schema.indexes().find(([fields]) => fields.providerId === 1);

    assert.ok(index, 'one Google identity must map to one account');
    assert.equal(index[1].unique, true, 'unique is what stops a second account claiming it');
    assert.deepEqual(
      index[1].partialFilterExpression,
      { providerId: { $type: "string" } },
      'a sparse unique index still indexes null providerId values, which is what made the second password-only invite collide on E11000; the partial filter excludes nulls so only Google accounts are indexed'
    );
  });

  test('no partial filter uses $ne, which MongoDB cannot build', async () => {
    // MongoDB rejects `$ne` inside a `partialFilterExpression` with
    // `Expression not supported in partial index: $not` (code 67) and creates
    // nothing. A declaration in that shape looks right and enforces nothing —
    // which is how `users.providerId_1` came to be missing from the live
    // database entirely.
    const modelDir = new URL('../src/models/', import.meta.url);
    const files = readdirSync(modelDir).filter((file) => file.endsWith('.js'));

    const offenders = [];

    for (const file of files) {
      const model = await loadModel(new URL(file, modelDir).href);

      for (const [fields, options] of model.schema.indexes()) {
        const filter = options?.partialFilterExpression;
        if (!filter || typeof filter !== "object") continue;

        for (const [field, condition] of Object.entries(filter)) {
          if (!condition || typeof condition !== "object") continue;
          if (condition.$ne === undefined) continue;

          offenders.push(`${model.modelName}.${field}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'these partial filters declare $ne, which MongoDB refuses to build — the index would never exist'
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

/**
 * Does this partial filter keep nulls out of the index?
 *
 * Only two shapes do: a `$type` that null is not, and a `$ne: null`. Mirrors
 * `boot/reconcileNullableUniqueIndexes.js`, which has to recognise the same
 * thing in a live index it did not create.
 *
 * The `$ne` shape is recognisable but not *declarable* — MongoDB refuses to
 * build it — which is why the declaration is always `$type: "string"`. The
 * separate test above enforces that.
 */
const excludesNulls = (partialFilterExpression, field) => {
  const condition = partialFilterExpression?.[field];
  if (!condition || typeof condition !== "object") return false;
  if (condition.$type !== undefined) return condition.$type !== "null";
  if (condition.$ne !== undefined) return condition.$ne === null;
  return false;
};

describe('no unique index is declared over a field that defaults to null', () => {
  // The whole class of bug, in one assertion.
  //
  // A unique index over a field that defaults to null means **one null row per
  // collection**. MongoDB's `sparse` does not save you: it skips a *missing*
  // field, but an explicit `null` is a present value and is indexed — as null.
  // So the second document to carry that null dies on E11000 with
  // `keyValue: { <field>: null }`.
  //
  // Five of these were live at once, and one of them was the parent portal:
  //
  //   - `Payment.receiptNumber` — null for every payment that has not settled,
  //     so the payments collection could hold exactly **one** pending payment.
  //     Once it did, no family could pay: the "Pay" button answered 500.
  //   - `Payment.reference` — null for every desk payment recorded in the
  //     admin console, so the second one died.
  //   - `SmsCreditTopUp.reverses`, `PlatformSmsPoolEntry.requestId` and
  //     `SmsPurchaseRequest.poolEntryId` — the same shape, one insert away
  //     from their own 500.
  //
  // `User.providerId` was the one already fixed, by hand, in
  // `reconcileProviderIdIndex.js`. The rest were missed.
  //
  // The remedy is a `partialFilterExpression` that excludes nulls. `sparse` is
  // not it, and `unique` on the field is not it.
  const modelDir = new URL('../src/models/', import.meta.url);
  const files = readdirSync(modelDir).filter((file) => file.endsWith('.js'));

  for (const file of files) {
    test(file, async () => {
      const model = await loadModel(new URL(file, modelDir).href);

      const offenders = [];

      for (const [fields, options] of model.schema.indexes()) {
        if (!options?.unique) continue;

        const keyFields = Object.keys(fields);

        // A compound unique index is a different animal: a null in one of its
        // components is part of the key, so it does not poison the collection
        // the way it does for a single-field index. `SmsTemplate`'s
        // `{ schoolId, key }` is the shape this is: the null school is a
        // platform-level template, and the key still keeps it unique.
        if (keyFields.length !== 1) continue;

        const field = keyFields[0];
        const schemaPath = model.schema.path(field);
        const defaultsToNull =
          schemaPath?.defaultValue === null || schemaPath?.options?.default === null;

        if (!defaultsToNull) continue;

        if (excludesNulls(options.partialFilterExpression, field)) continue;

        offenders.push(
          `${field} → ${JSON.stringify({ unique: true, ...options, partialFilterExpression: options.partialFilterExpression ?? null })}`
        );
      }

      assert.deepEqual(
        offenders,
        [],
        `${model.modelName} declares a unique index over a field that defaults to null, with no partial filter excluding nulls — one null row per collection, and the second insert dies on E11000`
      );
    });
  }
});
