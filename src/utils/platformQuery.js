import mongoose from "mongoose";
import ApiError from "./ApiError.js";

/**
 * Shared query helpers for the platform console.
 *
 * The console's list endpoints are the only ones in the product that paginate across
 * every tenant, which makes them the ones that can be asked to return something
 * absurd: 60,000 schools, every payment ever taken, every audit row since launch.
 * Each of those is a real query someone will run, and each of them is a table scan
 * wearing a `.limit()` that arrives too late to help.
 *
 * So three things are enforced here rather than trusted to thirty handlers:
 *
 *   - **a bounded page size.** `MAX_PER_PAGE` is the ceiling on the *requested*
 *     size, not just on the default. An operator asking for 50,000 rows gets 200
 *     and a page that works, because the alternative is a response nobody was going
 *     to read anyway.
 *   - **a total that is counted, not estimated.** One extra `countDocuments` on
 *     every list, which is the price of a pager that says "page 3 of 41".
 *   - **one shape for `meta`.** The product has three pagination envelopes
 *     (`{page,perPage,total,pages}`, `{users,pagination:{page,limit,…}}`, and the
 *     bare arrays), and the console's own frontend has a `Pagination` component that
 *     wants `{page, perPage, total, totalPages}`. Rather than let a ninth shape
 *     appear, every console list returns `meta` from `buildMeta`.
 */

/**
 * The largest page the API will serve.
 *
 * 200, not 1000. The platform's biggest real list — all payments, all schools — tops
 * out well under a thousand rows, and a screen that cannot page is a screen nobody
 * asked for. Anything above 200 is a caller asking for an export, and there is an
 * export endpoint for that, which streams and does not hold the result in memory.
 */
export const MAX_PER_PAGE = 200;

export const DEFAULT_PER_PAGE = 20;

/**
 * Resolve `page`/`perPage` from a validated query into `{ skip, limit }`.
 *
 * Reads a possibly-undefined pair without throwing, because this is called from
 * service functions that are also reachable from cron jobs and tests where no
 * `req.query` exists at all. Clamps rather than rejects: an operator typing
 * `perPage=99999` wants a big page, and silently giving them the maximum is more
 * useful than a 422 that makes them work out why.
 */
export const resolvePagination = ({ page, perPage } = {}) => {
  const safePage = Math.max(1, Number(page) || 1);
  const requested = Number(perPage) || DEFAULT_PER_PAGE;

  const safePerPage = Math.min(MAX_PER_PAGE, Math.max(1, requested));

  return {
    page: safePage,
    perPage: safePerPage,
    skip: (safePage - 1) * safePerPage,
    limit: safePerPage,
  };
};

/**
 * The `meta` block every console list returns.
 *
 * `pages` rather than `totalPages`, matching every other `meta` the API already
 * emits. `pageCount` is at least 1 for an empty result: "0 pages" makes a pager
 * render "page 1 of 0", which is a bug the caller then has to special-case. `pages: 0`
 * is arithmetically correct and useless.
 */
export const buildMeta = ({ page, perPage, total, extra = {} }) => ({
  page,
  perPage,
  total,
  pages: Math.max(1, Math.ceil(total / perPage)),
  ...extra,
});

/** A Mongo filter value for "no filter was supplied", per field. */
export const optionalId = (value, label = "ID") => {
  if (value === undefined || value === null || value === "") return null;

  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new ApiError(`Invalid ${label}`, 400, "INVALID_ID");
  }

  return new mongoose.Types.ObjectId(value);
};

/**
 * Validate a list of ids and return them as ObjectIds.
 *
 * Empty in, empty out — and that is why it returns `[]` rather than `null`. A
 * `$in: []` matches nothing, which is the correct reading of "no schools selected",
 * whereas a `null` would be dropped from the query document entirely and quietly
 * turn a scoped lookup into a platform-wide one. That inversion — a narrower
 * filter producing *more* rows — is the failure this function exists to make
 * impossible.
 */
export const toObjectIdList = (values, label = "ID") => {
  if (!Array.isArray(values)) return [];

  return values.map((value) => {
    if (!mongoose.Types.ObjectId.isValid(value)) {
      throw new ApiError(`Invalid ${label} in selection`, 400, "INVALID_ID");
    }
    return new mongoose.Types.ObjectId(value);
  });
};

/**
 * Split a long id list into chunks Mongo will accept in a single `$in`.
 *
 * A 16MB BSON document is a real ceiling, not a theoretical one: a `$in` with
 * 100,000 ids is a query that fails with an error nobody can interpret. Chunking
 * keeps every `$in` in this codebase small, at the cost of a few extra round trips
 * for genuinely huge inputs — which is the right trade, because a partial answer
 * silently is not.
 */
export const chunk = (items, size = 1000) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

/**
 * Resolve a `from`/`to` pair into a `createdAt` filter.
 *
 * Inclusive at both ends by widening the lower bound to the start of its day and
 * narrowing the upper bound to the end of its day. "Revenue on 12 March" must
 * include a payment recorded at 23:59:00.500 on the 12th, and a `$lte` on the bare
 * date (`2026-03-12T00:00:00Z`) drops it — which reports a day as smaller than it
 * is rather than as missing, the kind of error that is very hard to notice.
 *
 * `Ghana observes no DST and is permanently UTC+0`, so this is exact here
 * (see `utils/dateHelpers.js`) rather than an approximation that works out anyway.
 */
export const resolveDateRange = (from, to, field = "createdAt") => {
  const range = {};

  if (from) {
    const start = new Date(from);
    if (Number.isNaN(start.getTime())) {
      throw new ApiError("Invalid 'from' date", 400, "INVALID_DATE");
    }
    start.setUTCHours(0, 0, 0, 0);
    range.$gte = start;
  }

  if (to) {
    const end = new Date(to);
    if (Number.isNaN(end.getTime())) {
      throw new ApiError("Invalid 'to' date", 400, "INVALID_DATE");
    }
    end.setUTCHours(23, 59, 59, 999);
    range.$lte = end;
  }

  return Object.keys(range).length ? { [field]: range } : {};
};

/**
 * Sum a list of `{ amount, count }` aggregation rows without the caller having to
 * remember the `$group: { _id: null }` shape.
 *
 * `Number(...) || 0` on both halves, because Mongo returns `null` for `$sum` over
 * an empty match — and `null + 500` is `500`, quietly producing a revenue figure
 * for a school with no payments that nobody ever checked.
 */
export const sumRows = (rows = []) =>
  rows.reduce(
    (acc, row) => ({
      amount: acc.amount + (Number(row?.amount) || 0),
      count: acc.count + (Number(row?.count) || 0),
    }),
    { amount: 0, count: 0 }
  );

export default {
  MAX_PER_PAGE,
  DEFAULT_PER_PAGE,
  resolvePagination,
  buildMeta,
  optionalId,
  toObjectIdList,
  chunk,
  resolveDateRange,
  sumRows,
};