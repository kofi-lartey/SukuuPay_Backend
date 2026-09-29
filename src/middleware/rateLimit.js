/**
 * Minimal in-memory fixed-window rate limiter.
 * @param {{ windowMs?: number, max?: number, message?: string, keyBy?: string }} options
 */
export const rateLimit = ({
  windowMs = 15 * 60 * 1000,
  max = 10,
  message = 'Too many requests. Please try again later.',
  keyBy = 'ip',
} = {}) => {
  const hits = new Map();

  // Stop the store growing unbounded on long running processes.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  sweep.unref?.();

  return (req, res, next) => {
    const now = Date.now();
    const identity = keyBy === 'ip' ? req.ip : String(req.user?._id ?? req.ip);
    const key = `${req.baseUrl}${req.path}:${identity}`;

    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ success: false, message, retryAfter });
    }

    next();
  };
};

export default rateLimit;
