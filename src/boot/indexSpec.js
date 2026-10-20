import mongoose from "mongoose";

/**
 * Shared index-spec helpers for the boot migrations.
 *
 * Two questions come up in every repair:
 *
 *  1. **What does the schema declare?** `model.schema.indexes()` returns the
 *     `[fields, options]` pairs exactly as declared, with no database involved.
 *  2. **Does the live index match it?** An index already sitting in MongoDB is
 *     never rewritten by Mongoose. `autoIndex` only creates indexes that are
 *     *missing*, and it matches by name — so a live index with the right name
 *     and the wrong options survives every deploy untouched. That is how a
 *     `partialFilterExpression` ends up declared in the code and absent from
 *     the database.
 *
 * The remedy is always the same three steps: drop the live index whose spec
 * differs from the declaration, then create the declared one. The trap is
 * doing it with `model.createIndexes()`, which builds **every** index on the
 * model and therefore fails outright if any one of them conflicts with a live
 * index of the same name. `Payment.createIndexes()` is exactly that case: the
 * legacy non-sparse `refundOfPaymentId_1` makes the whole call fail with code
 * 86, so a repair that needed to rebuild `receiptNumber_1` would never rebuild
 * it — and the failure is silent, because the repair catches it.
 *
 * So: create the one index that needs creating, by name, with the declared
 * options.
 */

/** The options the schema declares for an index over exactly these fields. */
export const declaredOptionsFor = (model, fields) => {
  const wanted = JSON.stringify(fields);

  const entry = model.schema
    .indexes()
    .find(([keys]) => JSON.stringify(keys) === wanted);

  return entry ? entry[1] : null;
};

/**
 * The name MongoDB will give an index over these fields.
 *
 * Same rule the server uses: the field names joined by `_`, each suffixed with
 * its direction (`1` ascending, `-1` descending). A dotted path stays dotted,
 * so `{ "payment.reference": 1 }` is `payment.reference_1`.
 */
export const indexNameFor = (fields) =>
  Object.entries(fields)
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");

/** Does the live index enforce what the schema declares? */
export const liveIndexMatchesDeclared = (liveIndex, declared) => {
  if (!declared) return true;

  if (Boolean(liveIndex.unique) !== Boolean(declared.unique)) return false;
  if (Boolean(liveIndex.sparse) !== Boolean(declared.sparse)) return false;

  const liveFilter = JSON.stringify(liveIndex.partialFilterExpression ?? null);
  const declaredFilter = JSON.stringify(declared.partialFilterExpression ?? null);

  return liveFilter === declaredFilter;
};

/**
 * Make the live index over these fields match what the schema declares.
 *
 * Idempotent: a database that already has the declared index is left alone.
 *
 * @param {mongoose.Model} model
 * @param {object} fields the index key, e.g. `{ providerId: 1 }`
 * @returns {Promise<{name: string, outcome: 'created'|'replaced'|'ok'}>}
 */
export const ensureIndexMatchesDeclaration = async (model, fields) => {
  const collection = model.collection.collectionName;
  const declared = declaredOptionsFor(model, fields);
  const name = indexNameFor(fields);

  if (!declared) {
    throw new Error(
      `${collection} declares no index over ${JSON.stringify(fields)} — nothing to reconcile`
    );
  }

  const live = await model.collection.listIndexes().toArray();
  const existing = live.find((index) => index.name === name);

  if (existing && liveIndexMatchesDeclared(existing, declared)) {
    return { name, outcome: "ok" };
  }

  if (existing) {
    console.log(
      `[index-spec-migration] dropping "${name}" on ${collection} ` +
        `(key: ${JSON.stringify(existing.key)}, unique: ${Boolean(existing.unique)}, ` +
        `sparse: ${Boolean(existing.sparse)}, ` +
        `partialFilterExpression: ${JSON.stringify(existing.partialFilterExpression ?? null)})`
    );

    await model.collection.dropIndex(name);
  }

  await model.collection.createIndex(fields, declared);
  console.log(
    `[index-spec-migration] created "${name}" on ${collection} ` +
      `with the declared options ${JSON.stringify(declared)}`
  );

  return { name, outcome: existing ? "replaced" : "created" };
};

export default ensureIndexMatchesDeclaration;
