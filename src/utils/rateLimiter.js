// ─────────────────────────────────────────────
// In-process rate limiter
// ─────────────────────────────────────────────
// Fixed-window counters, keyed per scope. Deliberately in-memory: this process
// is the only thing enforcing it, so the limit is per instance. That is enough
// for the guard's purpose — stopping a runaway client or a mis-scoped broadcast
// loop — but a multi-instance deployment must move this to Redis or the limit
// multiplies by the instance count.
//
// Counters are pruned lazily on write; the map stays bounded by the number of
// distinct scopes in use.

const buckets = new Map();

class RateLimitError extends Error {
  constructor(message, retryAfter) {
    super(message);
    this.name = 'RateLimitError';
    this.status = 429;
    this.code = 'RATE_LIMITED';
    this.retryAfter = retryAfter;
  }
}

/**
 * Counts one hit against `key` and throws a 429 RateLimitError when the window
 * is exhausted. `limit` hits per `windowMs`.
 */
export const consumeRateLimit = (key, limit, windowMs) => {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { remaining: limit - 1 };
  }

  bucket.count += 1;

  if (bucket.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    throw new RateLimitError(
      `Rate limit of ${limit} exceeded for this scope. Retry in ${retryAfter}s.`,
      retryAfter
    );
  }

  return { remaining: limit - bucket.count };
};

/** Current state of a scope, without consuming a hit. */
export const peekRateLimit = (key) => {
  const bucket = buckets.get(key);
  if (!bucket || Date.now() >= bucket.resetAt) return null;
  return { count: bucket.count, resetAt: bucket.resetAt };
};

/** Test and operational helper: drops all counters. */
export const resetRateLimits = () => buckets.clear();

export { RateLimitError };
