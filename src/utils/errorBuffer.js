/**
 * A bounded, in-process ring buffer of server faults.
 *
 * ── Why this exists, and what it is not ──────────────────────────────────────
 *
 * The platform console is being given a "recent errors" screen, and the honest
 * answer to "where do the errors come from?" is: **nowhere**. Read the code.
 *
 *   - `middleware/errorHandler.js` is the only error boundary in the app, and
 *     its last act before writing a response is a bare `console.error`
 *     (`errorHandler.js:45`). It writes to no database and to no file.
 *   - `src/models/` contains no `ErrorLog`, no `JobRun`, no `CronLog`. There is
 *     no collection to read.
 *   - Nothing else in `src/` writes an error anywhere durable.
 *
 * So there is no history to query. This module is the smallest thing that makes
 * the screen true rather than decorative: a fixed-capacity ring buffer that
 * `src/index.js` feeds from the error pipeline, holding the last few hundred
 * faults for the life of this process.
 *
 * **It is not a durable error store, and the difference matters more than the
 * feature does.** Every limitation below is a real way this screen will lie by
 * omission if nobody knows about it:
 *
 *   - **It dies with the process.** A redeploy — which is what you do *because*
 *     something was broken — empties it. The stack trace of the error that caused
 *     the deploy is gone. There is no way to query what happened before boot.
 *   - **It is per instance.** On a multi-instance deploy (Render runs several
 *     behind a load balancer), whichever instance the console's request happens
 *     to land on shows only *its own* last 500 errors. A fault that happened on a
 *     sibling is invisible, and so is the fact that it happened. The payload says
 *     so (`scope: "process"`, `instancePid`) precisely so a screen can render the
 *     caveat instead of implying coverage it does not have.
 *   - **It is not sampled or persisted, so it cannot be correlated** after the
 *     fact. Two requests an hour apart that each dropped a payment may or may not
 *     both still be in the buffer.
 *
 * The correct fix is a persisted collection written on the error path, which
 * means an insert that must not itself be able to fail the request — the same
 * fire-and-forget discipline `utils/auditService.js` already uses. That is a
 * schema and an index decision, not something to smuggle in alongside a screen.
 * This module is deliberately shaped so that swapping it for a collection later
 * is a change to the two functions below and nothing else.
 *
 * **Why `errorHandler.js` was not touched.** Its contract is "a 4-arity
 * `(error, req, res, next)` middleware that always answers the response itself",
 * and it never calls `next()`. The console convention here is that no handler
 * throws and no handler forwards to `next(error)` — but that rule is about
 * *controllers*, whose failures are their own and answerable with a status code.
 * Express's error pipeline is different in kind: an errored request has nobody
 * left to answer it, and the only way it reaches the terminal handler is
 * `next(err)`. So `src/index.js` registers `recordRequestError` — a 4-arity
 * middleware that buffers and then forwards — immediately *before*
 * `app.use(errorHandler)`. `errorHandler.js` is unchanged, still the single
 * authority on what a client sees, and still strips 5xx messages.
 */

/**
 * Entries retained.
 *
 * 500, and the reasoning is the cost of each alternative. 100 is not enough:
 * a single afternoon of a misbehaving integration produces hundreds of errors and
 * the ones an operator wants (the first, and the last) would both be evicted by
 * the middle. 5000 is memory nobody spent on purpose — each entry carries a stack,
 * so it is kilobytes — and on a platform with a traffic spike it is exactly the
 * wrong thing to hold. A week-long backlog is not the answer either, because
 * "recent" is what an operator means when they open this during an incident.
 */
export const DEFAULT_CAPACITY = 500;

/** Above this, an entry's stack is truncated. Keeps one pathological error bounded. */
const MAX_STACK_LENGTH = 4000;

/** Per-field length caps. A body echoed into an error message must not become the entry. */
const MAX_MESSAGE_LENGTH = 1000;
const MAX_PATH_LENGTH = 300;
const MAX_STACK_FRAMES = 12;

/**
 * Strip anything credential-shaped out of a string before it is stored.
 *
 * Not paranoia. Error messages are the one place in this codebase where a
 * connection string surfaces verbatim: the MongoDB driver quotes the URI it
 * failed to parse, and `MONGODB_URI` is `mongodb+srv://user:password@host/…`.
 * That string ends up in a `console.error` today (which only a deploy's log
 * reader sees, and only for as long as the log is kept) — but this buffer is
 * *read back through an authenticated endpoint and rendered in a browser*, which
 * is a materially wider audience. It also travels into the `health.check` audit
 * entries the job writes. So the same message is scrubbed before it is stored.
 *
 * Applied to the message, the stack, and the path. Applied once, at the boundary,
 * so no caller can forget it.
 */
const CREDENTIAL_PATTERNS = [
  // mongodb://user:pass@host and mongodb+srv:// variants — the Mongo driver form.
  /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]*)@/gi,
  // key=value / key: value / "key":"value" for the credential-shaped names this
  // codebase actually uses.
  //
  // No leading `\b`, and an optional `[\w.-]*` prefix, because the real field
  // names are camelCase compounds: a `\b` before `secret` does not match inside
  // `moolreClientSecret` (no word boundary between "e" and "C"), so a
  // boundary-anchored version silently leaves the exact field most likely to
  // appear in a Mongoose `ValidationError` unredacted. `moolreClientSecret:
  // <value>` is therefore expected to become `moolreClientSecret: ***`.
  //
  // "key" is deliberately not an alternative on its own — `apiKey` and
  // `accessKey` are, bare `key` is not, because `monkey`-style identifiers would
  // otherwise match.
  /([\w.-]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?id|token|authorization|auth))(\s*[:=]\s*)("?)([^\s"',;}]+)\3/gi,
  /*
   * `Authorization: Bearer <jwt>` needs its own rule, applied first.
   *
   * The generic pattern stops at the first whitespace, so it would redact the word
   * "Bearer" and leave the actual token sitting in the message after a space —
   * worse than not redacting at all, because the string now *looks* sanitised. A
   * bearer credential has no delimiter until end of line, so this consumes to
   * there. `client[_-]?id` is in the list above rather than here because it is a
   * single opaque token with no spaces.
   */
  /\b(authorization)(\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\r\n"',;}]*/gi,
];

/**
 * @param {string} value
 * @returns {string} the same text with credential-shaped runs replaced.
 */
export const redactCredentials = (value) => {
  if (value === undefined || value === null) return "";

  let out = String(value);

  out = out.replace(CREDENTIAL_PATTERNS[0], (_match, scheme) => `${scheme}***:***@`);
  out = out.replace(CREDENTIAL_PATTERNS[1], (_match, name, separator) => `${name}${separator}***`);
  out = out.replace(CREDENTIAL_PATTERNS[2], (_match, name, separator) => `${name}${separator}***`);

  return out;
};

const truncate = (value, max) => {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
};

/**
 * The first few frames of a stack.
 *
 * Twelve frames is enough to identify the call site and short enough that a deep
 * recursion (which produces a stack of thousands) cannot fill the buffer on its
 * own. The top frames are the ones that name the failing function; the bottom
 * twenty are usually the event loop entry point repeated verbatim.
 */
const readStack = (error) => {
  const raw = typeof error?.stack === "string" ? error.stack : "";
  if (!raw) return null;

  const trimmed = truncate(raw, MAX_STACK_LENGTH);
  return trimmed.split("\n").slice(0, MAX_STACK_FRAMES).join("\n");
};

/**
 * The status an error will be answered with.
 *
 * Mirrors `errorHandler.js`'s own precedence — `error.status || error.statusCode ||
 * 500` — so the buffer's `status` is the number the client actually got rather
 * than a second, slightly different opinion about it.
 */
const readStatus = (error) => {
  const status = Number(error?.status || error?.statusCode || 500);
  return Number.isFinite(status) && status >= 100 && status <= 599 ? status : 500;
};

/**
 * The request fields worth keeping.
 *
 * Deliberately not the request. `req.body` can hold a password, a `select:false`
 * secret echoed back by a client, or a two-megabyte CSV filter; `req.headers`
 * carries the bearer token and the cookie. A URL path plus a method plus the
 * caller's address is enough to find the offending request in a proxy log, which
 * is the only question this data is ever asked.
 */
const readRequestContext = (req) => {
  if (!req || typeof req !== "object") return null;

  const rawPath = req.originalUrl || req.url || "";
  const path = rawPath.split("?")[0] || null;

  return {
    method: typeof req.method === "string" ? req.method.slice(0, 12) : null,
    // The query string is dropped, not truncated: `?token=…` is the shape a
    // leaked credential takes in a URL, and a truncated query is still a leaked
    // credential.
    path: path ? truncate(path, MAX_PATH_LENGTH) : null,
    ip:
      req.ip ||
      req.headers?.["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      null,
    userId: req.user?._id ? String(req.user._id) : null,
    role: req.user?.role || null,
  };
};

/*
 * Module state, not exported.
 *
 * Deliberately a plain array used as a ring rather than a `Map` or a real queue:
 * at 500 entries the operations that matter are `push` + `shift` (amortised O(1))
 * and a reverse iteration, and any of the several dozen queue implementations
 * available as a dependency would be more code than the whole data structure.
 *
 * `sequence` is monotonic and never reset, because after eviction the timestamp
 * is the only thing left to order by and two errors can share a millisecond. It is
 * what makes "the 412th error" addressable after the first 500 are gone.
 */
let entries = [];
let sequence = 0;

/**
 * Record one server fault.
 *
 * **Only 5xx and statusless errors are kept.** A 4xx is the client asking
 * something the API is supposed to refuse — a validation failure, a 404, a rate
 * limit — and it is answered correctly, with a message written for the human who
 * made the mistake. Buffering those would fill the ring with a school's typos
 * and evict the one unhandled exception an operator opened this screen to find.
 * The threshold is the same one `errorHandler.js` uses to decide a message is
 * unsafe to show the client, so the two agree about what a server fault is.
 *
 * Never throws. It is called from the error pipeline, and an exception raised
 * while handling an exception replaces the real error with a worse one.
 *
 * @param {unknown} error
 * @param {object} [req]
 * @returns {object|null} the stored entry, or null if it was not stored.
 */
export const recordError = (error, req) => {
  try {
    if (error === undefined || error === null) return null;

    const status = readStatus(error);
    if (status < 500) return null;

    sequence += 1;

    const entry = {
      seq: sequence,
      at: new Date().toISOString(),
      status,
      name: truncate(error?.name || "Error", 120),
      message: truncate(redactCredentials(error?.message || ""), MAX_MESSAGE_LENGTH),
      stack: readStack(error),
      request: readRequestContext(req),
      // Which process saw it. Useless on a single instance and essential on four:
      // it is how somebody proves that a fault is visible on the instance serving
      // the console but not on the instance that actually threw it.
      instancePid: process.pid,
    };

    entries.push(entry);
    if (entries.length > DEFAULT_CAPACITY) {
      entries.splice(0, entries.length - DEFAULT_CAPACITY);
    }

    return entry;
  } catch {
    // The one thing this module must never do is fail. A buffer that throws while
    // recording would replace the original error with "cannot read property of
    // undefined", which is both less useful and impossible to look up.
    return null;
  }
};

/**
 * The most recent entries, newest first.
 *
 * `limit` is clamped rather than trusted: this is reachable from an authenticated
 * endpoint, and 100,000 entries of stack traces is a response nobody asked for.
 *
 * A slice, not a reverse of the live array. `recentErrors` must not hand out a
 * mutable reference to the ring, because a caller that sorted or spliced it
 * would corrupt the buffer for every subsequent request.
 *
 * @param {{ limit?: number }} [options]
 * @returns {Array<object>} newest first.
 */
export const recentErrors = ({ limit = 100 } = {}) => {
  const requested = Number(limit);
  const safeLimit = Math.min(
    DEFAULT_CAPACITY,
    Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 100)
  );

  return entries.slice(-safeLimit).reverse();
};

/**
 * What this buffer can and cannot tell you, as data.
 *
 * Returned with every read so the screen has something concrete to render. The
 * alternative is a footer nobody reads over a window that looks like complete
 * coverage of the platform's errors — which is the failure this module exists to
 * avoid, and the easiest way to avoid it is to make the caveat part of the
 * payload rather than a comment nobody sees.
 */
export const errorBufferScope = () => ({
  scope: "process",
  capacity: DEFAULT_CAPACITY,
  retained: entries.length,
  oldestAt: entries[0]?.at || null,
  newestAt: entries[entries.length - 1]?.at || null,
  instancePid: process.pid,
  durable: false,
  limitations: [
    "In-memory only: these entries are lost on restart and on deploy.",
    "Per instance: on a multi-instance deploy each instance shows only its own errors.",
    "Not correlated: entries cannot be joined to a request id or a trace.",
    "5xx only: client errors (4xx) are answered correctly and are not recorded.",
  ],
});

/** Empties the ring. A test seam; nothing in the request path calls it. */
export const clearErrorBuffer = () => {
  entries = [];
  sequence = 0;
};

/**
 * Express 4-arity middleware: buffer the error, then forward it untouched.
 *
 * The shape is what makes Express treat this as error-handling middleware at all —
 * a function of arity four is only invoked on the error path, and a two-argument
 * one would be called on *every* request. Registered immediately before
 * `app.use(errorHandler)` in `src/index.js`.
 *
 * `next(error)` here is not the convention the console forbids. That rule is
 * about controllers, whose failures are theirs to answer; an errored request has
 * no handler left, and forwarding is the only mechanism Express offers. This
 * middleware does not shape the response, does not decide a status, and does not
 * swallow anything — `errorHandler.js` remains the single authority on what a
 * client sees, and buffering is strictly additive.
 *
 * @param {Error} error
 * @param {object} req
 * @param {object} _res unused; the terminal handler owns the response.
 * @param {Function} next
 */
export const recordRequestError = (error, req, _res, next) => {
  recordError(error, req);
  next(error);
};

export default {
  DEFAULT_CAPACITY,
  recordError,
  recordRequestError,
  recentErrors,
  errorBufferScope,
  clearErrorBuffer,
  redactCredentials,
};