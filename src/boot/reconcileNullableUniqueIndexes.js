import { Payment } from "../models/paymentModel.js";
import { SmsCreditTopUp } from "../models/smsCreditTopUpModel.js";
import { PlatformSmsPoolEntry } from "../models/PlatformSmsPoolEntry.js";
import { SmsPurchaseRequest } from "../models/SmsPurchaseRequest.js";
import { ParentMessage } from "../models/ParentMessage.js";
import { Student } from "../models/studentModel.js";
import { User } from "../models/userModel.js";
import { ImpersonationSession } from "../models/ImpersonationSession.js";
import {
  ensureIndexMatchesDeclaration,
  liveIndexMatchesDeclared,
} from "./indexSpec.js";

export { liveIndexMatchesDeclared };

/**
 * Boot migration: make the live unique indexes match the partial ones the
 * schemas declare.
 *
 * ## Why a database needs this at all
 *
 * A unique index over a field that is null for most rows means *one null row
 * per database*. MongoDB's `sparse` option does not save you: it skips a
 * **missing** field, but an explicit `null` is a present value and is indexed
 * as null. Every model below declares the field with `default: null`, so every
 * document carries that null, and the second one to be written dies on E11000
 * with `keyValue: { <field>: null }`.
 *
 * That is not theoretical. It is what a parent's "Pay" button hit:
 *
 *     E11000 duplicate key error collection: SukuuPay_DB.payments
 *     index: receiptNumber_1 dup key: { receiptNumber: null }
 *
 * `receiptNumber` is null for every payment that has not settled, so the
 * payments collection could hold exactly one pending payment — and once the
 * first one did, no family could pay at all. The same shape was live on seven
 * more fields, each of which was one insert away from its own 500.
 *
 * An index already sitting in MongoDB is never rewritten by Mongoose:
 * `autoIndex` only creates indexes that are *missing*, and it matches by
 * index name, so the legacy `receiptNumber_1` — a plain unique index over the
 * whole field — survives every deploy untouched. The reverse is also true: a
 * model that later declared a field unique leaves a non-unique live index
 * behind, so the constraint the model believes in is not the one the database
 * enforces. This is the same defect, and the same remedy, as
 * `reconcileProviderIdIndex.js`.
 *
 * The migration is idempotent and runs on every boot: for each field it drops
 * the live index whose spec differs from the declaration, and creates the
 * declared one by name.
 */

/**
 * The fields whose unique index has to exclude nulls.
 *
 * `receiptNumber` and `reference` are on `payments`; the others are the SMS
 * credit, pool and messaging collections, where a null means "this row is not
 * a reversal / not an allocation" rather than "this row is broken".
 *
 * The ids a pre-save hook mints are here for the same reason: the hook is what
 * puts a value there, and a row that skipped it would carry an explicit null
 * and poison the collection's unique index.
 */
export const NULL_EXCLUDING_TARGETS = [
  { model: Payment, field: "receiptNumber" },
  { model: Payment, field: "reference" },
  { model: SmsCreditTopUp, field: "reverses" },
  { model: PlatformSmsPoolEntry, field: "requestId" },
  { model: PlatformSmsPoolEntry, field: "entryId" },
  { model: SmsPurchaseRequest, field: "poolEntryId" },
  { model: SmsPurchaseRequest, field: "requestId" },
  { model: SmsPurchaseRequest, field: "payment.reference" },
  { model: ParentMessage, field: "messageId" },
  { model: Student, field: "uniquePayLinkToken" },
];

/**
 * Does this partial filter keep nulls out of the index?
 *
 * Only two shapes do: a `$type` that null is not, and a `$ne: null`. A filter
 * that is missing, empty, or that admits nulls is the legacy definition and
 * has to be replaced.
 *
 * `$ne: null` is listed for completeness — a live index can carry it if it was
 * created on a MongoDB build that allowed it, and recognising it is how such
 * an index gets replaced. **It cannot be declared**: MongoDB rejects `$ne`
 * inside a `partialFilterExpression` with `Expression not supported in partial
 * index: $not`, and creates nothing. The declaration is always `$type: "string"`.
 */
export const partialFilterExcludesNull = (index, field) => {
  const filter = index?.partialFilterExpression;
  if (!filter || typeof filter !== "object") return false;

  const condition = filter[field];
  if (!condition || typeof condition !== "object") return false;

  if (condition.$type !== undefined) return condition.$type !== "null";
  if (condition.$ne !== undefined) return condition.$ne === null;
  if (condition.$exists !== undefined) {
    return condition.$exists === true && condition.$ne === null;
  }

  return false;
};

/** The options the schema declares for a single-field index over `field`. */
export const declaredSpecFor = (model, field) => {
  const entry = model.schema
    .indexes()
    .find(([fields]) => Object.keys(fields).length === 1 && fields[field] === 1);

  return entry ? entry[1] : null;
};

export const reconcileNullableUniqueIndexes = async () => {
  const dropped = [];
  const restored = [];

  for (const { model, field } of NULL_EXCLUDING_TARGETS) {
    const collection = model.collection.collectionName;

    try {
      // The index key is the field itself, at `1`. For the one nested target
      // (`payment.reference`) the key is the dotted path, which is exactly how
      // it is declared.
      const result = await ensureIndexMatchesDeclaration(model, { [field]: 1 });

      if (result.outcome === "replaced") {
        dropped.push(`${collection}.${result.name}`);
        restored.push(collection);
        console.log(
          `[nullable-unique-index-migration] recreated the partial unique index on ${collection}.${field}`
        );
      } else if (result.outcome === "created") {
        restored.push(collection);
        console.log(
          `[nullable-unique-index-migration] created the partial unique index on ${collection}.${field}`
        );
      }
    } catch (error) {
      // A boot migration must not take the server down with it: the platform
      // still serves, and the error says exactly which index is missing.
      console.error(
        `[nullable-unique-index-migration] could not reconcile the index on ${collection}.${field}: ${error.message}`
      );
    }
  }

  return { dropped, restored };
};

export default reconcileNullableUniqueIndexes;
