import {
  PlatformSettings,
  DEFAULT_PLATFORM_SETTINGS,
  NESTED_PLATFORM_SETTINGS_BRANCHES,
} from "../models/PlatformSettings.js";

/**
 * The cached reader every consumer of platform settings goes through.
 *
 * `admin.service.js` owns the *write* (it needs the before/after pair for the audit
 * entry). This module owns the *read*, and it exists as a separate file for one
 * reason: four unrelated call sites need it — the maintenance middleware on every
 * request, `signup`, the public ad handler, and school provisioning — and none of
 * them should pull in `admin.service.js` and its School/User/Payment/AuditLog
 * imports to learn one boolean.
 *
 * **Cached, because it is read on every request and changes almost never.** An
 * uncached `findOne()` per request is one extra database round trip on the hot path
 * for a document that is written by hand, perhaps monthly. Thirty seconds is a
 * deliberate trade: it bounds how stale the flags can be, and it is short enough
 * that nobody will ever notice it.
 *
 * **The cache is invalidated synchronously by the write**, so an operator flipping a
 * flag sees it take effect on the instance they wrote it to, immediately. The TTL
 * only matters across *other* instances — Render runs more than one behind a load
 * balancer, and an invalidation is in-process, so a second instance can be up to 30
 * seconds behind. That is the accepted cost, and the reason maintenance mode has a
 * message field: it is worth saying what is happening rather than leaving a
 * colleague to wonder.
 *
 * **Fails open, everywhere.** A settings read that throws returns the defaults, and
 * `off`/`true` are the permissive ones. This is the opposite of the usual
 * fail-closed instinct and it is deliberate: a maintenance middleware that returns
 * 503 for every request because the database hiccuped has invented an outage the
 * product did not have. A platform that cannot be configured is a platform that
 * keeps working.
 */

const CACHE_TTL_MS = 30_000;

let cache = null;

/** Called by the settings writer. In-process only — see the note above. */
export const invalidatePlatformSettingsCache = () => {
  cache = null;
};

const withDefaults = (stored) => {
  // Merged per branch, not spread over the top: a stored document with `features`
  // but no `maintenance` — which is what an older write looks like — would
  // otherwise replace the whole maintenance default with `undefined`. The branch
  // list is shared with `admin.service.js` so a new group cannot be added to the
  // defaults and missed in one reader but not the other.
  const merged = { ...DEFAULT_PLATFORM_SETTINGS, ...(stored || {}) };
  NESTED_PLATFORM_SETTINGS_BRANCHES.forEach((branch) => {
    merged[branch] = {
      ...DEFAULT_PLATFORM_SETTINGS[branch],
      ...(stored?.[branch] || {}),
    };
  });
  return merged;
};

/**
 * The current settings, cached, defaulting to the shipped values.
 *
 * Never rejects. Every caller is a decision about whether to *allow* something, and
 * a decision that throws is a decision nobody made.
 */
export const getCachedPlatformSettings = async () => {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  let value = withDefaults(null);

  try {
    const stored = await PlatformSettings.findOne({ singletonKey: "platform" }).lean();
    value = withDefaults(stored);
  } catch (error) {
    // Logged rather than swallowed: the value is safe but the outage is a fact, and
    // a silent fallback is how "the flags are stuck" goes unreported for a week.
    console.error(
      "[platform-settings] read failed, serving defaults:",
      error.message
    );
  }

  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
};

/** The cached value without the await, for synchronous callers and tests. */
export const peekPlatformSettings = () => cache?.value || withDefaults(null);

/**
 * One feature flag.
 *
 * Unknown flag names resolve to `true` rather than throwing or defaulting false: a
 * typo in a call site should not silently switch off something a school depends on,
 * and every caller here is a refusal that would then block real traffic. This is the
 * fail-open rule applied to names rather than to failures.
 */
export const isFeatureEnabled = async (flag) => {
  try {
    const settings = await getCachedPlatformSettings();
    const value = settings.features?.[flag];
    return value === undefined ? true : Boolean(value);
  } catch {
    return true;
  }
};

/** `maintenance.mode`, always one of `off` | `readonly` | `on`. */
export const getMaintenanceMode = async () => {
  try {
    const settings = await getCachedPlatformSettings();
    const mode = settings.maintenance?.mode;
    return ["off", "readonly", "on"].includes(mode) ? mode : "off";
  } catch {
    return "off";
  }
};

/**
 * What a newly provisioned school is given.
 *
 * Read together in one call because both provisioning sites need both, and two
 * awaits would race the cache — the second could miss the TTL and hit the database
 * again for no reason.
 */
export const getProvisioningDefaults = async () => {
  try {
    const settings = await getCachedPlatformSettings();
    const markup = Number(settings.defaultMarkupPercent);
    const days = Number(settings.features?.trialDays);
    return {
      markupPercent: Number.isFinite(markup) ? markup : DEFAULT_PLATFORM_SETTINGS.defaultMarkupPercent,
      trialDays: Number.isFinite(days) ? days : DEFAULT_PLATFORM_SETTINGS.features.trialDays,
    };
  } catch {
    return {
      markupPercent: DEFAULT_PLATFORM_SETTINGS.defaultMarkupPercent,
      trialDays: DEFAULT_PLATFORM_SETTINGS.features.trialDays,
    };
  }
};

export default getCachedPlatformSettings;