import Joi from "joi";

// ──────────────────── Enums ────────────────────
const PAYMENT_STATUS_ENUM = ["pending", "processing", "completed", "failed", "cancelled", "refunded"];
const PAYMENT_METHOD_ENUM = ["momo", "card", "bank_transfer", "cash"];
const PAYMENT_PROVIDER_ENUM = ["arke", "mnotify", "manual", "mtn", "moolre"];

/**
 * The payment model's `momoNetwork` enum.
 *
 * `PORTAL_NETWORK_ALIASES` below is the *superset* — it accepts the parent-facing
 * spellings as well. This narrower list is kept for `paymentsQuerySchema`, whose
 * `network` filter is rendered as a dropdown of stored values on the admin
 * Payments screen; letting a parent-facing alias through a filter would mean a
 * query the UI cannot produce.
 */
const MOMO_NETWORK_ENUM = ["MTN", "VODAFONE", "AIRTELTELIGO", "UNKNOWN"];

/**
 * The shape of a pay token.
 *
 * Declared at the top of the module because four schemas below build their
 * `.pattern()` from it at module-evaluation time. Declared below them it would be
 * a temporal dead zone read, which is a runtime crash on the first import rather
 * than anything a test of one schema would have caught.
 *
 * Kept in one place because these schemas must not be able to drift apart: a
 * verify endpoint that accepted a token the page endpoint rejects would 422 on a
 * token the parent legitimately holds, on the one screen that has to work.
 *
 * `[0-9A-F]` only, matching `generatePayLinkToken`'s `randomBytes().toString("hex")`.
 */
export const PAY_TOKEN_PATTERN = /^STU-[A-F0-9]{8}$/;

/**
 * Portal spellings → the payment model's `momoNetwork` enum.
 *
 * **A parent picking a network chooses "Telecel Cash", never "VODAFONE".** Telecel
 * was rebranded in Ghana in 2017 and no parent calls it Vodafone Cash, so the
 * admin-facing spelling has to be accepted alongside the one on the card.
 *
 * A lookup rather than three `.toUpperCase()` calls at the call sites, because the
 * irregular cases (`Telecel` → `VODAFONE`, `AirtelTigo` → `AIRTELTELIGO`) are
 * exactly the ones that get typed wrong, and a second hand-written mapping is how
 * they end up disagreeing. `pay.service.resolveNetwork` applies it, so there is one
 * implementation.
 *
 * Also at the top: `initiatePaymentSchema`'s `.valid()` list is built from its keys.
 */
export const PORTAL_NETWORK_ALIASES = {
  MTN: "MTN",
  TELECEL: "VODAFONE",
  VODAFONE: "VODAFONE",
  RED: "VODAFONE",
  AIRTELTIGO: "AIRTELTELIGO",
  AIRTEL: "AIRTELTELIGO",
  TIGO: "AIRTELTELIGO",
  AT: "AIRTELTELIGO",
  // A parent who has not chosen, or a client that omitted the field. The gateway
  // resolves the real operator from the number's prefix anyway.
  UNKNOWN: "UNKNOWN",
};

// ──────────────────── Validators ────────────────────
export const paymentIdParamSchema = Joi.object({
  paymentId: Joi.string().trim().min(5).max(50).required(),
});

/**
 * `GET /pay/:token/receipt/:paymentId` — both path parameters, in one schema.
 *
 * This route used to chain `validate(payTokenParamSchema, "params")` and then
 * `validate(paymentIdParamSchema, "params")`. **That could never have worked.**
 * `validate` writes the validated value back onto `req.params` and validates with
 * `stripUnknown: true`, so the first middleware reduced `{ token, paymentId }` to
 * `{ token }` and deleted `paymentId`; the second then rejected every request with
 * `422 "paymentId" is required`. Reproduced by mounting the same two middlewares on
 * a bare Express app — the endpoint had never once served a receipt.
 *
 * Two schemas for one segment is a pattern not to repeat anywhere: whichever ran
 * first silently narrowed the params, and here the params are the thing being
 * validated, so the loss is not cosmetic. One schema per segment, containing every
 * parameter in it.
 */
export const payReceiptParamSchema = Joi.object({
  token: Joi.string().pattern(PAY_TOKEN_PATTERN).required()
    .messages({
      "string.pattern.base": "Invalid payment token format. Expected format: STU-XXXXXXXX",
    }),
  paymentId: Joi.string().trim().min(5).max(50).required().messages({
    "any.required": "Payment ID is required",
    "string.min": "Invalid payment ID",
  }),
});

export const payTokenParamSchema = Joi.object({
  token: Joi.string().pattern(PAY_TOKEN_PATTERN).required()
    .messages({
      "string.pattern.base": "Invalid payment token format. Expected format: STU-XXXXXXXX",
    }),
});

/**
 * `POST /pay/:token/initiate`.
 *
 * Serves both callers of this one endpoint. The admin flow sends
 * `phoneNumber` / `momoNetwork` because that is the payment model's vocabulary; the
 * parent portal sends `phone` / `network` because those are the words on the cards
 * a parent taps. Rather than validate twice — `validate` aborts on the first
 * failure, so two schemas on one route means whichever is listed first silently
 * decides the contract — both spellings are accepted here and the service reads
 * either. See `PORTAL_NETWORK_ALIASES` for the network names.
 *
 * `amount` is *not* checked against the student's balance here. It cannot be: the
 * balance is in the database and this schema is pure. `initiatePayment` re-reads it
 * and refuses an overpayment with a message naming the current balance — the point
 * of checking the ceiling against live data rather than trusting a figure the client
 * was shown earlier and may have been holding for minutes.
 *
 * The floor is 100 pesewas, GH₵ 1.00. A Mobile Money prompt for one pesewa is a
 * network round trip, a fee and a receipt for nothing. Note this is *tighter* than
 * the original `min(1)`, which existed for a bursar recording a desk adjustment of
 * a few pesewas in the admin Payments screen — a path that goes through
 * `manualPayment` and never through here.
 */
export const initiatePaymentSchema = Joi.object({
  amount: Joi.number().integer().min(100).required()
    .messages({
      "number.base": "Amount must be a number",
      "number.integer": "Amount must be an integer (pesewas)",
      "number.min": "The minimum payment is GH₵ 1.00",
      "any.required": "Amount is required",
    }),
  // 'momo' routes to a mobile money prompt and needs a MoMo number; 'card'
  // routes to the hosted checkout.
  paymentMethod: Joi.string().valid("momo", "card").default("momo"),
  // Either spelling, but not neither — checked after the fields are known.
  phoneNumber: Joi.string().trim().pattern(/^(0|233|\+233)[2-57][0-9]{8}$/).optional()
    .messages({ "string.pattern.base": "Invalid Ghana phone number format" }),
  phone: Joi.string().trim().pattern(/^(0|233|\+233)[2-57][0-9]{8}$/).optional()
    .messages({ "string.pattern.base": "Invalid Ghana phone number format" }),
  momoNetwork: Joi.string().trim().uppercase()
    .valid(...Object.keys(PORTAL_NETWORK_ALIASES))
    .optional(),
  network: Joi.string().trim().uppercase()
    .valid(...Object.keys(PORTAL_NETWORK_ALIASES))
    .optional(),
  description: Joi.string().trim().max(500).optional().allow("", null),
  // The OTP Moolre sent to the payer's phone.
  //
  // Moolre verifies the payer's number before it will send the approval
  // prompt: it answers `TP14` and sends the parent a code by SMS. The parent
  // types it here and the request is repeated, which is what actually puts
  // the prompt on their handset. Without this field the payment can never
  // leave the "waiting for a code" state.
  otpCode: Joi.string().trim().max(12).optional().allow("", null),
  feesBreakdown: Joi.array().items(Joi.object({
    label: Joi.string().trim().max(100).required(),
    amount: Joi.number().integer().min(0).required(),
  })).optional(),
  metadata: Joi.object().optional(),
  // When the gateway takes the payment on its hosted checkout (card), no MoMo
  // phone number is needed — the parent enters their card details there instead.
  // For MoMo (the default method), a Ghana phone number is required.
}).custom((value, helpers) => {
  if (value.paymentMethod === "momo") {
    const hasPhone = value.phone || value.phoneNumber;
    if (!hasPhone) {
      return helpers.error("any.invalid", { message: "Mobile money number is required" });
    }
  }
  return value;
});

export const verifyPaymentSchema = Joi.object({
  // The reference the portal was handed when the payment was started. Pinning
  // the poll to it keeps the answer about the payment being waited on, even
  // when the parent has more than one in flight.
  reference: Joi.string().trim().max(100).optional(),
  mtnReferenceId: Joi.string().trim().max(100).optional(),
});

/**
 * The hosted-checkout request.
 *
 * Only the reference is needed: the amount, the currency and the redirect are
 * read from the payment record rather than from the request, so a caller
 * cannot ask for a checkout page for a different amount than the one they
 * were charged.
 */
export const checkoutSchema = Joi.object({
  reference: Joi.string().trim().max(100).required(),
}).unknown(true);

/**
 * The Moolre callback payload.
 *
 * Every field is optional and the object allows unknown keys, because Moolre's
 * callback shape has changed across account configurations and the *payload*
 * is never trusted: `handleMoolreWebhook` re-verifies the transaction against
 * Moolre's own status endpoint before any money moves. A schema that rejected
 * an unfamiliar shape would turn a callback we could still have verified into
 * a 422 and a lost settlement.
 *
 * The reference is still required, because without one there is nothing to
 * verify — that is a payload we genuinely cannot act on, and it is a 400.
 */
export const moolreWebhookSchema = Joi.object({
  status: Joi.alternatives().try(Joi.number(), Joi.string()).optional(),
  message: Joi.string().optional(),
  reference: Joi.string().optional(),
  externalref: Joi.string().optional(),
  transactionid: Joi.alternatives().try(Joi.number(), Joi.string()).optional(),
  amount: Joi.number().optional(),
  channel: Joi.alternatives().try(Joi.number(), Joi.string()).optional(),
  currency: Joi.string().optional(),
  payer: Joi.string().optional(),
  accountnumber: Joi.string().optional(),
  data: Joi.object().unknown(true).optional(),
})
  .or("reference", "externalref", "transactionid", "data")
  .unknown(true);

export const paymentsQuerySchema = Joi.object({
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  studentId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  status: Joi.string().valid(...PAYMENT_STATUS_ENUM, "all").default("all"),
  paymentMethod: Joi.string().valid(...PAYMENT_METHOD_ENUM).optional(),
  provider: Joi.string().valid(...PAYMENT_PROVIDER_ENUM).optional(),
  // `class` is a class *name* (`School.academic.classes` is `[String]`; there are
  // no class ids in this system), so it is validated as a plain string and
  // resolved to student ids by the service rather than cast to an ObjectId.
  // `.allow("")` because the dashboard's filter bar submits every control on
  // save, and an empty class box must mean "no filter" rather than a 422.
  class: Joi.string().trim().max(50).allow("").optional(),
  network: Joi.string().valid(...MOMO_NETWORK_ENUM).optional(),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
  minAmount: Joi.number().integer().min(0).optional(),
  maxAmount: Joi.number().integer().min(0).optional(),
  search: Joi.string().trim().max(100).allow("").optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string().valid("createdAt", "amount", "completedAt", "paymentId").default("createdAt"),
  sortOrder: Joi.string().valid("asc", "desc").default("desc"),
});

/**
 * The export takes the same filters as the list, plus a format.
 *
 * `page`, `limit`, `sortBy` and `sortOrder` are inherited and then ignored by
 * the service on purpose: a client that deep-links "export this view" should not
 * be rejected for carrying the page it is on, and a file that silently carried
 * only that page's rows would be the failure `paginationFor()` in
 * `reports.service.js` exists to prevent. The file is always the whole filtered
 * set.
 *
 * CSV is the only format wired up, so the enum is single-valued for now; the
 * service still falls back to CSV for a direct caller, because refusing a caller
 * that asked for a file is worse than handing it the one file we can make.
 */
export const paymentExportQuerySchema = paymentsQuerySchema.keys({
  format: Joi.string().valid("csv").default("csv"),
});

export const paymentDetailQuerySchema = Joi.object({
  includeWebhookData: Joi.boolean().default(false),
});

export const refundPaymentSchema = Joi.object({
  reason: Joi.string().trim().min(5).max(500).required(),
  amount: Joi.number().integer().min(1).optional(),
});

export const generateReceiptSchema = Joi.object({
  paymentId: Joi.string().trim().min(5).max(50).required(),
});

/**
 * `POST /payments/:paymentId/receipt/email`.
 *
 * The email is optional and that is the point: the route reads the parent's
 * address off the student record, and this field is only needed when there is
 * none on file. It is validated as an email rather than a plain string so a
 * typo is refused here — with a message about the address — rather than
 * reaching Brevo and coming back as a provider error the bursar cannot act on.
 */
export const receiptEmailSchema = Joi.object({
  email: Joi.string().trim().email().allow("", null).messages({
    "string.email": "Enter a valid email address",
  }),
});

/**
 * `POST /payments/:paymentId/receipt/whatsapp`.
 *
 * No body at all — an empty schema. The recipient is derived from the parent's
 * record on the server; accepting a phone number here would let a caller point
 * any receipt at any number, and the audit trail would stop meaning "the
 * parent was sent it". The schema still runs for that reason: `validate` reads
 * every field against this list, so a stray key in the payload is dropped
 * rather than leaned on.
 */
export const receiptWhatsappSchema = Joi.object({});

// ──────────────────── Parent pay portal ────────────────────
//
// The schemas below describe the *public* parent portal. They share
// `initiatePaymentSchema` with the admin flow rather than replacing it, because
// that route has two callers and `validate` aborts on the first schema it fails —
// so a second schema on the same route would mean whichever was listed first
// silently became the contract. Where both callers needed something (the network a
// parent picks), the shared schema accepts both spellings.

/**
 * A due date may not sit in the past.
 *
 * Duplicated from `paymentPlan.validation.js` rather than imported: that file
 * keeps its exports flat and re-exporting a `Joi.custom` builder across two
 * validation modules would couple the admin plan API to the public portal. The
 * rule is three lines and it is asserted by tests in both suites, so a divergence
 * would be caught rather than shipped.
 */
const futureDate = Joi.date()
  .custom((value, helpers) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (new Date(value) < today) return helpers.error("any.custom");
    return value;
  })
  .messages({ "any.custom": "Choose today or a date in the future" });

/** A Ghanaian MoMo number, in any spelling `phoneNumbers.js` resolves. */
const ghanaPhone = Joi.string()
  .trim()
  .pattern(/^(0|233|\+233)[2-57][0-9]{8}$/)
  .messages({
    "string.pattern.base":
      "Enter a valid Ghanaian mobile number, e.g. 0241234567",
  });

/**
 * `POST /pay/:token/plan/request`.
 *
 * `interval` excludes `"custom"` even though `createPlanSchema` allows it: a
 * custom schedule needs per-installment amounts and dates, which a parent
 * choosing from three segmented options cannot supply and which the school must
 * set deliberately. Offering it here would produce a request the school has to
 * rewrite before it can be approved.
 *
 * `parentName` / `parentPhone` default to the student's primary guardian on the
 * server, so a parent who already has an account on the child does not retype
 * their own name. They are validated when present for the same reason.
 */
export const payRequestPlanSchema = Joi.object({
  numberOfInstallments: Joi.number().integer().min(2).max(6).required().messages({
    "number.min": "Choose between 2 and 6 instalments",
    "number.max": "Choose between 2 and 6 instalments",
    "any.required": "Choose how many instalments you need",
  }),
  interval: Joi.string().valid("weekly", "biweekly", "monthly").default("monthly"),
  startDate: futureDate.required().messages({
    "any.required": "Choose when you would like to start paying",
  }),
  parentName: Joi.string().trim().max(100).optional().allow("", null),
  parentPhone: ghanaPhone.optional().allow("", null),
  notes: Joi.string().trim().max(500).optional().allow("", null),
});

/**
 * `POST /pay/:token/notify-school`.
 *
 * `message` has a floor as well as a ceiling. A support inbox that accepts
 * `"?"` is one that gets `"?"` four times; a real message from a parent costs a
 * bursar a phone call and is worth a couple of seconds of typing.
 *
 * **`message` is no longer `required`.** It is conditionally required: a parent with
 * something to say but who would rather speak than type sends `parentName`,
 * `parentPhone` and an `audio` file and nothing else. That is not a corner case to be
 * tolerated — it is the reason the recorder exists, so a schema that demanded the
 * text would have made the feature unusable for exactly the parent it was built for.
 *
 * The "at least one of the two" rule cannot be expressed with `alternatives().try()`
 * on two sibling keys, because Joi has no way to say "A or B, and I do not know
 * which one the caller picked". It is enforced as a schema-level `.custom()` reading
 * the validated value.
 *
 * **`value.audio` is a marker, not the file.** Multer moves an uploaded file to
 * `req.file` and leaves `req.body` holding the text fields only, so on a multipart
 * submission there is no `audio` key here even when a recording is attached — and this
 * rule answered 422, telling a parent who had recorded a voice note to write a
 * message instead. `exposeParentAudioToBody` (`middleware/upload.js`) now sets a
 * truthy placeholder between multer and this schema, so the rule can see that a file
 * arrived. The bytes stay on `req.file`, where the controller reads them; nothing
 * multi-megabyte is ever handed to Joi.
 *
 * Which is why the service re-checks it from `req.file`. Both layers refusing the same
 * thing is not redundancy for its own sake: this one depends on a middleware being
 * mounted in the right position, and the endpoint is unauthenticated.
 */
export const payNotifySchoolSchema = Joi.object({
  parentName: Joi.string().trim().min(2).max(100).required(),
  parentPhone: ghanaPhone.required(),
  // `.min(10)` with `.allow("")` — and the order matters more than it looks. An
  // absent message is legal (a voice note on its own is a message), and `allow("")`
  // is what exempts it from the floor. Anything *present* still has to be a real
  // message: an inbox that accepts `"?"` is one that gets `"?"` four times, and a
  // bursar spends a phone call on each one. Dropping the floor when it was optional
  // was tried first and it let `"?"` straight through.
  message: Joi.string().trim().allow("").min(10).max(1000).messages({
    "string.empty": "",
    "string.min": "Please write at least a short message so the school can help",
    "string.max": "Please keep your message under 1000 characters",
  }),
  // A marker placed by `exposeParentAudioToBody` when a recording was attached.
  // Declared as `any` because only its truthiness matters to the rule below, and
  // declared at all so `stripUnknown: true` does not discard it.
  audio: Joi.any().optional(),
}).custom((value, helpers) => {
  const text = String(value?.message || '').trim();
  const hasAudio = Boolean(value?.audio);
  return text.length > 0 || hasAudio
    ? value
    : helpers.message({
        custom:
          'Please write a message or record a voice note so the school can help',
      });
});

/**
 * `GET /pay/:token/verify/:reference`.
 *
 * `reference` is the value the initiate call returned. It is not the gateway's
 * transaction id: this endpoint resolves the row the portal already created, so
 * a caller cannot use it to ask about an arbitrary transaction on the platform.
 */
export const payReferenceParamSchema = Joi.object({
  token: Joi.string().pattern(PAY_TOKEN_PATTERN).required().messages({
    "string.pattern.base": "Invalid payment token format. Expected format: STU-XXXXXXXX",
  }),
  reference: Joi.string()
    .trim()
    .pattern(/^SUK-[0-9]{10,}-[A-Z0-9]{6}$/)
    .required()
    .messages({
      "string.pattern.base": "Invalid payment reference",
    }),
});

/**
 * `GET /pay/:token/payments`.
 *
 * `filter` narrows the ledger to a window — `all`, `year` or `term` — and it
 * is validated rather than free text, because it reaches a Mongo date range.
 * `term` resolves to the school's own current term where the school has
 * configured one and to the calendar year where it has not; `pay.service.js`
 * owns that rule and this schema only decides what a caller may ask for.
 */
export const payPaymentsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(50).default(20),
  filter: Joi.string().trim().valid("all", "year", "term").default("all"),
});

/**
 * `POST /pay/:token/plan/cancel`.
 *
 * The reason is optional — a parent tapping "cancel" should not have to type
 * an explanation first — and it is capped at the model's own 300-character
 * limit, so a long paste is truncated here rather than refused.
 */
export const payPlanCancelSchema = Joi.object({
  reason: Joi.string().trim().max(300).optional().allow("", null),
});

/**
 * `POST /pay/:token/support`.
 *
 * The support form's three fields. `body` is the parent's message and it has a
 * floor for the same reason the pay page's message does: an inbox that accepts
 * "?" is one that gets "?" four times.
 *
 * The guardian's name and number are *not* here. They come from the student's
 * record — see `pay.service.js`'s `sendSupportMessage` — so a parent is never
 * asked to retype a number the school already holds.
 */
export const paySupportSchema = Joi.object({
  category: Joi.string().trim().max(60).optional().allow("", null),
  subject: Joi.string().trim().max(120).optional().allow("", null),
  body: Joi.string().trim().min(10).max(1000).required().messages({
    "any.required": "Please write a message so the school can help",
    "string.min": "Please write at least a short message so the school can help",
    "string.max": "Please keep your message under 1000 characters",
  }),
});
