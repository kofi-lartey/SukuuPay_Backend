import { School } from "../../models/schoolModel.js";
import { User } from "../../models/userModel.js";
import { Student } from "../../models/studentModel.js";
import { Payment } from "../../models/paymentModel.js";
import { PlatformLedger } from "../../models/PlatformLedger.js";
import {
  DisbursementBatch,
  OPEN_DISBURSEMENT_STATUSES,
} from "../../models/DisbursementBatch.js";
import {
  generateUniqueSlug,
  generateSchoolCode,
  validateGhanaPhone,
} from "../../utils/generateCode.js";
import { getProvisioningDefaults } from "../platformSettings.service.js";
import ApiError from "../../utils/ApiError.js";
import { optionalId } from "../../utils/platformQuery.js";
import { addDays, addMonths } from "../../utils/dateHelpers.js";

/**
 * Platform-owner operations on a single school.
 *
 * Deliberately a *sibling* of `services/admin.service.js`, not a replacement for
 * it. That file owns the platform-wide reads and aggregates (dashboard KPIs,
 * revenue, settings) and its `listAllSchools` is the console's schools table;
 * this file owns the writes, because a write needs a before/after pair and a
 * reason-required guard attached to it, and none of that belongs in the same
 * module as a `$group`. Splitting by read/write also keeps the two sets of
 * auditors independent: a change to a revenue aggregation cannot break a
 * suspension, and a change to a suspension cannot silently alter a revenue
 * figure.
 *
 * Every function here is a pure service: it validates, writes, and returns
 * `{ before, after }` for the controller to hand to `logRequest`. Nothing in this
 * file touches `req`, and nothing in this file audits — see the conventions note
 * that `utils/auditService.log` does not currently forward a top-level
 * `before`/`after` into `AuditLog.create`, which is why every controller below
 * carries the pair in `meta` as well.
 */

/**
 * Where the six platform-owned per-school fields actually live.
 *
 * **`subscription.`-prefixed, and that is not a choice made here.** The block that
 * declares `platformFeePercent`, `featureFlags`, `internalNotes`,
 * `accountManagerId`, `onboardingCompletedAt` and `tags` sits *inside* the already
 * open `subscription: { … }` object in `models/schoolModel.js` (which does not
 * close until the `monthlyFee` field), so those six are subpaths of `subscription`
 * rather than top-level school fields. Verified with
 * `Object.keys(School.schema.tree.subscription)`.
 *
 * This matters more than it looks: a reader that writes `school.platformFeePercent`
 * gets `undefined`, and `undefined` inside an aggregation `$multiply` is simply
 * zero, so the failure presents as "this school pays no platform fee" rather than
 * as an error. Centralising the six paths here means the correction, when it
 * happens, is one edit in one place instead of a grep across every service.
 */
export const PLATFORM_FIELD_PATHS = {
  platformFeePercent: "subscription.platformFeePercent",
  featureFlags: "subscription.featureFlags",
  internalNotes: "subscription.internalNotes",
  accountManagerId: "subscription.accountManagerId",
  onboardingCompletedAt: "subscription.onboardingCompletedAt",
  tags: "subscription.tags",
};

/**
 * Read one of the six by its declared path.
 *
 * A four-line indirection that buys one thing: if the fields are ever moved back to
 * the top level of `schoolModel.js`, this is the only place that has to be
 * touched here. The alternative — `school.subscription?.tags` written out at each
 * of the dozen use sites — means the move is a grep across every service, and one
 * missed site fails silently as `undefined` rather than as an error.
 */
const readPlatformField = (school, field) => {
  const path = PLATFORM_FIELD_PATHS[field];
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), school);
};

/** The write-side counterpart. Only used where the field is a whole subdocument. */
const writePlatformField = (school, field, value) => {
  const path = PLATFORM_FIELD_PATHS[field];
  const [head, tail] = path.split(".");
  school[head][tail] = value;
};

/**
 * Credentials stripped from every School read in this file.
 *
 * `hubtelClientId` and `hubtelApiKey` are `select: false` on the model and
 * therefore absent anyway; they are named explicitly because "a field is safe
 * because it happens to be `select: false` today" is not a property a reader can
 * verify from here, and the console is not the place to read a school's live
 * gateway credential — not even a super admin's. `hubtelClientSecret` and
 * `sms.apiKey` are the two that would actually cause harm.
 */
const SAFE_SCHOOL_SELECT =
  "-payment.hubtelClientId -payment.hubtelClientSecret -payment.hubtelApiKey -sms.apiKey";

/**
 * Payments whose platform cut has not been decided yet.
 *
 * `pending` and `processing` are the only statuses where the money has not landed
 * and the rate that will apply to it has not been taken. A `completed` payment has
 * already had its markup skimmed at the rate in force when the parent paid, which
 * is the whole reason the markup change warns instead of blocking — see
 * `updateSchoolMarkup`.
 */
const IN_FLIGHT_PAYMENT_STATUSES = ["pending", "processing"];

/**
 * `School.payment.gatewayMode`'s enum, restated so the service can refuse an
 * unknown value with a 400 rather than letting Mongoose raise a `ValidationError`
 * (which has no `status`, so it would surface as a 500).
 */
const GATEWAY_MODES = ["hubtel", "arke", "mnotify", "manual"];

/** The platform-written subset of a subscription. Narrower than the schema's enum. */
const PAID_SUBSCRIPTION_STATUSES = ["active", "expired"];

/**
 * Resolve a route param to an ObjectId, or fail with a 400.
 *
 * `optionalId` (`utils/platformQuery.js`) already validates the shape and throws
 * the right `ApiError`; it returns `null` for a missing value, which is correct
 * for a *filter* and wrong for a *resource id* — a filter with no id means "no
 * filter", while a request for `/schools//markup` means the caller built the URL
 * wrong, and silently treating it as "the first school" would write a rate change
 * against an arbitrary tenant.
 */
const requireObjectId = (value, label = "ID") => {
  const id = optionalId(value, label);
  if (!id) throw new ApiError(`Missing ${label}`, 400, "INVALID_ID");
  return id;
};

/**
 * Load a school or 404.
 *
 * `includeArchived` exists because a console must be able to *look at* a school
 * it archived. `archiveSchool` sets `deletedAt`, and every platform-wide list in
 * `admin.service.js` filters `deletedAt: null` — so an archived school is
 * invisible by design. Refusing the detail read too would mean the archive is
 * irreversible from the operator's point of view even though the row is right
 * there: no un-archive endpoint can be reasoned about when the record cannot be
 * opened.
 */
const findSchoolOrFail = async (schoolId, { includeArchived = false } = {}) => {
  const id = requireObjectId(schoolId, "school ID");
  const filter = includeArchived ? { _id: id } : { _id: id, deletedAt: null };
  const school = await School.findOne(filter).select(SAFE_SCHOOL_SELECT);
  if (!school) throw new ApiError("School not found", 404, "SCHOOL_NOT_FOUND");
  return school;
};

/**
 * Turn MongoDB's duplicate-key error into a 409 that names the offending field.
 *
 * The raw E11000 surfaces as a 500 whose message is `E11000 duplicate key error
 * collection: … index: email_1 dup key: { email: "…" }`. For a form that just lost
 * a race with another operator, that reads as "the server is broken" rather than
 * "pick a different email", so the index name is mapped back to a field and a
 * sentence a bursar can act on.
 *
 * `keyPattern` is the authoritative source (it is the actual index definition);
 * `keyValue` is the fallback for drivers that omit it. An unrecognised duplicate is
 * still a 409 — it is still a conflict, and a 500 would be a lie about that.
 */
const DUPLICATE_MESSAGES = {
  email: "A school with this email address already exists",
  slug: "Another school already uses that slug",
  schoolCode: "Another school already uses that school code",
};

const toDuplicateApiError = (error) => {
  const field =
    Object.keys(error?.keyPattern || {})[0] || Object.keys(error?.keyValue || {})[0] || null;

  const message = field
    ? DUPLICATE_MESSAGES[field] || `Another school already uses that ${field}`
    : "A school with these details already exists";

  return new ApiError(message, 409, field ? `DUPLICATE_${field.toUpperCase()}` : "DUPLICATE", {
    field,
  });
};

/** The four per-tenant capability switches, in the order the console lists them. */
const FEATURE_FLAG_KEYS = ["installments", "idCards", "whatsapp", "apiAccess"];

/**
 * `GET /admin/schools/:id` — everything the console shows on one school's page.
 *
 * One request rather than eight because the page is opened to answer a single
 * question — "is this school healthy, and what has the platform done to it" — and
 * a screen that fires eight platform-wide-scope requests to assemble it is eight
 * chances for the panels to disagree about which moment in time they describe.
 *
 * All reads run concurrently and are `.lean()`. `studentCount` and the
 * `students` list are counted separately rather than derived from the list,
 * because a list of ten is not a total and using `recentStudents.length` as the
 * enrolment would report a 1,200-student school as having ten.
 */
export const getAdminSchoolDetail = async (schoolId) => {
  const school = await findSchoolOrFail(schoolId, { includeArchived: true });
  const id = school._id;

  const [
    studentCount,
    recentPayments,
    recentStudents,
    teamMembers,
    ledgerSummary,
    disbursements,
  ] = await Promise.all([
    User.countDocuments({ schoolId: id, role: "student", deletedAt: null }),

    Payment.find({ schoolId: id, deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("paymentId studentId parentId amount currency status provider paymentMethod receiptNumber createdAt settledAt")
      .populate("studentId", "studentName studentClass")
      .lean(),

    Student.find({ schoolId: id, deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("studentName firstName lastName studentClass status totalOwed totalPaid balance createdAt")
      .lean(),

    User.find({ schoolId: id, deletedAt: null })
      .sort({ role: 1, createdAt: 1 })
      .select("name email phone role position status isEmailVerified lastLoginAt createdAt")
      .lean(),

    /*
     * The platform's own earnings from this tenant, grouped by entry type.
     *
     * Grouped on `(type, settled)` rather than on `type` alone because `settled` is
     * the distinction `PlatformLedger`'s own header insists on: unsettled entries
     * are *accrued* — taken from parents, on the dashboard, not yet in an account.
     * A per-type total that merged the two would answer "how much have we earned
     * from Kumasi Basic" with a number that includes money still sitting in the
     * gateway, which is the exact confusion the field exists to prevent.
     *
     * `$ne: 0` drops the empty halves so the summary does not carry four zero rows
     * per type for a school that has only ever been paid markup.
     */
    PlatformLedger.aggregate([
      { $match: { schoolId: id } },
      {
        $group: {
          _id: { type: "$type", settled: "$settled" },
          count: { $sum: 1 },
          amount: { $sum: "$amount" },
        },
      },
      { $match: { amount: { $ne: 0 } } },
    ]),

    /*
     * `metadata` is a `Mixed` bag that holds raw provider payloads on some batches
     * (see the reconciliation job). It is not projected here: a payout screen has
     * no use for a gateway callback body, and `Mixed` is untyped by definition, so
     * it is the one field on this model that could grow a credential.
     */
    DisbursementBatch.find({ schoolId: id })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("batchNumber status periodStart periodEnd grossAmount platformAmount netAmount paymentCount provider payoutReference approvedAt processedAt failureReason createdAt")
      .lean(),
  ]);

  return {
    school: school.toJSON(),
    subscription: school.subscription,
    paymentConfig: school.payment,
    tags: readPlatformField(school, "tags") ?? [],
    featureFlags: readPlatformField(school, "featureFlags") ?? null,
    internalNotes: readPlatformField(school, "internalNotes") ?? "",
    onboardingCompletedAt: readPlatformField(school, "onboardingCompletedAt") ?? null,
    platformFeePercent: readPlatformField(school, "platformFeePercent") ?? 0,
    stats: school.stats,
    studentCount,
    recentPayments,
    recentStudents,
    teamMembers,
    ledgerSummary: foldLedgerSummary(ledgerSummary),
    disbursements,
  };
};

/**
 * `{[{type, settled, count, amount}]}` → `{ byType, total, unsettled, settled }`.
 *
 * Folded in JS rather than with a second pipeline because the output is small and
 * fixed — eight entry types by two settlement states at most — and a `$group` that
 * reshapes that into nested objects is harder to read here than the loop that
 * produces it. Signs are preserved rather than absolutised: a `refund` entry is
 * negative and is supposed to reduce the school's balance with the platform.
 */
const foldLedgerSummary = (rows = []) => {
  const byType = {};
  let total = 0;
  let settled = 0;
  let unsettled = 0;

  for (const row of rows) {
    const type = row._id?.type;
    const isSettled = row._id?.settled === true;
    const amount = Number(row.amount) || 0;
    const count = Number(row.count) || 0;

    if (!type) continue;

    byType[type] = byType[type] || { amount: 0, count: 0, settledAmount: 0, unsettledAmount: 0 };
    byType[type].amount += amount;
    byType[type].count += count;
    if (isSettled) byType[type].settledAmount += amount;
    else byType[type].unsettledAmount += amount;

    total += amount;
    if (isSettled) settled += amount;
    else unsettled += amount;
  }

  return { byType, total, settled, unsettled, count: Object.values(byType).reduce((n, t) => n + t.count, 0) };
};

/**
 * `POST /admin/schools` — create a school by hand.
 *
 * Exists because the other provisioning route (`provisionSchoolForUser`) can only
 * ever create a school *for somebody who just signed up*, and the platform
 * routinely needs the opposite: a school that has been using SukuuPay since the
 * pilot spreadsheet, or one whose bursar was signed off in person and whose
 * account is being written down now.
 *
 * Two independent uniqueness layers, on purpose:
 *
 *   1. an explicit `findOne` per field, which produces the readable 409;
 *   2. `E11000` translation at the catch, because layer 1 is a read followed by a
 *      write and two operators clicking "create" on the same school at the same
 *      instant both pass it. Without layer 2 that race is a 500, which is how a
 *      duplicate school gets made — the operator sees a failure, tries again, and
 *      the retry is what actually creates the twin.
 */
export const createSchoolAsPlatform = async (payload = {}, actor) => {
  if (!actor?._id) {
    throw new ApiError("An authenticated platform operator is required", 401, "UNAUTHENTICATED");
  }

  const name = String(payload.name || "").trim();
  if (!name) throw new ApiError("School name is required", 400, "NAME_REQUIRED");

  const email = String(payload.email || "").trim().toLowerCase();
  if (!email) throw new ApiError("School email is required", 400, "EMAIL_REQUIRED");

  /*
   * The rest of the model's required set, checked here rather than left to
   * Mongoose.
   *
   * The Joi schema already marks `type`, `region`, `city` and `address` required, so
   * on the HTTP path they cannot arrive missing — this is the guard for every other
   * caller (a script, a test, a route wired without the middleware). Left to
   * Mongoose it is a `ValidationError` with a 500 status, which reports a server
   * fault for what is plainly a bad request, and `error.status` is undefined on it
   * so the controller's `error.status || 500` turns a fixable 400 into an
   * unactionable 500.
   */
  for (const field of ["type", "region", "city", "address"]) {
    if (!String(payload[field] || "").trim()) {
      throw new ApiError(`School ${field} is required`, 400, "FIELD_REQUIRED", { field });
    }
  }

  /*
   * Phone is normalised through the same `validateGhanaPhone` the self-service
   * path uses, rather than accepted as typed. The school's phone is not decoration:
   * it is the number the payment gateway calls back and the number SMS receipts are
   * quoted from, so a stored "0244 123 456" that no gateway will dial is a school
   * whose parents pay and hear nothing. Refusing is better than storing it — a
   * 400 here is answerable by the operator in one retry, and an unparseable number
   * in the database is a support ticket that appears weeks later.
   */
  const phone = validateGhanaPhone(String(payload.phone || ""));
  if (!phone) {
    throw new ApiError(
      "Invalid Ghana phone number format (expected 024XXXXXXXX, 23324XXXXXXXX or a 9-digit number)",
      400,
      "INVALID_PHONE"
    );
  }

  const slug = await generateUniqueSlug(payload.slug ? String(payload.slug) : name);
  const schoolCode = payload.schoolCode
    ? String(payload.schoolCode).trim().toUpperCase()
    : await generateSchoolCode(name);

  const [emailTaken, slugTaken, codeTaken] = await Promise.all([
    School.exists({ email }),
    School.exists({ slug }),
    School.exists({ schoolCode }),
  ]);

  if (emailTaken) throw toDuplicateApiError({ keyPattern: { email: 1 } });
  if (slugTaken) throw toDuplicateApiError({ keyPattern: { slug: 1 } });
  if (codeTaken) throw toDuplicateApiError({ keyPattern: { schoolCode: 1 } });

  const { markupPercent, trialDays } = await getProvisioningDefaults();

  /*
   * Markup: an explicit value from the operator wins over the platform default.
   *
   * `createSchool` merges `{ ...data.payment, platformMarkupPercent: markupPercent }`
   * and its own comment says "the platform default is the floor" — but the literal
   * that follows assigns the default *last*, so it actually overrides an explicit
   * choice. That is not reproduced here: this endpoint exists for the case where
   * the operator is writing down a school they negotiated a rate with, and
   * silently replacing their number with the platform default is the one outcome
   * that makes the endpoint worse than `createSchool`.
   */
  const explicitMarkup = Number(payload.payment?.platformMarkupPercent);
  const platformMarkupPercent = Number.isFinite(explicitMarkup)
    ? Math.min(100, Math.max(0, explicitMarkup))
    : markupPercent;

  /*
   * Trial defaults from platform settings, overridable per school.
   *
   * An operator creating a school by hand is usually back-filling an existing
   * relationship, not starting a 30-day trial, so `subscription.status: 'active'`
   * with a period end one month out is a legitimate body. The defaults still apply
   * when nothing is said, so the common case — a brand-new school — is created
   * exactly the way self-service creates one.
   */
  const now = new Date();
  const requestedSubscription = payload.subscription || {};
  const subscriptionStatus = requestedSubscription.status || "trial";
  const trialEndsAt =
    requestedSubscription.trialEndsAt || addDays(now, Number(trialDays) || 0);
  const currentPeriodEnd =
    requestedSubscription.currentPeriodEnd ||
    (subscriptionStatus === "trial" ? trialEndsAt : addMonths(now, 1));

  try {
    const school = await School.create({
      name,
      slug,
      schoolCode,
      type: payload.type || "private",
      phone,
      email,
      region: payload.region,
      city: payload.city,
      address: payload.address,
      gpsAddress: payload.gpsAddress ?? "",
      website: payload.website ?? "",
      motto: payload.motto ?? "",
      brandColor: payload.brandColor || "#1E3A8A",
      academic: payload.academic || undefined,
      stats: payload.stats || undefined,
      payment: {
        ...(payload.payment || {}),
        platformMarkupPercent,
        // Never inherited from a caller body. A credential belongs in the
        // operator's own integration screen, not in a create request that may
        // have been copy-pasted from a CSV.
        hubtelClientId: null,
        hubtelClientSecret: null,
        hubtelApiKey: null,
      },
      sms: { ...(payload.sms || {}), apiKey: null },
      subscription: {
        plan: requestedSubscription.plan || "trial",
        status: subscriptionStatus,
        monthlyFee: Number(requestedSubscription.monthlyFee) || 0,
        trialEndsAt,
        currentPeriodStart: requestedSubscription.currentPeriodStart || now,
        currentPeriodEnd,
        platformFeePercent: Number.isFinite(Number(requestedSubscription.platformFeePercent))
          ? Number(requestedSubscription.platformFeePercent)
          : 0,
        tags: normaliseTags(requestedSubscription.tags ?? []),
        featureFlags: { ...FEATURE_FLAG_DEFAULTS, ...(requestedSubscription.featureFlags || {}) },
        internalNotes: String(requestedSubscription.internalNotes || "").slice(0, 2000),
        accountManagerId: actor._id,
      },
      // `deletedAt: null` is written explicitly rather than left to the default.
      // It is the flag every platform read filters on, so a document that omits it
      // and a document that is archived are then distinguishable by inspection —
      // and the default is not guaranteed to be applied by `create` on a path
      // where the value was already set.
      deletedAt: null,
      createdBy: actor._id,
    });

    return { school: school.toJSON() };
  } catch (error) {
    if (error?.code === 11000) throw toDuplicateApiError(error);
    throw error;
  }
};

const FEATURE_FLAG_DEFAULTS = {
  installments: true,
  idCards: true,
  whatsapp: false,
  apiAccess: false,
};

/**
 * `PUT /admin/schools/:id` — edit the fields a school admin may not.
 *
 * An allowlist, and an allowlist that throws rather than ignores.
 *
 * `PUT /schools/:id` (`school.service.updateSchool`) is deliberately narrow: a
 * school admin can change their own contact details and nothing structural. The
 * platform owner needs the complement — the name a school traded under last year,
 * a region that was mis-coded at signup, a `stats` correction — and the complement
 * is genuinely dangerous to over-share. So this endpoint names what it will edit
 * and refuses everything else with an explanation, rather than accepting a body
 * and `$set`-ing whatever survived validation.
 *
 * `status` is on that list of refusals, and it is the important one: suspension
 * requires a written reason, is audited as its own action, and cascades to the
 * school's users (`school.service.suspendSchool`). A generic field write that could
 * set `status` would be a suspension with no reason, no cascade and the wrong audit
 * entry — three of the four things that make the real one safe. The Joi schema
 * forbids `status` too; this list is the second gate, for the caller that reaches
 * the service without the middleware.
 */
const PLATFORM_EDITABLE_FIELDS = new Set([
  "name",
  "type",
  "phone",
  "email",
  "region",
  "city",
  "address",
  "gpsAddress",
  "academic",
  "brandColor",
  "stats",
]);

export const updateSchoolAsPlatform = async (schoolId, patch = {}) => {
  const refused = Object.keys(patch).filter((key) => !PLATFORM_EDITABLE_FIELDS.has(key));
  if (refused.length) {
    throw new ApiError(
      refused.includes("status")
        ? "Status is not changed here. Suspend or unsuspend the school through its own endpoint so the reason is recorded."
        : `These fields cannot be edited from the platform console: ${refused.join(", ")}`,
      400,
      "FIELD_NOT_EDITABLE_HERE",
      { fields: refused }
    );
  }

  const school = await findSchoolOrFail(schoolId);
  const before = school.toJSON();

  if (patch.email !== undefined) {
    const email = String(patch.email).trim().toLowerCase();
    const clash = await School.exists({ email, _id: { $ne: school._id } });
    if (clash) throw toDuplicateApiError({ keyPattern: { email: 1 } });
    school.email = email;
  }

  if (patch.phone !== undefined) {
    const phone = validateGhanaPhone(String(patch.phone));
    if (!phone) throw new ApiError("Invalid Ghana phone number format", 400, "INVALID_PHONE");
    school.phone = phone;
  }

  for (const key of ["name", "type", "region", "city", "address", "gpsAddress", "brandColor"]) {
    if (patch[key] !== undefined) school[key] = patch[key];
  }

  // Merged rather than assigned: `academic` is a subdocument the school maintains
  // through its own endpoints (`currentTerm`, `classes`, `finalYearClasses`), and
  // `$set`-ing a two-key body over it would erase the rest — including the
  // `finalYearClasses` that `graduateStudent`'s guard depends on.
  if (patch.academic !== undefined) {
    school.academic = { ...school.academic, ...patch.academic };
  }

  if (patch.stats !== undefined) {
    school.stats = { ...school.stats, ...patch.stats };
  }

  try {
    await school.save();
  } catch (error) {
    if (error?.code === 11000) throw toDuplicateApiError(error);
    throw error;
  }

  return { before, after: school.toJSON() };
};

/**
 * `PUT /admin/schools/:id/markup` — the platform's cut of each parent payment.
 *
 * **This never rewrites history, and the response says so out loud.** A markup
 * change is prospective: every payment already collected keeps the rate it was
 * charged at, because that money has been split, receipted, and reported to the
 * school at the old rate. Re-pricing it would mean restating settled income the
 * platform has already recognised, which is an accounting event, not a settings
 * change — and it would silently disagree with the `DisbursementBatch` amounts
 * frozen at approval.
 *
 * So instead of blocking, the endpoint counts the payments that have *not* been
 * collected yet — the `pending`/`processing` ones — and returns them as
 * `warnings`. They are the only payments whose rate this decision actually moves,
 * and an operator changing a rate deserves to know how much parent money is
 * currently in flight before they press save, because that money will be split at
 * the new number.
 *
 * The warning is informational and never a 409. The alternative — refusing while
 * anything is in flight — would mean a rate change is impossible exactly when a
 * school is growing fastest, which is when a rate change is most needed.
 */
export const updateSchoolMarkup = async (schoolId, platformMarkupPercent) => {
  const percent = Number(platformMarkupPercent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new ApiError("Markup percent must be between 0 and 100", 400, "INVALID_MARKUP");
  }

  const school = await findSchoolOrFail(schoolId);
  const before = Number(school.payment?.platformMarkupPercent) || 0;

  const [inFlight, collectedCount] = await Promise.all([
    Payment.aggregate([
      { $match: { schoolId: school._id, status: { $in: IN_FLIGHT_PAYMENT_STATUSES }, deletedAt: null } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" } } },
    ]),
    Payment.countDocuments({ schoolId: school._id, status: "completed", deletedAt: null }),
  ]);

  const inFlightCount = Number(inFlight[0]?.count) || 0;
  const inFlightAmount = Number(inFlight[0]?.amount) || 0;

  school.payment.platformMarkupPercent = percent;
  await school.save();

  const deltaPercent = percent - before;

  return {
    before: { platformMarkupPercent: before },
    after: { platformMarkupPercent: percent },
    warnings: [
      {
        code: "MARKUP_APPLIES_TO_IN_FLIGHT_PAYMENTS_ONLY",
        inFlightPaymentCount: inFlightCount,
        inFlightAmount,
        collectedPaymentCount: collectedCount,
        message:
          `${inFlightCount} payment${inFlightCount === 1 ? "" : "s"} totalling ${inFlightAmount} pesewas ` +
          `are still pending or processing. These will be split at the new rate of ${percent}%. ` +
          `The ${collectedCount} already-collected payment${collectedCount === 1 ? "" : "s"} keep the ` +
          `rate they were charged at${deltaPercent === 0 ? "." : `, and the change moves platform revenue by ${deltaPercent > 0 ? "+" : ""}${deltaPercent} percentage points on future collections only.`}`,
      },
    ],
  };
};

/**
 * `PUT /admin/schools/:id/platform-fee` — Mode B fee for a school on its own
 * gateway.
 *
 * Bounded 0–5, matching the model's own ceiling, and the cap is a commercial
 * decision rather than a technical one: this is a percentage of a school's
 * collected volume for the privilege of using SukuuPay to reach its parents, not a
 * skim off one parent's MoMo. A 100% "platform fee" is a syntactically valid
 * number and a nonsense charge, and the only thing standing between it and a
 * school is this check.
 */
export const updateSchoolPlatformFee = async (schoolId, platformFeePercent) => {
  const percent = Number(platformFeePercent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 5) {
    throw new ApiError("Platform fee percent must be between 0 and 5", 400, "INVALID_PLATFORM_FEE");
  }

  const school = await findSchoolOrFail(schoolId);
  const before = Number(readPlatformField(school, "platformFeePercent")) || 0;

  writePlatformField(school, "platformFeePercent", percent);
  await school.save();

  return {
    before: { platformFeePercent: before },
    after: { platformFeePercent: percent },
  };
};

/**
 * `PUT /admin/schools/:id/gateway-mode` — which rail this school's money moves on.
 *
 * **Refused outright while any disbursement batch is open.**
 *
 * `OPEN_DISBURSEMENT_STATUSES` is `draft`, `pending_approval`, `approved`,
 * `processing` and `failed` — that is, everything except `paid` and `cancelled`
 * (`models/DisbursementBatch.js`). A batch in any of those states holds
 * `paymentIds` and a `netAmount` that were computed for a specific rail, and an
 * approved or `processing` batch is money that has been, or is being, authorised
 * against a particular gateway account. Switching the school's `gatewayMode` while
 * one is open produces the worst of both: the batch executes against the old
 * credential while every *new* payment is collected on the new one, and the
 * school's next reconciliation has two providers' references in one statement.
 *
 * A `failed` batch counts too, deliberately — that is money which has not reached
 * the school and will be retried, so the retry still has to go out on the same
 * rail. The remedy is to settle or cancel the batch first, which is a decision the
 * finance screen already supports.
 */
export const updateSchoolGatewayMode = async (schoolId, gatewayMode) => {
  /*
   * The enum is checked here as well as in the Joi schema, for the same reason the
   * school-id shape is: `School.payment.gatewayMode` is a closed Mongoose enum, so
   * an unchecked value does not produce a 400 — it produces a `ValidationError`
   * with no `status` property after the "no open batches" query has already run.
   */
  if (!GATEWAY_MODES.includes(gatewayMode)) {
    throw new ApiError(
      `Unknown gateway mode "${gatewayMode}". Valid modes are ${GATEWAY_MODES.join(", ")}.`,
      400,
      "INVALID_GATEWAY_MODE"
    );
  }

  const school = await findSchoolOrFail(schoolId);
  const before = school.payment?.gatewayMode;

  if (before === gatewayMode) {
    return { before: { gatewayMode }, after: { gatewayMode }, changed: false };
  }

  const openBatches = await DisbursementBatch.find({
    schoolId: school._id,
    status: { $in: OPEN_DISBURSEMENT_STATUSES },
  })
    .select("batchNumber status periodStart periodEnd netAmount")
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  if (openBatches.length) {
    throw new ApiError(
      `This school has ${openBatches.length} disbursement batch${openBatches.length === 1 ? "" : "es"} still open. ` +
        "Settle or cancel them before changing the payment rail — pending money cannot be moved mid-flight.",
      409,
      "OPEN_DISBURSEMENTS_BLOCK_GATEWAY_CHANGE",
      { batches: openBatches }
    );
  }

  school.payment.gatewayMode = gatewayMode;
  await school.save();

  return {
    before: { gatewayMode: before },
    after: { gatewayMode },
    changed: true,
  };
};

/**
 * `PUT /admin/schools/:id/subscription` — plan, fee and billing period.
 *
 * Two defaults are inferred when the caller does not state them, and both exist to
 * prevent a subscription that is *set up but not running*:
 *
 *   - **`status: 'trial'` with no `trialEndsAt`** gets `now + features.trialDays`
 *     from platform settings. A trial with a null end date never expires, because
 *     the job that expires trials compares against `trialEndsAt` — so the school
 *     would sit on trial forever while the console shows "trial". Defaulting is
 *     the difference between a trial and an oversight.
 *   - **an active paid plan with no `currentPeriodEnd`** gets `now + 1 month`. The
 *     same class of bug with the opposite sign: a paid subscription with a null
 *     period end is either never billed or billed on a null date, and the renewal
 *     job would skip it silently. Anchoring to `currentPeriodStart` when one was
 *     supplied would be marginally more correct for a back-dated period, and is
 *     what happens — see below.
 *
 * `trialEndsAt` in the past is a 422 and not a 400. "In the past" is a relation to
 * *now*, not to the request, so it cannot be a static schema bound that a Joi
 * `custom` rule would express better; and it is not a state conflict either — the
 * caller did not ask for anything that conflicts with the school's current state,
 * they asked for a date that cannot be true. This is the one 422 the service owns,
 * and the schema deliberately leaves the field as a plain optional ISO date.
 */
export const updateSchoolSubscription = async (schoolId, payload = {}) => {
  const requestedTrialEndsAt = payload.trialEndsAt ? new Date(payload.trialEndsAt) : null;
  if (requestedTrialEndsAt && Number.isNaN(requestedTrialEndsAt.getTime())) {
    throw new ApiError("trialEndsAt is not a valid date", 400, "INVALID_DATE");
  }
  if (requestedTrialEndsAt && requestedTrialEndsAt.getTime() < Date.now()) {
    throw new ApiError(
      "trialEndsAt cannot be in the past — a trial that has already ended is a subscription status, not a date",
      422,
      "TRIAL_ENDS_IN_PAST"
    );
  }

  const school = await findSchoolOrFail(schoolId);
  const before = { ...school.subscription };

  // Read the *requested* values first, before anything is written, because whether a
  // default is warranted depends on what the caller asked for rather than on what
  // the school currently holds.
  const nextPlan = payload.plan ?? school.subscription?.plan;
  const nextStatus = payload.status ?? school.subscription?.status;

  if (payload.monthlyFee !== undefined) {
    const fee = Number(payload.monthlyFee);
    // Integer pesewas, like every money field in the product (1 GHS = 100 pesewas).
    // A fractional pesewa is not a real amount of money and would round
    // differently in the ledger than in the subscription record.
    if (!Number.isInteger(fee) || fee < 0) {
      throw new ApiError(
        "monthlyFee must be a whole number of pesewas (1 GHS = 100 pesewas)",
        400,
        "INVALID_MONTHLY_FEE"
      );
    }
    school.subscription.monthlyFee = fee;
  }

  if (payload.currentPeriodStart !== undefined) {
    school.subscription.currentPeriodStart = new Date(payload.currentPeriodStart);
  }

  if (requestedTrialEndsAt) {
    school.subscription.trialEndsAt = requestedTrialEndsAt;
  } else if (payload.status === "trial" && !school.subscription.trialEndsAt) {
    const { trialDays } = await getProvisioningDefaults();
    school.subscription.trialEndsAt = addDays(new Date(), Number(trialDays) || 0);
  }

  const activatingPaidPlan =
    payload.status !== undefined &&
    PAID_SUBSCRIPTION_STATUSES.includes(payload.status) &&
    payload.plan !== undefined &&
    payload.plan !== "trial";

  if (payload.currentPeriodEnd !== undefined) {
    school.subscription.currentPeriodEnd = new Date(payload.currentPeriodEnd);
  } else if (activatingPaidPlan && !school.subscription.currentPeriodEnd) {
    // Anchored to the period start when one was supplied in the same request, so a
    // back-dated activation bills for a month from *its* start rather than from
    // today — which is what the operator who typed the past date meant.
    const anchor =
      payload.currentPeriodStart !== undefined
        ? new Date(payload.currentPeriodStart)
        : school.subscription.currentPeriodStart || new Date();
    school.subscription.currentPeriodEnd = addMonths(anchor, 1);
  }

  if (payload.paymentMethod !== undefined) {
    school.subscription.paymentMethod = payload.paymentMethod;
  }

  /*
   * Written last, and only once each.
   *
   * `nextPlan`/`nextStatus` were read *before* any write, so by the time they are
   * assigned here the "if not supplied, keep what is there" fallback still refers to
   * the school's original values — writing them earlier and then re-reading would be
   * a no-op round trip that reads as though the defaults were being recomputed, and
   * invites a second reader to "fix" the order and break the fallback.
   */
  if (nextPlan !== undefined) school.subscription.plan = nextPlan;
  if (nextStatus !== undefined) school.subscription.status = nextStatus;

  await school.save();

  return {
    before: {
      plan: before.plan,
      status: before.status,
      monthlyFee: before.monthlyFee,
      trialEndsAt: before.trialEndsAt,
      currentPeriodStart: before.currentPeriodStart,
      currentPeriodEnd: before.currentPeriodEnd,
      paymentMethod: before.paymentMethod,
    },
    after: {
      plan: school.subscription.plan,
      status: school.subscription.status,
      monthlyFee: school.subscription.monthlyFee,
      trialEndsAt: school.subscription.trialEndsAt,
      currentPeriodStart: school.subscription.currentPeriodStart,
      currentPeriodEnd: school.subscription.currentPeriodEnd,
      paymentMethod: school.subscription.paymentMethod,
    },
  };
};

/**
 * `PUT /admin/schools/:id/feature-flags` — the four per-tenant capability switches.
 *
 * A true patch, merged flag by flag. `$set`-ing the whole `featureFlags`
 * subdocument with a two-key body would reset the other two to their schema
 * defaults, and two of those defaults are the *permissive* ones (`installments`,
 * `idCards` both true) — so a client turning WhatsApp off for one school would
 * silently re-enable ID card generation it had deliberately disabled.
 */
export const updateSchoolFeatureFlags = async (schoolId, flags = {}) => {
  const unknown = Object.keys(flags).filter((key) => !FEATURE_FLAG_KEYS.includes(key));
  if (unknown.length) {
    throw new ApiError(
      `Unknown feature flag(s): ${unknown.join(", ")}. Known flags are ${FEATURE_FLAG_KEYS.join(", ")}.`,
      400,
      "UNKNOWN_FEATURE_FLAG",
      { unknown }
    );
  }

  if (!Object.keys(flags).length) {
    throw new ApiError("At least one feature flag is required", 400, "NO_FLAGS");
  }

  const school = await findSchoolOrFail(schoolId);
  const before = { ...(school.subscription?.featureFlags || FEATURE_FLAG_DEFAULTS) };

  for (const key of FEATURE_FLAG_KEYS) {
    if (flags[key] !== undefined) school.subscription.featureFlags[key] = Boolean(flags[key]);
  }

  await school.save();

  return { before, after: { ...school.subscription.featureFlags } };
};

/**
 * `PUT /admin/schools/:id/tags` — replace the operator's label set.
 *
 * Replace, not merge: the console's tag editor is a full list in a text field, and
 * a merge would make "remove the last tag" impossible to express.
 *
 * Normalised to lowercase + trimmed, deduped, capped at 20 and 50 characters each.
 * Lowercase because tags are a *filter* (`GET /admin/schools?tag=pilot`), and
 * `"Pilot"` and `"pilot"` being different documents is a filter that silently
 * returns nothing — which looks exactly like "this school has no tags". The caps
 * are the same reason the schema caps the query parameter: a tag field is not a
 * notes field, and an unbounded array here is an index entry per element on
 * `{ tags: 1, status: 1 }`.
 */
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;

export const normaliseTags = (tags) => {
  if (!Array.isArray(tags)) return [];

  const seen = new Set();
  const out = [];

  for (const raw of tags) {
    const tag = String(raw ?? "").trim().toLowerCase();
    if (!tag) continue;
    const clipped = tag.slice(0, MAX_TAG_LENGTH);
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    out.push(clipped);
    if (out.length >= MAX_TAGS) break;
  }

  return out;
};

export const updateSchoolTags = async (schoolId, tags = []) => {
  if (!Array.isArray(tags)) {
    throw new ApiError("tags must be an array of strings", 400, "INVALID_TAGS");
  }
  if (tags.length > MAX_TAGS) {
    throw new ApiError(`A school may carry at most ${MAX_TAGS} tags`, 400, "TOO_MANY_TAGS");
  }

  const normalised = normaliseTags(tags);
  const school = await findSchoolOrFail(schoolId);

  const before = [...(readPlatformField(school, "tags") || [])];
  writePlatformField(school, "tags", normalised);
  await school.save();

  return { before: { tags: before }, after: { tags: normalised } };
};

/**
 * `PUT /admin/schools/:id/notes` — the account manager's private column.
 *
 * Truncated at 2000 to match the model's `maxlength`, which exists so the field
 * cannot become a second `internalNotes`-shaped blob that nobody reads. Trimming
 * here rather than letting Mongoose raise a `ValidationError` turns a schema
 * failure into a 400 that says what happened.
 */
export const MAX_INTERNAL_NOTES_LENGTH = 2000;

export const updateSchoolInternalNotes = async (schoolId, internalNotes = "") => {
  const notes = String(internalNotes ?? "").trim();

  if (notes.length > MAX_INTERNAL_NOTES_LENGTH) {
    throw new ApiError(
      `Internal notes are limited to ${MAX_INTERNAL_NOTES_LENGTH} characters`,
      400,
      "NOTES_TOO_LONG"
    );
  }

  const school = await findSchoolOrFail(schoolId);
  const before = readPlatformField(school, "internalNotes") ?? "";

  writePlatformField(school, "internalNotes", notes);
  await school.save();

  return { before: { internalNotes: before }, after: { internalNotes: notes } };
};

/**
 * `PUT /admin/schools/:id/archive` — soft delete, school row only.
 *
 * **Never `deleteOne`, and never a cascade.** Two separate refusals:
 *
 *   - *No `deleteOne`.* `School` owns the `schoolCode`, the `slug` and the email,
 *     each of them `unique`. A hard delete frees them, so re-creating the school
 *     the operator just removed — the obvious next action after an archive done by
 *     mistake — hands the identifiers to a brand-new document with none of the
 *     history, and every `Payment`, `DisbursementBatch` and `PlatformLedger` row
 *     already pointing at the old id now points at a stranger. `deletedAt` plus
 *     `status: 'archived'` removes it from every read without destroying the one
 *     thing that cannot be reconstructed: the fact that it existed.
 *
 *   - *No cascade.* `services/school.service.js` has an `archiveSchool` that also
 *     runs `User.updateMany({ schoolId }, { status: 'deactivated' })`, and this one
 *     does not. That is deliberate. Deactivating a bursar's login is a separate
 *     decision with its own endpoint, its own audit action and its own
 *     before/after; folding it into an archive means a reversible-looking action
 *     irreversibly locks out every teacher at the school, and a later
 *     "un-archive" has no matching "un-deactivate" to go with it. If the platform
 *     wants the two to move together that is a product decision, and it belongs on
 *     one endpoint that does both visibly — not as a side effect of an archive.
 *
 * Payments are never touched for the same reason: the money is the school's and
 * the ledger's, and it does not become unreadable because the console hides the
 * school.
 */
export const archiveSchool = async (schoolId, actor) => {
  const school = await findSchoolOrFail(schoolId, { includeArchived: true });

  if (school.status === "archived" && school.deletedAt) {
    throw new ApiError("School is already archived", 409, "ALREADY_ARCHIVED");
  }

  const before = {
    status: school.status,
    deletedAt: school.deletedAt,
    suspendedReason: school.suspendedReason,
  };

  school.status = "archived";
  school.deletedAt = new Date();
  await school.save();

  return {
    before,
    after: {
      status: school.status,
      deletedAt: school.deletedAt,
      suspendedReason: school.suspendedReason,
    },
    archivedBy: actor?._id || null,
    // Surfaced rather than assumed: a caller that needs to know what the archive
    // did *not* touch has to be told, not left to infer it from silence.
    untouched: { users: true, payments: true, disbursements: true, ledger: true },
  };
};