/**
 * Rate limiters for the public pay surface.
 *
 * **Why this file is keyed by pay token rather than by IP.** Every other limiter
 * in this service keys on `req.user?._id ?? req.ip`, which is right for an
 * authenticated endpoint. It is exactly the wrong key here. The parent pay link is
 * reached from whatever network the parent's phone happens to be on — a prepaid
 * bundle in a district, a shared business line, a school office computer that four
 * families take turns on. An IP-keyed limit charges every one of those callers for
 * the actions of the others, and a parent who retries a failed MoMo prompt three
 * times while a relative behind the same NAT is reading the page spends the whole
 * budget on one payment. The token *is* the identity on this surface: it names one
 * student, so a limit per token is both fairer and a tighter abuse bound (an
 * attacker with a leaked link cannot spread attempts across IPs to escape it).
 *
 * The window is fixed rather than sliding, matching the store below.
 *
 * `express-rate-limit` is deliberately not used: it is not a dependency of this
 * service, and adding a Redis-backed limiter to fix a limit that is intended to be
 * per-process would be a larger change than the thing it guards. The same caveat
 * `utils/rateLimiter.js` records applies here — on a multi-instance deployment these
 * limits multiply by the instance count.
 */

/** One hour, in the unit the preset tables below use. */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The portal's limits, named for the endpoint they protect rather than for their
 * numbers, so a route reads as `payLinkViewLimit` instead of `rateLimit60`.
 *
 * These are deliberately asymmetric. Reading the page is cheap and a parent on a
 * 3G connection may re-open it many times across a term, so it gets a generous
 * budget; *sending* money gets five an hour, which is several more than any real
 * parent needs and still far too few to be useful to someone probing the endpoint
 * for a way to over-collect against a live token.
 */
export const PAY_PORTAL_LIMITS = {
  /** `GET /pay/:token` — the page itself, plus the history and plan sub-reads. */
  view: { windowMs: HOUR_MS, max: 60, message: 'Too many attempts. Please wait a few minutes and try again.' },
  /** `POST /pay/:token/initiate` — one per real payment, with room for a retry. */
  initiate: { windowMs: HOUR_MS, max: 5, message: 'Too many payment attempts from this link. Please try again later, or contact the school.' },
  /** `POST /pay/:token/request-plan` — a day, because one is being worked on. */
  requestPlan: { windowMs: DAY_MS, max: 3, message: 'You have already sent several requests from this link. The school will be in touch.' },
  /** `POST /pay/:token/notify-school` — a support message, not a chat. */
  notifySchool: { windowMs: DAY_MS, max: 3, message: 'You have already sent several messages from this link. Please call the school instead.' },
  /** `GET /pay/:token/verify/:reference` — polled every few seconds while pending. */
  verify: { windowMs: HOUR_MS, max: 120, message: 'Too many status checks from this link. Please reload the page.' },
};

/**
 * The token-keyed identity, reduced to its last four characters.
 *
 * The token is read from the request path rather than from a header or a body
 * field, because the token in the path is the only value on this surface a caller
 * cannot freely choose — a header is attacker-controlled, which would make the
 * limit meaningless.
 *
 * That truncation is not obfuscation of a secret the process already holds in the
 * URL — it is so a heap snapshot, or a dump of the limiter's own keys, does not
 * become a list of live pay links. Collisions on four characters are possible and
 * harmless: two tokens sharing a suffix share a budget, which is the same outcome
 * as two parents behind one NAT.
 *
 * Falls back to the address when there is no token in the path, so a limiter
 * mounted ahead of a route that failed to bind `:token` degrades to IP keying
 * rather than to a single shared bucket every caller contends for.
 */
const tokenIdentity = (req) => {
  const token = req.params?.token ?? req.params?.payToken;
  if (!token || typeof token !== 'string') return `ip:${req.ip}`;
  return `tok:${token.slice(-4)}`;
};

/** Resolves the map key for one request. */
const resolveIdentity = (req, keyBy) => {
  if (keyBy === 'token') return tokenIdentity(req);

  // Everything else is the historical behaviour: an authenticated caller's own
  // user id, and an anonymous one's address. Unchanged, because the authenticated
  // limiters already rely on it.
  return String(req.user?._id ?? req.ip);
};

/**
 * Minimal in-memory fixed-window rate limiter.
 *
 * @param {{ windowMs?: number, max?: number, message?: string, keyBy?: string }} options
 *   `keyBy` accepts `'ip'` (the historical default, still used by the authenticated
 *   endpoints — their identity is the user, falling back to the address) or
 *   `'token'` (the pay portal's; see `tokenIdentity`).
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
    const identity = resolveIdentity(req, keyBy);
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

/**
 * Builds a limiter from a `PAY_PORTAL_LIMITS` entry.
 *
 * A factory rather than eight module-level constants so that each call site names
 * the *intent* it is guarding, and the numbers live in one table where they can be
 * reviewed together. `keyBy: 'token'` is not a parameter: these are the pay-portal
 * limiters and every one of them is token-keyed.
 *
 * @param {{ windowMs: number, max: number, message: string }} preset
 */
export const payPortalLimit = (preset) =>
  rateLimit({ ...preset, keyBy: 'token' });

export const payLinkViewLimit = payPortalLimit(PAY_PORTAL_LIMITS.view);
export const payInitiateLimit = payPortalLimit(PAY_PORTAL_LIMITS.initiate);
export const payRequestPlanLimit = payPortalLimit(PAY_PORTAL_LIMITS.requestPlan);
export const payNotifySchoolLimit = payPortalLimit(PAY_PORTAL_LIMITS.notifySchool);
export const payVerifyLimit = payPortalLimit(PAY_PORTAL_LIMITS.verify);

export default rateLimit;