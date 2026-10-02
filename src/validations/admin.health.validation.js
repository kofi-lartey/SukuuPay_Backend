import Joi from "joi";

/**
 * Schemas for the platform console's health and maintenance endpoints.
 */

/**
 * `PUT /admin/health/maintenance`
 *
 * **Two states on the wire, three in the database.**
 *
 * The console's switch is a toggle, because that is what a person operating an
 * incident can actually use — one control, unambiguously on or off. What is stored
 * is `PlatformSettings.maintenance.mode`, which is `off | readonly | on`
 * (`models/PlatformSettings.js:183-187`) and is consumed by
 * `middleware/maintenance.js`. `mode` is deliberately **not** in this schema.
 *
 * The reason it is not offered is that `readonly` is the state that makes a schema
 * migration safe: every read still answers, so nobody is staring at a 503 and
 * wondering whether to retry, while nothing can be half-written. If the console
 * could pick `on`, it would be a strictly worse kill switch — the one an operator
 * reaches for reflexively would take every page down. Exposing `mode` here would
 * make that possible with one dropdown, so the adapter in
 * `services/admin/health.service.js` is the only place that writes it.
 *
 * `.min(1)` on the object, so `{}` is a 422 rather than a silent no-op: this is a
 * platform-wide switch, and a request that changes nothing almost certainly means
 * the client sent the wrong shape.
 *
 * `enabled` is genuinely required — an absent `enabled` has no defensible reading
 * and defaulting it would risk a toggle appearing to work while doing nothing.
 *
 * `message` is optional here and **required at 400 by the service when
 * `enabled` is true**. The rule is a business decision, not a shape rule, and the
 * console convention reserves 422 for the validation layer: a platform-wide
 * lockout with no explanation shown to users is worse than the outage it was
 * managing, and that belongs with the logic that knows whether the platform is
 * being locked. `.allow("")` is here so a client can send an empty message while
 * *disabling* — which is how a toggle UI naturally submits the field it cleared.
 */
export const setMaintenanceModeSchema = Joi.object({
  enabled: Joi.boolean().required().messages({
    "boolean.base": "Maintenance `enabled` must be true or false",
  }),
  message: Joi.string().trim().allow("").max(500),
}).min(1);

/**
 * `GET /admin/health/errors`
 *
 * `from`/`to` accept the empty string for the reason given in
 * `admin.auditLogs.validation.js`: a date-range picker sends both fields on first
 * load. `resolveDateRange` widens `to` to the end of its day, so a single-day
 * range is the whole day rather than the first millisecond of it.
 *
 * `limit` defaults to 100 and is capped at 500 because **500 is the size of the
 * in-process ring buffer itself** (`utils/errorBuffer.js`). Allowing a larger
 * limit would return the same 500 entries and imply there were more, so the
 * bound is stated rather than left to a silently-clamped response.
 */
export const recentErrorsQuerySchema = Joi.object({
  from: Joi.date().iso().optional().allow(null, ""),
  to: Joi.date().iso().optional().allow(null, ""),
  limit: Joi.number().integer().min(1).max(500).default(100),
});