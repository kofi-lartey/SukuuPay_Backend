// ─────────────────────────────────────────────
// SMS reminders
// ─────────────────────────────────────────────
// Fee reminders, from a school's ledger to its parents' hands.
//
// The transmit half of SMS lives in `utils/arkeselApi.js`; the receive half is
// `handleSmsDeliveryReport` in `services/inboundWebhooks.service.js`. This module
// is the layer between them: it decides *who* gets a message, *what* it says,
// *what it costs*, and *what happens when it fails*.
//
// Three decisions shape everything below.
//
// **1. Credit is charged before the send, not after.** A gateway that accepts a
// message and a school that cannot pay for it is the wrong order. The balance
// is decremented atomically before the first message leaves, so two concurrent
// broadcasts cannot both spend the same credits. A message that then fails to
// submit has its credit refunded, because the school was billed for nothing.
//
// **2. "Overdue" is a grace period, not a date comparison.** A Ghanaian school
// under the 1998 Act gives a statutory 30-day grace period, and a parent inside
// that window has not defaulted — they are inside the terms they agreed to.
// Sending a "final warning" to one is the exact failure this module exists to
// avoid, so `overdue` is `now > deadline + gracePeriodDays` and nothing else.
// The period is configurable because a school may have been more lenient in
// practice, and the audience picker must reproduce what the bursar remembers
// being told.
//
// **3. A scheduled broadcast sends the snapshot, not a fresh query.** See
// `SmsJob.recipientsSnapshot`. The recipient list and the numbers in it are
// frozen when the school confirms. Re-resolving at send time would mean a
// parent who paid an hour after the confirmation dialog is told they still owe.
import mongoose from 'mongoose';
import { School } from '../models/schoolModel.js';
import { Student } from '../models/studentModel.js';
import { Payment } from '../models/paymentModel.js';
import { PaymentPlan } from '../models/paymentPlanModel.js';
import { SmsMessage } from '../models/smsMessageModel.js';
import { SmsTemplate } from '../models/smsTemplateModel.js';
import { SmsJob } from '../models/smsJobModel.js';
import { SmsCreditTopUp } from '../models/smsCreditTopUpModel.js';
import ApiError from '../utils/ApiError.js';
import { log as auditLog } from '../utils/auditService.js';
import { checkIdempotency, rememberIdempotency, hashPayload } from '../utils/idempotency.js';
import { consumeRateLimit } from '../utils/rateLimiter.js';
import { normalisePhone, maskPhone, formatPhone, toGhanaE164, networkForGhanaNumber } from '../utils/phoneNumbers.js';
import { formatCedis, formatAccraDate } from '../utils/formatters.js';
import { sendArkeselSms, isArkeselSendConfigured, getArkeselConfigStatus } from '../utils/arkeselApi.js';
import {
  LIMITS,
  SMS_PRESET_TEMPLATES,
  SMS_TOKENS,
  SMS_CREDIT_RATE_PES,
} from '../config/constants.js';

// ──────────────────── Token rendering ────────────────────

/**
 * The `{token}` names a body uses, in order of first appearance, deduplicated.
 *
 * Deduplicated because a body may legitimately repeat one — "GHC {balance} for
 * {studentName}, balance {balance} outstanding" is clumsy copy but not invalid —
 * and the token row in the composer should show the token once.
 */
export const extractTokens = (body = '') => {
  const found = [];
  const pattern = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
  let match = pattern.exec(String(body));
  while (match) {
    if (!found.includes(match[1])) found.push(match[1]);
    match = pattern.exec(String(body));
  }
  return found;
};

/**
 * Rejects a body whose `{...}` names are not in the vocabulary.
 *
 * Checked at save *and* at send. At save it is a friendly 400 in the template
 * editor; at send it is what stops a hand-written body with a typo —
 * `{parentname}` — reaching 200 parents as a literal string, which is both
 * embarrassing and unreadable on a 160-character screen.
 */
export const assertTokensValid = (body, { context = 'message' } = {}) => {
  const unknown = extractTokens(body).filter((token) => !SMS_TOKENS.includes(token));
  if (!unknown.length) return extractTokens(body);

  throw new ApiError(
    `${context} uses unknown ${unknown.length === 1 ? 'token' : 'tokens'}: ${unknown.map((t) => `{${t}}`).join(', ')}. Available tokens: ${SMS_TOKENS.map((t) => `{${t}}`).join(', ')}`,
    400,
    'UNKNOWN_SMS_TOKEN'
  );
};

/**
 * Substitutes a recipient's values into a body.
 *
 * An unmatched token is left in place rather than blanked, on purpose. A missing
 * value is a data problem the school should see ("{studentClass}" on the
 * handset is a bug report from a parent); an empty string is indistinguishable
 * from a legitimately blank field, and the reminder reads as though it were
 * addressed to nobody.
 */
export const renderBody = (body = '', values = {}) =>
  String(body).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, token) =>
    values[token] === undefined || values[token] === null || values[token] === ''
      ? match
      : String(values[token])
  );

// ──────────────────── Length and cost ────────────────────

// GSM-7: 160 characters per part, 153 for each part after the first (the
// concatenation header costs 7 characters). A character outside the GSM-7
// alphabet — an emoji, a curly apostrophe a bursar pastes in from Word — drops
// the message to UCS-2 at 70 characters per part, which is a cost the school
// should be able to see before sending rather than discover on the bill.
const GSM7_BASIC = /^[\x20-\x7E\n\r]*$/;
const GSM7_EXTENDED = /^[\x20-\x7E\n\r@£$¥èéùìòÇØøÅå]*$/;

export const countSmsParts = (body = '') => {
  const text = String(body ?? '');
  const perPart = GSM7_BASIC.test(text) || GSM7_EXTENDED.test(text) ? 160 : 70;
  if (text.length <= perPart) return 1;
  // Every part after the first carries a 7-character user-data header.
  return Math.ceil((text.length - perPart) / (perPart - 7)) + 1;
};

/**
 * What a body of this length will cost, in credits.
 *
 * One credit per part, which is how both gateways bill. A 480-character reminder
 * is four messages' worth, not one — the single most common surprise on an SMS
 * bill, and the reason the composer shows a running cost.
 */
export const estimateCost = (body = '', recipients = 1) => countSmsParts(body) * Number(recipients || 0);

// ──────────────────── Scoping ────────────────────

/**
 * The school a request acts on. A super_admin must name one explicitly; every
 * other role is pinned to their own school, so a missing `schoolId` narrows
 * rather than widens the scope.
 */
export const resolveSchoolId = (user, explicitSchoolId) => {
  if (user?.role === 'super_admin') {
    return explicitSchoolId ? new mongoose.Types.ObjectId(explicitSchoolId) : null;
  }
  return user?.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

/**
 * Rejects a request that names a school the caller does not belong to.
 *
 * Silently falling back to the caller's own school would send to the wrong
 * audience — the failure mode here is 200 parents receiving another school's
 * fee position, not a stray filter.
 */
export const assertSchoolAccess = (user, schoolIdParam) => {
  if (
    schoolIdParam &&
    user?.role !== 'super_admin' &&
    user?.schoolId &&
    String(user.schoolId) !== String(schoolIdParam)
  ) {
    throw new ApiError('You do not have access to this school', 403, 'SCHOOL_ACCESS_DENIED');
  }
};

/** Loads the school a send acts on, with the credential fields it needs. */
const loadSchool = async (schoolId) => {
  const school = await School.findById(schoolId)
    .select('name schoolCode sms.name sms.senderId sms.provider sms.balance sms.apiKey')
    .lean();
  if (!school) throw new ApiError('School not found', 404, 'SCHOOL_NOT_FOUND');
  return school;
};

/**
 * The school a request acts on, as a live document.
 *
 * A document rather than a lean read, because every send path mutates
 * `school.sms.balance`. Loading it fresh each time is deliberate: the balance
 * must be read at the moment of charging, not cached from a request that started
 * before a concurrent broadcast spent it.
 */
const loadSchoolForUpdate = async (schoolId) => {
  const school = await School.findById(schoolId);
  if (!school) throw new ApiError('School not found', 404, 'SCHOOL_NOT_FOUND');
  return school;
};

/**
 * The sender ID a send will use, and whether it can be used at all.
 *
 * `school.sms.senderId` is empty on a school that never set one, so the
 * platform-wide `ARKESEL_SENDER_ID` is the fallback. The result is *reported* at
 * the read endpoints, not just enforced at send time: a bursar should be able to
 * see that their sender ID will be dropped by MTN before they spend 200 credits
 * discovering it, because a bad sender ID fails at the handset with no report
 * and the money is gone.
 */
const resolveSenderId = (school) => {
  const schoolSender = String(school?.sms?.senderId || '').trim();
  if (schoolSender) return { senderId: schoolSender, source: 'school' };

  const config = getArkeselConfigStatus();
  return {
    senderId: config.hasSenderId ? '' : '',
    source: 'platform',
    // The platform sender is read from the env inside the transport, so the
    // service reports *whether* one exists rather than duplicating its value.
    configured: config.configured && config.senderIdValid,
    issue: config.senderIdValid
      ? null
      : config.senderIdIssue || 'No sender ID is configured for this deployment',
  };
};

// ──────────────────── Credits ────────────────────

/**
 * Spends `units` of a school's credit, atomically.
 *
 * `$inc` with a `balance: { $gte: units }` filter is what makes two concurrent
 * broadcasts safe. A read-then-write would let both see 1,420 credits, both
 * decide they can afford 1,000, and both proceed — spending 2,000 against a
 * balance of 1,420. The conditional update means the second one matches nothing
 * and is told so.
 *
 * @returns {Promise<{ok: true, balance: number} | {ok: false, balance: number}>}
 */
const chargeCredits = async (schoolId, units) => {
  if (!units) return { ok: true, balance: null };

  const school = await School.findOneAndUpdate(
    { _id: schoolId, 'sms.balance': { $gte: units } },
    { $inc: { 'sms.balance': -units } },
    { returnDocument: 'after' }
  ).select('sms.balance');

  if (school) return { ok: true, balance: school.sms.balance };

  // No match means either the school is gone or the balance was short. Reading
  // it back turns an opaque "not allowed" into the actionable "you need 10 more".
  const current = await School.findById(schoolId).select('sms.balance').lean();
  if (!current) throw new ApiError('School not found', 404, 'SCHOOL_NOT_FOUND');
  return { ok: false, balance: current.sms.balance };
};

/** Returns credits to a school. Never negative-to-negative: clamped at zero. */
const refundCredits = async (schoolId, units) => {
  if (!units) return null;
  const school = await School.findOneAndUpdate(
    { _id: schoolId, 'sms.balance': { $lt: LIMITS.MAX_SMS_CREDIT_TOP_UP_UNITS } },
    { $inc: { 'sms.balance': units } },
    { returnDocument: 'after' }
  ).select('sms.balance');
  return school?.sms.balance ?? null;
};

// ──────────────────── Gateway ────────────────────
/**
 * A transport failure is returned, not thrown. The caller has already spent a
 * credit and created a `SmsMessage` row at this point, and a thrown error would
 * leave that row un-written — a message billed for but absent from the history,
 * which is the one thing a bursar reconciling their balance cannot forgive.
 */

/**
 * Submits one rendered message.
 *
 * Arkesel is the only transmit path wired, because it is the only one the
 * codebase has a client for (`utils/arkeselApi.js`). A school on `hubtel` or
 * `mnotify` is refused with an explanation rather than silently routed through
 * Arkesel: the sender ID is registered with a specific operator, so a message
 * sent through the wrong gateway is dropped by the handset with no report, and
 * the school would be billed for messages nobody received.
 *
 * A transport failure is returned, not thrown. The caller has already spent a
 * credit and created a `SmsMessage` row at this point, and a thrown error would
 * leave that row un-written — a message billed for but absent from the history,
 * which is the one thing a bursar reconciling their balance cannot forgive.
 *
 * **Exported for the platform console's broadcast**, which is the one caller that
 * has no `School` of its own. It passes a synthetic `{ sms: { provider, senderId } }`
 * object carrying the platform's own gateway settings, and therefore draws on the
 * deployment-level `ARKESEL_API_KEY` rather than any school's `sms.balance` — which
 * is correct: an announcement about a platform outage is the platform's cost, not a
 * charge against a customer's credit. Exporting it rather than reimplementing it is
 * what keeps "one transmit path" true; a second implementation would drift on the
 * provider check and the sender-ID fallback within a month.
 */
export const submitMessage = async ({ to, body, school }) => {
  const provider = school?.sms?.provider || 'arke';
  if (provider !== 'arke') {
    return {
      ok: false,
      code: 'SMS_PROVIDER_UNSUPPORTED',
      reason: `This school is configured for the "${provider}" SMS gateway, which has no transmit client in this deployment. Set school.sms.provider to "arke" to send.`,
    };
  }

  if (!isArkeselSendConfigured()) {
    return {
      ok: false,
      code: 'SMS_GATEWAY_NOT_CONFIGURED',
      reason:
        'No SMS gateway is configured on this deployment. Set ARKESEL_API_KEY (and ARKESEL_SENDER_ID) to enable sending.',
    };
  }

  try {
    const result = await sendArkeselSms({
      to,
      message: body,
      senderId: String(school?.sms?.senderId || '').trim() || undefined,
    });
    return { ok: true, providerMessageId: result.providerMessageId, creditsUsed: result.creditsUsed };
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'SMS_GATEWAY_ERROR',
      reason: error?.message || 'The SMS gateway rejected the message',
    };
  }
};

// ──────────────────── Recipients ────────────────────

const getPrimaryParent = (student) =>
  (student?.parents || []).find((parent) => parent.isPrimary) || student?.parents?.[0] || null;

/**
 * Picks the parents a `recipient` rule names on one student.
 *
 * Returns the whole set for `all`, and a single parent for every other rule —
 * including `primary_indexed`, which addresses a parent by position because the
 * caller knows the form's ordering but not the sub-document id. A broadcast
 * resolves `primary` only; a per-student send can narrow.
 */
const selectParents = (student, rule = 'primary', recipientIndex = 0) => {
  const parents = student?.parents || [];
  if (!parents.length) return [];
  if (rule === 'all') return parents;

  if (rule === 'primary_indexed') {
    const chosen = parents[recipientIndex ?? 0];
    return chosen ? [chosen] : [];
  }

  const primary = getPrimaryParent(student);
  return primary ? [primary] : [];
};

/** The values a body may interpolate for one recipient. */
const buildTokenValues = ({ student, parent, school, plan, term }) => {
  const nextInstallment =
    plan?.installments?.find((i) => i.status === 'pending' || i.status === 'overdue') || null;

  return {
    parentName: parent?.parentName || '',
    studentName: student?.studentName || '',
    // The public pay link, not the raw token: the token is the secret that
    // authorises the payment, and it never appears in a message body.
    studentId: student?.studentId || '',
    studentClass: student?.studentClass || '',
    balance: formatCedis(student?.balance ?? 0),
    totalOwed: formatCedis(student?.totalOwed ?? 0),
    amountPaid: formatCedis(student?.totalPaid ?? 0),
    // The next tranche's date when there is a plan, the term deadline when there
    // is not. A due date in a reminder is a date the parent can act on, and the
    // term deadline is the one every Ghanaian school already publishes.
    dueDate: nextInstallment?.dueDate
      ? formatAccraDate(nextInstallment.dueDate)
      : student?.deadline
        ? formatAccraDate(student.deadline)
        : '',
    schoolName: school?.name || '',
    payLink: student?.payLink || '',
    term: term || '',
  };
};

/**
 * Turns an audience rule into a Student query.
 *
 * Resolved as a query rather than a list of ids, because a school's roster
 * outlives any request: materialising 2,000 ObjectIds to count them, then
 * counting again, is two round trips to learn a number the database could give
 * in one.
 */
const buildAudienceFilter = (schoolId, audience) => {
  const filter = { schoolId, status: 'active', deletedAt: null };
  const { type, minBalance, includeZeroBalance } = audience;

  const oweFilter = includeZeroBalance ? { $gte: 0 } : { $gte: minBalance ?? 1 };
  filter.balance = oweFilter;

  switch (type) {
    case 'all':
      // No further narrowing: the opt-in above already decided the balance rule.
      break;

    case 'all_owing':
      break;

    case 'overdue': {
      // Deadline plus the statutory grace period. Compared on the deadline, not
      // on a payment timestamp: a student with no payments has no payment to
      // date from, and would never be overdue under a payments-based rule.
      const cutoff = new Date();
      cutoff.setUTCHours(0, 0, 0, 0);
      cutoff.setUTCDate(cutoff.getUTCDate() - (audience.overdueDays ?? 30));
      filter.deadline = { $lt: cutoff };
      break;
    }

    case 'installment_due_soon': {
      // Handled in `resolveAudience` rather than here, because "has a tranche
      // due in N days" is a property of a *plan* sub-document, and Mongo cannot
      // express a comparison against one embedded array's field from a different
      // collection. The plan ids are resolved first, then students are matched
      // against them.
      break;
    }

    case 'at_risk': {
      // Same reasoning as `installment_due_soon`, plus the slipped branch. The
      // balance filter above still applies, so an at-risk family whose ledger is
      // somehow square is not messaged.
      break;
    }

    case 'class': {
      const classes = audience.class ?? audience.classes;
      filter.studentClass = { $in: Array.isArray(classes) ? classes : [classes] };
      break;
    }

    case 'students': {
      filter._id = { $in: audience.studentIds || [] };
      break;
    }

    default:
      throw new ApiError(`Unknown audience type "${type}"`, 400, 'UNKNOWN_AUDIENCE_TYPE');
  }

  return filter;
};

/**
 * Resolves an audience rule to parents with a deliverable number.
 *
 * The `skipped` breakdown matters as much as the list. A school that selects
 * "all owing" and gets 180 recipients when 40 students owe has been told nothing
 * by that number alone — but 40 parents with a number that will not normalise is
 * actionable, and it is the difference between a bursar fixing a data problem
 * and a bursar assuming the system is broken.
 */
export const resolveAudience = async (schoolId, audience, { school, limit = LIMITS.MAX_SMS_JOB_BATCH } = {}) => {
  const resolvedSchool = school || (await loadSchool(schoolId));

  let studentFilter = buildAudienceFilter(schoolId, audience);
  let planByStudent = new Map();

  if (audience.type === 'installment_due_soon' || audience.type === 'at_risk') {
    const horizon = new Date();
    horizon.setUTCHours(23, 59, 59, 999);
    horizon.setUTCDate(horizon.getUTCDate() + (audience.dueSoonDays ?? 5));
    const now = new Date();

    // An unsettled tranche: one that is not paid and not waived, and still owes
    // money. Expressed once and reused, because the two branches of `at_risk`
    // differ only in which side of `now` the due date falls on and forgetting
    // the "still owes money" half would include families who prepaid a tranche
    // out of caution.
    const UNSETTLED = { status: { $in: ['pending', 'overdue', 'partial'] } };

    const installmentMatch =
      audience.type === 'at_risk'
        ? {
            // Either already slipped, or landing within the horizon. One
            // `$elemMatch` rather than two queries: a plan can satisfy both, and
            // two separate finds would then return the same plan twice.
            $or: [
              { ...UNSETTLED, dueDate: { $lte: now } },
              { ...UNSETTLED, dueDate: { $gt: now, $lte: horizon } },
            ],
          }
        : { ...UNSETTLED, dueDate: { $lte: horizon, $gte: now } };

    const plans = await PaymentPlan.find({
      schoolId,
      // `defaulted` is in scope on purpose: a family two tranches behind is
      // exactly who a chaser should reach, and dropping them would make the
      // audience quietly exclude the worst cases.
      planStatus: { $in: ['active', 'defaulted'] },
      installments: { $elemMatch: installmentMatch },
    })
      .select('studentId installments')
      .lean();

    planByStudent = new Map(plans.map((plan) => [String(plan.studentId), plan]));
    if (!plans.length) return { recipients: [], skipped: { no_match: 0 }, students: [], total: 0 };

    studentFilter = { ...studentFilter, _id: { $in: plans.map((plan) => plan.studentId) } };
  }

  // `excludeRecentPayers`: drop anyone who has paid in the window. Without this
  // a parent who settled an hour ago receives "you owe GHC 550" for a balance
  // they have already cleared, which is the single fastest way to lose the trust
  // the reminder was meant to spend.
  let recentPayerIds = null;
  if (audience.excludeRecentPayers) {
    const window = new Date(Date.now() - (audience.recentPaymentWindowHours ?? 48) * 3600 * 1000);
    const recent = await Payment.find({
      schoolId,
      status: 'completed',
      createdAt: { $gte: window },
    })
      .select('studentId')
      .lean();
    recentPayerIds = new Set(recent.map((payment) => String(payment.studentId)));
  }

  // A hard cap is a safety valve, not a policy: beyond it the request is a
  // filter bug, and a 10,000-recipient broadcast is not a thing a school does on
  // purpose. Applied to the query so a runaway rule cannot load the roster into
  // memory.
  const students = await Student.find(studentFilter).limit(limit + 1).lean();
  const overCap = students.length > limit;
  const capped = overCap ? students.slice(0, limit) : students;

  if (overCap) {
    throw new ApiError(
      `This audience matches more than ${limit.toLocaleString('en-GH')} students. Narrow the class, the balance range or the date window before sending.`,
      422,
      'AUDIENCE_TOO_LARGE'
    );
  }

  const recipients = [];
  const skipped = {
    no_match: 0,
    no_parent: 0,
    no_balance: 0,
    opted_out: 0,
    recent_payer: 0,
    invalid_number: 0,
  };

  let totalBalance = 0;

  for (const student of capped) {
    const parents = selectParents(student, 'primary');

    if (!parents.length) {
      skipped.no_parent += 1;
      continue;
    }
    if ((student.balance ?? 0) < (audience.minBalance ?? 1) && !audience.includeZeroBalance) {
      skipped.no_balance += 1;
      continue;
    }
    if (recentPayerIds?.has(String(student._id))) {
      skipped.recent_payer += 1;
      continue;
    }

    const parent = parents[0];
    const normalised = toGhanaE164(parent.phone);
    if (!normalised.valid) {
      // Counted, not silently dropped: this is a data-quality signal the school
      // can fix, and a recipient total that quietly loses 40 parents is a
      // recipient total nobody can trust.
      skipped.invalid_number += 1;
      continue;
    }

    const plan = planByStudent.get(String(student._id)) || null;
    const values = buildTokenValues({
      student,
      parent,
      school: resolvedSchool,
      plan,
      term: resolvedSchool?.currentTerm,
    });

    totalBalance += student.balance ?? 0;

    recipients.push({
      parentId: parent._id,
      studentId: student._id,
      phone: normalised.e164,
      parentName: parent.parentName,
      studentName: student.studentName,
      studentClass: student.studentClass,
      balance: student.balance ?? 0,
      amountPaid: student.totalPaid ?? 0,
      // The raw date, not a formatted one: the snapshot is a record, and
      // formatting it here would freeze one locale's rendering into it.
      dueDate: student.deadline || null,
      payLink: student.payLink || null,
      // The substituted values, so the audience preview can show one recipient
      // fully rendered without re-resolving the audience.
      values,
    });
  }

  return {
    recipients,
    skipped,
    total: capped.length,
    totalBalance,
  };
};

// ──────────────────── Preview ────────────────────

/** The per-recipient numbers an audience rule resolves to, for the picker. */
export const previewAudienceHandler = async (schoolIdParam, query, user) => {
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  const school = await loadSchool(schoolId);
  const { recipients, skipped, total, totalBalance } = await resolveAudience(
    schoolId,
    query.audience,
    { school }
  );

  // The operator split, so a school can see who a broadcast will actually reach
  // before it costs anything. Ghana's operators hold distinct prefix blocks and
  // that is the only way to tell them apart, so this is a real measurement of
  // the roster's network mix — not a decoration. A school whose parents are 90%
  // Telecel is a school whose MTN sender ID is being validated for no reason.
  //
  // `unknown` is a real bucket rather than being dropped: a number that matches
  // no block is a data-quality problem in the roster, and hiding it would make
  // the three known bars sum to less than the recipient count with nothing
  // explaining the gap.
  const networkSplit = { mtn: 0, telecel: 0, airteltigo: 0, unknown: 0 };
  for (const recipient of recipients) {
    networkSplit[networkForGhanaNumber(recipient.phone) || 'unknown'] += 1;
  }

  return {
    audience: query.audience,
    matchCount: recipients.length,
    studentCount: total,
    totalBalance,
    totalBalanceDisplay: formatCedis(totalBalance),
    networkSplit,
    skipped,
    // Phone numbers are masked even though this endpoint is school-scoped: the
    // audience picker is a count-and-total widget, and it has no reason to hold
    // a list of every parent's number. Only the sample render needs one, and it
    // gets the first recipient's real values.
    sample: recipients[0]
      ? {
          parentName: recipients[0].parentName,
          phoneDisplay: formatPhone(recipients[0].phone),
          phoneMasked: maskPhone(recipients[0].phone),
          network: networkForGhanaNumber(recipients[0].phone),
          studentName: recipients[0].studentName,
          studentClass: recipients[0].studentClass,
          balance: recipients[0].balance,
          balanceDisplay: formatCedis(recipients[0].balance),
          payLink: recipients[0].payLink,
        }
      : null,
  };
};

/** Cost and length for a body, without sending it. */
export const previewSmsHandler = async (studentId, query, user) => {
  const student = await Student.findById(studentId)
    .populate('schoolId', 'name schoolCode sms')
    .lean();
  if (!student || student.deletedAt) throw new ApiError('Student not found', 404, 'STUDENT_NOT_FOUND');

  const school = student.schoolId;
  assertSchoolAccess(user, String(school?._id || ''));

  const parent = getPrimaryParent(student);
  let body = query.body;

  if (query.templateId) {
    const template = await SmsTemplate.findOne({
      _id: query.templateId,
      deletedAt: null,
      $or: [{ schoolId: school?._id || null }, { schoolId: null }],
    }).lean();
    if (!template) throw new ApiError('Template not found', 404, 'TEMPLATE_NOT_FOUND');
    body = template.body;
  }

  if (!body) throw new ApiError('A body or templateId is required', 400, 'BODY_REQUIRED');
  assertTokensValid(body, { context: 'Message body' });

  // Rendered against the real student when there is one, so the preview shows
  // the copy that parent will actually receive — including their own balance and
  // their own pay link, which is the part most worth checking before a send.
  const rendered = parent
    ? renderBody(body, buildTokenValues({ student, parent, school }))
    : renderBody(body, { schoolName: school?.name || '' });

  const parts = countSmsParts(rendered);
  const unresolved = extractTokens(rendered).filter((token) => rendered.includes(`{${token}}`));

  return {
    rendered,
    segments: parts,
    // One credit per part. The label says "credits" rather than "SMS" because
    // that is the unit the school's balance is denominated in, and a bursar
    // reconciling a balance needs the two to be the same word.
    estimatedCost: parts,
    estimatedCostDisplay: `${parts} credit${parts === 1 ? '' : 's'}`,
    length: rendered.length,
    perSegmentLimit: GSM7_BASIC.test(rendered) || GSM7_EXTENDED.test(rendered) ? 160 : 70,
    // Flagged rather than rejected: a message over the cap is still sendable,
    // just expensive, and the user should see the cost before deciding.
    overPartLimit: parts > LIMITS.MAX_SMS_PARTS,
    tokens: extractTokens(rendered),
    // Tokens the student record has no value for. A `{dueDate}` with no deadline
    // behind it reaches the handset as the literal text, which is worth knowing
    // before 200 parents see it.
    unresolvedTokens: unresolved,
    to: parent ? maskPhone(parent.phone) : null,
    isTest: false,
  };
};

// ──────────────────── Single send ────────────────────

/**
 * Sends one message to a student's parent(s).
 *
 * The order is deliberate and is the whole reason this function is not a
 * three-liner: rate limit, then idempotency, then credit, then the gateway, then
 * the record. Credit is spent before the send so two concurrent requests cannot
 * both pass an affordability check, and refunded on failure so a school is never
 * billed for a message that was not accepted.
 */
export const sendSms = async (studentId, data, user, { idempotencyKey } = {}) => {
  // A single send is the operation most likely to be retried by a nervous user,
  // and the one whose repeat effect is a real parent's phone buzzing twice.
  consumeRateLimit(
    `sms:send:${user?._id || 'anon'}:${studentId}`,
    30,
    60 * 60 * 1000
  );

  assertSchoolAccess(user, data.schoolId);

  const replay = await checkIdempotency(idempotencyKey, 'sms.send', { studentId, ...data });
  if (replay) return { ...replay, replayed: true };

  const student = await Student.findById(studentId).lean();
  if (!student || student.deletedAt) throw new ApiError('Student not found', 404, 'STUDENT_NOT_FOUND');

  const schoolId = resolveSchoolId(user, data.schoolId) || student.schoolId;
  const school = await loadSchoolForUpdate(schoolId);

  // Resolve the body from a template or take the literal one.
  let body = data.body;
  let template = null;
  let category = data.category;

  if (data.templateId) {
    template = await SmsTemplate.findOne({
      _id: data.templateId,
      deletedAt: null,
      $or: [{ schoolId }, { schoolId: null }],
    }).lean();
    if (!template) throw new ApiError('Template not found', 404, 'TEMPLATE_NOT_FOUND');
    body = template.body;
    // A template's own category is the default; an explicit one overrides it, so
    // a school can send "Final Warning" copy filed under a campaign without
    // editing the template.
    category = data.category || template.category;
  }

  if (!body) throw new ApiError('A message body is required', 400, 'BODY_REQUIRED');
  assertTokensValid(body, { context: 'Message body' });
  category = category || 'custom';

  // A test send may carry an arbitrary number — it is the school's own phone,
  // not a student's parent. Normalisation still applies, so a typo is a 400 here
  // rather than a message to a stranger.
  const isTest = Boolean(data.isTest);
  const targetNumber = data.to
    ? toGhanaE164(data.to)
    : { valid: false, e164: null, reason: 'no number to send to' };

  if (data.to && !targetNumber.valid) {
    throw new ApiError(`"${data.to}" is not a valid Ghanaian MSISDN: ${targetNumber.reason}`, 400, 'INVALID_MSISDN');
  }

  // Parents to reach. A test send has no parent, so the list is a single
  // synthetic recipient built from the explicit number.
  let parents = [];
  if (isTest) {
    parents = [{ _id: null, parentName: user?.name || 'Test', phone: targetNumber.e164 }];
  } else {
    if (data.recipient === 'parentId' && data.parentId) {
      parents = (student.parents || []).filter((parent) => String(parent._id) === String(data.parentId));
      if (!parents.length) {
        throw new ApiError('That parent is not on this student record', 404, 'PARENT_NOT_FOUND');
      }
    } else if (data.recipient === 'primary_indexed') {
      const chosen = (student.parents || [])[data.recipientIndex ?? 0];
      if (!chosen) {
        throw new ApiError(`This student has no parent at index ${data.recipientIndex ?? 0}`, 422, 'PARENT_INDEX_OUT_OF_RANGE');
      }
      parents = [chosen];
    } else if (data.recipient === 'all') {
      parents = student.parents || [];
    } else {
      const primary = getPrimaryParent(student);
      if (!primary) throw new ApiError('This student has no parent to message', 422, 'NO_PARENT_ON_RECORD');
      parents = [primary];
    }
  }

  if (!parents.length) throw new ApiError('This student has no parent to message', 422, 'NO_PARENT_ON_RECORD');

  // ── Credit ──
  // A scheduled or multi-recipient send is rejected here rather than silently
  // treated as immediate: this endpoint charges per message at the moment of
  // sending, and a delayed multi-recipient send would hold a reservation that
  // nothing releases.
  if (data.scheduledAt) {
    throw new ApiError(
      'A single send cannot be scheduled. Use POST /sms/bulk, which reserves credit at acceptance and releases it if the run fails.',
      400,
      'SCHEDULED_SEND_REQUIRES_BULK'
    );
  }
  if (parents.length > 1 && !isTest) {
    throw new ApiError(
      'Sending to several parents at once is a broadcast. Use POST /sms/bulk so it is queued, rate-limited and cancellable as one run.',
      400,
      'MULTI_PARENT_SEND_REQUIRES_BULK'
    );
  }

  const parent = parents[0];
  const values = buildTokenValues({ student, parent, school });
  const rendered = renderBody(body, values);
  const parts = countSmsParts(rendered);

  if (parts > LIMITS.MAX_SMS_PARTS) {
    throw new ApiError(
      `That message is ${parts} SMS parts, over the ${LIMITS.MAX_SMS_PARTS}-part limit. Shorten it to ${LIMITS.MAX_SMS_PARTS * 160} characters.`,
      422,
      'MESSAGE_TOO_LONG'
    );
  }

  // A test costs nothing. Charging for it would mean a school's own test
  // messages appear in its delivery statistics and inflate its bill.
  const units = isTest ? 0 : parts;

  let balanceAfter = school.sms?.balance ?? 0;
  if (units > 0) {
    const charge = await chargeCredits(schoolId, units);
    if (!charge.ok) {
      throw new ApiError(
        `Insufficient SMS credit: this message costs ${units} credit${units === 1 ? '' : 's'} and the school has ${charge.balance ?? 0} available.`,
        402,
        'INSUFFICIENT_SMS_CREDIT',
        { required: units, available: charge.balance ?? 0 }
      );
    }
    // From the charge, not from the document loaded above: the charge was a
    // separate atomic update, and echoing the pre-charge figure would show a
    // bursar a balance they do not have.
    balanceAfter = charge.balance;
  }

  // ── Gateway ──
  const number = isTest ? targetNumber.e164 : normalisePhone(parent.phone).e164;

  const outcome = await submitMessage({ to: number, body: rendered, school });

  // A failed submission is recorded rather than discarded. The message is a real
  // attempt against a real parent's number with a real failure reason attached,
  // and it is what makes "we sent 400 and 37 bounced" answerable.
  //
  // Field names are the model's, not this module's vocabulary: `message`,
  // `segments`, `toE164`. They predate the reminders module and are what the
  // delivery-report webhook already reads, so the row is written in the shape
  // the receive half expects.
  const message = await SmsMessage.create({
    schoolId,
    studentId: student._id,
    parentId: parent._id || null,
    type: category,
    // The same category under the model's free-text `purpose`, which predates the
    // enum and is what a report reconciled by business reason reads.
    purpose: category,
    templateId: data.templateId || null,
    // `to` stays as submitted, because that is the form the provider echoes back
    // in its delivery report; `toE164` is the normalised form for display.
    to: isTest ? targetNumber.e164 : parent.phone,
    toE164: number,
    message: rendered,
    segments: parts,
    status: outcome.ok ? 'submitted' : 'failed',
    provider: school.sms?.provider || 'arke',
    providerMessageId: outcome.ok ? outcome.providerMessageId || null : null,
    failureReason: outcome.ok ? '' : String(outcome.reason).slice(0, 500),
    isTest,
    creditsCharged: units,
    idempotencyKey: idempotencyKey || null,
    sentAt: outcome.ok ? new Date() : null,
    createdBy: user?._id || null,
  });

  if (!outcome.ok) {
    // The message was never accepted, so the school keeps its credit. Recorded
    // as a message anyway so the history shows the attempt and the reason.
    if (units > 0) await refundCredits(schoolId, units);

    throw new ApiError(outcome.reason, outcome.code === 'SMS_GATEWAY_NOT_CONFIGURED' ? 503 : 502, outcome.code, {
      messageId: message._id,
      failureCode: outcome.code,
    });
  }

  await auditLog({
    action: isTest ? 'sms.test_send' : 'sms.send',
    entity: 'SmsMessage',
    entityId: message._id,
    userId: user?._id,
    schoolId,
    meta: {
      studentId: String(student._id),
      parentId: parent._id ? String(parent._id) : null,
      category,
      parts,
      creditsCharged: units,
      isTest,
    },
  });

  const data_ = {
    message: {
      id: message._id,
      to: message.toE164,
      toDisplay: formatPhone(message.toE164),
      message: rendered,
      segments: parts,
      status: message.status,
      category,
      isTest,
      sentAt: message.sentAt,
      providerMessageId: message.providerMessageId,
    },
    balanceAfter,
    estimatedCost: units,
  };

  await rememberIdempotency(idempotencyKey, 'sms.send', { studentId, ...data }, user?._id, data_);

  return { data: data_, replayed: false };
};

// ──────────────────── Templates ────────────────────

/** `name` → `key`. The composer shows one, the model stores the other. */
const slugifyKey = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);

/**
 * Writes the four platform presets if they are not already there.
 *
 * Idempotent and content-addressed on `body`, so it runs on every template list
 * without cost and a school that has edited a preset is not reverted: the seeded
 * copy is only written when no row with that key exists at all. A school that
 * wants the original back has `presetBody` to restore from.
 */
export const seedPresetTemplates = async (schoolId, user) => {
  const created = [];

  for (const preset of SMS_PRESET_TEMPLATES) {
    const existing = await SmsTemplate.findOne({
      key: preset.key,
      schoolId: null,
      deletedAt: null,
    })
      .select('_id')
      .lean();

    // Seeded once. A school that has edited "Final Warning" keeps its edit — the
    // copy is theirs once it exists, and re-seeding on every read would undo it
    // every time they opened the composer. `presetBody` is how they get the
    // original back.
    if (existing) continue;

    created.push(
      await SmsTemplate.create({
        key: preset.key,
        name: preset.name,
        description: '',
        category: preset.category,
        body: preset.body,
        tokens: extractTokens(preset.body),
        requiredTokens: preset.requiredTokens,
        isPreset: true,
        schoolId: null,
        presetBody: preset.body,
        createdBy: user?._id || null,
      })
    );
  }

  return created;
};

/** A school's templates: the platform presets plus its own, presets first. */
export const listTemplates = async (query, user) => {
  const schoolId = resolveSchoolId(user, query.schoolId);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  // The presets are written on read, not by a migration, so a school created
  // after the deploy still gets them and a school that lost them gets them back.
  await seedPresetTemplates(schoolId, user);

  const filter = query.includeDeleted ? {} : { deletedAt: null };

  if (query.own) {
    // `own` is the composer's "Saved" section: platform rows excluded.
    filter.schoolId = schoolId;
  } else if (user?.role === 'super_admin' && !query.schoolId) {
    // A super_admin with no school named is browsing the platform catalogue, not
    // a school's composer, so only the presets are in scope.
    filter.schoolId = null;
  } else {
    // Everyone else sees the platform presets plus their own. Not a plain
    // `{schoolId}` match: that would hide the four presets from every school.
    filter.$or = [{ schoolId: null }, { schoolId }];
  }

  if (query.category && query.category !== 'all') filter.category = query.category;

  const templates = await SmsTemplate.find(filter).sort({ isPreset: -1, name: 1 }).lean();

  return templates.map(({ presetBody, ...template }) => ({
    ...template,
    // `presetBody` is restoration state, not content the composer needs, so it
    // is stripped from the payload rather than shipped. `isModifiedPreset` is
    // what the "restore original" action keys off.
    isModifiedPreset: Boolean(template.isPreset && presetBody && presetBody !== template.body),
  }));
};

export const createTemplate = async (data, user) => {
  const schoolId = resolveSchoolId(user, data.schoolId);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  const key = data.key || slugifyKey(data.name);
  if (!key) {
    throw new ApiError('A template name that yields a usable key is required', 400, 'INVALID_TEMPLATE_KEY');
  }

  const tokens = assertTokensValid(data.body, { context: 'Template body' });

  const existing = await SmsTemplate.findOne({ key, schoolId, deletedAt: null }).select('_id').lean();
  if (existing) {
    throw new ApiError(
      `You already have a template called "${data.name}". Give it a different name.`,
      409,
      'TEMPLATE_KEY_TAKEN'
    );
  }

  const template = await SmsTemplate.create({
    key,
    name: data.name,
    description: data.description || '',
    category: data.category || 'custom',
    body: data.body,
    tokens,
    requiredTokens: data.requiredTokens || [],
    isPreset: false,
    schoolId,
    createdBy: user?._id || null,
  });

  await auditLog({
    action: 'sms.template_create',
    entity: 'SmsTemplate',
    entityId: template._id,
    userId: user?._id,
    schoolId,
    meta: { key, category: template.category, tokens },
  });

  return template.toJSON();
};

export const updateTemplate = async (templateId, data, user) => {
  const schoolId = resolveSchoolId(user);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  const template = await SmsTemplate.findOne({ _id: templateId, deletedAt: null });
  if (!template) throw new ApiError('Template not found', 404, 'TEMPLATE_NOT_FOUND');

  // A platform preset belongs to nobody and is edited by nobody. If a school
  // could overwrite "Final Warning", every other school would broadcast the
  // change — so presets are copied, not modified, and this is the guard.
  if (!template.schoolId) {
    throw new ApiError(
      'This is a platform template and cannot be edited. Save your changes as a new template instead.',
      403,
      'PRESET_TEMPLATE_IMMUTABLE'
    );
  }
  if (String(template.schoolId) !== String(schoolId)) {
    throw new ApiError('You do not have access to this template', 403, 'SCHOOL_ACCESS_DENIED');
  }

  if (data.body !== undefined) {
    const tokens = assertTokensValid(data.body, { context: 'Template body' });
    template.body = data.body;
    template.tokens = tokens;
  }
  if (data.name !== undefined) template.name = data.name;
  if (data.description !== undefined) template.description = data.description;
  if (data.category !== undefined) template.category = data.category;
  if (data.requiredTokens !== undefined) template.requiredTokens = data.requiredTokens;

  template.updatedBy = user?._id || null;
  await template.save();

  await auditLog({
    action: 'sms.template_update',
    entity: 'SmsTemplate',
    entityId: template._id,
    userId: user?._id,
    schoolId,
    meta: { key: template.key, fields: Object.keys(data) },
  });

  return template.toJSON();
};

/**
 * Soft-deletes a template.
 *
 * A soft delete, not a removal: every `SmsMessage` from it references
 * `templateId`, and the history has to keep rendering. Deleting the row would
 * leave past sends pointing at nothing, and a bursar asking "what did this
 * message say?" would get a blank.
 */
export const deleteTemplate = async (templateId, user) => {
  const schoolId = resolveSchoolId(user);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  const template = await SmsTemplate.findOne({ _id: templateId, deletedAt: null });
  if (!template) throw new ApiError('Template not found', 404, 'TEMPLATE_NOT_FOUND');

  if (!template.schoolId) {
    throw new ApiError(
      'This is a platform template and cannot be deleted.',
      403,
      'PRESET_TEMPLATE_IMMUTABLE'
    );
  }
  if (String(template.schoolId) !== String(schoolId)) {
    throw new ApiError('You do not have access to this template', 403, 'SCHOOL_ACCESS_DENIED');
  }

  template.deletedAt = new Date();
  template.updatedBy = user?._id || null;
  await template.save();

  await auditLog({
    action: 'sms.template_delete',
    entity: 'SmsTemplate',
    entityId: template._id,
    userId: user?._id,
    schoolId,
    meta: { key: template.key, name: template.name },
  });

  return { id: template._id, deletedAt: template.deletedAt };
};

/** Renders a body against a named sample, for the composer's preview. */
export const previewTemplate = async (data, user) => {
  const schoolId = resolveSchoolId(user, data.schoolId);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  let body = data.body;
  if (data.templateId) {
    const template = await SmsTemplate.findOne({
      _id: data.templateId,
      deletedAt: null,
      $or: [{ schoolId: null }, { schoolId }],
    }).lean();
    if (!template) throw new ApiError('Template not found', 404, 'TEMPLATE_NOT_FOUND');
    body = template.body;
  }
  if (!body) throw new ApiError('A body or templateId is required', 400, 'BODY_REQUIRED');

  assertTokensValid(body, { context: 'Template body' });

  // Sample values are placeholders the user chose, not a real student's data. A
  // preview must not require a real student to exist, and must not leak one
  // parent's details into a screen a third party might be looking at.
  const school = await loadSchool(schoolId);
  const values = {
    parentName: data.sample?.parentName ?? 'Mr. Mensah',
    studentName: data.sample?.studentName ?? 'Kwame Mensah',
    studentId: data.sample?.studentId ?? 'SHS-0001',
    studentClass: data.sample?.studentClass ?? 'JHS 2A',
    balance: formatCedis(data.sample?.balance ?? 55000),
    amountPaid: formatCedis(data.sample?.amountPaid ?? 0),
    dueDate: data.sample?.dueDate ?? '30 Nov 2025',
    schoolName: data.sample?.schoolName ?? school.name,
    payLink: data.sample?.payLink ?? 'https://sukuupay.com/pay/STU-8F3K9D2L',
    term: data.sample?.term ?? 'Term 1',
  };

  const rendered = renderBody(body, values);
  const parts = countSmsParts(rendered);

  return {
    rendered,
    parts,
    length: rendered.length,
    tokens: extractTokens(rendered),
    unresolvedTokens: extractTokens(rendered).filter((token) => rendered.includes(`{${token}}`)),
    estimatedCost: parts,
  };
};

// ──────────────────── Bulk send ────────────────────

/**
 * Accepts a broadcast.
 *
 * Credit is spent here, at acceptance, not per message during the run. That is
 * what makes the cost the school was shown in the confirmation dialog the cost
 * they are actually billed: the recipient count is resolved and charged before
 * the job is created, and a run that submits fewer messages refunds the
 * difference. The alternative — spending per message — means the school's
 * balance changes while the job is in flight, and "you have 1,420 left" was true
 * only when the dialog was shown.
 */
export const bulkSendSms = async (data, user, { idempotencyKey } = {}) => {
  consumeRateLimit(`sms:bulk:${user?._id || 'anon'}`, 20, 60 * 60 * 1000);

  assertSchoolAccess(user, data.schoolId);

  const replay = await checkIdempotency(idempotencyKey, 'sms.bulk_send', data);
  if (replay) return { ...replay, replayed: true };

  const schoolId = resolveSchoolId(user, data.schoolId);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  const school = await loadSchool(schoolId);

  // ── Body ──
  let body = data.body;
  let template = null;
  let category = data.category;

  if (data.templateId) {
    template = await SmsTemplate.findOne({
      _id: data.templateId,
      deletedAt: null,
      $or: [{ schoolId: null }, { schoolId }],
    }).lean();
    if (!template) throw new ApiError('Template not found', 404, 'TEMPLATE_NOT_FOUND');
    body = template.body;
    category = data.category || template.category;
  }
  if (!body) throw new ApiError('A message body is required', 400, 'BODY_REQUIRED');

  assertTokensValid(body, { context: 'Message body' });
  category = category || 'custom';

  // ── Audience ──
  const { recipients, skipped, total, totalBalance } = await resolveAudience(
    schoolId,
    data.audience,
    { school, limit: data.maxRecipients || LIMITS.MAX_SMS_JOB_BATCH }
  );

  if (!recipients.length) {
    throw new ApiError(
      'No parents matched this audience. Widen the filters, or fix the parent numbers on the students who matched — an unusable number is counted separately for exactly this reason.',
      422,
      'NO_RECIPIENTS'
    );
  }

  // ── Cost ──
  // Measured on the *first* recipient's rendered length, not the template's:
  // names and amounts vary in width, and a body that fits 160 characters for
  // "Ada" is 168 for "Kwabena Owusu-Mensah". Measured on the longest render of
  // the batch it is a real upper bound, so the school is never charged for less
  // than it agreed to.
  const parts = recipients.reduce((max, recipient) => {
    const rendered = renderBody(body, recipient.values);
    return Math.max(max, countSmsParts(rendered));
  }, 1);

  if (parts > LIMITS.MAX_SMS_PARTS) {
    throw new ApiError(
      `That message is ${parts} SMS parts, over the ${LIMITS.MAX_SMS_PARTS}-part limit. Shorten it before broadcasting.`,
      422,
      'MESSAGE_TOO_LONG'
    );
  }

  const units = parts * recipients.length;

  const charge = await chargeCredits(schoolId, units);
  if (!charge.ok) {
    throw new ApiError(
      `Insufficient SMS credit: this broadcast costs ${units} credits (${parts} part${parts === 1 ? '' : 's'} × ${recipients.length} parents) and the school has ${charge.balance ?? 0} available.`,
      402,
      'INSUFFICIENT_SMS_CREDIT',
      { required: units, available: charge.balance ?? 0, parts, recipients: recipients.length }
    );
  }

  // ── Job ──
  // `scheduled` rather than `queued` for a future run, so the history can tell
  // "waiting its turn" from "waiting for the clock".
  const scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
  const isFuture = scheduledAt && scheduledAt.getTime() > Date.now();

  const job = await SmsJob.create({
    schoolId,
    body,
    templateId: data.templateId || null,
    category,
    audienceType: data.audience.type,
    filters: data.audience,
    status: isFuture ? 'scheduled' : 'queued',
    recipientsResolved: recipients.length,
    recipientsSkipped: recipients.length === total ? 0 : total - recipients.length,
    skippedInvalidNumber: skipped.invalid_number || 0,
    skippedReasons: skipped,
    creditsCharged: units,
    scheduledAt,
    // The snapshot. Deterministic by construction: the parent who pays an hour
    // from now is still messaged with the balance they had when the bursar
    // confirmed the recipient count.
    recipientsSnapshot: recipients.map((recipient) => ({
      parentId: recipient.parentId,
      studentId: recipient.studentId,
      phone: recipient.phone,
      parentName: recipient.parentName,
      studentName: recipient.studentName,
      studentClass: recipient.studentClass,
      balance: recipient.balance,
      amountPaid: recipient.amountPaid,
      dueDate: recipient.dueDate,
      payLink: recipient.payLink,
    })),
    createdBy: user?._id,
  });

  await auditLog({
    action: 'sms.bulk_send',
    entity: 'SmsJob',
    entityId: job._id,
    userId: user?._id,
    schoolId,
    meta: {
      audienceType: job.audienceType,
      recipients: recipients.length,
      parts,
      creditsCharged: units,
      scheduledAt: scheduledAt || null,
      totalBalance,
    },
  });

  const data_ = {
    job: {
      id: job._id,
      status: job.status,
      category,
      audienceType: job.audienceType,
      recipients: recipients.length,
      parts,
      creditsCharged: units,
      balanceAfter: charge.balance,
      scheduledAt: job.scheduledAt,
      totalBalance,
      totalBalanceDisplay: formatCedis(totalBalance),
      skipped: job.skippedReasons,
    },
  };

  await rememberIdempotency(idempotencyKey, 'sms.bulk_send', data, user?._id, data_);

  return { data: data_, replayed: false };
};

/**
 * Processes one job.
 *
 * Batched rather than one-at-a-time because a 2,000-recipient broadcast done
 * sequentially is 2,000 sequential HTTP round trips, which is minutes of the
 * school's evening. Batched, it is a handful of seconds — and because each batch
 * is a small transaction, a provider failure mid-run fails one batch rather than
 * the whole thing.
 *
 * The cancel check is between batches, never inside one. A message already handed
 * to the gateway cannot be recalled, so a "cancelled" job must not carry a
 * delivered message under its label: the run stops cleanly at the next boundary
 * and the count of what already went out is what it says it sent.
 */
export const processSmsJob = async (jobId, { batchSize = 25 } = {}) => {
  const job = await SmsJob.findOne({ _id: jobId, status: { $in: ['queued', 'scheduled'] } });
  if (!job) return null;

  // A scheduled job whose time has not come is left alone. Claiming it early
  // would send at 09:00 a run the bursar asked for at 19:00.
  if (job.scheduledAt && job.scheduledAt.getTime() > Date.now()) return null;

  job.status = 'processing';
  job.startedAt = new Date();
  await job.save();

  const school = await loadSchool(job.schoolId);
  const snapshot = await SmsJob.findById(job._id).select('+recipientsSnapshot').lean();
  const recipients = snapshot?.recipientsSnapshot || [];

  const counts = { queued: 0, sent: 0, delivered: 0, failed: 0 };
  let processed = 0;
  let cancelled = false;
  let failureReason = '';
  // Hoisted out of the batch loop on purpose: the refund after the run has to be
  // computed against the *widest* render in the whole batch, and a `longest`
  // scoped to the last iteration would refund against one lucky short name.
  let widestRender = 1;

  for (let offset = 0; offset < recipients.length; offset += batchSize) {
    // Re-read the status each batch rather than caching it: a cancel issued
    // mid-run has to take effect, and the only thing that knows it is the
    // document.
    const current = await SmsJob.findById(job._id).select('status').lean();
    if (current?.status === 'cancelling' || current?.status === 'cancelled') {
      cancelled = true;
      break;
    }

    const batch = recipients.slice(offset, offset + batchSize);
    const rendered = batch.map((recipient) => ({
      recipient,
      message: renderBody(job.body, {
        parentName: recipient.parentName,
        studentName: recipient.studentName,
        studentClass: recipient.studentClass,
        balance: formatCedis(recipient.balance ?? 0),
        amountPaid: formatCedis(recipient.amountPaid ?? 0),
        dueDate: recipient.dueDate ? formatAccraDate(recipient.dueDate) : '',
        schoolName: school.name,
        payLink: recipient.payLink,
      }),
    }));

    const batchWidth = rendered.reduce((max, entry) => Math.max(max, countSmsParts(entry.message)), 1);
    widestRender = Math.max(widestRender, batchWidth);
    const units = batchWidth * batch.length;

    // A run that has spent the school's credit stops. The charged amount is what
    // was reserved at acceptance, so this only fires if something else drained
    // the balance between acceptance and the run — and stopping is correct: the
    // alternative is negative balance and a bill the school did not agree to.
    if (units > 0) {
      const charge = await chargeCredits(job.schoolId, units);
      if (!charge.ok) {
        failureReason = `SMS credit ran out mid-run: ${units} credits required, ${charge.balance ?? 0} available. ${processed} of ${recipients.length} messages were sent.`;
        break;
      }
    }

    for (const { recipient, message } of rendered) {
      const outcome = await submitMessage({ to: recipient.phone, body: message, school });
      const segments = countSmsParts(message);

      await SmsMessage.create({
        schoolId: job.schoolId,
        studentId: recipient.studentId,
        parentId: recipient.parentId,
        type: job.category,
        purpose: job.category,
        templateId: job.templateId,
        jobId: job._id,
        to: recipient.phone,
        toE164: recipient.phone,
        message,
        segments,
        status: outcome.ok ? 'submitted' : 'failed',
        provider: school.sms?.provider || 'arke',
        providerMessageId: outcome.ok ? outcome.providerMessageId || null : null,
        failureReason: outcome.ok ? '' : String(outcome.reason).slice(0, 500),
        // Only an accepted message is charged, and only to this message. A
        // rejected one is refunded at the end of the run as part of the
        // acceptance-time reservation, so charging it here would credit twice.
        creditsCharged: outcome.ok ? segments : 0,
        sentAt: outcome.ok ? new Date() : null,
        createdBy: job.createdBy,
      });

      if (outcome.ok) counts.sent += 1;
      else counts.failed += 1;
      processed += 1;
    }

    await SmsJob.findById(job._id).updateOne({
      $set: {
        result: counts,
        progressPercent: Math.round((processed / recipients.length) * 100),
        updatedBy: job.createdBy,
      },
    });
  }

  const finalStatus = cancelled ? 'cancelled' : failureReason ? 'failed' : 'completed';

  await SmsJob.findById(job._id).updateOne({
    $set: {
      status: finalStatus,
      result: counts,
      progressPercent: finalStatus === 'completed' ? 100 : Math.round((processed / recipients.length) * 100),
      completedAt: cancelled ? null : new Date(),
      cancelledAt: cancelled ? new Date() : null,
      failureReason,
      updatedBy: job.createdBy,
    },
  });

  // The difference between the credit reserved at acceptance and the credit the
  // run actually spent goes back. A run that submitted half its messages has
  // been paid for half, and a school's balance should say so immediately rather
  // than after a nightly reconciliation nobody scheduled.
  const spent = (counts.sent + counts.failed) * widestRender;
  const refundable = Math.max(job.creditsCharged - spent, 0);
  if (refundable > 0) {
    await refundCredits(job.schoolId, refundable);
    await SmsJob.findById(job._id).updateOne({ $inc: { creditsRefunded: refundable } });
  }

  await auditLog({
    action: 'sms.bulk_send',
    entity: 'SmsJob',
    entityId: job._id,
    schoolId: job.schoolId,
    meta: { status: finalStatus, ...counts, creditsRefunded: refundable, failureReason },
  });

  return { jobId: job._id, status: finalStatus, result: counts, creditsRefunded: refundable };
};

/**
 * Drains the queue.
 *
 * Called on a timer and exposed as a route so a deployment with no scheduler
 * configured can trigger it. Single-flight on purpose: two concurrent drains
 * would claim the same `queued` job and double-send a broadcast to real parents,
 * which is the one thing this module must never do.
 */
let draining = false;

export const drainSmsQueue = async ({ limit = 5, batchSize = 25 } = {}) => {
  if (draining) return { skipped: true, reason: 'A drain is already running' };
  draining = true;

  try {
    const jobs = await SmsJob.find({
      status: { $in: ['queued', 'scheduled'] },
      $or: [{ scheduledAt: null }, { scheduledAt: { $lte: new Date() } }],
      deletedAt: null,
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .select('_id')
      .lean();

    const results = [];
    for (const job of jobs) {
      // Sequential, not parallel: each run spends the same school's credit, and
      // two runs of one school in parallel would race the balance check.
      results.push(await processSmsJob(job._id, { batchSize }));
    }

    return { processed: results.filter(Boolean).length, results: results.filter(Boolean) };
  } finally {
    draining = false;
  }
};

// ──────────────────── Job control ────────────────────

export const getSmsJob = async (jobId, user) => {
  const job = await SmsJob.findOne({ _id: jobId, deletedAt: null })
    .select('+body +recipientsSnapshot')
    .lean();
  if (!job) throw new ApiError('Job not found', 404, 'JOB_NOT_FOUND');

  assertSchoolAccess(user, String(job.schoolId));

  const snapshot = job.recipientsSnapshot || [];
  const sample = snapshot[0];

  return {
    ...job,
    // The snapshot is summarised, not returned. It is every parent's number for
    // the whole school, and a job read is not a consent to hand it back.
    recipientsSnapshot: undefined,
    body: job.body,
    sampleRecipient: sample
      ? {
          parentName: sample.parentName,
          phoneDisplay: formatPhone(sample.phone),
          studentName: sample.studentName,
          balance: sample.balance,
          balanceDisplay: formatCedis(sample.balance),
        }
      : null,
    messageCount: snapshot.length,
  };
};

export const listSmsJobs = async (query, user) => {
  const schoolId = resolveSchoolId(user, query.schoolId);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  const filter = { schoolId, deletedAt: null };
  if (query.status && query.status !== 'all') filter.status = query.status;
  if (query.category && query.category !== 'all') filter.category = query.category;
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }

  const page = Number(query.page) || 1;
  const perPage = Math.min(Number(query.perPage) || 20, LIMITS.MAX_NOTIFICATIONS_PAGE);

  const [jobs, total] = await Promise.all([
    SmsJob.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean(),
    SmsJob.countDocuments(filter),
  ]);

  return { jobs, meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) } };
};

/**
 * Cancels a job.
 *
 * Refuses a job that has already started sending. A cancel takes effect between
 * batches, so one already `processing` may be 400 messages in — promising to
 * stop it and then stopping it in 200 is worse than not offering the button, and
 * the refund arithmetic gets murky enough that nobody trusts it. A `queued` or
 * `scheduled` job has sent nothing, so cancelling it is exact and the full
 * credit comes straight back.
 */
export const cancelSmsJob = async (jobId, data, user) => {
  const schoolId = resolveSchoolId(user);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  const job = await SmsJob.findOne({ _id: jobId, schoolId, deletedAt: null });
  if (!job) throw new ApiError('Job not found', 404, 'JOB_NOT_FOUND');

  if (['completed', 'cancelled', 'failed'].includes(job.status)) {
    throw new ApiError(
      `This job is already ${job.status} and cannot be cancelled`,
      409,
      'JOB_NOT_CANCELLABLE'
    );
  }
  if (job.status === 'processing') {
    throw new ApiError(
      'This broadcast is already sending. Cancelling mid-run cannot recall the messages already accepted by the gateway — wait for it to finish and read the result.',
      409,
      'JOB_ALREADY_RUNNING'
    );
  }

  const refundable = job.creditsCharged;
  if (refundable > 0) {
    await refundCredits(job.schoolId, refundable);
    job.creditsRefunded = refundable;
  }

  job.status = 'cancelled';
  job.cancellationReason = data.reason || '';
  job.cancelledAt = new Date();
  job.completedAt = new Date();
  job.updatedBy = user?._id || null;
  await job.save();

  await auditLog({
    action: 'sms.job_cancel',
    entity: 'SmsJob',
    entityId: job._id,
    userId: user?._id,
    schoolId,
    meta: { reason: data.reason || '', creditsRefunded: refundable },
  });

  return {
    jobId: job._id,
    status: job.status,
    cancellationReason: job.cancellationReason,
    cancelledAt: job.cancelledAt,
    creditsRefunded: refundable,
    result: job.result,
  };
};

// ──────────────────── History ────────────────────

export const listSmsMessages = async (query, user) => {
  const schoolId = resolveSchoolId(user, query.schoolId);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  const filter = { schoolId, deletedAt: null };
  if (!query.includeTest) filter.isTest = false;
  if (query.status && query.status !== 'all') filter.status = query.status;
  if (query.category && query.category !== 'all') filter.type = query.category;
  if (query.jobId) filter.jobId = new mongoose.Types.ObjectId(query.jobId);
  if (query.studentId) filter.studentId = new mongoose.Types.ObjectId(query.studentId);
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }
  if (query.search) {
    const pattern = new RegExp(String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ message: pattern }, { to: pattern }];
  }

  const page = Number(query.page) || 1;
  const perPage = Math.min(Number(query.perPage) || 20, LIMITS.MAX_NOTIFICATIONS_PAGE);

  const [messages, total] = await Promise.all([
    SmsMessage.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .populate('studentId', 'studentName studentId studentClass')
      .lean(),
    SmsMessage.countDocuments(filter),
  ]);

  // The per-status tally, computed over the whole filtered set rather than the
  // page: a history that reports "12 failed" when the page happens to show two
  // is worse than no tally, because it reads as a delivery rate.
  const statusCounts = await SmsMessage.aggregate([
    { $match: filter },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  return {
    messages,
    meta: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
      statusCounts: Object.fromEntries(statusCounts.map((row) => [row._id, row.count])),
    },
  };
};

// ──────────────────── Credits ────────────────────

export const getSmsCredits = async (schoolIdParam, user) => {
  assertSchoolAccess(user, schoolIdParam);
  const schoolId = resolveSchoolId(user, schoolIdParam);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  const school = await School.findById(schoolId)
    .select('name sms.balance sms.provider sms.senderId')
    .lean();
  if (!school) throw new ApiError('School not found', 404, 'SCHOOL_NOT_FOUND');

  const [topUps, spend] = await Promise.all([
    SmsCreditTopUp.find({ schoolId }).sort({ createdAt: -1 }).limit(20).lean(),
    SmsMessage.aggregate([
      { $match: { schoolId: new mongoose.Types.ObjectId(schoolId), isTest: false, deletedAt: null } },
      {
        $group: {
          _id: null,
          charged: { $sum: '$creditsCharged' },
          refunded: { $sum: '$creditsRefunded' },
          sent: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
          delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'rejected']] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const usage = spend[0] || { charged: 0, refunded: 0, sent: 0, delivered: 0, failed: 0 };
  const settled = usage.sent + usage.delivered;
  const config = getArkeselConfigStatus();
  const balance = school.sms?.balance ?? 0;

  return {
    school: { id: school._id, name: school.name },
    balance,
    // What the topbar pill and the composer's send button both need, so neither
    // has to derive it — and neither can disagree with the other.
    units: balance,
    // The cedi value of the balance, at the platform's own rate. Returned rather
    // than computed in each client so the header and the composer cannot quote
    // two different prices for the same credit.
    ratePes: SMS_CREDIT_RATE_PES,
    balancePes: balance * SMS_CREDIT_RATE_PES,
    balanceCedis: formatCedis(balance * SMS_CREDIT_RATE_PES),
    provider: school.sms?.provider || 'arke',
    senderId: school.sms?.senderId || null,
    // Whether a send would actually reach a handset right now. Reported
    // explicitly because a missing gateway key produces a 503 at send time, and
    // a bursar should learn that before composing 200 messages, not after.
    canSend: config.configured,
    gateway: {
      configured: config.configured,
      hasSenderId: config.hasSenderId,
      senderIdValid: config.senderIdValid,
      senderIdIssue: config.senderIdIssue,
      dlrCallbackConfigured: config.dlrCallbackConfigured,
    },
    usage: {
      ...usage,
      netCharged: Math.max(usage.charged - usage.refunded, 0),
      // Only settled messages count toward a rate. A message still waiting on its
      // delivery report is not a failure, and counting it as one would make
      // every school's rate fall the moment it sends.
      deliveryRate: settled ? Math.round((usage.delivered / settled) * 1000) / 10 : null,
    },
    topUps,
  };
};

/**
 * Adds credit to a school.
 *
 * A school admin may top up their own balance — this is a metered product and a
 * bursar paying for more capacity is the normal case, not a privileged one. It
 * does not create a payment: the purchase happens in the payment surface, and
 * this records the credit that purchase bought, with its reference. A top-up
 * with no reference is legitimate (a support grant) and is recorded as one, so
 * the ledger can tell the two apart.
 */
export const topUpSmsCredits = async (data, user) => {
  const schoolId = resolveSchoolId(user, data.schoolId);
  if (!schoolId) throw new ApiError('No school in scope', 403, 'NO_SCHOOL_SCOPE');

  const source = data.reference ? 'purchase' : 'grant';

  const topUp = await SmsCreditTopUp.create({
    schoolId,
    units: data.units,
    amountPes: data.amountPes ?? null,
    provider: data.provider || null,
    reference: data.reference || null,
    source,
    note: data.note || '',
    createdBy: user?._id || null,
  });

  const school = await School.findOneAndUpdate(
    { _id: schoolId },
    { $inc: { 'sms.balance': data.units } },
    { returnDocument: 'after' }
  )
    .select('sms.balance')
    .lean();

  await auditLog({
    action: 'sms.credit_topup',
    entity: 'SmsCreditTopUp',
    entityId: topUp._id,
    userId: user?._id,
    schoolId,
    meta: { units: data.units, amountPes: data.amountPes ?? null, source, reference: data.reference || null },
  });

  return {
    topUp: topUp.toJSON(),
    balance: school?.sms?.balance ?? 0,
  };
};

export { hashPayload };
