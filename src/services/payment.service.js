import mongoose from "mongoose";
import { Payment } from "../models/paymentModel.js";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import { PaymentPlan } from "../models/paymentPlanModel.js";
import { buildPayLink } from "../utils/generatePayLink.js";
import { nextReceiptNumber } from "../utils/receiptNumber.js";
import { applyCompletedPaymentToPlan } from "./paymentPlan.service.js";
// The balance movement, the school stat and the platform ledger entry. Imported
// from its own module so the two webhook paths below do not each grow their own
// copy — see `paymentApplication.service.js` for what that copy was missing.
import { settlePayment } from "./paymentApplication.service.js";
// The parent-safe projection for everything a pay link may read. Imported here so
// the public read model lives in one module rather than being assembled in both.
import { getPortalView } from "./pay.service.js";
import {
  requestToPay as mtnRequestToPay,
  getTransactionStatus as mtnGetTransactionStatus,
  normaliseTransaction,
  mapMtnStatus,
  isAccountActive as mtnIsAccountActive,
  MtnTransportError,
} from "../utils/mtnApi.js";
import { resolveGateway } from "../utils/paymentGateway.js";
import {
  initiatePayment as moolreInitiatePayment,
  verifyTransaction as moolreVerifyTransaction,
  createCheckoutSession as moolreCreateCheckoutSession,
  normaliseChannel as moolreNormaliseChannel,
  channelLabel as moolreChannelLabel,
  MoolreTransportError,
} from "../utils/moolreClient.js";
import { escapeRegExp } from "../utils/generateStudentId.js";
import { generatePaymentReference } from "../utils/paymentReference.js";
import { PORTAL_NETWORK_ALIASES } from "../validations/payment.validation.js";
import { startOfDayAccra, endOfDayAccra } from "../utils/dateHelpers.js";
import { PAY_LINK_BASE_URL, MOOLRE_CALLBACK_URL, MOOLRE_CALLBACK_SECRET } from "../config/env.js";

class ApiError extends Error {
  constructor(message, status = 500, code = "INTERNAL_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

const auditService = {
  log: async ({ action, entity, entityId, userId, details }) => {
    console.log(`[AUDIT] ${action} | ${entity}:${entityId} | User:${userId} |`, details);
  },
};

const fetchSchool = async (schoolId) => {
  const school = await School.findById(schoolId)
    // `email` is the school's business address, which Moolre requires on a
    // hosted checkout page. It is the receipt address there too.
    .select("schoolCode slug name email payment")
    .lean();
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");
  return school;
};

// ──────────────────── Gateway selection ────────────────────
// Moolre is the primary gateway. Selection lives in utils/paymentGateway.js so
// the plan-prepay path can share it without importing this module (the two
// already import each other).

/**
 * Maps a portal network name onto the payment model's `momoNetwork` enum.
 *
 * The same lookup `pay.service.resolveNetwork` applies, so there is one
 * implementation: a parent who picked "Telecel Cash" and an admin who picked
 * "VODAFONE" end up as the same stored value, and the gateway is handed a
 * network it can route.
 *
 * An unrecognised name becomes `UNKNOWN` rather than throwing, because the
 * gateway can still resolve the real operator from the number's prefix.
 */
const resolveNetwork = (network) =>
  PORTAL_NETWORK_ALIASES[String(network || "UNKNOWN").toUpperCase()] || "UNKNOWN";

// ──────────────────── Public: Get student by pay token ────────────────────
/**
 * The public pay page's read model.
 *
 * Delegates to `pay.service.js` rather than projecting the Student document here.
 * The version this replaced did its own projection inline, and it had two problems
 * that only an allowlist structure avoids:
 *
 *   - It returned `id: student._id` — the Mongo id — on an endpoint with no
 *     authentication, which is a live handle on the collection to anyone holding a
 *     pay link.
 *   - It masked parent numbers with `phone.replace(/(\d{3})\d{4}(\d{2})/, ...)`,
 *     which is unanchored and assumes a ten-digit number. For the international
 *     forms this codebase explicitly accepts elsewhere — `233244123456` became
 *     `233****23456`, leaking eight of twelve digits; `00233244123456` leaked ten
 *     of fourteen. `phoneNumbers.phoneSearchCandidates` lists those spellings as
 *     ordinary, so a school with one on file was publishing it.
 *
 * `pay.service.js` builds the response from a fixed list of fields and masks with
 * a digit count rather than a pattern, so neither can regress by a field being
 * added to the model.
 *
 * `payLink` is still returned: the existing pay page and the school's copy-paste
 * tooling read it, and it is derivable from the token the caller already holds.
 */
export const getStudentByPayToken = async (token) => {
  const view = await getPortalView(token);
  return { ...view, payLink: buildPayLink(token) };
};

// ──────────────────── Public: Initiate payment ────────────────────

/**
 * The reference the parent portal shows and polls on.
 *
 * `SUK-<epoch ms>-<6 chars>`: the timestamp makes it sortable and roughly unique,
 * and the suffix removes the collision risk that a pure timestamp has — several
 * parents can tap "Pay" in the same millisecond on a busy morning, and this
 * endpoint's rate limit is per token, so two *different* tokens can easily be
 * initiated together.
 *
 * Uppercase alphanumerics only, because `payReferenceParamSchema` validates this
 * exact shape and a lowercase generator would produce a reference the portal's own
 * verify endpoint then rejects.
 */
export { generatePaymentReference } from "../utils/paymentReference.js";

/**
 * Starts a Mobile Money payment against a pay token.
 *
 * `data.feesBreakdown` is accepted from the caller and that is deliberate: it is
 * the split the parent was *shown*, and a parent who pays GH₵ 550 on a quote that
 * said GH₵ 558.25 must not be charged the difference discovered later. It is
 * bounded below by `platformMarkupPercent`'s own ceiling in the checkout flow, not
 * here, because this function has no idea what a school agreed to charge.
 *
 * The amount ceiling **is** checked here, against the student's live balance, and
 * not against anything the client sent or was shown. See `pay.service.js`'s
 * `validatePaymentRequest` for the same rule on the portal path.
 */
export const initiatePayment = async (token, data) => {
  const student = await Student.findOne({ uniquePayLinkToken: token, deletedAt: null });
  if (!student) {
    throw new ApiError("Invalid or expired payment link", 404, "INVALID_PAY_TOKEN");
  }

  if (student.status !== "active") {
    throw new ApiError("Student account is not active", 400, "STUDENT_NOT_ACTIVE");
  }

  const balance = Math.max(student.balance || 0, 0);

  if (balance <= 0) {
    throw new ApiError(
      "There is nothing outstanding to pay on this account",
      400,
      "NO_OUTSTANDING_BALANCE"
    );
  }

  const amount = Number(data.amount);

  // Refused rather than clamped. Clamping a parent's GH₵ 900 submission to the
  // GH₵ 550 outstanding would create a payment the parent did not authorise, and
  // the difference would sit on their receipt as a mystery credit.
  if (amount > balance) {
    throw new ApiError(
      `That is more than the amount outstanding. The balance is GHS ${(balance / 100).toFixed(2)}`,
      400,
      "AMOUNT_EXCEEDS_BALANCE"
    );
  }

  const school = await fetchSchool(student.schoolId);

  // The school is the other half of this payment: it holds the fee lines, the
  // gateway key and the receipt address. A student whose school cannot be
  // read cannot be paid, and saying so beats the `TypeError` that reading
  // `school.schoolCode` off a null would otherwise raise.
  if (!school) {
    throw new ApiError(
      "We could not find your school on this payment link. Please contact the school.",
      400,
      "SCHOOL_NOT_FOUND"
    );
  }

  // Find primary parent for contact info
  const primaryParent = (student.parents || []).find((p) => p.isPrimary) || student.parents?.[0];

  // `method`/`gateway` are resolved from the request when we are minting a
  // new payment. When an OTP code is being submitted we instead reuse the
  // in-flight payment that triggered the verification prompt: Moolre verifies
  // per transaction, so a freshly minted reference would never match the OTP
  // it sent, and the code would be rejected.
  let reusedPayment = null;
  if (data.otpCode) {
    // The client is asked to send the reference of the payment it is waiting
    // on. That names the transaction exactly, and it is the only lookup that
    // cannot drift: the amount and the number are re-sent by the client, and a
    // parent who edits either of them in the meantime would otherwise send
    // their code to a payment Moolre never issued it for.
    if (data.reference) {
      reusedPayment = await Payment.findOne({
        reference: data.reference,
        studentId: student._id,
        provider: "moolre",
        // A settled or failed payment is not waiting for a code, and a code
        // cannot revive it — so only a live one may be continued.
        status: { $in: ["pending", "processing"] },
        deletedAt: null,
      }).lean();
    }

    // No reference, or one that names nothing of this student's: fall back to
    // the newest pending payment for the same amount and the same number.
    if (!reusedPayment) {
      reusedPayment = await Payment.findOne({
        studentId: student._id,
        provider: "moolre",
        status: "pending",
        amount: Number(data.amount),
        momoPhoneNumber: data.phone || data.phoneNumber || primaryParent?.phone,
        deletedAt: null,
      })
        .sort({ createdAt: -1 })
        .lean();
    }
  }

  const method = reusedPayment
    ? reusedPayment.paymentMethod || "momo"
    : data.phone || data.phoneNumber
      ? "momo"
      : "card";
  const gateway = reusedPayment
    ? reusedPayment.provider || "moolre"
    : resolveGateway(school, method);

  // Stamp the plan this payment settles, when there is a live one.
  //
  // The webhook could look the plan up from the student instead, and did — which
  // meant a payment initiated *before* a plan was created was applied to that plan
  // when it settled, retroactively. Naming the plan at the moment the parent was
  // quoted keeps "which schedule was this money promised against" answered by the
  // intent at that moment.
  const livePlan = await PaymentPlan.findOne({
    studentId: student._id,
    planStatus: { $in: ["pending_acceptance", "active"] },
    deletedAt: null,
  }).select("_id");

  // Reuse the in-flight OTP-pending payment, or mint a new one.
  let payment;
  if (reusedPayment) {
    payment = await Payment.findById(reusedPayment._id);
  } else {
    payment = await Payment.create({
      studentId: student._id,
      schoolId: student.schoolId,
      parentId: primaryParent?._id || null,
      amount,
      currency: "GHS",
      status: "pending",
      paymentMethod: method,
      provider: gateway,
      // The portal sends `phone`/`network`; the admin flow sends
      // `phoneNumber`/`momoNetwork`. The route's schema accepts either, and this
      // is where the two are read — reading only the admin spelling meant the
      // parent's chosen network was dropped to `UNKNOWN` and the payer's number
      // silently fell back to the guardian on file, so the prompt went to the
      // wrong handset.
      momoPhoneNumber: data.phone || data.phoneNumber || primaryParent?.phone,
      // `resolveNetwork` maps the parent-facing spellings (`Telecel`,
      // `AirtelTigo`) onto the model's enum, so the network that reaches the
      // gateway is one it can route.
      momoNetwork: resolveNetwork(data.network || data.momoNetwork),
      description: data.description || `School fees payment for ${student.studentName}`,
      feesBreakdown: data.feesBreakdown || [],
      paymentPlanId: livePlan?._id || null,
      // The portal polls `GET /pay/:token/verify/:reference`, which resolves a row by
      // this value. `paymentId` is not usable for it: it is generated in a pre-save
      // hook, so it does not exist until after the document is written, and the
      // parent has the response long before any retry could look it up.
      reference: generatePaymentReference(),
      createdBy: student.createdBy,
    });
  }

  if (gateway === "moolre") {
    // A card payment has no USSD prompt to send: the parent completes it on
    // Moolre's own hosted checkout page, which is the one place card, bank
    // transfer and mobile money are all offered. The reference is still
    // unclaimed at this point, so it can be used as the checkout's
    // `externalref` — which the lazy fallback in `createMoolreCheckout` cannot
    // do, because the push has already claimed it by then.
    if (method === "card") {
      return initiateMoolreCheckout(payment, student, school, token);
    }

    return initiateMoolrePayment(payment, student, school, token, data.otpCode);
  }

  return initiateMtnPayment(payment, student, school, token);
};

// ──────────────────── MTN: initiate ────────────────────
/**
 * Charges the payer through MTN Collections (Request To Pay).
 *
 * The payer is prompted on their handset and authorises the debit; the money
 * only moves once they do, so the Payment stays `processing` until the callback
 * or a status poll settles it. `X-Reference-Id` is the paymentId, which makes a
 * client retry of the same payment replay rather than debit twice.
 */
const initiateMtnPayment = async (payment, student, school, token) => {
  const phone = payment.momoPhoneNumber;

  if (!phone) {
    payment.status = "failed";
    payment.failureReason = "No phone number on file for the payer";
    await payment.save();
    throw new ApiError(
      "No phone number on file for this payer",
      400,
      "PAYER_PHONE_MISSING"
    );
  }

  try {
    const result = await mtnRequestToPay({
      amount: payment.amount,
      phone,
      externalId: payment.paymentId,
      referenceId: payment.paymentId,
      payerMessage: `Payment for ${student.studentName}`,
      payeeNote: payment.description,
    });

    payment.status = "processing";
    payment.mtnReferenceId = result?.referenceId || null;
    payment.mtnResponseCode = String(result?.status || "").toUpperCase() || "PENDING";
    await payment.save();

    await auditService.log({
      action: "payment.initiate",
      entity: "Payment",
      entityId: payment._id,
      userId: student.createdBy,
      details: {
        paymentId: payment.paymentId,
        amount: payment.amount,
        studentId: student.studentId,
        provider: "mtn",
        referenceId: payment.mtnReferenceId,
      },
    });

    return {
      payment: payment.toJSON(),
      provider: "mtn",
      // The parent must authorise on their handset; there is no server-side
      // confirmation to wait for.
      requiresPayerApproval: true,
      mtn: {
        referenceId: payment.mtnReferenceId,
        status: payment.mtnResponseCode,
        payerPhone: phone,
      },
      payLink: buildPayLink(token),
    };
  } catch (error) {
    // A rejected initiation is terminal: no prompt was issued, so the payment
    // must not be left pending for a callback that will never arrive.
    payment.status = "failed";
    payment.mtnResponseMessage = error.message?.slice(0, 500) || "MTN request failed";
    await payment.save();

    if (error instanceof MtnTransportError) {
      throw new ApiError(error.message, error.status, error.code);
    }
    throw error;
  }
};

// ──────────────────── Moolre: initiate ────────────────────
/**
 * Starts a Moolre USSD push payment.
 *
 * The payer is prompted on their handset and authorises the debit; the money
 * only moves once they do, so the Payment stays `processing` until the
 * callback or a status poll settles it.
 *
 * The hosted-checkout URL is returned alongside the push, because the push can
 * fail to arrive: a parent on a handset that cannot receive a USSD prompt, or
 * one who dismisses it, has no way to pay. The fallback is one click away
 * rather than a support call.
 */
const initiateMoolrePayment = async (payment, student, school, token, otpCode) => {
  const phone = payment.momoPhoneNumber;

  if (!phone) {
    payment.status = "failed";
    payment.failureReason = "No phone number on file for the payer";
    await payment.save();
    throw new ApiError(
      "No phone number on file for this payer",
      400,
      "PAYER_PHONE_MISSING"
    );
  }

  // The network is stored on the Payment in this platform's vocabulary
  // (MTN / VODAFONE / AIRTELTELIGO / UNKNOWN). An UNKNOWN network cannot be
  // routed — Moolre would accept the request and then fail to deliver it to
  // any carrier — so it is refused here, where the parent can be told why.
  if (!payment.momoNetwork || payment.momoNetwork === "UNKNOWN") {
    payment.status = "failed";
    payment.failureReason = "No mobile money network selected for the payment";
    await payment.save();
    throw new ApiError(
      "Please choose the mobile money network you are paying from",
      400,
      "MOMO_NETWORK_REQUIRED"
    );
  }

  // The callback is where Moolre posts the transaction result. It comes from
  // the config rather than being built here, so a deployment behind a proxy
  // or a custom domain can point it at the right address with one env var.
  const callbackUrl = MOOLRE_CALLBACK_URL;

  try {
    const result = await moolreInitiatePayment({
      // Moolre takes cedis; this platform stores pesewas.
      amount: payment.amount / 100,
      phone,
      network: payment.momoNetwork,
      reference: payment.reference,
      description: payment.description || `Payment for ${student.studentName}`,
      otpCode,
    });

    // Moolre wants the payer's phone number verified before it will send the
    // prompt — it answers `TP14` and sends the parent an OTP by SMS. The
    // payment is **not** failed here: it is waiting for the parent to type
    // that code in. Marking it failed would tell the parent their payment
    // was declined when nothing has even been attempted yet.
    if (result?.status === "otp_required") {
      payment.status = "pending";
      payment.moolreReference = payment.reference;
      payment.moolreChannel = moolreNormaliseChannel(payment.momoNetwork);
      payment.moolreResponseMessage =
        result?.message?.slice(0, 500) || "Phone number verification required";
      await payment.save();

      return {
        payment: payment.toJSON(),
        provider: "moolre",
        // The parent has to enter the code Moolre sent them before the prompt
        // can be sent at all.
        requiresOtp: true,
        otpRequired: true,
        moolre: {
          reference: payment.reference,
          channel: payment.moolreChannel,
          payerPhone: phone,
        },
        payLink: buildPayLink(token),
      };
    }

    payment.status = "processing";
    payment.moolreReference = payment.reference;
    payment.moolreTransactionId = result?.transactionId || result?.transactionid || null;
    payment.moolreChannel = moolreNormaliseChannel(payment.momoNetwork);
    await payment.save();

    await auditService.log({
      action: "payment.initiate",
      entity: "Payment",
      entityId: payment._id,
      userId: student.createdBy,
      details: {
        paymentId: payment.paymentId,
        amount: payment.amount,
        studentId: student.studentId,
        provider: "moolre",
        reference: payment.reference,
        // The channel code Moolre was given, and the network it means — an
        // audit line is read by a person, and "13" is not a network.
        channel: payment.moolreChannel,
        network: moolreChannelLabel(payment.momoNetwork),
      },
    });

    return {
      payment: payment.toJSON(),
      provider: "moolre",
      // The parent must authorise on their handset; there is no server-side
      // confirmation to wait for.
      requiresPayerApproval: true,
      moolre: {
        reference: payment.reference,
        channel: payment.moolreChannel,
        payerPhone: phone,
      },
      payLink: buildPayLink(token),
    };
  } catch (error) {
    // A rejected initiation is terminal: no prompt was issued, so the payment
    // must not be left pending for a callback that will never arrive.
    payment.status = "failed";
    payment.moolreResponseMessage = error.message?.slice(0, 500) || "Moolre request failed";
    await payment.save();

    if (error instanceof MoolreTransportError) {
      throw new ApiError(error.message, error.status, error.code);
    }
    throw error;
  }
};

// ──────────────────── Moolre: hosted checkout ────────────────────
/**
 * Opens Moolre's hosted checkout for a payment that is not a USSD push.
 *
 * The hosted page belongs to Moolre: the parent picks a card, a bank transfer
 * or a mobile money network on it, and the money settles through the same
 * wallet the USSD push settles through. It is the only payment page this
 * platform offers, so it is what the card path runs on.
 *
 * **The reference is free here.** Moolre requires `externalref` to be unique,
 * and the USSD push claims the payment's reference by sending it to the
 * carrier. A checkout opened at initiation has not done that, so the payment's
 * own reference can be used — which means the checkout settles the same
 * Payment record that the callback will post to.
 *
 * The payment goes to `processing` rather than `pending`: the page is open and
 * the parent is on it, so there is nothing left to send. It settles when
 * Moolre's callback arrives, or when the parent's browser polls.
 */
const initiateMoolreCheckout = async (payment, student, school, token) => {
  try {
    const session = await moolreCreateCheckoutSession({
      // Moolre takes cedis; this platform stores pesewas.
      amount: payment.amount / 100,
      reference: payment.reference,
      redirectUrl: `${PAY_LINK_BASE_URL}/pay/${token}`,
      // Moolre requires a business address on the link. The school's is the
      // right one; the platform address is the fallback for a school that has
      // none on file.
      email: school?.email || undefined,
      // The hosted checkout settles the same payment the push would have, so it
      // posts to the same callback.
      callbackUrl: MOOLRE_CALLBACK_URL,
    });

    payment.status = "processing";
    payment.moolreReference = payment.reference;
    await payment.save();

    await auditService.log({
      action: "payment.initiate",
      entity: "Payment",
      entityId: payment._id,
      userId: student.createdBy,
      details: {
        paymentId: payment.paymentId,
        amount: payment.amount,
        studentId: student.studentId,
        provider: "moolre",
        method: "card",
        reference: payment.reference,
      },
    });

    return {
      payment: payment.toJSON(),
      provider: "moolre",
      // The parent still has to approve the payment — on Moolre's page this
      // time, not on their handset.
      requiresPayerApproval: true,
      checkoutUrl: session.checkoutUrl,
      moolre: {
        reference: payment.reference,
        checkoutUrl: session.checkoutUrl,
      },
      payLink: buildPayLink(token),
    };
  } catch (error) {
    // No checkout page was opened, so nothing is in flight: the payment must
    // not be left pending for a callback that will never arrive.
    payment.status = "failed";
    payment.moolreResponseMessage = error.message?.slice(0, 500) || "Moolre checkout failed";
    await payment.save();

    if (error instanceof MoolreTransportError) {
      throw new ApiError(error.message, error.status, error.code);
    }
    throw error;
  }
};

/**
 * Creates the hosted-checkout URL for a payment that is already in flight.
 *
 * This is the fallback for a parent whose handset never received the USSD
 * prompt — the phone is off, out of credit, or on a network that does not
 * carry the prompt. Without it, that parent has no way to pay at all.
 *
 * **It is a separate call, not part of initiation, for a concrete reason:**
 * Moolre requires `externalref` to be unique, and the USSD push has already
 * consumed this payment's reference. Creating the link during initiation
 * would be rejected as a duplicate — and doing it lazily, only when the parent
 * asks for it, means no payment pays for a checkout link it never uses.
 *
 * The link is created against the same payment, so the callback it produces
 * settles the same Payment record.
 */
export const createMoolreCheckout = async (token, reference) => {
  const student = await Student.findOne({ uniquePayLinkToken: token, deletedAt: null });
  if (!student) {
    throw new ApiError("Invalid or expired payment link", 404, "INVALID_TOKEN");
  }

  const payment = await Payment.findOne({
    reference: String(reference || ""),
    studentId: student._id,
    deletedAt: null,
  });

  if (!payment) {
    throw new ApiError("We could not find that payment on this link.", 404, "PAYMENT_NOT_FOUND");
  }

  if (payment.status === "completed") {
    throw new ApiError("That payment has already been completed.", 409, "PAYMENT_ALREADY_COMPLETED");
  }

  const school = await School.findById(student.schoolId).lean();

  const session = await moolreCreateCheckoutSession({
    amount: payment.amount / 100,
    reference: payment.reference,
    redirectUrl: `${PAY_LINK_BASE_URL}/pay/${token}`,
    // Moolre requires a business address on the link. The school's is the
    // right one; the platform address is the fallback for a school that has
    // none on file.
    email: school?.email || undefined,
    // The hosted checkout settles the same payment the push would have, so it
    // posts to the same callback.
    callbackUrl: MOOLRE_CALLBACK_URL,
  });

  return {
    checkoutUrl: session.checkoutUrl,
    reference: session.reference || payment.reference,
    expiresInMinutes: 60,
  };
};

// ──────────────────── Public: Verify payment ────────────────────
export const verifyPayment = async (token, data) => {
  const student = await Student.findOne({ uniquePayLinkToken: token, deletedAt: null });
  if (!student) {
    throw new ApiError("Invalid or expired payment link", 404, "INVALID_PAY_TOKEN");
  }

  // Find the most recent pending/processing payment for this student
  const filter = {
    studentId: student._id,
    status: { $in: ["pending", "processing"] },
  };

  // The portal polls on the reference it was given at initiation. Pinning the
  // poll to it matters once a parent has two payments in flight — the "most
  // recent" rule would otherwise answer for the wrong one, and the sheet would
  // report on a payment that is not the one being waited on.
  if (data.reference) filter.reference = String(data.reference);

  if (data.mtnReferenceId) filter.mtnReferenceId = data.mtnReferenceId;

  const payment = await Payment.findOne(filter).sort({ createdAt: -1 });
  if (!payment) {
    throw new ApiError("No pending payment found for verification", 404, "PAYMENT_NOT_FOUND");
  }

  // An MTN payment is settled by polling the provider's status endpoint, which
  // is the system of record — the callback is only a notification. Polling here
  // lets the parent's browser confirm a prompt they have already approved.
  if (payment.provider === "mtn" && payment.mtnReferenceId) {
    try {
      const raw = await mtnGetTransactionStatus(payment.mtnReferenceId);
      const transaction = normaliseTransaction(raw);
      const mapped = mapMtnStatus(transaction?.status);
      if (mapped && mapped !== payment.status) {
        await applyMtnStatus(payment, transaction, mapped);
        return payment.toJSON();
      }
    } catch (error) {
      console.error(`[MTN] Status poll failed for ${payment.paymentId}:`, error.message);
    }
    return payment.toJSON();
  }

  // A Moolre payment is settled by polling Moolre's status endpoint, which is
  // the system of record — the callback is only a notification. Polling here
  // lets the parent's browser confirm a prompt they have already approved,
  // even when the callback was lost.
  if (payment.provider === "moolre") {
    try {
      const verification = await moolreVerifyTransaction({
        reference: payment.reference || payment.moolreReference,
      });
      const mapped = mapMoolreStatus(verification.status);
      if (mapped && mapped !== payment.status) {
        await applyMoolreStatus(payment, verification, mapped);
        return payment.toJSON();
      }
    } catch (error) {
      console.error(`[MOOLRE] Verify failed for ${payment.paymentId}:`, error.message);
    }
    return payment.toJSON();
  }

  return payment.toJSON();
};

/**
 * Polls the gateway for a pending payment and applies the result.
 *
 * **The callback is a notification; the gateway is the system of record.**
 * A parent's browser polls while they approve a prompt on their handset, and
 * the portal's own poll window is short. If the callback is late — or lost —
 * the parent sees a failure for a payment that actually succeeded, which is
 * the worst possible outcome: they pay again, and the school collects twice.
 *
 * So the poller asks the gateway directly, and settles on a confirmed success.
 * The settlement goes through the same claim-and-settle path the callback
 * uses, so a payment that settles by poll and then by callback is still
 * credited exactly once.
 *
 * Returns `true` when the payment's status changed, so the caller can re-read
 * it.
 */
export const refreshPendingPayment = async (token, reference) => {
  const student = await Student.findOne({ uniquePayLinkToken: token, deletedAt: null });
  if (!student) return false;

  const payment = await Payment.findOne({
    reference: String(reference || ""),
    studentId: student._id,
    deletedAt: null,
  });

  if (!payment) return false;
  if (payment.status !== "pending" && payment.status !== "processing") return false;

  if (payment.provider === "moolre") {
    try {
      const verification = await moolreVerifyTransaction({
        reference: payment.reference || payment.moolreReference,
      });
      const mapped = mapMoolreStatus(verification.status);
      if (mapped && mapped !== payment.status) {
        await applyMoolreStatus(payment, verification, mapped);
        return true;
      }
    } catch (error) {
      // A failed poll is not a failed payment. The callback may still arrive.
      console.error(`[MOOLRE] Status poll failed for ${payment.paymentId}:`, error.message);
    }
    return false;
  }

  if (payment.provider === "mtn" && payment.mtnReferenceId) {
    try {
      const raw = await mtnGetTransactionStatus(payment.mtnReferenceId);
      const transaction = normaliseTransaction(raw);
      const mapped = mapMtnStatus(transaction?.status);
      if (mapped && mapped !== payment.status) {
        await applyMtnStatus(payment, transaction, mapped);
        return true;
      }
    } catch (error) {
      console.error(`[MTN] Status poll failed for ${payment.paymentId}:`, error.message);
    }
    return false;
  }

  return false;
};

// ──────────────────── Public: Get receipt ────────────────────
export const getReceipt = async (token, paymentId) => {
  const student = await Student.findOne({ uniquePayLinkToken: token, deletedAt: null });
  if (!student) {
    throw new ApiError("Invalid or expired payment link", 404, "INVALID_PAY_TOKEN");
  }

  const payment = await Payment.findOne({
    paymentId,
    studentId: student._id,
    status: "completed",
  });

  if (!payment) {
    throw new ApiError("Receipt not found", 404, "RECEIPT_NOT_FOUND");
  }

  const school = await fetchSchool(student.schoolId);

  return {
    receipt: {
      receiptNumber: payment.receiptNumber,
      paymentId: payment.paymentId,
      reference: payment.reference,
      date: payment.completedAt,
      student: {
        studentId: student.studentId,
        studentName: student.studentName,
        studentClass: student.studentClass,
      },
      school: {
        name: school.name,
        schoolCode: school.schoolCode,
        address: school.address,
        city: school.city,
        region: school.region,
      },
      amount: payment.amount,
      currency: payment.currency,
      paymentMethod: payment.paymentMethod,
      description: payment.description,
      feesBreakdown: payment.feesBreakdown,
    },
  };
};

// ──────────────────── Shared filter ────────────────────

/** Human names for the `momoNetwork` enum, and the labels the summary sorts by. */
const NETWORK_ORDER = ["MTN", "VODAFONE", "AIRTELTELIGO", "UNKNOWN"];
const NETWORK_LABELS = {
  MTN: "MTN MoMo",
  // `VODAFONE` is the stored value and `Vodafone Cash` the real product. This
  // said "Telecel Cash", which is a different Ghanaian network — Vodafone
  // Red/Vodafone Cash and Telecel Cash are separate brands with separate
  // shortcodes, and a bursar reconciling a Vodafone charge against a statement
  // line labelled "Telecel" has been handed a contradiction by the app.
  VODAFONE: "Vodafone Cash",
  AIRTELTELIGO: "AT Money",
  UNKNOWN: "Unidentified",
};

/** Human names for the `paymentMethod` enum. */
const METHOD_LABELS = {
  momo: "Mobile Money",
  cash: "Cash",
  card: "Card",
  bank_transfer: "Bank transfer",
  unknown: "Unknown",
};

/**
 * The one filter behind the payments list, the dashboard summary and the CSV
 * export.
 *
 * Extracted for the same reason `student.service.js` extracted
 * `buildRosterFilter`: the list and the export each rebuilt the filter
 * independently and drifted, so "export what I am looking at" returned a
 * different set of rows than the screen it was exported from. Here there are
 * three readers, and a filter added to one and forgotten in the other two is a
 * report that quietly disagrees with the table above it. The school scope is
 * returned alongside the filter because the export needs it for the filename.
 */
const buildPaymentFilter = async (query, user) => {
  // Unchanged from the inline filter this replaces. A `super_admin` may act
  // inside a named school; every other user is confined to their own, and a user
  // with no school is never given a scope rather than being handed one by a
  // query parameter they supplied themselves.
  const schoolId = user.role === "super_admin" && query.schoolId
    ? new mongoose.Types.ObjectId(query.schoolId)
    : user.schoolId
      ? new mongoose.Types.ObjectId(user.schoolId)
      : null;

  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const filter = { schoolId, deletedAt: null };
  if (query.status && query.status !== "all") filter.status = query.status;
  if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
  if (query.provider) filter.provider = query.provider;
  // Collected rather than assigned, because `search` also needs an `$or` and two
  // separate assignments to `filter.$or` mean whichever is written second silently
  // wins. That is not hypothetical: `filter.$or` was assigned for `UNKNOWN` and
  // again for `search`, so filtering "Unidentified" and typing a receipt number
  // together dropped the network half and showed every network. One `$or`, both
  // sets of clauses, `$and`-ed together.
const orClauses = [];

  if (query.network) {
    // `UNKNOWN` is a *bucket*, not a stored value.
    //
    // `getPaymentSummary` groups by network with
    // `$ifNull: ["$momoNetwork", "UNKNOWN"]`, so cash, card and hand-recorded rows
    // land in its "Unidentified" tile with a count and a share — which is what
    // makes the filter bar offer it as a chip. The list filter was an exact
    // `momoNetwork` match, so selecting that chip returned an empty table under a
    // heading that said there were payments in it. The two surfaces have to agree
    // on what `UNKNOWN` means, so this expands it to the rows that actually fall
    // into it: a null, missing, or literally-`UNKNOWN` network.
    if (query.network === "UNKNOWN") {
      orClauses.push({ momoNetwork: null }, { momoNetwork: "UNKNOWN" });
    } else {
      filter.momoNetwork = query.network;
    }
  }

  if (query.startDate || query.endDate) {
    filter.createdAt = {};
    if (query.startDate) filter.createdAt.$gte = startOfDayAccra(query.startDate);
    // Snapped to the end of the day, not passed through as `new Date(endDate)`.
    //
    // `?endDate=2026-09-30` is `2026-09-30T00:00:00Z`, which excludes every
    // payment made on the 30th — so "This month" on 30 September excluded
    // today, and a bursar reconciling the last day of term could not see it.
    // Worse, it disagreed with the summary: `getPaymentSummary` snapped the same
    // window with `endOfDayAccra`, so the KPI band above the table could report
    // an inflow the table below it had no rows for. Two endpoints reading one
    // query parameter are one definition of a date range, and that definition is
    // an inclusive calendar day in Accra.
    if (query.endDate) filter.createdAt.$lte = endOfDayAccra(query.endDate);
  }

  if (query.minAmount || query.maxAmount) {
    filter.amount = {};
    if (query.minAmount) filter.amount.$gte = query.minAmount;
    if (query.maxAmount) filter.amount.$lte = query.maxAmount;
  }

  // ── The student-side conditions ──
  // `class` and the student half of `search` are properties of the *Student*
  // document; a Payment stores no copy of `studentClass` or `studentName`, so
  // there is nothing on this collection to match them against. They are resolved
  // to the matching student `_id`s here and applied as `studentId: { $in: ids }`
  // — the same shape `reports.service.js` uses in its `classScope`, so a
  // payments table filtered to "JHS 2" and a JHS 2 report cover the same rows.
  //
  // All three conditions (an explicit `studentId`, `class`, `search`) go into one
  // Student query and one `$in`. Resolving them separately and merging the id
  // lists afterwards would have taken the union, so "class JHS 2 AND search
  // Ama" would have returned every payment for any student in the school.
  const studentMatch = {};
  if (query.studentId) studentMatch._id = new mongoose.Types.ObjectId(query.studentId);
  if (query.class) studentMatch.studentClass = query.class;

  // The search term is escaped before it reaches `$regex`. It used to be spliced
  // in raw, so `?search=.*` matched every payment in the school and `?search=[`
  // threw a driver error that surfaced as a 500 — a search box is an injection
  // point until it is escaped, and escaping also makes it the literal substring
  // search a user typing into one actually expects.
  const searchTerm = query.search ? escapeRegExp(String(query.search).trim()) : "";
  if (searchTerm) {
    const rx = { $regex: searchTerm, $options: "i" };
    studentMatch.$or = [{ studentName: rx }, { studentId: rx }];
  }

  let studentIds = null;
  if (Object.keys(studentMatch).length > 0) {
    // `deletedAt: null` matches `classScope`: an archived student is not "in"
    // any class, so their payments are not reachable through the student side
    // of a filter. The list without a student-side filter still shows them —
    // a payment is never hidden by the archiving of the student it paid for.
    studentIds = (
      await Student.find({ schoolId, deletedAt: null, ...studentMatch })
        .select("_id")
        .lean()
    ).map((s) => s._id);
    filter.studentId = { $in: studentIds };
  }

  // `searchTerm`, not `query.search`: the schema allows `?search=` and the
  // query string can carry a lone space, and an empty `$regex` matches every
  // document — so a whitespace-only search box would have silently turned the
  // filter off's opposite, listing the whole school. No term means no `$or`,
  // which is the same rule `searchClause` applies in `student.service.js`.
  if (searchTerm) {
    // The payment-side fields first — the transaction refs a bursar is actually
    // pasted in from a receipt or a gateway dashboard — then the students whose
    // name or human id matched. An empty `studentIds` is not an error here: that
    // branch simply matches nothing while the reference branches still work, so
    // searching for a receipt number is unaffected by a student search finding
    // nothing.
    orClauses.push(
      { paymentId: { $regex: searchTerm, $options: "i" } },
      { receiptNumber: { $regex: searchTerm, $options: "i" } },
      { studentId: { $in: studentIds || [] } }
    );
  }

  if (orClauses.length) filter.$or = orClauses;

  return { filter, schoolId };
};

// ──────────────────── Admin: List payments ────────────────────
export const listPayments = async (query, user) => {
  const { filter } = await buildPaymentFilter(query, user);

  const sortBy = query.sortBy || "createdAt";
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;
  const skip = (Number(query.page) - 1) * Number(query.limit);

  const [payments, total] = await Promise.all([
    Payment.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(Number(query.limit))
      // `parents` is populated for the guardian column the table shows. The
      // numbers are *not* masked: unlike the roster, this surface exists to let
      // a bursar chase a payment that did not arrive, and the route is already
      // behind `authenticate` + `requireSchoolAdmin`. The export takes them
      // unmasked for the same reason (see `exportStudents`' comment).
      .populate("studentId", "studentId studentName studentClass parents")
      .lean(),
    Payment.countDocuments(filter),
  ]);

  return {
    data: payments,
    meta: {
      page: Number(query.page),
      limit: Number(query.limit),
      total,
      totalPages: Math.ceil(total / Number(query.limit)),
    },
  };
};

// ──────────────────── Admin: Payment summary ────────────────────

// Mirrors of the helpers in `reports.service.js`, deliberately not a shared
// import: that module keeps both private, and a share percentage that rounds
// differently in two modules is worse than a duplicated two-line function.
const round = (num, dp = 2) => {
  const factor = Math.pow(10, dp);
  return (Math.round((Number(num) || 0) * factor)) / factor;
};

// `rate(collected, expected)` — the same argument order and the same guard as
// `reports.service.js`. An empty window has no percentage, and returning 0
// rather than NaN keeps the KPI row renderable instead of showing "NaN%".
const rate = (collected, expected) => {
  if (!expected || expected === 0) return 0;
  return round((collected / expected) * 100);
};

/** An ISO timestamp, or an empty cell when the date is missing or unparseable. */
const toIsoOrBlank = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

/**
 * The window the summary is actually measured over, and the window immediately
 * before it.
 *
 * **Default: 1st of the current calendar month (00:00 Accra) through now.**
 *
 * Chosen to match `monthWindow()` in `reports.service.js`, so an unfiltered
 * dashboard and the headmaster monthly report cover exactly the same dates —
 * two modules answering "collected this month" with different defaults is how a
 * bursar ends up with two figures on two screens that disagree. A term window
 * was the other candidate, but `School.academic.currentYear` is optional and
 * `termsPerYear` is frequently unset, so a term default would quietly fall back
 * to a calendar year for exactly the schools that had not configured one — and
 * a term that opens mid-month would compare a part-week against a full term in
 * the trend figure.
 *
 * `endDate` defaults to *now* rather than to the end of the month, so a payment
 * made a minute ago is inside the window. An explicit date is snapped to the
 * day with `startOfDayAccra` / `endOfDayAccra`, matching every other report
 * here, so `?endDate=2026-09-30` includes the whole of the 30th.
 *
 * The previous window is derived by *length*, not by calendar: it ends one
 * millisecond before the current window opens and is exactly as long as it. The
 * obvious alternative — "the previous calendar month" — compares a half-finished
 * month against a full one and reports a collapse in income that never happened.
 * The one-millisecond gap is deliberate: with both sides inclusive on `start`,
 * a payment landing exactly on the boundary would be counted in both.
 */
const resolveSummaryPeriod = (query, now) => {
  const start = query.startDate
    ? startOfDayAccra(new Date(query.startDate))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = query.endDate ? endOfDayAccra(new Date(query.endDate)) : now;
  const span = end.getTime() - start.getTime();

  return {
    start,
    end,
    previousStart: new Date(start.getTime() - span),
    previousEnd: new Date(start.getTime() - 1),
  };
};

/**
 * The dashboard's KPI row, computed by the database over the same filter the
 * list uses.
 *
 * Not a sum over one page of the list above it. That list is paginated at 20
 * rows and capped at 100, so a client that added up what it was holding
 * reported the first twenty payments in the school as the school's income — the
 * same trap `getStudentStats` documents for the roster. Every figure below is
 * produced by one aggregation, so the KPI band and the table beneath it are
 * computed from the same filter and cannot disagree.
 *
 * There is deliberately no "escrow cleared", "pending sweep" or "next sweep
 * time" figure. Nothing in this backend banks money: `Payment.settlement.
 * appliedAt` is the stamp that says the money was *credited to the student's
 * balance*, not that it reached a bank account, and there is no settlement batch
 * or sweep job anywhere in the codebase to compute a sweep from. A dashboard
 * tile implying otherwise would be a number this system cannot honestly produce.
 */
export const getPaymentSummary = async (query, user) => {
  const now = new Date();
  const { start, end, previousStart, previousEnd } = resolveSummaryPeriod(query, now);

  // Built through the shared builder with the *resolved* window substituted in,
  // so every other filter is inherited rather than re-derived here. `createdAt`
  // is then lifted back out because each facet below applies its own window —
  // the current one and the preceding one, which a single top-level `$match`
  // could not express.
  const { filter } = await buildPaymentFilter(
    { ...query, startDate: start, endDate: end },
    user
  );
  const scoped = { ...filter };
  delete scoped.createdAt;

  const inWindow = { createdAt: { $gte: start, $lte: end } };
  const completed = { ...inWindow, status: "completed" };

  const [facets] = await Payment.aggregate(
    [
      { $match: scoped },
      {
        $facet: {
          completedTotals: [
            { $match: completed },
            { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
          ],
          // `wallets` per network, so the summary can say how many distinct
          // MSISDNs paid through each network without a second round trip.
          byNetwork: [
            { $match: completed },
            {
              $group: {
                _id: { $ifNull: ["$momoNetwork", "UNKNOWN"] },
                amount: { $sum: "$amount" },
                count: { $sum: 1 },
                wallets: { $addToSet: "$momoPhoneNumber" },
              },
            },
          ],
          byMethod: [
            { $match: completed },
            {
              $group: {
                _id: { $ifNull: ["$paymentMethod", "unknown"] },
                amount: { $sum: "$amount" },
                count: { $sum: 1 },
              },
            },
          ],
          walletCount: [
            // `$ne: null` also excludes documents where the field is absent,
            // which is what a cash payment recorded before the number existed
            // looks like. Counting distinct numbers here rather than summing
            // the per-network counts is what makes it "wallets", not
            // "wallet-network pairs".
            { $match: { ...completed, momoPhoneNumber: { $ne: null } } },
            { $group: { _id: "$momoPhoneNumber" } },
            { $count: "value" },
          ],
          awaiting: [
            { $match: { ...inWindow, status: { $in: ["pending", "processing"] } } },
            { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
          ],
          previous: [
            {
              $match: {
                createdAt: { $gte: previousStart, $lte: previousEnd },
                status: "completed",
              },
            },
            { $group: { _id: null, amount: { $sum: "$amount" } } },
          ],
        },
      },
    ],
    // `allowDiskUse` because a school with a term's worth of payments can push
    // this facet past the 100MB in-memory grouping limit; without it the whole
    // KPI band fails with an error rather than degrading.
    { allowDiskUse: true }
  );

  const totals = facets?.completedTotals?.[0] || { amount: 0, count: 0 };
  const awaiting = facets?.awaiting?.[0] || { amount: 0, count: 0 };
  const totalInflow = totals.amount || 0;
  const previousTotalInflow = facets?.previous?.[0]?.amount || 0;

  const networkBuckets = new Map((facets?.byNetwork || []).map((row) => [row._id, row]));

  // Every network is returned, including the ones with no money in the window.
  // A KPI row that only lists the networks present makes the client invent the
  // missing ones, and "MTN collected nothing" and "MTN does not appear because
  // the query omitted it" have to be told apart. Ties fall back to the enum
  // order so the array is stable between two calls with the same data.
  const networks = NETWORK_ORDER
    .map((network) => {
      const row = networkBuckets.get(network);
      const amount = row?.amount || 0;
      return {
        network,
        label: NETWORK_LABELS[network],
        amount,
        count: row?.count || 0,
        sharePercent: rate(amount, totalInflow),
        // `$addToSet` collects `null` for a payment with no MSISDN, which is
        // every non-Mobile-Money row; those are not wallets.
        wallets: (row?.wallets || []).filter(Boolean).length,
      };
    })
    .sort(
      (a, b) =>
        b.amount - a.amount ||
        NETWORK_ORDER.indexOf(a.network) - NETWORK_ORDER.indexOf(b.network)
    );

  const byMethod = (facets?.byMethod || [])
    .map((row) => ({
      method: row._id,
      label: METHOD_LABELS[row._id] || row._id,
      amount: row.amount || 0,
      count: row.count || 0,
      sharePercent: rate(row.amount || 0, totalInflow),
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    period: { startDate: start, endDate: end },
    totalInflow,
    totalTransactions: totals.count || 0,
    previousTotalInflow,
    // `null` rather than 0 or Infinity when there is no prior window to compare
    // against: "we collected money this month and there is nothing to compare it
    // to" is a different statement from "we collected nothing".
    trendPercent: previousTotalInflow
      ? round(((totalInflow - previousTotalInflow) / previousTotalInflow) * 100)
      : null,
    networks,
    walletCount: facets?.walletCount?.[0]?.value || 0,
    awaitingConfirmation: { amount: awaiting.amount || 0, count: awaiting.count || 0 },
    byMethod,
    // There is no `fees` field on Payment. `feesBreakdown` is a breakdown *of*
    // the amount — summing it would restate the inflow, not add a fee to it —
    // so this is `null` rather than a number that looks like a figure and is
    // not one.
    feesCollected: null,
  };
};

// ──────────────────── Admin: Export payments ────────────────────
/**
 * The payments table as a CSV file.
 *
 * Uses the shared filter, so "export what I am looking at" is literally the
 * rows on screen — the drift `student.service.js` had to fix in its own export,
 * and the reason this file cannot have a filter of its own.
 */
export const exportPayments = async (query, user) => {
  const { filter, schoolId } = await buildPaymentFilter(query, user);
  const school = await fetchSchool(schoolId);

  // CSV is the only format wired up. `paymentExportQuerySchema` already rejects
  // anything else with a 422; the fallback here is for a direct service caller,
  // and it still produces a CSV rather than a file named `.xlsx` that is not one.
  const format = "csv";

  // Unbounded on purpose. `page`/`limit` stay in the query schema so an
  // "export this view" link can carry them without being rejected, and they are
  // ignored here: a file that silently carried only the first page of rows is
  // the failure `paginationFor()` in `reports.service.js` exists to prevent,
  // because a bursar reconciling it would be reconciling a partial file.
  const payments = await Payment.find(filter)
    .sort({ createdAt: -1 })
    .populate("studentId", "studentId studentName studentClass parents")
    .lean();

  const slug = school.slug || school.schoolCode || "payments";
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `payments-${slug}-${dateStr}.${format}`;

  // Declared up front rather than derived from the first row, for the reason
  // `exportStudents` gives: a header derived from row zero makes an export that
  // matched nothing produce an empty file, which opens as one blank line and
  // reads to a bursar as data loss. `streamCsv` writes this header before any
  // row, so the zero-match case is a correct, distinguishable header-only file.
  const columns = [
    { key: "transactionRef", header: "Transaction Ref" },
    { key: "dateTime", header: "Date/Time" },
    { key: "studentId", header: "Student ID" },
    { key: "studentName", header: "Student Name" },
    { key: "studentClass", header: "Class" },
    { key: "guardianName", header: "Guardian Name" },
    { key: "guardianPhone", header: "Guardian Phone" },
    { key: "channel", header: "Channel" },
    { key: "method", header: "Method" },
    { key: "provider", header: "Provider" },
    { key: "status", header: "Status" },
    { key: "amountCedis", header: "Amount (Cedis)" },
    { key: "receiptNumber", header: "Receipt Number" },
    { key: "description", header: "Description" },
  ];

  const rows = payments.map((payment) => {
    const student = payment.studentId || {};
    const parents = student.parents || [];
    // The primary parent, falling back to the first: business rule #4 keeps
    // exactly one `isPrimary`, but a record written before that rule was
    // enforced can have none, and an empty guardian column is worse than a
    // second parent's name.
    const guardian = parents.find((p) => p.isPrimary) || parents[0] || null;
    const isMomo = payment.paymentMethod === "momo";

    return {
      transactionRef: payment.paymentId || "",
      // `completedAt` when the payment settled, `createdAt` otherwise. A refund
      // and a failed attempt are not "when it completed", and a reconciliation
      // file that dates them all to the moment the row was created is wrong for
      // exactly the rows a bursar most wants to find. The guard is not
      // decorative: `new Date("").toISOString()` throws, and one row with both
      // timestamps missing would fail the whole export.
      dateTime: toIsoOrBlank(payment.completedAt || payment.createdAt),
      studentId: student.studentId || "",
      studentName: student.studentName || "",
      studentClass: student.studentClass || "",
      // Unmasked, for the reason `exportStudents` gives: an export is taken
      // off-system and reconciled against a statement, so a masked number makes
      // the file useless for the one thing it is exported for.
      guardianName: guardian?.parentName || "",
      guardianPhone: guardian?.phone || "",
      // The network for a Mobile Money payment, and the method for everything
      // else. A cash payment has `momoNetwork: "UNKNOWN"` on the record, so
      // printing that would tell the bursar the network was unknown when the
      // real answer is that no network was involved. The raw method sits in the
      // next column, so the file is still filterable in a spreadsheet.
      channel: isMomo
        ? NETWORK_LABELS[payment.momoNetwork] || NETWORK_LABELS.UNKNOWN
        : METHOD_LABELS[payment.paymentMethod] || payment.paymentMethod || "",
      method: payment.paymentMethod || "",
      provider: payment.provider || "",
      status: payment.status || "",
      // Cedis, named in the header. The stored integer is pesewas (85000 =
      // GH₵ 850.00), and a header that says `amount` for a pesewa count gets
      // read as a hundredfold error by anyone who opens the file — the same
      // correction `exportStudents` made with `totalOwedCedis`.
      //
      // A refund is stored as a negative amount, and `streamCsv` prefixes any
      // cell starting with "-" as a spreadsheet-formula guard, so that one row
      // arrives as the text `'-50.00` rather than the number -50.00. That is the
      // shared writer doing its job and it is not worked around here; the
      // Status column carries the meaning, and the JSON list shows the raw
      // integer.
      amountCedis: ((payment.amount || 0) / 100).toFixed(2),
      receiptNumber: payment.receiptNumber || "",
      description: payment.description || "",
    };
  });

  return {
    filename,
    rowCount: rows.length,
    mimeType: "text/csv; charset=utf-8",
    columns,
    rows,
  };
};

// ──────────────────── Admin: Get payment detail ────────────────────
export const getPaymentDetail = async (paymentId, query, user) => {
  const schoolId = user.role === "super_admin"
    ? null
    : user.schoolId
      ? new mongoose.Types.ObjectId(user.schoolId)
      : null;

  if (!schoolId && user.role !== "super_admin") {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const filter = { paymentId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;

  const payment = await Payment.findOne(filter)
    .populate("studentId", "studentId studentName studentClass schoolId parents")
    .populate("schoolId", "name schoolCode")
    .lean();

  if (!payment) {
    throw new ApiError("Payment not found", 404, "NOT_FOUND");
  }

  // Optionally include webhook payload
  if (!query.includeWebhookData) {
    delete payment.webhookPayload;
  }

  return payment;
};

// ──────────────────── Admin: Generate receipt ────────────────────
export const generateReceipt = async (paymentId, user) => {
  const schoolId = user.role === "super_admin"
    ? null
    : user.schoolId
      ? new mongoose.Types.ObjectId(user.schoolId)
      : null;

  if (!schoolId && user.role !== "super_admin") {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const filter = { paymentId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;

  // `parents` on the student and `logo`/`phone`/`email`/`brandColor` on the
  // school are projected because a receipt is not only read on screen — it is
  // emailed and sent on WhatsApp, and both of those need an address to send
  // to that this function is the only place that already has. Without it the
  // delivery endpoints have to look the student up again, and a second read
  // of the same record on the same request is how the two answers drift.
  const payment = await Payment.findOne(filter)
    .populate("studentId", "studentId studentName studentClass parents")
    .populate("schoolId", "name schoolCode address city region phone email logo brandColor")
    .lean();

  if (!payment) {
    throw new ApiError("Payment not found", 404, "NOT_FOUND");
  }

  if (payment.status !== "completed") {
    throw new ApiError("Can only generate receipt for completed payments", 400, "INVALID_PAYMENT_STATUS");
  }

  // Generate receipt number if not exists
  //
  // From the atomic counter, like the model's own pre-save hook — the count of
  // the school's receipts today was a read-then-write race, and two receipts
  // requested at the same moment picked the same number.
  if (!payment.receiptNumber) {
    payment.receiptNumber = await nextReceiptNumber(payment.schoolId._id);
    payment.receiptGeneratedAt = new Date();
    await Payment.findByIdAndUpdate(payment._id, {
      receiptNumber: payment.receiptNumber,
      receiptGeneratedAt: payment.receiptGeneratedAt,
    });
  }

  // The guardian the receipt is about, resolved here so the email and
  // WhatsApp endpoints do not each re-read the student.
  const primaryParent =
    (payment.studentId?.parents || []).find((p) => p.isPrimary) ||
    (payment.studentId?.parents || [])[0] ||
    null;

  return {
    receipt: {
      receiptNumber: payment.receiptNumber,
      paymentId: payment.paymentId,
      reference: payment.reference,
      date: payment.completedAt,
      student: {
        studentId: payment.studentId.studentId,
        studentName: payment.studentId.studentName,
        studentClass: payment.studentId.studentClass,
        // Where to send the receipt. `null` when the record has no address —
        // the caller asks the bursar for one rather than inventing it.
        parentEmail: primaryParent?.email || null,
        parentPhone: primaryParent?.phone || null,
      },
      school: {
        name: payment.schoolId.name,
        schoolCode: payment.schoolId.schoolCode,
        address: payment.schoolId.address,
        city: payment.schoolId.city,
        region: payment.schoolId.region,
        phone: payment.schoolId.phone,
        email: payment.schoolId.email,
        // The logo the PDF header draws and the modal preview renders. Absent
        // on both, the bordered initial tile stands in.
        logo: payment.schoolId.logo,
        brandColor: payment.schoolId.brandColor,
      },
      amount: payment.amount,
      currency: payment.currency,
      paymentMethod: payment.paymentMethod,
      description: payment.description,
      feesBreakdown: payment.feesBreakdown,
    },
    // The primary parent's subdocument id, so a supplied email can be
    // persisted against the right record.
    primaryParentId: primaryParent?._id || null,
    studentDocId: payment.studentId?._id || null,
  };
};

// ──────────────────── Settlement claim ────────────────────
// Settlement is claimed before the balance moves. `Payment.settlement.appliedAt`
// is set with a conditional update, so of N retries of the same "Success"
// callback exactly one proceeds to the $inc below; the rest return a duplicate
// acknowledgement and leave the parent's balance alone.
export const claimPaymentSettlement = async (payment) => {
  const claim = await Payment.findOneAndUpdate(
    { _id: payment._id, "settlement.appliedAt": null },
    { $set: { "settlement.appliedAt": new Date() } },
    { returnDocument: 'after' }
  );

  if (!claim) return null;
  // Keep the in-memory document consistent, so the save() below does not write
  // the stale null back over the claim.
  payment.settlement = payment.settlement || {};
  payment.settlement.appliedAt = claim.settlement.appliedAt;
  return claim;
};

/** Releases a claim whose settlement failed, so a provider retry can retry it. */
export const releasePaymentSettlement = async (paymentId) => {
  await Payment.updateOne({ _id: paymentId }, { $set: { "settlement.appliedAt": null } });
};

// ──────────────────── MTN: settlement ────────────────────

/**
 * Applies an MTN transaction state to a payment, moving the student's balance
 * only on settlement.
 *
 * The settlement claim is taken before the balance moves, exactly as in the
 * Moolre path: MTN delivers the same "SUCCESSFUL" callback more than once, and
 * without the claim each delivery would re-run the `$inc` and credit the parent
 * several times over.
 */
const applyMtnStatus = async (payment, transaction, mappedStatus) => {
  const isSettlement = mappedStatus === "completed";

  if (isSettlement) {
    const claim = await claimPaymentSettlement(payment);
    if (!claim) {
      return { duplicate: true };
    }
  }

  payment.mtnStatusReason = transaction?.statusReason || null;
  payment.mtnFinancialTransactionId =
    transaction?.financialTransactionId || payment.mtnFinancialTransactionId;

  if (isSettlement) {
    payment.status = "completed";
    payment.completedAt = new Date();
    payment.settlement.reference =
      transaction?.financialTransactionId || payment.settlement?.reference || null;
  } else if (mappedStatus === "failed") {
    payment.status = "failed";
    payment.failedAt = new Date();
    payment.failureReason = transaction?.statusReason?.slice(0, 500) || "Reported failed by MTN";
  } else if (mappedStatus === "refunded") {
    // A provider-side reversal returned the money to the payer. It is terminal
    // and must never be treated as a settlement.
    payment.status = "refunded";
    payment.refundedAt = new Date();
  } else if (mappedStatus === "processing") {
    payment.status = "processing";
  }

  // Saved before the money moves — see the Moolre path for why.
  await payment.save();

  if (isSettlement) {
    try {
      // Balance, school stat and platform ledger. Only the balance is allowed to
      // throw, and if it does the claim is released so the next callback or poll
      // settles this payment rather than leaving it completed-but-uncounted.
      await settlePayment(payment);
    } catch (error) {
      await releasePaymentSettlement(payment._id);
      throw error;
    }
  }

  if (isSettlement && payment.paymentPlanId) {
    await applyCompletedPaymentToPlan(payment);
  }

  return { duplicate: false, payment };
};

// ──────────────────── Moolre: settlement ────────────────────

/**
 * Maps Moolre's normalised status onto this platform's Payment statuses.
 *
 * `success` settles the payment, `failed` is terminal, and everything else —
 * including a status Moolre has not finished deciding — stays `processing`.
 */
const mapMoolreStatus = (status) => {
  if (status === "success") return "completed";
  if (status === "failed") return "failed";
  return "processing";
};

/**
 * Applies a Moolre transaction status to a payment, moving the student's
 * balance only on settlement.
 *
 * The settlement claim is taken before the balance moves, exactly as in the
 * MTN path: Moolre delivers the same "successful" callback more than once, and
 * without the claim each delivery would re-run the `$inc` and credit the parent
 * several times over.
 */
const applyMoolreStatus = async (payment, verification, mappedStatus) => {
  const isSettlement = mappedStatus === "completed";

  if (isSettlement) {
    const claim = await claimPaymentSettlement(payment);
    if (!claim) {
      return { duplicate: true };
    }
  }

  if (verification?.transactionId) {
    payment.moolreTransactionId = verification.transactionId;
  }
  if (verification?.channel) {
    payment.moolreChannel = String(verification.channel);
  }

  if (isSettlement) {
    payment.status = "completed";
    payment.completedAt = new Date();
    payment.settlement.reference =
      verification?.transactionId || payment.settlement?.reference || payment.reference || null;
  } else if (mappedStatus === "failed") {
    payment.status = "failed";
    payment.failedAt = new Date();
    payment.failureReason =
      verification?.raw?.message?.slice(0, 500) || "Reported failed by Moolre";
  } else {
    payment.status = "processing";
  }

  // Saved before the money moves — see the Moolre path for why.
  await payment.save();

  if (isSettlement) {
    try {
      // Balance, school stat and platform ledger — see `settlePayment`'s
      // docstring for why only the balance is allowed to throw.
      await settlePayment(payment);
    } catch (error) {
      // The claim is released so a provider retry settles this payment instead
      // of leaving it stuck as completed-but-uncounted.
      await releasePaymentSettlement(payment._id);
      throw error;
    }
  }

  if (isSettlement && payment.paymentPlanId) {
    await applyCompletedPaymentToPlan(payment);
  }

  return { duplicate: false, payment };
};

/**
 * Handles a Moolre callback.
 *
 * **The callback is a notification, not proof of payment.** Moolre posts it
 * when it has a result, but a callback is an unauthenticated HTTP request
 * from the internet: it can be replayed, forged, or delivered for a
 * transaction that failed. So the payload is never trusted on its own — the
 * transaction is re-verified against Moolre's own status endpoint, and only a
 * confirmed success settles the payment.
 *
 * The amount is checked against what the local record expects. A mismatch is
 * logged and the payment is left unsettled rather than credited: the money
 * that arrived is not the money that was owed, and guessing which one is right
 * is how a school's ledger stops matching its bank.
 */
export const handleMoolreWebhook = async (payload) => {
  const body = payload?.data || payload || {};

  // Moolre's callback carries a `secret` in `data`, and the docs are explicit
  // that it must be validated before any payment record changes. This is a
  // second line of defence *behind* the re-verification below — a callback
  // that fails the secret check is still re-verified rather than trusted, and
  // one that passes it is still re-verified.
  if (MOOLRE_CALLBACK_SECRET) {
    const presented = String(body.secret || "");
    const expected = String(MOOLRE_CALLBACK_SECRET);
    const matches =
      presented.length === expected.length &&
      presented.length > 0 &&
      // Constant-time: a length-and-content comparison that does not leak
      // where the first differing character is.
      (() => {
        let diff = 0;
        for (let i = 0; i < presented.length; i += 1) {
          diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
        }
        return diff === 0;
      })();

    if (!matches) {
      console.error("[MOOLRE WEBHOOK] Callback secret mismatch — refused", {
        reference: body.externalref,
      });
      throw new ApiError(
        "Callback secret mismatch",
        403,
        "MOOLRE_CALLBACK_SECRET_MISMATCH"
      );
    }
  }

  const reference =
    body.externalref ||
    body.reference ||
    payload?.externalref ||
    payload?.reference ||
    body.transactionid ||
    payload?.transactionid;

  if (!reference) {
    throw new ApiError("No valid payment reference in payload", 400, "INVALID_WEBHOOK_PAYLOAD");
  }

  const payment = await Payment.findOne({
    $or: [{ reference }, { moolreReference: reference }, { paymentId: reference }],
    deletedAt: null,
  });

  if (!payment) {
    console.warn(`[MOOLRE WEBHOOK] Payment not found for reference:`, reference);
    // Acknowledged so Moolre does not retry a callback for a payment that is
    // not ours — or not yet ours.
    return { success: true, message: "Payment not found in system" };
  }

  // An already-settled payment is acknowledged without touching the balance.
  // The claim inside `applyMoolreStatus` would catch this too, but checking
  // first avoids a pointless verification call on every retry.
  if (payment.status === "completed") {
    return { success: true, duplicate: true, message: "Payment already settled" };
  }

  // Re-verify with Moolre. A failure here is not a settlement failure: it
  // means we could not reach Moolre to find out, so the caller must be told
  // to retry rather than being handed a definitive "failed".
  let verification;
  try {
    verification = await moolreVerifyTransaction({ reference: payment.reference || reference });
  } catch (error) {
    console.error(`[MOOLRE WEBHOOK] Verification failed for ${reference}:`, error.message);
    const err = new ApiError(
      "Could not verify the transaction with Moolre. The callback will be retried.",
      502,
      "MOOLRE_VERIFICATION_FAILED"
    );
    err.retryable = true;
    throw err;
  }

  if (verification.status !== "success") {
    const mapped = mapMoolreStatus(verification.status);
    if (mapped === "failed" && payment.status !== "failed") {
      payment.status = "failed";
      payment.failedAt = new Date();
      payment.failureReason =
        verification?.raw?.message?.slice(0, 500) || "Reported failed by Moolre";
      await payment.save();
    }
    return { success: true, status: mapped, payment: payment.toJSON() };
  }

  // The amount Moolre confirms must cover what this record expects.
  // `payment.amount` is in pesewas; Moolre reports cedis.
  const expected = Number(payment.amount) / 100;
  const received = Number(verification.amount);

  if (Number.isFinite(expected) && Number.isFinite(received) && received + 0.01 < expected) {
    console.error("[MOOLRE WEBHOOK] Amount mismatch", {
      expected,
      received,
      reference,
      paymentId: payment.paymentId,
    });
    // Not settled, and not marked failed either: the payment may be
    // short-paid rather than unpaid, and a human has to look at it.
    return { success: true, message: "Amount mismatch", mismatch: true };
  }

  const result = await applyMoolreStatus(payment, verification, "completed");

  payment.webhookPayload = payload;
  payment.webhookReceivedAt = new Date();
  await payment.save();

  await auditService.log({
    action: "webhook.received",
    entity: "Payment",
    entityId: payment._id,
    userId: payment.createdBy,
    details: {
      status: "success",
      provider: "moolre",
      reference,
      amount: received,
      // The channel code Moolre reported, and the network it means — an audit
      // line is read by a person, and "13" is not a network.
      channel: verification.channel,
      network: verification.channel ? moolreChannelLabel(verification.channel) : null,
    },
  });

  return { success: true, duplicate: false, payment: payment.toJSON(), ...result };
};

/**
 * Handles an MTN transaction result, from either the callback or a status poll.
 *
 * Accepts the payload in both the bare transaction shape and the
 * `{ status, ... }` envelope MTN posts to the callback URL, so the two ingress
 * paths cannot diverge.
 */
export const handleMtnResult = async (rawPayload) => {
  const transaction = normaliseTransaction(rawPayload?.data || rawPayload);
  if (!transaction?.referenceId && !transaction?.externalId) {
    throw new ApiError("No valid payment reference in payload", 400, "INVALID_WEBHOOK_PAYLOAD");
  }

  const filter = { deletedAt: null };
  if (transaction.referenceId) filter.mtnReferenceId = transaction.referenceId;
  else filter.mtnFinancialTransactionId = transaction.financialTransactionId;
  // The externalId is our paymentId, so a callback that omits MTN's own
  // reference can still be matched.
  if (Object.keys(filter).length === 1 && transaction.externalId) {
    filter.paymentId = transaction.externalId;
  }

  const payment = await Payment.findOne(filter);

  if (!payment) {
    /**
     * Not a fee payment — try the regulated purchase flows.
     *
     * SMS credit and ID-card orders deliberately do **not** mint a `Payment`:
     * `Payment.studentId` is `required: true` and a school buying credit has no
     * student, so loosening it would have reached into the settlement path, the Daily
     * Payments `$lookup` and four compound indexes — and would have rendered a credit
     * purchase in that report as "Unknown student".
     *
     * So those references (`SMS-PAY-…`) live on their own collections and arrive here
     * on the same shared MTN callback. Matched **before** the "not found" reply below,
     * which would otherwise acknowledge the callback and drop it on the floor — the
     * school's money would arrive and their request would sit at `awaiting_payment`
     * forever, with a support conversation as the only way out.
     *
     * Matched on both `referenceId` and `externalId` because `requestToPay` was called
     * with the same value for each, but MTN does not guarantee which it echoes back on
     * a given delivery.
     */
    const orderRef =
      transaction.referenceId || transaction.externalId || null;

    if (orderRef) {
      const { onSmsRequestPaymentConfirmed } = await import(
        "./smsPurchaseRequest.service.js"
      );

      const order = await onSmsRequestPaymentConfirmed(orderRef, {
        financialTransactionId: transaction.financialTransactionId,
        reason: transaction.statusReason,
      });

      if (order.matched) {
        return {
          success: true,
          message: order.changed
            ? "SMS purchase payment confirmed; awaiting administrator approval"
            : "SMS purchase already recorded",
          payment: null,
          order: order.request?.toJSON?.() || null,
        };
      }
    }

    console.warn("[MTN-WEBHOOK] Payment not found for payload:", transaction);
    // Acknowledged rather than retried: MTN will redeliver a reference this
    // deployment never issued, and a retry loop turns that into a support
    // incident.
    return { success: true, message: "Payment not found in system" };
  }

  const mapped = mapMtnStatus(transaction.status);
  if (!mapped) {
    console.warn(`[MTN-WEBHOOK] Unmapped MTN status "${transaction.status}"`);
    return { success: true, message: "Status not recognised", payment: payment.toJSON() };
  }

  payment.webhookPayload = rawPayload;
  payment.webhookReceivedAt = new Date();

  const result = await applyMtnStatus(payment, transaction, mapped);
  if (result.duplicate) {
    return { success: true, duplicate: true, message: "Payment already settled", payment: payment.toJSON() };
  }

  await auditService.log({
    action: "webhook.received",
    entity: "Payment",
    entityId: payment._id,
    userId: payment.createdBy,
    details: {
      provider: "mtn",
      status: transaction.status,
      transactionId: transaction.financialTransactionId,
      amount: transaction.amount,
    },
  });

  return { success: true, payment: payment.toJSON() };
};

/**
 * Whether an MSISDN is an active MTN MoMo account.
 *
 * Proactive check: an inactive number fails the debit at the provider, and
 * telling the parent before prompting is better than a payment left pending.
 */
export const checkMtnPayerActive = async (phone) => {
  try {
    const result = await mtnIsAccountActive(phone);
    return { active: result?.result === true, raw: result };
  } catch (error) {
    if (error instanceof MtnTransportError) {
      throw new ApiError(error.message, error.status, error.code);
    }
    throw error;
  }
};

// ──────────────────── Admin: Refund payment ────────────────────
export const refundPayment = async (paymentId, data, user) => {
  const schoolId = user.role === "super_admin"
    ? null
    : user.schoolId
      ? new mongoose.Types.ObjectId(user.schoolId)
      : null;

  if (!schoolId && user.role !== "super_admin") {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const filter = { paymentId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;

  const payment = await Payment.findOne(filter);
  if (!payment) {
    throw new ApiError("Payment not found", 404, "NOT_FOUND");
  }

  if (payment.status !== "completed") {
    throw new ApiError("Can only refund completed payments", 400, "INVALID_PAYMENT_STATUS");
  }

  const refundAmount = data.amount || payment.amount;

  if (refundAmount > payment.amount) {
    throw new ApiError("Refund amount cannot exceed payment amount", 400, "INVALID_REFUND_AMOUNT");
  }

  /*
   * How much has *already* been given back.
   *
   * The check above compares one refund against the original amount and nothing
   * else, so two refunds of 60% each both passed and the school was refunded 20%
   * more than it collected. This aggregate is what closes that: the running total is
   * read from the reversal rows, keyed on `refundOfPaymentId`, and the new refund is
   * rejected if it would take the total past the original.
   *
   * The original's `status` cannot carry this. A partially refunded payment stays
   * `completed` — it is still partly real money, and a school reconciling its ledger
   * needs the row to read as a payment — so there is nowhere on it to record how far
   * along the reversal is.
   */
  const alreadyRefunded = await Payment.aggregate([
    { $match: { refundOfPaymentId: payment._id, deletedAt: null, status: "completed" } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  // `amount` is negative on a reversal, so the sum is negative and the magnitude is
  // what has been given back.
  const refundedSoFar = Math.abs(Number(alreadyRefunded[0]?.total) || 0);
  const refundable = payment.amount - refundedSoFar;

  if (refundable <= 0) {
    throw new ApiError("This payment has already been fully refunded", 400, "ALREADY_REFUNDED");
  }

  if (refundAmount > refundable) {
    throw new ApiError(
      `Only ${refundable} pesewas of this payment remain refundable (${refundedSoFar} already returned)`,
      400,
      "EXCEEDS_REFUNDABLE"
    );
  }

  // Create refund payment record (negative amount)
  const refundPayment = await Payment.create({
    studentId: payment.studentId,
    schoolId: payment.schoolId,
    parentId: payment.parentId,
    amount: -refundAmount,
    currency: payment.currency,
    status: "completed",
    paymentMethod: payment.paymentMethod,
    provider: payment.provider,
    description: `Refund: ${data.reason}`,
    // The explicit relation the aggregate above reads. Previously the only link back
    // to the original was the `"Refund: "` prefix on `description`, which is a string
    // convention anyone could edit away.
    refundOfPaymentId: payment._id,
    createdBy: user._id,
  });

  // Update original payment
  payment.status = refundAmount === payment.amount ? "refunded" : "completed"; // partial refund stays completed
  if (refundAmount === payment.amount) {
    payment.refundedAt = new Date();
  }
  await payment.save();

  // Update student balance
  await Student.findByIdAndUpdate(payment.studentId, {
    $inc: { totalPaid: -refundAmount, balance: refundAmount },
  });

  // Update school stats.
  //
  // By **one**, not by `refundAmount`. `stats.totalPaymentsThisMonth` is a count:
  // `manualPayment.service.js` increments it by `1` when a payment is recorded,
  // and the webhook paths increment it by `1` as well. Subtracting the cedi value
  // here drove the counter thousands below zero after a single GH₵ 850 refund,
  // and it is read straight off the School document by the dashboard. A statistic
  // that reads -849998 is worse than one that is never updated, because it is
  // believed.
  await School.findByIdAndUpdate(payment.schoolId, {
    $inc: { "stats.totalPaymentsThisMonth": -1 },
  });

  await auditService.log({
    action: "refund.payment",
    entity: "Payment",
    entityId: payment._id,
    userId: user._id,
    schoolId: payment.schoolId,
    // `before`/`after` on the original's status, plus the running total. Without
    // these the entry records only that a refund happened and not how much of the
    // payment was left — which is the question a school asks six weeks later.
    before: { status: payment.status, refundable },
    after: {
      status: refundAmount === payment.amount ? "refunded" : "completed",
      refundedSoFar,
      refundableAfter: refundable - refundAmount,
    },
    // Also in `meta` so a single record carries the whole story even for a reader
    // that only displays `meta`.
    meta: {
      refundAmount,
      reason: data.reason,
      refundPaymentId: refundPayment.paymentId,
      refundPaymentObjectId: String(refundPayment._id),
      refundedSoFar,
    },
  });

  return {
    originalPayment: payment.toJSON(),
    refundPayment: refundPayment.toJSON(),
    refundAmount,
    refundedSoFar,
    refundableAfter: refundable - refundAmount,
  };
};

export { ApiError };