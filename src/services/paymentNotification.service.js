// Telling the two people a settled payment is about.
//
//   Backend/src/services/paymentNotification.service.js
//
// A payment that lands moves three balances — the student's, the school's and
// the platform's — and `settlePayment` in `paymentApplication.service.js` does
// that. What it did not do was tell anyone. The parent found out by polling,
// and the school found out by opening the Payments screen and noticing.
//
// ## The two audiences, and why they are told differently
//
// The **parent** is told by SMS. They are not a `User` — a parent reaches the
// portal by holding a pay token, and `Notification.userId` is a required
// reference to `User` — so there is no inbox row to write. An SMS is also the
// channel that works: it arrives on the handset that made the payment, and it
// says what happened without the parent having to open anything.
//
// The **school** is told by an in-app `Notification`. The staff of a school are
// `User`s with a `school_admin` or `accountant` role, and the notification
// bell is already in their top bar. The `payment.received` type has been
// declared in the notification vocabulary since the beginning and has never
// been written — this is the writer.
//
// ## Exactly once
//
// Every message here is sent under a claim taken by a conditional update on
// the payment (`notification.sentAt: null` → a timestamp). A gateway that is
// not answered retries, and a settlement whose balance step failed is
// released so the retry can redo it — so without the claim a parent could
// receive two receipts for one payment. The claim is what makes "the parent
// is told" a fact rather than a hope.
import { Payment } from "../models/paymentModel.js";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import { User } from "../models/userModel.js";
import { Notification } from "../models/Notification.js";
import { NOTIFICATION_TYPES } from "../config/constants.js";
import { sendSms } from "../utils/smsService.js";
import { toCedis } from "../utils/formatters.js";

/**
 * The parent on file for a student.
 *
 * The same resolver appears in five modules in this codebase, identically:
 * the primary parent, or the first one if none was marked primary. A payment
 * notification is not the place to have a sixth, different rule.
 */
const getPrimaryParent = (student) =>
  (student?.parents || []).find((p) => p.isPrimary) || student?.parents?.[0] || null;

/**
 * Who at a school hears about money arriving.
 *
 * `User.status` is `"active"`, not `isActive` — the field name differs from
 * most of this codebase, and a query for a field that does not exist does not
 * throw, it simply matches nobody. That failure is silent: the payment is
 * recorded and no human is ever told.
 *
 * `school_admin` and `accountant` because both are the people who answer a
 * fee question. A teacher has no business acting on a payment.
 */
const findSchoolRecipients = (schoolId) =>
  User.find({
    schoolId,
    role: { $in: ["school_admin", "accountant"] },
    status: "active",
    deletedAt: null,
  })
    .select("phone schoolId")
    .lean();

/**
 * Claims the right to notify for this payment.
 *
 * A conditional update — `notification.sentAt: null` — so two concurrent
 * settlements of the same payment cannot both win. This is the same shape as
 * `claimPaymentSettlement`, and for the same reason: the provider retries
 * until it is answered, and the same "payment succeeded" callback routinely
 * arrives two or three times.
 *
 * @returns {Promise<boolean>} true when this caller won the claim
 */
export const claimPaymentNotification = async (paymentId) => {
  const claim = await Payment.findOneAndUpdate(
    { _id: paymentId, "notification.sentAt": null },
    { $set: { "notification.sentAt": new Date() } },
    { returnDocument: "after" }
  );

  return Boolean(claim);
};

/**
 * The number a receipt goes to.
 *
 * The **payer's** number, not the parent's on file. The person in the portal
 * is the one who handed over the money, and the portal promises them "a
 * receipt has been sent to your phone by SMS" — which has to be the phone
 * they paid from, or the promise is false.
 *
 * A desk payment has no payer number, so it falls back to the parent on file,
 * which is the only address there is.
 */
const resolveReceiptNumber = (payment, student) => {
  const payer = String(payment?.momoPhoneNumber || "").trim();
  if (payer) return payer;
  return getPrimaryParent(student)?.phone || null;
};

/**
 * The receipt SMS to the parent.
 *
 * Short on purpose: a long receipt is a segmented SMS, and a segmented SMS
 * costs the school money and arrives as several messages on a phone the
 * parent is reading over someone's shoulder.
 */
const buildReceiptMessage = ({ school, student, payment, amountCedis }) =>
  `${school?.name || "SukuuPay"}: payment of GHS ${amountCedis} received for ` +
  `${student?.studentName || "your child"}. Balance now GHS ${toCedis(student?.balance)}. ` +
  `Ref ${payment?.paymentId || payment?.reference || ""}. Thank you.`;

/**
 * The rails a receipt can go out on, in the order they are tried.
 *
 * There is more than one, and they are not interchangeable in practice: a
 * school's SMS provider and its payment gateway are **separate accounts**,
 * with separate balances and separate approvals, and either can be the one
 * that is unusable on a given day.
 *
 *   1. **The school's own SMS provider.** It is the account the school set
 *      up, and the one every other message to that family has gone over.
 *   2. **The gateway the payment came in on.** A payment taken through Moolre
 *      is receipted over the same wallet, with the same approved sender ID.
 *
 * The first one that accepts carries the receipt. A receipt that is never
 * sent is a family who think the school has lost their money, so a rail that
 * is merely out of credit should not be the end of the attempt — the other
 * rail may be perfectly healthy.
 *
 * The duplicate risk is accepted and bounded: the fallback only runs when the
 * first rail **explicitly rejected** the message, not when it merely timed
 * out after accepting it — the one case where a second send would bill the
 * family twice for the same receipt.
 */
const resolveReceiptRails = (payment, school) => {
  const rails = [];
  const schoolProvider = school?.sms?.provider;
  if (schoolProvider) {
    rails.push({ provider: schoolProvider, school });
  }

  const gateway = String(payment?.provider || "").toLowerCase();
  if (gateway && gateway !== "manual" && gateway !== schoolProvider) {
    rails.push({
      provider: gateway,
      school: { ...(school || {}), sms: { ...(school?.sms || {}), provider: gateway } },
    });
  }

  return rails;
};

/**
 * True when a failure leaves it open whether the message was delivered.
 *
 * Both providers say so in the failure text, and that text is the only signal
 * there is: a timeout is not a rejection, and treating it as one is how a
 * family ends up with two receipts for one payment.
 */
const isPossiblyAccepted = (reason) =>
  /may or may not have been accepted|may have been delivered|timed out/i.test(String(reason || ""));

/**
 * Sends the receipt to the parent.
 *
 * `sendSms` never throws — it reports the failure in its return value — so
 * this cannot abort a settlement that has already moved the money.
 */
const sendParentReceipt = async ({ payment, student, school }) => {
  const to = resolveReceiptNumber(payment, student);
  if (!to) return { sent: false, reason: "No number on file for the payer" };

  const message = buildReceiptMessage({
    school,
    student,
    payment,
    amountCedis: toCedis(payment.amount),
  });

  const rails = resolveReceiptRails(payment, school);
  const attempts = [];

  for (const rail of rails) {
    const result = await sendSms({
      to,
      message,
      school: rail.school,
      purpose: "payment_receipt",
      studentId: payment.studentId,
      parentName: getPrimaryParent(student)?.parentName || "",
    });

    if (result?.sent) {
      return {
        sent: true,
        reason: null,
        provider: result.provider || rail.provider,
        attempts,
      };
    }

    attempts.push({
      provider: result?.provider || rail.provider,
      reason: result?.reason || "unknown reason",
    });

    // A timeout is not a rejection. The gateway may have accepted the message
    // and lost the answer, and a second rail would then deliver the same
    // receipt twice — a family told twice, and billed twice for the platform
    // to tell them. The providers say so in the failure text, and that text is
    // the only signal there is.
    if (isPossiblyAccepted(result?.reason)) {
      return {
        sent: false,
        reason:
          `${result?.provider || rail.provider} did not confirm the send: ` +
          `${result?.reason || "unknown reason"} — the message may have been delivered.`,
        provider: result?.provider || rail.provider,
        attempts,
      };
    }
  }

  return {
    sent: false,
    reason: attempts.map((a) => `${a.provider}: ${a.reason}`).join("; ") || "no SMS rail available",
    provider: attempts.length ? attempts[attempts.length - 1].provider : null,
    attempts,
  };
};

/**
 * Writes one notification per member of staff who handles fees.
 *
 * `Notification.userId` is `required` and indexed: this collection is a
 * personal inbox, not a school-wide board, so one row per admin is the only
 * shape the schema admits.
 *
 * The message is capped at 500 characters by the schema, and the full detail
 * goes into `meta`, which is unbounded — a bursar opening the notification
 * reads the whole thing.
 */
const notifySchoolStaff = async ({ payment, student, school, receipt }) => {
  const recipients = await findSchoolRecipients(payment.schoolId);
  if (!recipients.length) return { written: 0 };

  const amountCedis = toCedis(payment.amount);
  const studentName = student?.studentName || "A student";
  const reference = payment.paymentId || payment.reference || "";

  // When the receipt SMS did not go out, the school is told about **that** as
  // well as about the payment.
  //
  // The silent failure this prevents is the one that matters: the payment is
  // recorded, the portal shows the receipt, and everyone believes the parent
  // was told — because the code never said otherwise. The parent is left
  // believing the school has no record of it. A bursar who sees "the receipt
  // could not be sent" can hand the family a printed receipt; a bursar who
  // sees nothing cannot.
  const receiptFailed = receipt && receipt.sent === false;
  const receiptNote = receiptFailed
    ? ` The receipt SMS could not be sent to the parent (${receipt.reason || "unknown reason"}).`
    : "";

  const rows = recipients.map((admin) => ({
    userId: admin._id,
    schoolId: admin.schoolId,
    type: NOTIFICATION_TYPES.PAYMENT_RECEIVED,
    title: `Payment received — ${studentName}`,
    message:
      `GHS ${amountCedis} received for ${studentName}` +
      (student?.studentClass ? ` (${student.studentClass})` : "") +
      `. Reference ${reference}.` +
      receiptNote,
    link: "/dashboard/payments",
    meta: {
      paymentId: payment.paymentId,
      paymentRef: String(payment._id),
      reference: payment.reference || null,
      studentRef: student?.studentId || null,
      studentName,
      studentClass: student?.studentClass || null,
      amount: Math.round(Number(payment.amount) || 0),
      amountCedis: Number(amountCedis),
      balance: student?.balance ?? null,
      paidVia: payment.paymentMethod || null,
      payerPhone: payment.momoPhoneNumber || null,
      schoolName: school?.name || null,
      // Whether the parent was actually told, and by which rail. A bursar
      // asking "did the family get it?" has an answer here.
      receiptSent: receipt ? Boolean(receipt.sent) : null,
      receiptProvider: receipt?.provider || null,
      receiptReason: receipt?.reason || null,
    },
  }));

  try {
    const result = await Notification.insertMany(rows, { ordered: false });
    return { written: result.length };
  } catch (error) {
    // The payment is already recorded on the school's Payments screen.
    // Re-throw so the caller can record the failure honestly instead of
    // telling the school the in-app alert was written when it wasn't.
    throw error;
  }
};

/**
 * Tells the parent and the school that a payment has settled.
 *
 * Both channels are best-effort and neither can abort the other: the money has
 * already moved by the time this runs, and a school whose SMS provider is
 * having a bad afternoon still needs the payment recorded.
 *
 * The claim is taken **first**, before anything is sent. A failure after the
 * claim is a message that is not sent — which is the lesser evil, because the
 * alternative is a retry that sends it twice.
 *
 * It runs **after** the balance has moved, so the balance quoted in the
 * receipt is the balance the parent now has.
 *
 * ## It refuses to announce a payment that did not settle
 *
 * The check is on `settlement.appliedAt`, which the settlement claim sets
 * before the balance moves. A payment that never settled — an abandoned
 * verification prompt, a gateway callback that never arrived — has no claim,
 * and a receipt for it tells a family that money arrived when it did not.
 *
 * That is not a hypothetical: a parent who starts a payment and walks away
 * leaves a `processing` payment behind, and every one of them is a payment
 * this must stay silent about.
 *
 * @param {import('mongoose').Document} payment a saved, `completed` Payment
 * @returns {Promise<{claimed: boolean, parent: object, school: object}>}
 */
export const notifyPaymentSettled = async (payment) => {
  // Nothing is claimed and nothing is sent. A receipt is a statement about
  // money, and this one would be false.
  if (!payment?.settlement?.appliedAt) {
    console.warn(
      `[PAY-NOTIFY] Refusing to announce ${payment?.paymentId || payment?._id}: the settlement was never applied.`
    );
    return {
      claimed: false,
      parent: { sent: false, reason: "The payment has not settled" },
      school: { written: 0 },
    };
  }

  const claimed = await claimPaymentNotification(payment._id);
  if (!claimed) {
    // Already told. A duplicate receipt SMS is worse than no receipt SMS.
    return { claimed: false, parent: { sent: false }, school: { written: 0 } };
  }

  const [student, school] = await Promise.all([
    Student.findById(payment.studentId).lean(),
    School.findById(payment.schoolId).lean(),
  ]);

  const parent = await sendParentReceipt({ payment, student, school });
  let schoolResult = { written: 0, notificationError: null };
  try {
    schoolResult = await notifySchoolStaff({ payment, student, school, receipt: parent });
  } catch (error) {
    schoolResult.notificationError = error.message;
    console.error(
      `[PAY-NOTIFY] In-app alert write failed for ${payment.paymentId}:`,
      error.message
    );
  }

  // Record what was actually delivered, on the payment itself, so a school
  // asking "did the family get the receipt?" has an answer that is not a
  // guess. It is written after the fact and never gates anything: a payment
  // that was made is a payment that was made, whether or not a message went
  // out afterwards.
  try {
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          "notification.channels": [
            ...(parent.sent ? ["sms"] : []),
            ...(schoolResult.written ? ["in_app"] : []),
          ],
        },
      }
    );
  } catch (error) {
    console.error(
      `[PAY-NOTIFY] Could not record the notification channels for ${payment.paymentId}:`,
      error.message
    );
  }

  if (!parent.sent) {
    // Loud, because this is the failure that used to be invisible. A parent who
    // was not told is a family who think the school has lost their money.
    console.error(
      `[PAY-NOTIFY] The receipt for ${payment.paymentId} was NOT sent to the parent:`,
      parent.reason || "unknown reason"
    );
  }

  return { claimed: true, parent, school: schoolResult };
};

export default { notifyPaymentSettled, claimPaymentNotification };
