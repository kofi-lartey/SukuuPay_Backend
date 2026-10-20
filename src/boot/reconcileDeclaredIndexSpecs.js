import { Payment } from "../models/paymentModel.js";
import { User } from "../models/userModel.js";
import { ImpersonationSession } from "../models/ImpersonationSession.js";
import { ensureIndexMatchesDeclaration } from "./indexSpec.js";

/**
 * Boot migration: make the live indexes match the specs the schemas declare.
 *
 * ## The defect
 *
 * Mongoose matches indexes by **name**. `autoIndex` creates an index that is
 * missing and leaves alone one that already exists under that name — even when
 * the options are completely different. So a model that declares
 * `{ sparse: true }` over a field whose live index is a plain full index keeps
 * the plain one, forever, and the constraint the model believes in is not the
 * one the database enforces.
 *
 * Worse, the mismatch is not merely inert. MongoDB refuses to create an index
 * whose name already exists with different options — code 86, `An existing
 * index has the same name as the requested index` — and Mongoose builds a
 * model's indexes **one at a time, stopping at the first failure**. So a single
 * stale index does not merely go unrepaired: it blocks every index after it in
 * the declaration order from ever being created, on every boot, with the error
 * swallowed by `model.init().catch(function $modelInitNoop() {})`.
 *
 * That is how `users.providerId_1` came to be **missing entirely** from a live
 * database while the model declared it: the declaration was
 * `{ $exists: true, $ne: null }`, which MongoDB rejects outright (code 67,
 * `Expression not supported in partial index: $not`), and the neighbouring
 * `authProvider_1` conflict stopped the build before it got there. The
 * "one Google identity = one account" guarantee was not being enforced, and
 * nothing said so.
 *
 * ## The repair
 *
 * For each target: drop the live index whose spec differs from the declaration,
 * then create the declared one. The creation is **targeted** — one index, by
 * name, with the declared options — rather than `model.createIndexes()`, which
 * would rebuild the whole model and fail again on the next conflict.
 *
 * Idempotent: a database that already matches the declarations is left alone.
 */

/**
 * The indexes whose live spec must equal the declared one.
 *
 * Each entry is an index whose *options* carry meaning — a `sparse` that keeps
 * a null out of a low-cardinality index, a `partialFilterExpression` that
 * keeps an index down to the rows a query actually reads. Losing any of them
 * is not a performance detail:
 *
 *  - `Payment.refundOfPaymentId` — `sparse` keeps the null that almost every
 *    payment carries out of an index they never appear in.
 *  - `User.authProvider` — partial on `google`, so the admin console's
 *    "signed in with Google" filter reads a handful of rows instead of every
 *    account on the platform.
 *  - `ImpersonationSession.superAdminId` — partial on `endedAt: null`, so the
 *    impersonation hot path reads only *open* sessions. The index is cheap
 *    because it holds normally zero or one.
 */
export const DECLARED_SPEC_TARGETS = [
  { model: Payment, fields: { refundOfPaymentId: 1 } },
  { model: User, fields: { authProvider: 1 } },
  { model: ImpersonationSession, fields: { superAdminId: 1 } },
];

export const reconcileDeclaredIndexSpecs = async () => {
  const replaced = [];
  const created = [];

  for (const { model, fields } of DECLARED_SPEC_TARGETS) {
    const collection = model.collection.collectionName;

    try {
      const result = await ensureIndexMatchesDeclaration(model, fields);

      if (result.outcome === "replaced") {
        replaced.push(`${collection}.${result.name}`);
      } else if (result.outcome === "created") {
        created.push(`${collection}.${result.name}`);
      }
    } catch (error) {
      // A boot migration must not take the server down with it: the platform
      // still serves, and the error says exactly which index is missing.
      console.error(
        `[index-spec-migration] could not reconcile the index on ${collection}.${JSON.stringify(fields)}: ${error.message}`
      );
    }
  }

  return { replaced, created };
};

export default reconcileDeclaredIndexSpecs;
