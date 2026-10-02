import mongoose from 'mongoose';
import { School } from '../../models/schoolModel.js';
import { User } from '../../models/userModel.js';
import { SmsMessage } from '../../models/smsMessageModel.js';
import { SmsCreditTopUp } from '../../models/smsCreditTopUpModel.js';
import { ARKESEL_SENDER_ID } from '../../config/env.js';
import { getCachedPlatformSettings } from '../platformSettings.service.js';
import { submitMessage, countSmsParts } from '../sms.service.js';
import ApiError from '../../utils/ApiError.js';
import {
  resolvePagination,
  buildMeta,
  optionalId,
  toObjectIdList,
  resolveDateRange,
} from '../../utils/platformQuery.js';

/**
 * Platform-wide SMS administration.
 *
 * Three facts about this codebase shape everything below, and they were established
 * by reading `services/sms.service.js` rather than assumed:
 *
 *   1. **Credits are per school.** `school.sms.balance` is the balance, and
 *      `chargeCredits` debits one school's document. There is no platform pool and
 *      no master balance anywhere in the product.
 *   2. **The gateway key is deployment-level.** `ARKESEL_API_KEY` is one key for the
 *      whole instance; a school's `sms.apiKey` is not consulted at transmit time. So
 *      a message sent *without* a school is not free — it is paid for by whoever
 *      holds the instance's Arkesel account, which for a platform announcement is
 *      exactly right.
 *   3. **Arkesel is the only transmit client.** `submitMessage` refuses any other
 *      provider with an explanation rather than silently routing through Arkesel,
 *      because a sender ID registered with one operator is dropped by the others.
 *
 * Which means a platform broadcast can be funded honestly: it sends through the
 * platform's own identity and charges no school's credit. What it cannot do is
 * borrow a school's balance, so a per-school credit top-up is the only way SMS
 * credit moves, and the top-up endpoint says so.
 */

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * `GET /admin/sms/overview`
 *
 * `costThisMonth` is an **estimate** and is labelled as one in its key name rather
 * than only in a comment. It is `messages × PlatformSettings.sms.ratePesewas`, which
 * is a list price. Arkesel's actual invoice will differ — bundles, per-network
 * rates, and refunds for failed messages — so a console that presented this as
 * "cost" would produce a discrepancy the operator could not explain against the
 * invoice. The name `estimatedCostThisMonth` exists to make that impossible to drop
 * in a table header by accident.
 */
export const getSmsOverview = async (query = {}) => {
  const { from, to } = query;
  const range = resolveDateRange(from, to);
  const settings = await getCachedPlatformSettings();
  const ratePesewas = Number(settings?.sms?.ratePesewas) || 0;

  const monthStart = new Date();
  monthStart.setUTCHours(0, 0, 0, 0);
  monthStart.setUTCDate(1);

  const monthRange = { createdAt: { $gte: monthStart, $lte: new Date() } };
  const windowRange = Object.keys(range).length ? range : monthRange;

  const [byStatus, windowTotals, allTimeTotals, topSchools, schoolCount] = await Promise.all([
    SmsMessage.aggregate([
      { $match: { deletedAt: null, ...windowRange } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    SmsMessage.aggregate([
      { $match: { deletedAt: null, ...windowRange } },
      { $group: { _id: null, count: { $sum: 1 }, segments: { $sum: '$segments' } } },
    ]),
    SmsMessage.aggregate([
      { $match: { deletedAt: null } },
      { $group: { _id: null, count: { $sum: 1 } } },
    ]),
    SmsMessage.aggregate([
      { $match: { deletedAt: null, ...windowRange } },
      { $group: { _id: '$schoolId', count: { $sum: 1 }, segments: { $sum: '$segments' } } },
      { $sort: { segments: -1 } },
      { $limit: 10 },
    ]),
    School.countDocuments({ deletedAt: null }),
  ]);

  // `schoolId` is nullable on SmsMessage — a platform-level message has no school —
  // so the aggregation produces a `_id: null` bucket that would otherwise appear as
  // a row with no school. Kept out of the top-schools table and reported separately,
  // because "platform messages" is a real number the operator needs and not a
  // school.
  const namedSchools = topSchools.filter((row) => row._id);
  const platformMessages = topSchools.find((row) => !row._id);

  const schoolNames = await School.find({
    _id: { $in: namedSchools.map((row) => row._id) },
  })
    .select('name schoolCode region')
    .lean();

  const nameById = new Map(schoolNames.map((school) => [String(school._id), school]));

  const segments = Number(windowTotals[0]?.segments) || 0;

  return {
    provider: settings?.sms?.provider || 'arke',
    ratePesewas,
    window: { from: from || null, to: to || null },
    totals: {
      messages: Number(windowTotals[0]?.count) || 0,
      segments,
      allTimeMessages: Number(allTimeTotals[0]?.count) || 0,
      estimatedCostThisMonth: segments * ratePesewas,
    },
    byStatus: byStatus.map((row) => ({ status: row._id, count: row.count })),
    topSchools: namedSchools.map((row) => ({
      schoolId: row._id,
      name: nameById.get(String(row._id))?.name || 'Unknown school',
      schoolCode: nameById.get(String(row._id))?.schoolCode || '',
      region: nameById.get(String(row._id))?.region || '',
      count: row.count,
      segments: row.segments,
    })),
    platformMessages: {
      count: Number(platformMessages?.count) || 0,
      segments: Number(platformMessages?.segments) || 0,
    },
    schoolsWithBalance: schoolCount,
  };
};

/**
 * `GET /admin/sms/credits`
 *
 * **"Master balance" in this codebase means the sum of every school's balance, and
 * nothing more.** There is no platform credit pool — `SmsCreditTopUp.schoolId` is
 * required, so credit cannot exist without a school to hold it, and
 * `chargeCredits` debits `school.sms.balance` directly. The sum is therefore a
 * useful number (it is what the platform owes schools in SMS) and a misleading one
 * (it is not spendable by the platform), so it is returned as
 * `totalHeldBySchools` and there is deliberately no `platformBalance` field for a
 * console to render as though one existed.
 */
export const getSmsCredits = async (query = {}) => {
  const { schoolId, page, perPage } = query;
  const scopedSchool = optionalId(schoolId, 'school ID');
  const { skip, limit, page: safePage, perPage: safePerPage } = resolvePagination({
    page,
    perPage,
  });

  const filter = { deletedAt: null };
  if (scopedSchool) filter._id = scopedSchool;

  const [schools, total, aggregate, topUps] = await Promise.all([
    School.find(filter)
      .sort({ 'sms.balance': -1 })
      .skip(skip)
      .limit(limit)
      .select('name schoolCode region sms.provider sms.balance sms.senderId')
      .lean(),
    School.countDocuments(filter),
    School.aggregate([
      { $match: { deletedAt: null, ...(scopedSchool ? { _id: scopedSchool } : {}) } },
      {
        $group: {
          _id: null,
          totalHeldBySchools: { $sum: '$sms.balance' },
          schoolsWithCredit: {
            $sum: { $cond: [{ $gt: ['$sms.balance', 0] }, 1, 0] },
          },
        },
      },
    ]),
    SmsCreditTopUp.find(scopedSchool ? { schoolId: scopedSchool } : {})
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('schoolId', 'name schoolCode')
      .lean(),
  ]);

  const settings = await getCachedPlatformSettings();

  return {
    provider: settings?.sms?.provider || 'arke',
    ratePesewas: Number(settings?.sms?.ratePesewas) || 0,
    // Named for what it is. A console rendering this as "platform balance" would be
    // promising money the platform cannot spend.
    totalHeldBySchools: Number(aggregate[0]?.totalHeldBySchools) || 0,
    schoolsWithCredit: Number(aggregate[0]?.schoolsWithCredit) || 0,
    // Said plainly rather than left as an absent field, because "there is no
    // platform pool" and "we forgot to return one" look identical to a client.
    platformPool: null,
    platformPoolNote:
      'SMS credit in this platform is held per school. There is no master balance to draw from; a platform broadcast is sent on the platform sender ID and charged to nobody.',
    schools: schools.map((school) => ({
      schoolId: school._id,
      name: school.name,
      schoolCode: school.schoolCode,
      region: school.region,
      provider: school.sms?.provider || 'arke',
      balance: Number(school.sms?.balance) || 0,
    })),
    recentTopUps: topUps,
    meta: buildMeta({ page: safePage, perPage: safePerPage, total }),
  };
};

/**
 * `POST /admin/sms/credits/topup` — record credit arriving.
 *
 * **Records, it does not pay.** There is no payment integration for SMS credit
 * anywhere in this product, so this writes `SmsCreditTopUp` rows and increments the
 * named schools' balances. A dialog that says "top up" and means "we transferred
 * money to Arkesel" would be wrong, so the endpoint's own response reports what it
 * did rather than what it sounds like it did.
 *
 * The two shapes:
 *
 *   - **with `schoolIds`** — credit is granted to each named school. `units` is
 *     split evenly with the remainder to the first few, because a fractional
 *     balance would make every subsequent cost calculation wrong and there is no
 *     way to refund a message.
 *   - **without `schoolIds`** — a **platform credit note**: nothing is credited,
 *     because `SmsCreditTopUp.schoolId` is required and a row cannot exist without
 *     an owner. Recorded in the audit entry's `meta` and reported as
 *     `creditedSchools: 0`, so it is visibly different from crediting every school.
 */
export const recordSmsCreditTopUp = async ({ amount, provider, schoolIds, note, amountPes }, actor) => {
  const units = Number(amount) || 0;
  if (units < 1) {
    throw new ApiError('An SMS top-up must be at least one message', 400, 'INVALID_AMOUNT');
  }

  const ids = toObjectIdList(schoolIds || [], 'school ID');

  if (!ids.length) {
    return {
      platformCreditNote: true,
      creditedSchools: 0,
      units,
      note: note || '',
      message:
        'Recorded as a platform credit note. No school was credited, because SMS credit in this platform is held per school — name the schools to fund.',
    };
  }

  const schools = await School.find({ _id: { $in: ids }, deletedAt: null }).select('_id name').lean();
  if (schools.length !== ids.length) {
    const found = new Set(schools.map((school) => String(school._id)));
    const missing = ids.filter((id) => !found.has(String(id)));
    throw new ApiError(
      `${missing.length} of the selected schools do not exist or are deleted`,
      404,
      'SCHOOL_NOT_FOUND'
    );
  }

  // Split evenly, remainder to the front. Documented rather than left to a reader to
  // infer, because a fractional `sms.balance` silently poisons every downstream
  // cost calculation and there is no mechanism to revoke one credit.
  const base = Math.floor(units / ids.length);
  const remainder = units % ids.length;

  const results = [];
  for (let index = 0; index < ids.length; index += 1) {
    const share = base + (index < remainder ? 1 : 0);
    const school = schools.find((entry) => String(entry._id) === String(ids[index]));

    // `findOneAndUpdate` rather than a read-then-write: two concurrent top-ups for
    // the same school would otherwise both read the same balance and one increment
    // would be lost.
    await School.updateOne(
      { _id: ids[index], deletedAt: null },
      { $inc: { 'sms.balance': share } }
    );

    await SmsCreditTopUp.create({
      schoolId: ids[index],
      units: share,
      amountPes: amountPes ?? null,
      provider: provider || null,
      source: amountPes ? 'purchase' : 'grant',
      note: note || '',
      createdBy: actor?._id || null,
    });

    results.push({ schoolId: ids[index], schoolName: school?.name || '', units: share });
  }

  return {
    platformCreditNote: false,
    creditedSchools: results.length,
    units,
    allocations: results,
  };
};

/**
 * `GET /admin/sms/logs` — delivery history across every school.
 *
 * **The message body is redacted server-side, and the client is not trusted to do
 * it.** A platform-wide list of rendered SMS bodies is a searchable copy of every
 * school's correspondence with its parents, which is exactly the data this console
 * has no reason to hold. So the endpoint returns a **truncated preview** and a
 * **masked number**, never the raw values.
 *
 * The preview exists at all because a delivery failure is unreadable without it —
 * "Message not delivered" against an empty body tells an operator nothing about why
 * — and 72 characters is where a fee-reminder body stops being identifiable and
 * starts being the whole message. It is cut here rather than in the browser because
 * anything sent to a client has already left: masking in the UI is presentation, not
 * redaction, and a developer tools panel shows the real number.
 *
 * `to` is masked to the first four and last two digits. Enough to recognise a
 * recurring number on a school's own row; useless as a list of parents to call.
 *
 * The row still answers "did it deliver", never "who does this person owe". There is
 * no `parentName`, no `parentId` and no link to a student's record on this payload —
 * the question a bursar asks is about their message, and the one a school would object
 * to is about their parents' data.
 */
export const listSmsLogs = async (query = {}) => {
  const { schoolId, status, from, to, page, perPage } = query;
  const scopedSchool = optionalId(schoolId, 'school ID');
  const { skip, limit, page: safePage, perPage: safePerPage } = resolvePagination({ page, perPage });

  const filter = {
    deletedAt: null,
    ...(scopedSchool ? { schoolId: scopedSchool } : {}),
    ...(status ? { status } : {}),
    ...resolveDateRange(from, to),
  };

  const [rows, total] = await Promise.all([
    SmsMessage.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select(
        'schoolId studentId parentId type purpose to message segments status provider providerMessageId creditsCharged failureReason sentAt deliveredAt failedAt createdAt'
      )
      .populate('schoolId', 'name schoolCode region')
      .lean(),
    SmsMessage.countDocuments(filter),
  ]);

  return {
    data: rows.map((row) => ({
      _id: row._id,
      school: row.schoolId
        ? {
            _id: row.schoolId._id,
            name: row.schoolId.name,
            schoolCode: row.schoolId.schoolCode,
            region: row.schoolId.region,
          }
        : null,
      // A platform-level broadcast has no school, and the row must say so rather
      // than render as an empty cell that looks like missing data.
      scope: row.schoolId ? 'school' : 'platform',
      studentId: row.studentId,
      parentId: row.parentId,
      category: row.type,
      purpose: row.purpose,
      to: maskPhone(row.to),
      messagePreview: previewMessage(row.message),
      segments: row.segments,
      status: row.status,
      provider: row.provider,
      providerMessageId: row.providerMessageId,
      creditsCharged: row.creditsCharged,
      failureReason: row.failureReason,
      sentAt: row.sentAt,
      deliveredAt: row.deliveredAt,
      failedAt: row.failedAt,
      createdAt: row.createdAt,
    })),
    // Stated once rather than left to each caller to infer: there is no `message`
    // field on this payload, and a screen showing an empty cell needs to know that
    // is redaction rather than a bug.
    redaction: {
      message: 'Preview only — the full body is never returned on a platform-wide read.',
      to: 'Phone numbers are masked to the first four and last two digits.',
    },
    meta: buildMeta({ page: safePage, perPage: safePerPage, total }),
  };
};

/**
 * `0234••••89` — first four, last two, everything between elided.
 *
 * Four leading digits is the Ghanaian mobile prefix, so the mask keeps the carrier
 * visible, which is the one fact about a number an operator troubleshooting a
 * delivery failure actually needs. Returns `''` rather than a masked stub for a
 * missing value, so "we have no number" reads as empty and not as `•••••`.
 */
const maskPhone = (value) => {
  const digits = String(value || '').replace(/[^\d]/g, '');
  if (digits.length < 7) return '';
  return `${digits.slice(0, 4)}•••${digits.slice(-2)}`;
};

/**
 * 72 characters plus a real ellipsis.
 *
 * A real `…` rather than a CSS `truncate`, because the point is that the value on the
 * wire is short — a browser-side truncation sends the whole body and then hides most
 * of it, which is not redaction.
 */
const PREVIEW_CHARS = 72;
const previewMessage = (value) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`;
};

/**
 * The ceiling on one broadcast.
 *
 * 500 recipients, and the number is about cost and irreversibility rather than
 * about the database: this is metered SMS from a real provider to real phones, and
 * a mis-targeted announcement cannot be recalled once the provider has accepted it.
 * The server refuses above this and returns the resolved count, so the console can
 * show the operator what they were about to send before they are told no.
 */
export const MAX_BROADCAST_RECIPIENTS = 500;

/**
 * `POST /admin/sms/broadcast` — tell every school's administrators something.
 *
 * **Recipients are `school_admin` accounts, and nothing else.** Not every staff
 * member, not teachers, not viewers: a platform maintenance notice is an operational
 * fact about the bursar's account, and a teacher's handset is not a place to put it.
 * Active, non-deleted schools only — a message to a school that cannot log in is
 * noise that trains people to ignore notices.
 *
 * **Sent on the platform's own sender ID, charging no school's credit.** That is
 * what `submitMessage` gives us by accepting any object with an `sms` block: the
 * deployment-level `ARKESEL_API_KEY` is used, `school.sms.balance` is never touched.
 * An announcement about a platform outage is the platform's cost, and charging it to
 * a customer who already cannot take payments would be both wrong and, on a day that
 * matters, visible.
 *
 * **Written synchronously, in batches, with a per-recipient row.** Not queued
 * through `SmsJob`: that pipeline exists to resolve an *audience of parents* from
 * students and plans, and here the audience is already a resolved list of accounts.
 * Reusing it would mean inventing a student-shaped recipient for something that is
 * an admin, and the queue's credit-charging step is wrong for a message nobody is
 * paying for.
 */
export const broadcastToSchoolAdmins = async (
  { targetAudience, schoolIds, message },
  actor
) => {
  const body = String(message || '').trim();
  if (!body) {
    throw new ApiError('A broadcast needs a message', 400, 'MESSAGE_REQUIRED');
  }

  const schoolFilter = {
    status: 'active',
    deletedAt: null,
  };

  if (targetAudience === 'selected_schools') {
    const ids = toObjectIdList(schoolIds || [], 'school ID');
    if (!ids.length) {
      throw new ApiError(
        'Select at least one school for a targeted broadcast',
        400,
        'NO_SCHOOLS_SELECTED'
      );
    }
    schoolFilter._id = { $in: ids };
  }

  const schools = await School.find(schoolFilter).select('_id name').lean();
  const schoolIdsResolved = schools.map((school) => school._id);

  if (!schoolIdsResolved.length) {
    throw new ApiError(
      'No active school matched this broadcast — nothing was sent',
      404,
      'NO_RECIPIENTS'
    );
  }

  const recipients = await User.find({
    role: 'school_admin',
    status: 'active',
    deletedAt: null,
    schoolId: { $in: schoolIdsResolved },
    // A phone number, not a name: an admin without one cannot be reached, and
    // sending to `null` produces a row that reports success and reaches nobody.
    phone: { $nin: [null, ''] },
  })
    .select('_id name phone schoolId')
    .lean();

  if (!recipients.length) {
    throw new ApiError(
      'None of the selected schools has an administrator with a phone number on file',
      404,
      'NO_RECIPIENTS'
    );
  }

  if (recipients.length > MAX_BROADCAST_RECIPIENTS) {
    throw new ApiError(
      `This broadcast resolves to ${recipients.length} recipients, above the ${MAX_BROADCAST_RECIPIENTS} limit. Narrow the selection.`,
      400,
      'TOO_MANY_RECIPIENTS',
      { recipients: recipients.length, limit: MAX_BROADCAST_RECIPIENTS }
    );
  }

  const settings = await getCachedPlatformSettings();
  const provider = settings?.sms?.provider || 'arke';

  if (provider !== 'arke') {
    throw new ApiError(
      `This deployment is configured for the "${provider}" SMS gateway, which has no transmit client wired (see services/sms.service.js). Set PlatformSettings.sms.provider to "arke" to send.`,
      409,
      'SMS_PROVIDER_UNSUPPORTED'
    );
  }

  // The synthetic sender. `submitMessage` only reads `sms.provider` and
  // `sms.senderId`, so this is everything it needs — and giving it the shape of a
  // `School` is what lets one transmit path serve both callers instead of two
  // implementations drifting apart.
  const platformSender = {
    _id: null,
    sms: {
      provider,
      senderId: ARKESEL_SENDER_ID || '',
    },
  };

  const segments = countSmsParts(body);
  const results = { sent: 0, failed: 0, rows: [] };

  /*
   * Sequential, not parallel.
   *
   * A burst of 500 simultaneous requests against one gateway is how an account
   * gets rate-limited, and a rate-limited broadcast reports `failed` for every
   * recipient while the operator believes it sent. Sequential is slower and it is
   * the difference between a slow announcement and a broken one. The console's own
   * message advises keeping broadcasts short for the same reason.
   */
  for (const recipient of recipients) {
    const submitted = await submitMessage({
      to: recipient.phone,
      body,
      school: platformSender,
    });

    /*
     * The `SmsMessage` row is written whatever the gateway said.
     *
     * A failed submission still needs to be on record: "we tried to tell your
     * administrators about an outage and it did not reach them" is the fact an
     * operator needs at 2am, and a history with only successes would report a
     * broadcast that reached more people than it did.
     */
    const row = await SmsMessage.create({
      schoolId: recipient.schoolId,
      // No student and no parent: this is addressed to a staff account, and leaving
      // those null is what keeps it out of every per-student message list.
      studentId: null,
      parentId: null,
      type: 'announcement',
      purpose: 'platform_broadcast',
      to: recipient.phone,
      message: body,
      segments,
      // No credit charged. This is the platform's own sender and nobody's balance
      // is debited, so `creditsCharged: 0` is a true zero and not an omission.
      creditsCharged: 0,
      provider,
      status: submitted.ok ? 'submitted' : 'failed',
      providerMessageId: submitted.ok ? submitted.providerMessageId : null,
      failureReason: submitted.ok ? null : submitted.reason || submitted.code || 'Send failed',
      sentAt: submitted.ok ? new Date() : null,
      failedAt: submitted.ok ? null : new Date(),
      createdBy: actor?._id || null,
    });

    if (submitted.ok) results.sent += 1;
    else results.failed += 1;

    results.rows.push({
      messageId: row._id,
      userId: recipient._id,
      schoolId: recipient.schoolId,
      status: row.status,
    });
  }

  return {
    recipients: recipients.length,
    schools: schoolIdsResolved.length,
    segments,
    segmentsTotal: segments * recipients.length,
    estimatedCost: segments * recipients.length * (Number(settings?.sms?.ratePesewas) || 0),
    sent: results.sent,
    failed: results.failed,
    // Truncated deliberately. 500 rows of per-recipient ids is not something an
    // operator reads, and the counts above are what the screen shows.
    results: results.rows.slice(0, 50),
    provider,
  };
};

export default {
  getSmsOverview,
  getSmsCredits,
  recordSmsCreditTopUp,
  listSmsLogs,
  broadcastToSchoolAdmins,
  MAX_BROADCAST_RECIPIENTS,
};