import Joi from 'joi';
import { getGhanaRegions } from '../utils/generateCode.js';

/**
 * Joi schemas for the platform console's per-school writes.
 *
 * Two files rather than one because the schools schemas carry the only place in the
 * console where a *range* is a commercial decision (`platformFeePercent` ≤ 5) and
 * the only place where a field is deliberately forbidden rather than merely absent
 * (`status` on a generic school update). Keeping them beside the route params they
 * share — and away from `admin.validation.js`, which is the platform-wide list and
 * revenue filters — means a change to the school detail page cannot alter the
 * dashboard's query validation.
 *
 * Every body schema here is a **patch**: fields optional, `.min(1)` on the object.
 * `middleware/validate.js` runs with `stripUnknown: true`, so an unknown key is
 * removed silently rather than rejected — which is precisely why a schema that
 * *must* refuse something has to name it (`forbidden()`), and why the services
 * behind these routes keep their own allowlist as a second gate.
 */

/**
 * Route params.
 *
 * A literal 24-hex pattern rather than `.custom(mongoose.isValid)`. Joi runs before
 * any Mongoose import in the request path, and a 422 naming the format is a better
 * answer than a `CastError` surfacing as a 400 from a controller that then has to
 * know about ObjectIds at all.
 */
export const schoolIdParamSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({ 'string.pattern.base': 'Invalid school ID format' }),
});

/**
 * `GET /admin/schools/:id/markup`
 *
 * `.min(0).max(100)` matches the model's own bound on
 * `payment.platformMarkupPercent`. The service re-checks, because the service is
 * reachable without this middleware; the schema exists so the error is a field-level
 * 422 that names the field rather than a service-thrown 400 that does not.
 */
export const updateMarkupSchema = Joi.object({
  platformMarkupPercent: Joi.number().min(0).max(100).required(),
});

/**
 * `PUT /admin/schools/:id/platform-fee`
 *
 * Capped at 5 rather than 100. This is a percentage of a school's collected volume
 * for using SukuuPay to reach its own parents — not a skim off one MoMo payment — so
 * 5 is a commercial ceiling rather than an arithmetic one, and the only thing
 * standing between a typo and a school being charged its entire takings is this
 * bound. `PlatformSettings.defaultPlatformFeePercent` carries the same cap.
 */
export const updatePlatformFeeSchema = Joi.object({
  platformFeePercent: Joi.number().min(0).max(5).required(),
});

/**
 * `PUT /admin/schools/:id/gateway-mode`
 *
 * The four values from `School.payment.gatewayMode`'s enum. `manual` is a real
 * option, not a fallback: a school paying by bank transfer has no rail to change,
 * and refusing the value would make "switch this school to manual" inexpressible
 * rather than merely pointless.
 */
export const updateGatewayModeSchema = Joi.object({
  gatewayMode: Joi.string().valid('hubtel', 'arke', 'mnotify', 'manual').required(),
});

/**
 * `PUT /admin/schools/:id/subscription`
 *
 * A patch, and `status: 'trial'` is a *trigger* rather than just a value: the
 * service reads it to decide whether to default `trialEndsAt` to
 * `now + features.trialDays`. That is why `trialEndsAt` is not required alongside
 * it — requiring both would make the default unreachable through the API and the
 * default is the whole point.
 *
 * `trialEndsAt` is **not** bounded against "now" here even though the service
 * refuses a past date with a 422. "In the past" is a relation to the moment of the
 * request, not a property of the value, so a static schema bound would be either
 * vacuous or would reject a legitimate back-dated correction; the service owns that
 * rule and says which field it is about.
 *
 * `monthlyFee` is integer pesewas. `1 GHS = 100 pesewas`, every money field in the
 * product is an integer, and a fractional pesewa is not an amount of money — it is
 * a rounding decision that two different screens would make differently.
 */
export const updateSubscriptionSchema = Joi.object({
  plan: Joi.string().valid('trial', 'basic', 'standard', 'premium', 'enterprise'),
  monthlyFee: Joi.number().integer().min(0),
  status: Joi.string().valid('trial', 'active', 'expired', 'suspended', 'cancelled'),
  trialEndsAt: Joi.date().iso(),
  currentPeriodStart: Joi.date().iso(),
  currentPeriodEnd: Joi.date().iso(),
  paymentMethod: Joi.string().valid('momo', 'card', 'bank_transfer', 'manual'),
}).min(1);

/**
 * `PUT /admin/schools/:id/feature-flags`
 *
 * `.min(1)` on the object and on the group, so an empty body cannot be used to
 * "reset the flags to defaults". The two booleans that default **true** are the
 * reason: a body of `{}` merged over nothing is a no-op, but a body of `{}`
 * written *as* the whole subdocument would silently re-enable installments and ID
 * cards for a school an operator had deliberately switched off. Four named keys, not
 * `Joi.object().unknown(true)` — a flag the model does not have is a typo, and
 * `whatsappEnabled` should be a 422 rather than a silently stored `whatsappEnabled`
 * field that nothing reads.
 */
export const updateFeatureFlagsSchema = Joi.object({
  installments: Joi.boolean(),
  idCards: Joi.boolean(),
  whatsapp: Joi.boolean(),
  apiAccess: Joi.boolean(),
}).min(1);

/**
 * `PUT /admin/schools/:id/tags`
 *
 * `.max(50)` per tag and `.max(20)` on the array, matching the service's own caps.
 * Lowercasing is *not* done here: Joi would have to lowercase each element and the
 * service has to do it anyway (it is reachable without this middleware), and doing
 * it in two places invites the two disagreeing. Tags are a filter key, so the
 * normalisation has to happen on write, not on read.
 */
export const updateTagsSchema = Joi.object({
  tags: Joi.array().items(Joi.string().trim().min(1).max(50)).max(20).required(),
});

/**
 * `PUT /admin/schools/:id/notes`
 *
 * `.max(2000)` matches `School.subscription.internalNotes`'s `maxlength`. A school
 * must never see this field, so there is no pagination and no reason for it to grow
 * without limit — it is the account manager's margin, not a second issue tracker.
 */
export const updateInternalNotesSchema = Joi.object({
  internalNotes: Joi.string().allow('').max(2000).required(),
});

/**
 * `POST /admin/schools` — manual platform creation.
 *
 * Only `name`, `type`, `phone` and `email` are required, because those four are what
 * `School` itself marks `required`; the rest of the model's required set (`region`,
 * `city`, `address`) is required here too because a school without a region cannot
 * be filtered, billed by region or appear on a regional report, and inventing one
 * would be worse than asking.
 *
 * `slug` and `schoolCode` are **accepted but not required**: the service generates
 * them with `utils/generateCode.js` when absent, and an operator who has been given
 * a school's existing code by phone needs to be able to enter it rather than be
 * told the system invented a different one.
 *
 * `hubtelClientId` / `hubtelClientSecret` / `hubtelApiKey` / `sms.apiKey` are absent
 * rather than merely ignored. `validate` strips unknown keys, so a body carrying a
 * credential has it *removed* before the service runs — and the service independently
 * nulls all four on write, so there is no path by which a credential arriving in a
 * create request is persisted.
 */
export const createSchoolAsPlatformSchema = Joi.object({
  name: Joi.string().trim().min(2).max(150).required(),
  type: Joi.string().valid('public', 'private', 'international', 'mission', 'charter').required(),
  phone: Joi.string().trim().min(7).max(20).required(),
  email: Joi.string().email().lowercase().trim().required(),
  slug: Joi.string().trim().max(160),
  schoolCode: Joi.string().trim().uppercase().max(12),
  region: Joi.string().valid(...getGhanaRegions()).required(),
  city: Joi.string().trim().min(1).max(80).required(),
  address: Joi.string().trim().min(1).max(200).required(),
  gpsAddress: Joi.string().trim().allow('').max(200),
  website: Joi.string().trim().allow('').max(200),
  motto: Joi.string().trim().allow('').max(200),
  brandColor: Joi.string().trim().regex(/^#[0-9a-fA-F]{6}$/).default('#1E3A8A'),
  academic: Joi.object({
    currentTerm: Joi.string().trim().max(40),
    currentYear: Joi.string().trim().max(10),
    termsPerYear: Joi.number().integer().min(1).max(4),
  }).min(1),
  stats: Joi.object({
    totalStudents: Joi.number().integer().min(0),
    totalTeachers: Joi.number().integer().min(0),
    totalParents: Joi.number().integer().min(0),
    totalPaymentsThisMonth: Joi.number().integer().min(0),
  }).min(1),
  payment: Joi.object({
    momoMerchantId: Joi.string().trim().allow('').max(80),
    bankAccount: Joi.object({
      accountName: Joi.string().trim().allow('').max(120),
      accountNumber: Joi.string().trim().allow('').max(40),
      bankName: Joi.string().trim().allow('').max(120),
      branch: Joi.string().trim().allow('').max(120),
    }).min(1),
    gatewayMode: Joi.string().valid('hubtel', 'arke', 'mnotify', 'manual'),
    platformMarkupPercent: Joi.number().min(0).max(100),
    networksEnabled: Joi.object({
      mtn: Joi.boolean(),
      telecel: Joi.boolean(),
      airteltigo: Joi.boolean(),
    }).min(1),
  }).min(1),
  sms: Joi.object({
    provider: Joi.string().valid('hubtel', 'arke', 'mnotify'),
    senderId: Joi.string().trim().allow('').max(20),
  }).min(1),
  /**
   * The subscription override.
   *
   * Present because a school created by hand is usually a *back-fill* — one that has
   * been a customer for months — and always trialling it would be wrong. Omit the
   * group entirely and the service applies the platform defaults: `plan: 'trial'`,
   * `status: 'trial'`, `trialEndsAt = now + features.trialDays` and the default
   * markup, which is exactly what self-service provisioning produces.
   */
  subscription: Joi.object({
    plan: Joi.string().valid('trial', 'basic', 'standard', 'premium', 'enterprise'),
    status: Joi.string().valid('trial', 'active', 'expired', 'suspended', 'cancelled'),
    trialEndsAt: Joi.date().iso(),
    currentPeriodStart: Joi.date().iso(),
    currentPeriodEnd: Joi.date().iso(),
    paymentMethod: Joi.string().valid('momo', 'card', 'bank_transfer', 'manual'),
    monthlyFee: Joi.number().integer().min(0),
    platformFeePercent: Joi.number().min(0).max(5),
    tags: Joi.array().items(Joi.string().trim().min(1).max(50)).max(20),
    featureFlags: Joi.object({
      installments: Joi.boolean(),
      idCards: Joi.boolean(),
      whatsapp: Joi.boolean(),
      apiAccess: Joi.boolean(),
    }).min(1),
    internalNotes: Joi.string().allow('').max(2000),
  }).min(1),
});

/**
 * `PUT /admin/schools/:id` — the platform-owned field patch.
 *
 * **`status` is `forbidden()`, not merely absent.** `stripUnknown` would delete an
 * undeclared `status` and the write would succeed with the operator believing the
 * school was suspended. Suspension has its own reason-required endpoint, its own
 * audit action, and cascades to the school's users — three things this generic
 * write must not be a back door to. Naming the key produces a 422 that says so.
 *
 * `email` is unique on the model, so a change that collides is a 409 raised by the
 * service's duplicate-key translation; the schema cannot see the collection.
 */
export const updateSchoolAsPlatformSchema = Joi.object({
  name: Joi.string().trim().min(2).max(150),
  type: Joi.string().valid('public', 'private', 'international', 'mission', 'charter'),
  phone: Joi.string().trim().min(7).max(20),
  email: Joi.string().email().lowercase().trim(),
  region: Joi.string().valid(...getGhanaRegions()),
  city: Joi.string().trim().min(1).max(80),
  address: Joi.string().trim().min(1).max(200),
  gpsAddress: Joi.string().trim().allow('').max(200),
  brandColor: Joi.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  academic: Joi.object({
    currentTerm: Joi.string().trim().max(40),
    currentYear: Joi.string().trim().max(10),
    termsPerYear: Joi.number().integer().min(1).max(4),
    gradingSystem: Joi.string().valid('WAEC', 'IB', 'Cambridge', 'Custom'),
    classes: Joi.array().items(Joi.string().trim().max(60)),
    finalYearClasses: Joi.array().items(Joi.string().trim().max(60)),
  }).min(1),
  stats: Joi.object({
    totalStudents: Joi.number().integer().min(0),
    totalTeachers: Joi.number().integer().min(0),
    totalParents: Joi.number().integer().min(0),
    totalPaymentsThisMonth: Joi.number().integer().min(0),
  }).min(1),
  status: Joi.any().forbidden().messages({
    'any.unknown':
      'status cannot be changed here — use the suspend or unsuspend endpoint so the reason is recorded',
  }),
}).min(1);

/**
 * `GET /admin/schools` — the console's schools table.
 *
 * `tag` is a single value, not an array. A school carries at most 20 tags and the
 * console's use for this is one operator label at a time ("show me everything tagged
 * at-risk"); an array parameter would need an AND/OR decision that no caller has
 * asked for, and an `$all` over a multikey index is the slower query.
 *
 * `sortBy` is an allowlist because it becomes a Mongo sort key directly — a client
 * choosing `subscription.monthlyFee` today must be refused today, not when that
 * field stops existing.
 */
export const listAdminSchoolsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(200).default(20),
  status: Joi.string().valid('active', 'suspended', 'archived'),
  region: Joi.string().valid(...getGhanaRegions()),
  plan: Joi.string().valid('trial', 'basic', 'standard', 'premium', 'enterprise'),
  tag: Joi.string().trim().max(50).allow('').optional(),
  search: Joi.string().trim().max(100).allow('').optional(),
  sortBy: Joi.string()
    .valid('name', 'createdAt', 'schoolCode', 'region', 'status', 'onboardingCompletedAt')
    .default('createdAt'),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
});