import { User } from '../models/userModel.js';

/**
 * Boot migration: replace the legacy `providerId` index with the partial one.
 *
 * Why a database needs this at all. `userModel.js` declares the unique index on
 * `providerId` with a `partialFilterExpression` of
 * `{ providerId: { $exists: true, $ne: null } }`, precisely so password-only
 * accounts — which carry `providerId: null` from the field default — never
 * collide. That is a *declaration*. An index already sitting in MongoDB is
 * never rewritten by Mongoose: `autoIndex` only creates indexes that are
 * missing, and it matches by index name, so the legacy `providerId_1` — the
 * original `sparse: true` unique index, under which MongoDB treats an explicit
 * `null` as a present value and indexes it — survives every deploy untouched.
 *
 * With that stale index in place, the *second* password-only invite dies on
 * E11000 with `keyValue: { providerId: null }`, and a platform can never have
 * more than one invited staff account per database. The symptom surfaces in
 * `userController.inviteUser` as a duplicate-key error whose `keyValue` has no
 * `email`, which is how this was found.
 *
 * The migration is idempotent and runs on every boot:
 *
 *  1. List the collection's indexes.
 *  2. Drop any *unique* index over `providerId` that lacks the partial filter
 *     (the legacy sparse one). A non-unique index over the same key is left
 *     alone — it is not what breaks inserts, and it may exist for a reason.
 *  3. Recreate the declared index via `createIndexes()`, which is a no-op when
 *     an index with the same name and spec already exists.
 */
export const reconcileProviderIdIndex = async () => {
  const indexes = await User.collection.listIndexes().toArray();

  const isUniqueOverProviderIdOnly = (index) =>
    Boolean(index.unique) &&
    Object.keys(index.key || {}).length === 1 &&
    'providerId' in index.key;

  // Only an index whose partial filter keeps `null` out is correct. Missing,
  // `{}`, or a filter that admits nulls all mean the legacy definition.
  const partialExcludesNull = (index) => {
    const filter = index.partialFilterExpression;
    if (!filter || typeof filter !== 'object') return false;
    const condition = filter.providerId;
    return Boolean(condition && typeof condition === 'object' && condition.$ne === null);
  };

  const stale = indexes.filter(
    (index) =>
      index.name !== '_id_' &&
      isUniqueOverProviderIdOnly(index) &&
      !partialExcludesNull(index)
  );

  for (const index of stale) {
    console.log(
      `[providerId-index-migration] dropping legacy unique index "${index.name}" ` +
        `(${JSON.stringify(index.key)}, unique: ${Boolean(index.unique)}, ` +
        `partialFilterExpression: ${JSON.stringify(index.partialFilterExpression ?? null)})`
    );
    await User.collection.dropIndex(index.name);
  }

  if (stale.length > 0) {
    // Recreate what the schema declares. Safe to call after a drop, and a no-op
    // on a database that already has the partial index.
    await User.createIndexes();
    console.log(
      '[providerId-index-migration] recreated the unique index on providerId ' +
        'with partialFilterExpression { providerId: { $exists: true, $ne: null } }'
    );
  }

  return { dropped: stale.map((index) => index.name) };
};

export default reconcileProviderIdIndex;
