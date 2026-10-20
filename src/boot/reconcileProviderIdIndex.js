import { User } from '../models/userModel.js';
import { ensureIndexMatchesDeclaration } from './indexSpec.js';

/**
 * Boot migration: make the live `providerId` index match the declared one.
 *
 * Why a database needs this at all. `userModel.js` declares the unique index on
 * `providerId` with a `partialFilterExpression` that keeps nulls out of it, so
 * password-only accounts — which carry `providerId: null` from the field default
 * — never collide with one another. That is a *declaration*. An index already
 * sitting in MongoDB is never rewritten by Mongoose: `autoIndex` only creates
 * indexes that are *missing*, and it matches by index name, so a legacy
 * `providerId_1` survives every deploy untouched.
 *
 * With the legacy index in place, the *second* password-only invite dies on
 * E11000 with `keyValue: { providerId: null }`, and a platform can never have
 * more than one invited staff account per database. The symptom surfaces in
 * `userController.inviteUser` as a duplicate-key error whose `keyValue` has no
 * `email`, which is how this was found.
 *
 * ## The declaration was unbuildable, which is worse than the legacy index
 *
 * The filter used to be `{ providerId: { $exists: true, $ne: null } }`. MongoDB
 * does not support `$ne` inside a `partialFilterExpression` — it answers
 * `Expression not supported in partial index: $not` (code 67) and creates
 * nothing at all. So `providerId_1` was **never built on any deployment**:
 * `User.createIndexes()` failed with code 67 on every boot, and the database
 * was left with no constraint on `providerId` whatsoever. Two simultaneous
 * first sign-ins on one Google identity could both create an account, which is
 * precisely the race the index exists to close.
 *
 * The filter is now `{ providerId: { $type: "string" } }`, which MongoDB accepts
 * and which excludes nulls the same way: a password-only account's `providerId`
 * is `null`, which is not a string, so it is not in the index and cannot
 * collide with another null.
 *
 * The migration is idempotent and runs on every boot: it drops the live index
 * if its spec differs from the declaration, and creates the declared one.
 */
export const reconcileProviderIdIndex = async () => {
  const result = await ensureIndexMatchesDeclaration(User, { providerId: 1 });

  return {
    dropped: result.outcome === 'replaced' ? [result.name] : [],
    created: result.outcome === 'created' ? [result.name] : [],
  };
};

export default reconcileProviderIdIndex;
