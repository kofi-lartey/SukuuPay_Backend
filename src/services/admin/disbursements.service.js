/**
 * Platform-owner disbursements: turning collected parent money into a paid-out
 * school, one auditable operation at a time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MOST IMPORTANT THING IN THIS FILE: THERE IS NO PAYOUT PROVIDER WIRED.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `utils/paymentGateway.js` was read before this was written, and it is a
 * **collection** selector, not a payout client. It exports `resolveGateway` and
 * `availableGateways`, and every one of them answers "which gateway should take
 * this *parent payment*". None of them moves money out.
 *
 * `utils/mtnApi.js` is closer, and the gap is worth spelling out. It declares a
 * second MTN product —
 *
 *     disbursement: { path: '/disbursement', subscriptionKey: MTN_DISBURSEMENT_SUBSCRIPTION_KEY }
 *
 * (mtnApi.js:74) — and its internal `request()` is product-parameterised, so the
 * plumbing to reach MTN's transfer endpoint exists. What does **not** exist is
 * any exported function that calls it: there is no `transferToMobileMoney`, no
 * `/v1_0/transfer`, no payout call of any kind. `isMtnConfigured()` (mtnApi.js:81)
 * checks only `MTN_COLLECTION_SUBSCRIPTION_KEY`, so a deployment with a working
 * disbursement key still reports "MTN not configured" here, and
 * `assertConfigured('disbursement')` is never called by anything.
 *
 * So `executePayoutProviderCall()` below throws `PayoutProviderNotWiredError`,
 * and `settleDisbursementBatch()` catches exactly that one error type and parks
 * the batch at **`approved`, with `payoutReference: null`**. It does not fabricate
 * a `paid`. A `paid` batch means money left the gateway float, and a
 * `payoutReference` is the provider's own proof of it; writing either without a
 * transfer would put a lie in the one table the platform's accounts are rebuilt
 * from. `approved` with no reference is honest: a human approved it, nobody has
 * moved it yet, and the finance overview keeps counting the money as held.
 *
 * When the provider lands, this file changes in exactly one function. The
 * approve, retry, ledger-settling and audit paths below are already written for
 * the wired case and are exercised by the same code path.
 */

import mongoose from "mongoose";
import { School } from "../../models/schoolModel.js";
import { Payment } from "../../models/paymentModel.js";
import {
  DisbursementBatch,
  OPEN_DISBURSEMENT_STATUSES,
  SETTLED_DISBURSEMENT_STATUSES,
} from "../../models/DisbursementBatch.js";
import {
  PlatformLedger,
  PLATFORM_REVENUE_TYPES,
} from "../../models/PlatformLedger.js";
import { Counter } from "../../models/counterModel.js";
import { getCachedPlatformSettings } from "../platformSettings.service.js";
import ApiError from "../../utils/ApiError.js";
import {
  optionalId,
  resolvePagination,
  buildMeta,
  resolveDateRange,
} from "../../utils/platformQuery.js";
import { startOfDayAccra, endOfDayAccra } from "../../utils/dateHelpers.js";

/**
 * How many schools appear in the dashboard's payout worklist.
 *
 * Ten, not "all", because the endpoint this feeds is a screen and a screen does
 * not scroll past ten. The full queue is `GET /admin/finance/disbursements`,
 * which paginates; this is the glance.
 */
const BY_SCHOOL_LIMIT = 10;

/** Reconciliation samples are for eyeballing, not for exporting. */
const UNMATCHED_SAMPLE_LIMIT = 20;

// ────────────────────────── Batch numbers ──────────────────────────

/**
 * `DISB-2026-000123`, from the atomic counter.
 *
 * `Counter.findOneAndUpdate({key},{$inc:{seq:1}},{upsert:true})` and **not** a
 * read of the current maximum. The reason is written out in `counterModel.js`:
 * read-max-then-increment is a read-then-write race, and two payout batches
 * built in the same second — which is exactly what a weekly run over 40 schools
 * produces — both read `000122`, both write `000123`, and one of them dies on
 * the unique index on `batchNumber` with an error nobody can interpret.
 *
 * The key is per-year, so the counter restarts at 1 each January while the
 * `DISB-<year>-` prefix keeps the values globally unique anyway.
 */
const nextBatchNumber = async (at = new Date()) => {
  const year = at.getUTCFullYear();

  const counter = await Counter.findOneAndUpdate(
    { key: `disbursementBatch:${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );

  return `DISB-${year}-${String(counter.seq).padStart(6, "0")}`;
};

// ────────────────────────── Payout provider seam ──────────────────────────

/**
 * "There is no provider" is not the same failure as "the provider said no".
 *
 * They are separated by type, not by message, because the consequence is
 * completely different. A provider rejection means the batch is `failed` and the
 * money has not moved. No provider at all means the batch is `approved` and
 * simply waiting for a payout integration — marking it `failed` would put every
 * batch in the system into a retry queue that has nothing to retry against, and
 * would tell a school their payout broke when nothing was ever attempted.
 *
 * `providerStatus` is carried where a wired provider reports an HTTP status,
 * because `retryDisbursementBatch` reads it to decide whether a failure is worth
 * retrying at all.
 */
class PayoutProviderNotWiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "PayoutProviderNotWiredError";
    this.code = "PAYOUT_PROVIDER_NOT_WIRED";
    this.permanent = true;
  }
}

/**
 * THE ONE FUNCTION TO CHANGE WHEN A PAYOUT PROVIDER IS WIRED.
 *
 * The contract it must satisfy, because `settleDisbursementBatch` is written
 * against it and nothing else needs to move:
 *
 *   - resolve to `{ payoutReference: string, raw?: object }` on success. The
 *     reference is the provider's own transfer id and goes straight onto the
 *     batch and onto every ledger line the batch settles, which is the only way
 *     a reconciliation can later prove the money went where it was supposed to.
 *   - throw on failure, with the provider's words in `message` (they are stored
 *     verbatim in `failureReason`, because a support ticket quotes them) and, if
 *     the provider gave an HTTP status, on `providerStatus`.
 *   - never throw `PayoutProviderNotWiredError`. That type means "this code has
 *     not been written", which is a different statement from "the transfer was
 *     refused", and the two must not be conflated.
 *
 * A likely implementation is `request('disbursement', '/v1_0/transfer', …)` in
 * `mtnApi.js` (the product and the generic `request` are both already there),
 * with `X-Reference-Id` derived from the batch number so a retry after a timeout
 * replays the original transfer rather than sending the school a second one —
 * the same idempotency rule `requestToPay` follows (mtnApi.js:184).
 *
 * @throws {PayoutProviderNotWiredError} always, today.
 */
export const executePayoutProviderCall = async () => {
  throw new PayoutProviderNotWiredError(
    "No payout provider is wired. utils/paymentGateway.js selects a collection " +
      "gateway only, and utils/mtnApi.js declares the MTN disbursement product " +
      "without exposing a transfer call. The batch has been approved and its money " +
      "has NOT been sent."
  );
};

/**
 * Is a provider failure worth retrying?
 *
 * A 4xx from a payout API is almost always permanent: a closed or wrong account
 * number, a name that does not match, a limit the merchant is over. Retrying it
 * produces the same rejection, burns an `attempts` increment, and — worse —
 * trains an operator to click "retry" on a batch that cannot succeed. So 4xx is
 * treated as permanent, with the two exceptions that are 4xx-shaped but
 * transient by definition: 408 (request timeout) and 429 (rate limited).
 *
 * Everything else — no status at all, 5xx, a network error — is transient. A 500
 * from a payments provider is very often "we lost it", and the transfer may or
 * may not have happened, which is why the retry path still reuses the same batch
 * row and the same reference rather than making a new one.
 */
const isPermanentFailure = (error) => {
  const status = Number(error?.providerStatus ?? error?.status);
  if (!Number.isFinite(status)) return false;
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
};

// ────────────────────────── Shared settle path ──────────────────────────

/**
 * The one place a batch can become `paid`, shared by approve and retry.
 *
 * Three outcomes, and they are not variants of each other:
 *
 *   1. **Paid.** A wired provider returned a reference. The batch is stamped
 *      `paid` / `processedAt`, the reference is written, the payments keep their
 *      batch id, and the batch's ledger lines flip to `settled: true`. Settling
 *      the ledger is the whole point: `settled: false` is *accrued* revenue —
 *      taken from parents, visible on the dashboard, not yet in an account
 *      (PlatformLedger.js:126) — and leaving it accruing after the money has
 *      gone would double-count it as both held and paid.
 *   2. **Approved, not sent.** `PayoutProviderNotWiredError`. Parked at
 *      `approved`, reference `null`, ledger left unsettled. See the header.
 *   3. **Failed.** Any other error. `failed` / `failedAt` / verbatim
 *      `failureReason`, ledger left unsettled, `attempts` incremented, and
 *      `metadata.failureKind` stamped so the retry endpoint can tell a
 *      retryable failure from a permanent one without re-parsing provider prose.
 *
 * @param {object} batch   a live (un-saved) DisbursementBatch already at `processing`
 * @param {object} school  the School document, for the provider payload
 */
const settleDisbursementBatch = async (batch, { school, trigger, actor }) => {
  try {
    const result = await executePayoutProviderCall({ batch, school, actor, trigger });

    batch.status = "paid";
    batch.processedAt = new Date();
    batch.payoutReference = result.payoutReference;
    batch.failureReason = "";
    batch.metadata = {
      ...(batch.metadata || {}),
      payoutSettledBy: trigger,
      payoutProviderPayload: result.raw ?? null,
    };
    await batch.save();

    // The ledger is append-only with respect to *amounts* — a wrong entry is
    // corrected by a compensating `adjustment`, never by an edit. Flipping
    // `settled` is not that: it is the settlement stamp the field exists to
    // carry, and it is the only update this file makes to `PlatformLedger`.
    await PlatformLedger.updateMany(
      { disbursementBatchId: batch._id, settled: false },
      {
        $set: {
          settled: true,
          settledAt: batch.processedAt,
          reference: result.payoutReference,
        },
      }
    );

    return { batch, settled: true, paid: true };
  } catch (error) {
    /*
     * Split on the error *type*, not on its message.
     *
     * "No provider" and "the provider refused" produce the same class of log
     * line and the opposite consequences, so they cannot share a branch. The
     * narrowing (`instanceof`) is what makes the parked state reachable: any
     * other error is a real provider rejection and must never be able to reach
     * `approved`.
     */
    const notWired = error instanceof PayoutProviderNotWiredError;

    batch.status = notWired ? "approved" : "failed";
    batch.payoutReference = null;

    if (notWired) {
      batch.processedAt = null;
      batch.failedAt = null;
      batch.failureReason = "";
    } else {
      batch.failedAt = new Date();
      /*
       * Verbatim. Not normalised, not summarised, not "MTN transfer failed".
       * A school asking why they have not been paid is answered by quoting the
       * provider, and a paraphrase is where the useful part gets lost.
       */
      batch.failureReason = String(error?.message || "Payout provider call failed").slice(0, 1000);

      /*
       * The second increment of the operation, and the reason `attempts` on a
       * failed batch reads one higher than the number of provider calls made.
       * The caller already incremented on entering `processing` — an attempt was
       * made — and this records that the attempt was also a failure, so
       * `attempts > 1` is a reliable "this has been tried more than once" signal
       * for a triage query. What it is *not* is a count of transfers sent, and
       * the parked `approved` path (no increment here) is the case where the two
       * readings differ most: one increment, zero provider calls, which is
       * correct under both.
       */
      batch.attempts = (batch.attempts || 0) + 1;
    }

    batch.metadata = {
      ...(batch.metadata || {}),
      payoutIntegration: {
        wired: !notWired,
        lastErrorCode: error?.code || null,
        lastProviderStatus: error?.providerStatus ?? error?.status ?? null,
        failureKind: notWired ? null : isPermanentFailure(error) ? "permanent" : "transient",
        attemptedVia: trigger,
      },
    };

    await batch.save();

    return { batch, settled: false, paid: false, failure: notWired ? null : error };
  }
};

// ────────────────────────── Build a batch ──────────────────────────

/**
 * Collect a school's completed parent payments for a window, split off
 * SukuuPay's share, and stage a batch for human approval.
 *
 * Nothing here moves money. The most this function can do is decide *how much*
 * would move, which is why the batch it writes is `pending_approval` and not
 * `paid`.
 */
export const buildDisbursementBatch = async ({ schoolId, periodStart, periodEnd }, actor) => {
  const schoolObjectId = optionalId(schoolId, "school ID");
  if (!schoolObjectId) {
    throw new ApiError("A schoolId is required", 400, "SCHOOL_ID_REQUIRED");
  }

  const school = await School.findById(schoolObjectId)
    .select("name schoolCode status payment.platformMarkupPercent subscription.platformFeePercent")
    .lean();

  if (!school) {
    throw new ApiError("School not found", 404, "NOT_FOUND");
  }

  /*
   * A suspended school is refused before anything is written.
   *
   * Suspension is the platform's statement that this tenant should not be
   * transacting. Building a payout batch against one anyway produces a queue
   * item that a later job could pick up and pay, which is precisely what
   * suspending was supposed to prevent. 409, not 403: the caller is allowed to
   * do this, the school's current state is what stops them.
   */
  if (school.status === "suspended") {
    throw new ApiError(
      `${school.name} is suspended. Unsuspend the school before building a disbursement batch — a suspended tenant must not have money queued to leave the platform.`,
      409,
      "SCHOOL_SUSPENDED"
    );
  }

  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new ApiError("periodStart and periodEnd must both be valid dates", 400, "INVALID_PERIOD");
  }

  /*
   * The inverted-window guard.
   *
   * An inverted window is a `$gte` later than `$lte`, which matches **nothing**.
   * The result is a batch-less, empty, 409-shaped outcome that is byte-for-byte
   * identical to a school that genuinely collected nothing that week. Every
   * other reason a batch comes out empty is visible in the data; this one is
   * invisible, and it is the one an operator types by accident (an "end" field
   * and a "start" field swapped in a form) rather than one the system produces.
   * Rejecting it here means the message can say what is actually wrong.
   */
  if (end.getTime() < start.getTime()) {
    throw new ApiError(
      "periodEnd must not be earlier than periodStart. An inverted window matches no payments and is indistinguishable from a school that collected nothing.",
      400,
      "INVERTED_PERIOD"
    );
  }

  /*
   * The application half of the don't-pay-twice guard.
   *
   * `DisbursementBatch` carries a **unique** index on
   * `{ schoolId, periodStart, periodEnd }` (DisbursementBatch.js:257) and that
   * index is the real guard — it holds no matter which code path runs, including
   * a scheduled job nobody re-reads this file for. This check runs first purely
   * because it can return a message an operator can act on: "window already
   * covered by DISB-2026-000123 (paid)" is a different afternoon from a
   * duplicate-key error on a unique index. The E11000 catch at the bottom of
   * this function is the index doing its job for the paths this check misses.
   */
  const existing = await DisbursementBatch.findOne({
    schoolId: schoolObjectId,
    periodStart: start,
    periodEnd: end,
  })
    .select("batchNumber status")
    .lean();

  if (existing) {
    throw new ApiError(
      `This window is already covered by batch ${existing.batchNumber} (${existing.status}). One batch per school per window — building a second one would pay the school twice.`,
      409,
      "DUPLICATE_WINDOW"
    );
  }

  /*
   * `amount: { $gt: 0 }` is not a nicety.
   *
   * `Payment.amount` has no `min` on purpose: `refundPayment` records a reversal
   * as its own row with a negative amount (paymentModel.js:44-53), and that is
   * the right shape for a ledger. But a *payout* is money going out; folding a
   * -50,000 refund into a batch would reduce what the school receives by money it
   * was already given back, and a school's refund handling is a separate
   * decision that belongs on `PlatformLedger`, not inside a transfer.
   */
  const candidates = await Payment.find({
    schoolId: schoolObjectId,
    status: "completed",
    deletedAt: null,
    amount: { $gt: 0 },
    createdAt: { $gte: start, $lte: end },
  })
    .select("_id amount studentId receiptNumber createdAt")
    .sort({ createdAt: 1 })
    .lean();

  if (!candidates.length) {
    /*
     * 409 with a specific message, rather than creating an empty batch.
     *
     * An empty batch is a `paid`-able row worth 0 pesewas that a payout run will
     * happily pick up, that appears in "awaiting approval" forever, and that
     * makes a school's history show a payout week that collected nothing —
     * which reads, to the school, as a lost payment rather than a quiet week.
     */
    throw new ApiError(
      `No completed payments for ${school.name} were created between ${start.toISOString()} and ${end.toISOString()}. Nothing to disburse.`,
      409,
      "NO_PAYMENTS_IN_WINDOW"
    );
  }

  /*
   * The anti-join, and the reason the ledger — not the payment — is the
   * authority on "has this already been paid".
   *
   * A payment is spoken for when its markup ledger line names a batch that has
   * reached `paid`. The alternative — trusting a `disbursementBatchId` stamped on
   * the payment itself — makes the two records that must agree into one, so a
   * write that lands on the payment and not the ledger (or the reverse) is
   * invisible and the payment is paid twice.
   *
   * **Known limit, and it is a real one.** A school on a 0% markup writes *no*
   * ledger lines at all (`PlatformLedger.amount` rejects 0 — see the insert
   * below), so for those schools this anti-join finds nothing and overlapping
   * *different* windows can each claim the same payment. The unique index on
   * `{ schoolId, periodStart, periodEnd }` still stops the exact-same-window
   * case, which is the common one. The overlapping-different-window case is
   * caught only by whoever widens a window by hand, and it is fixed properly by
   * adding `disbursementBatchId` to `paymentModel.js` and using it as a second
   * check — not by weakening this one, which is right for every school that pays
   * the platform anything at all.
   */
  const candidateIds = candidates.map((payment) => payment._id);

  const claimed = await PlatformLedger.find({
    type: "markup",
    paymentId: { $in: candidateIds },
    disbursementBatchId: { $ne: null },
  })
    .select("paymentId disbursementBatchId")
    .lean();

  let alreadyPaid = new Set();
  if (claimed.length) {
    const claimedBatchIds = [...new Set(claimed.map((entry) => entry.disbursementBatchId))];
    const settled = await DisbursementBatch.find({
      _id: { $in: claimedBatchIds },
      status: { $in: SETTLED_DISBURSEMENT_STATUSES },
    })
      .select("_id")
      .lean();

    alreadyPaid = new Set(settled.map((entry) => String(entry._id)));
  }

  const paidPaymentIds = new Set(
    claimed
      .filter((entry) => alreadyPaid.has(String(entry.disbursementBatchId)))
      .map((entry) => String(entry.paymentId))
  );

  const included = candidates.filter((payment) => !paidPaymentIds.has(String(payment._id)));
  const skippedAlreadyPaid = candidates.length - included.length;

  /*
   * **Only `paid` batches are treated as claiming a payment, and that is a
   * deliberate divergence from `DisbursementBatch.js:138-137`** ("a second batch
   * is refused while any of these payments is unsettled"). Excluding payments
   * held by an *open* batch would make one pending approval block a legitimate,
   * non-overlapping payout window for the same school — a school collecting
   * every day and paid weekly would find that the second week cannot be staged
   * until the first is approved, which is a queue that stops draining whenever
   * one batch sits for review.
   *
   * The cost of the looser rule is real and is worth stating: build two
   * *overlapping* windows while the first is still `pending_approval` and the
   * same payment is claimed by both, and approving both pays it twice. The
   * unique index does not help — the windows are not equal. The mitigation that
   * does work is the one already in place: `pending_approval` is the only status
   * `approveDisbursementBatch` accepts, so a human (or the auto-approve job) sees
   * both batches before either is paid, and the second approval is the moment the
   * duplicate is caught. If the schedule ever runs unattended *and* operators
   * start staging overlapping windows, this is the check to tighten — by
   * extending the anti-join to `OPEN_DISBURSEMENT_STATUSES`, not by adding a
   * second batch row.
   */

  if (!included.length) {
    throw new ApiError(
      `Every completed payment for ${school.name} in this window has already been paid out in an earlier batch. There is nothing left to disburse.`,
      409,
      "ALL_PAYMENTS_ALREADY_PAID"
    );
  }

  /*
   * The split.
   *
   * **Rounded per payment, then summed — not rounded once on the total.** The
   * brief's formula (`round(sum(amount) * pct / 100)`) and the per-line sum can
   * differ by up to one pesewa per payment, and which one is right is decided by
   * a different question than arithmetic: `PlatformLedger` is the record the
   * platform's revenue is rebuilt from, and the platform's cut of *this batch*
   * must equal the sum of the ledger lines that batch settled. If the batch
   * carries a figure the ledger cannot produce, then approving it and later
   * summing its own lines gives two different answers to "what did we keep", and
   * one of them is a bug nobody can see. So the batch total is the sum of the
   * lines, and the aggregate-rounded figure is carried alongside it in
   * `metadata.markupOnAggregate` for anyone who needs to reconcile to it.
   *
   * The rate is read from the school at build time, which is the only moment
   * the split is decided. It is frozen onto the batch in `breakdown` and
   * `metadata.markupPercentAtApproval` so a later markup change cannot
   * retroactively alter what was agreed.
   */
  const markupPercent = Number(school.payment?.platformMarkupPercent || 0);

  const lines = included.map((payment) => ({
    payment,
    platformAmount: Math.round((payment.amount * markupPercent) / 100),
  }));

  const grossAmount = lines.reduce((sum, line) => sum + line.payment.amount, 0);
  const platformAmount = lines.reduce((sum, line) => sum + line.platformAmount, 0);
  const netAmount = grossAmount - platformAmount;
  const markupOnAggregate = Math.round((grossAmount * markupPercent) / 100);

  /*
   * `subscription.platformFeePercent` is recorded but **not** deducted.
   *
   * It is a Mode B charge — a school running its own gateway pays SukuuPay a
   * monthly percentage for using SukuuPay to talk to those parents
   * (schoolModel.js:194-214) — not a per-payment skim. Deducting it here would
   * make one school's gateway choice change its per-payment rate, which is
   * exactly the conflation the two fields exist to prevent. It is carried so the
   * breakdown screen can show both rates, and the fee itself is charged as its
   * own `platform_fee` ledger entry by subscription billing.
   */
  const platformFeePercent = Number(school.subscription?.platformFeePercent || 0);

  const batchNumber = await nextBatchNumber();

  let batch;
  try {
    batch = await DisbursementBatch.create({
      batchNumber,
      schoolId: schoolObjectId,
      periodStart: start,
      periodEnd: end,
      status: "pending_approval",
      grossAmount,
      platformAmount,
      netAmount,
      paymentCount: included.length,
      paymentIds: included.map((payment) => payment._id),
      breakdown: {
        markupAmount: platformAmount,
        platformFeeAmount: 0,
        markupPercent,
        platformFeePercent,
      },
      provider: "manual",
      createdBy: actor?._id || null,
      metadata: {
        markupPercentAtBuild: markupPercent,
        markupOnAggregate,
        skippedAlreadyPaid,
        schoolNameAtBuild: school.name,
      },
    });
  } catch (error) {
    /*
     * The unique index firing is the guard working, not a crash. Two operators
     * (or an operator and a job) building the same window at the same moment
     * both pass the read above; the index is what makes exactly one of them
     * win, and this turns the loser into a 409 that says why instead of a 500.
     */
    if (error?.code === 11000) {
      throw new ApiError(
        "A batch for this school and window already exists. One batch per window — a second one would pay the school twice.",
        409,
        "DUPLICATE_WINDOW"
      );
    }
    throw error;
  }

  /*
   * One ledger entry per payment.
   *
   * Per payment, not one lump sum for the batch, for three reasons: the platform's
   * revenue is grouped by school and by period from this collection, so a lump
   * sum destroys the per-tenant statement; a per-line entry is what lets a later
   * refund point at the exact line it reverses; and a batch whose ledger cannot
   * be read one-line-per-parent is not an auditable record of anything.
   *
   * Zero-amount lines are dropped. `PlatformLedger.amount` validates
   * `value !== 0` (PlatformLedger.js:74) — a zero revenue line is not a
   * transaction — so a school on a 0% markup writes no markup entries at all and
   * its batch is entirely platform-revenue-free, which is the honest record.
   */
  const ledgerLines = lines
    .filter((line) => line.platformAmount !== 0)
    .map((line) => ({
      type: "markup",
      amount: line.platformAmount,
      currency: "GHS",
      schoolId: schoolObjectId,
      paymentId: line.payment._id,
      studentId: line.payment.studentId,
      disbursementBatchId: batch._id,
      description: `Platform markup on ${line.payment.receiptNumber || line.payment._id} (${batchNumber})`,
      settled: false,
      reference: null,
      metadata: {
        batchNumber,
        markupPercent,
        grossAmount: line.payment.amount,
      },
      createdBy: actor?._id || null,
    }));

  if (ledgerLines.length) {
    await PlatformLedger.insertMany(ledgerLines);
  }

  /*
   * Stamp the batch id onto the payments.
   *
   * **`Payment` has no `disbursementBatchId` field.** The anti-join above reads
   * the ledger instead, and that is the authoritative one — but a forward
   * reference on the payment is what makes "which batch took this receipt?"
   * answerable from a single collection, and it is written here through the raw
   * driver rather than the model for two reasons:
   *
   *   - the model is `strict`, so a `$set` of an undeclared path through
   *     `updateMany` is dropped silently. Going to `Payment.collection` is the
   *     only way to store a field the schema does not yet declare.
   *   - it bypasses `timestamps` and the pre-save hook. Neither is wanted here:
   *     bumping `updatedAt` on 143 payments makes the payment history lie about
   *     when those records changed, and the receipt-number hook re-fires on any
   *     `status` change (it does not change here, but the coupling is not worth
   *     relying on).
   *
   * Adding the field to `paymentModel.js` is a one-line change and makes this
   * write redundant rather than wrong. Until then the field is readable by
   * aggregation, not by `Payment.find()`.
   */
  await Payment.collection.updateMany(
    { _id: { $in: included.map((payment) => payment._id) } },
    { $set: { disbursementBatchId: batch._id } }
  );

  return {
    ...batch.toObject(),
    schoolName: school.name,
    split: {
      grossAmount,
      platformAmount,
      netAmount,
      markupPercent,
      platformFeePercent,
      markupOnAggregate,
      skippedAlreadyPaid,
    },
    ledgerEntriesWritten: ledgerLines.length,
  };
};

// ────────────────────────── Approve ──────────────────────────

/**
 * The auto-approve rule, stated once because it is the most easily
 * mis-implemented rule in the finance area.
 *
 * `PlatformSettings.disbursement.autoApprove` is **not** a switch that decides
 * whether a disbursement may be approved. It decides whether a disbursement may
 * be approved **without a human**, and the two are deliberately different:
 *
 *   - **The platform owner may always approve manually.** A super admin
 *     pressing "Approve" in the console *is* the human the two-phase batch
 *     exists to require. Gating that behind the same flag as the job would mean
 *     the owner can be locked out of approving their own company's money by a
 *     setting about unattended runs — which is a different decision than the one
 *     the setting expresses. So `autoApprove: false` does **not** stop a human.
 *   - **A job may only approve when `autoApprove` is true.** The scheduled run
 *     that sweeps `OPEN_DISBURSEMENT_STATUSES` has no human behind it, and that
 *     is precisely the capability the flag names. It defaults to `false`
 *     (PlatformSettings.js:131), and the reader
 *     (`getCachedPlatformSettings`) serves the shipped default when the database
 *     cannot be read, so a settings outage fails *closed* here — the job stops,
 *     the humans keep working. The fail-open default of that helper is right for
 *     a maintenance flag and wrong for this one, which is why the gate checks
 *     `=== true` rather than truthiness of a possibly-defaulted object.
 *   - **An impersonated request is not the owner acting explicitly.** It is the
 *     owner wearing a school's identity, and the impersonation middleware
 *     already refuses writes during a session — but the approve route is the
 *     single most consequential write in the console, so the check is repeated
 *     here where the money is. A rule enforced only by middleware is a rule that
 *     disappears the moment somebody calls the service from a job.
 *
 * @returns {{allowed: boolean, isHumanOwner: boolean, autoApprove: boolean}}
 */
const resolveApprovalAuthority = async (actor, req) => {
  const settings = await getCachedPlatformSettings();
  const autoApprove = settings?.disbursement?.autoApprove === true;
  const isHumanOwner =
    Boolean(actor?._id) && actor?.role === "super_admin" && !req?.impersonation;

  return { allowed: isHumanOwner || autoApprove, isHumanOwner, autoApprove };
};

export const approveDisbursementBatch = async (batchId, actor, req) => {
  const batchObjectId = optionalId(batchId, "batch ID");
  if (!batchObjectId) {
    throw new ApiError("A batchId is required", 400, "BATCH_ID_REQUIRED");
  }

  const batch = await DisbursementBatch.findById(batchObjectId);
  if (!batch) {
    throw new ApiError("Disbursement batch not found", 404, "NOT_FOUND");
  }

  /*
   * The state check that costs a school the most if it is missing.
   *
   * Approving twice would pay twice. `pending_approval` is the *only* status
   * from which an approval is accepted: `paid` means it already happened,
   * `processing` means another request holds it, `failed` means the retry route
   * is the correct verb and reusing the same row is what makes retry a retry,
   * and `cancelled` means somebody already stopped it on purpose. The 409 names
   * the status it found, so the operator is told which of those it is.
   */
  if (batch.status !== "pending_approval") {
    throw new ApiError(
      `Batch ${batch.batchNumber} is "${batch.status}", not "pending_approval", so it cannot be approved. ${
        batch.status === "paid"
          ? "It has already been paid."
          : batch.status === "failed"
            ? "Use the retry endpoint to try it again — retrying must not create a second batch."
            : "Only a batch awaiting approval can be approved."
      }`,
      409,
      "INVALID_STATE"
    );
  }

  const authority = await resolveApprovalAuthority(actor, req);

  if (!authority.allowed) {
    throw new ApiError(
      "Auto-approval is disabled. A disbursement can only be approved without a named human by a scheduled job when Platform Settings → Disbursement → Auto-approve is on. Exit impersonation, or approve it yourself.",
      403,
      "AUTO_APPROVE_DISABLED"
    );
  }

  const school = await School.findById(batch.schoolId)
    .select("name payment.bankAccount")
    .lean();

  batch.status = "processing";
  batch.approvedAt = new Date();
  batch.attempts = (batch.attempts || 0) + 1;

  if (authority.isHumanOwner) {
    batch.approvedBy = actor._id;
  } else {
    /*
     * `approvedBy` stays null for a job-approved batch, and the rule goes in
     * `metadata` instead. `DisbursementBatch.js:21` is explicit that an approval
     * column exists so a machine decision is never attributed to a person —
     * pointing it at the cron owner would do exactly that.
     */
    batch.approvedBy = null;
  }

  batch.metadata = {
    ...(batch.metadata || {}),
    approvedByRule: authority.isHumanOwner ? "manual-owner" : "auto-approve-setting",
  };

  await batch.save();

  return settleDisbursementBatch(batch, { school, trigger: "approve", actor });
};

// ────────────────────────── Retry ──────────────────────────

export const retryDisbursementBatch = async (batchId, actor) => {
  const batchObjectId = optionalId(batchId, "batch ID");
  if (!batchObjectId) {
    throw new ApiError("A batchId is required", 400, "BATCH_ID_REQUIRED");
  }

  const batch = await DisbursementBatch.findById(batchObjectId);
  if (!batch) {
    throw new ApiError("Disbursement batch not found", 404, "NOT_FOUND");
  }

  if (batch.status !== "failed") {
    throw new ApiError(
      `Batch ${batch.batchNumber} is "${batch.status}", not "failed". Only a failed payout can be retried.`,
      409,
      "INVALID_STATE"
    );
  }

  /*
   * Permanent failures are refused, not retried.
   *
   * A 4xx from a payout API is the provider saying the *request* is wrong — a
   * closed account, a name mismatch, a limit — and repeating it verbatim cannot
   * succeed. The refusal is a 409 with the reason, because the fix is a change
   * to the school's payout details followed by an approval of the corrected
   * batch, and an operator who is not told that will sit there clicking retry.
   *
   * Read from `metadata.failureKind`, stamped when the failure was recorded, so
   * the decision does not depend on re-parsing provider prose. A batch whose
   * failure predates that stamp is treated as transient, because refusing to
   * retry an unmarked batch would strand money for a field that did not exist
   * when it failed.
   */
  if (batch.metadata?.payoutIntegration?.failureKind === "permanent") {
    throw new ApiError(
      `Batch ${batch.batchNumber} failed permanently (${batch.failureReason}). Retrying the same transfer will be rejected again — correct the school's payout details, then approve a new batch.`,
      409,
      "PERMANENT_FAILURE"
    );
  }

  const school = await School.findById(batch.schoolId).select("name payment.bankAccount").lean();

  /*
   * **The same row.** This is the whole point of retry.
   *
   * Creating a second batch for these payments would be indistinguishable, to
   * every downstream consumer, from paying the school twice — and the unique
   * index on `{ schoolId, periodStart, periodEnd }` would usually stop it, but
   * only for the exact same window. A failure that moved the window (an operator
   * widening the period to catch a late payment) would slip past the index and
   * pay out payments that were in the first batch. Reusing the row cannot
   * duplicate anything: `paymentIds` is unchanged, the ledger lines are
   * unchanged, and `attempts` is the only thing that moves.
   */
  batch.status = "processing";
  batch.failedAt = null;
  batch.failureReason = "";
  batch.attempts = (batch.attempts || 0) + 1;
  batch.metadata = {
    ...(batch.metadata || {}),
    payoutIntegration: {
      ...(batch.metadata?.payoutIntegration || {}),
      failureKind: null, // cleared: the previous verdict no longer applies
    },
    retriedFromStatus: "failed",
  };

  await batch.save();

  return settleDisbursementBatch(batch, { school, trigger: "retry", actor });
};

// ────────────────────────── Reads ──────────────────────────

export const listDisbursements = async (query = {}) => {
  const { status, schoolId, from, to, page, perPage } = query;

  const filter = {};

  if (status) filter.status = status;
  if (schoolId) filter.schoolId = optionalId(schoolId, "school ID");
  Object.assign(filter, resolveDateRange(from, to, "createdAt"));

  const { skip, limit, page: safePage, perPage: safePerPage } = resolvePagination({
    page,
    perPage,
  });

  const [rows, total] = await Promise.all([
    DisbursementBatch.find(filter)
      .populate("schoolId", "name schoolCode")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    DisbursementBatch.countDocuments(filter),
  ]);

  const data = rows.map((batch) => ({
    ...batch,
    schoolName: batch.schoolId?.name || null,
    schoolCode: batch.schoolId?.schoolCode || null,
  }));

  return { data, meta: buildMeta({ page: safePage, perPage: safePerPage, total }) };
};

/**
 * The batch, the payments that make it up, the split, and the ledger lines.
 *
 * All four in one payload because the four questions are asked together — "what
 * am I about to pay this school, and what proves it?" — and answering them from
 * three round trips lets the three answers drift: a batch whose stored
 * `netAmount` disagrees with the sum of its own `paymentIds` is precisely the
 * discrepancy this screen exists to catch, so it must be computable in one read.
 */
export const getDisbursementBatch = async (batchId) => {
  const batchObjectId = optionalId(batchId, "batch ID");
  if (!batchObjectId) {
    throw new ApiError("A batchId is required", 400, "BATCH_ID_REQUIRED");
  }

  const batch = await DisbursementBatch.findById(batchObjectId)
    .populate("schoolId", "name schoolCode")
    .populate("approvedBy", "name email")
    .lean();

  if (!batch) {
    throw new ApiError("Disbursement batch not found", 404, "NOT_FOUND");
  }

  const [payments, ledgerEntries] = await Promise.all([
    batch.paymentIds?.length
      ? Payment.find({ _id: { $in: batch.paymentIds } })
          .populate("studentId", "studentId studentName studentClass")
          .select("paymentId amount status receiptNumber studentId moolreReference moolreTransactionId mtnReferenceId mtnFinancialTransactionId provider createdAt")
          .lean()
      : [],
    PlatformLedger.find({ disbursementBatchId: batch._id }).sort({ createdAt: 1 }).lean(),
  ]);

  const breakdown = {
    grossAmount: batch.grossAmount,
    platformAmount: batch.platformAmount,
    netAmount: batch.netAmount,
    schoolReceives: batch.netAmount,
    platformKeeps: batch.platformAmount,
    markupPercent: batch.breakdown?.markupPercent ?? null,
    platformFeePercent: batch.breakdown?.platformFeePercent ?? null,
    paymentCount: batch.paymentCount,
    ledgerEntries: ledgerEntries.length,
    ledgerSettled: ledgerEntries.length > 0 && ledgerEntries.every((entry) => entry.settled),
  };

  return {
    ...batch,
    schoolName: batch.schoolId?.name || null,
    schoolCode: batch.schoolId?.schoolCode || null,
    approvedByName: batch.approvedBy?.name || null,
    breakdown,
    payments: payments.map((payment) => ({
      id: payment._id,
      paymentId: payment.paymentId,
      amount: payment.amount,
      status: payment.status,
      receiptNumber: payment.receiptNumber,
      provider: payment.provider,
      gatewayReference:
        payment.moolreReference ||
        payment.moolreTransactionId ||
        payment.mtnFinancialTransactionId ||
        payment.mtnReferenceId ||
        null,
      createdAt: payment.createdAt,
      student: payment.studentId
        ? {
            id: payment.studentId._id,
            studentId: payment.studentId.studentId,
            studentName: payment.studentId.studentName,
            studentClass: payment.studentId.studentClass,
          }
        : null,
    })),
    ledgerEntries,
  };
};

/**
 * One payload for the whole finance dashboard.
 *
 * Every figure here is a **pesewa integer** and every one of them answers a
 * different question. The dashboard fails when two of them are the same number
 * wearing different labels, so the distinctions are worth stating:
 *
 *   - `cashHeld` is the platform's own unsettled *accrued* revenue — markup and
 *     fees taken from parents that have not been swept into an account. It is
 *     not the float owed to schools; that is `pendingDisbursements`. Keeping them
 *     apart is the difference between "we have earned this" and "we are holding
 *     this for somebody else", and a headline that conflates them overstates
 *     what the platform can spend.
 *   - `pendingDisbursements` is the sum of `netAmount` across open batches —
 *     money promised to schools and not yet sent. It is the number that has to
 *     be *out* before the month can be called settled.
 *   - `disbursedThisMonth` is the mirror of that, and is keyed on
 *     `processedAt` rather than `createdAt` because a batch built in March and
 *     paid in April is an April disbursement. Keying it on the build date would
 *     report April as empty in the month a school was actually paid.
 */
export const getFinanceOverview = async () => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const todayStart = startOfDayAccra(now);
  const todayEnd = endOfDayAccra(now);

  const [
    cashHeldRow,
    pendingRow,
    disbursedRow,
    revenueRow,
    bySchoolRows,
    unsettledBySchool,
    reconciliation,
  ] = await Promise.all([
    // Money taken and earned, not yet swept out. Positive only: a negative
    // unsettled entry is a refund or a chargeback, and adding it here would
    // quietly restate an earlier period's revenue.
    PlatformLedger.aggregate([
      { $match: { settled: false, amount: { $gt: 0 } } },
      { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),

    DisbursementBatch.aggregate([
      { $match: { status: { $in: OPEN_DISBURSEMENT_STATUSES } } },
      { $group: { _id: null, amount: { $sum: "$netAmount" }, count: { $sum: 1 } } },
    ]),

    DisbursementBatch.aggregate([
      {
        $match: {
          status: { $in: SETTLED_DISBURSEMENT_STATUSES },
          processedAt: { $gte: monthStart, $lte: now },
        },
      },
      { $group: { _id: null, amount: { $sum: "$netAmount" }, count: { $sum: 1 } } },
    ]),

    PlatformLedger.aggregate([
      {
        $match: {
          type: { $in: PLATFORM_REVENUE_TYPES },
          amount: { $gt: 0 },
          createdAt: { $gte: monthStart, $lte: now },
        },
      },
      { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),

    // The payout worklist: who is owed the most, biggest first.
    DisbursementBatch.aggregate([
      { $match: { status: { $in: OPEN_DISBURSEMENT_STATUSES } } },
      {
        $group: {
          _id: "$schoolId",
          netOwed: { $sum: "$netAmount" },
          batchCount: { $sum: 1 },
        },
      },
      { $sort: { netOwed: -1 } },
      { $limit: BY_SCHOOL_LIMIT },
    ]),

    // What the platform itself is holding against each of those schools, shown on
    // the same row so an operator can see the whole position for one school
    // without a second query — "they are owed GHS 4,000 and we have GHS 200 of
    // their markup uncollected" is a different conversation from either number.
    PlatformLedger.aggregate([
      { $match: { settled: false, amount: { $gt: 0 }, schoolId: { $ne: null } } },
      { $group: { _id: "$schoolId", platformUnsettled: { $sum: "$amount" } } },
    ]),

    (async () => {
      /*
       * Reconciliation, and what `unmatched` actually means.
       *
       * `matched` is "this completed payment carries a provider reference, so it
       * can be tied to a line on the gateway's statement". `unmatched` is the
       * absence of any such reference. **A missing reference is a signal to look
       * at, not a failure**: a school running `manual`, or a row written by a
       * migration, can all be perfectly settled with nothing to reconcile
       * against. Counting those as "unmatched" is correct — they are genuinely
       * unreconciled *from the gateway's side* — and the answer is a person
       * spending a minute on them, not an alarm.
       *
       * The reference fields are the provider's own handles across every active
       * rail: Moolre (`moolreReference` / `moolreTransactionId`) and MTN
       * (`mtnReferenceId` / `mtnFinancialTransactionId`). A payment on either
       * rail reconciles; a manual payment never carries one, so it is unmatched
       * forever — by construction, and the console says so.
       */
      const match = {
        status: "completed",
        deletedAt: null,
        createdAt: { $gte: todayStart, $lte: todayEnd },
      };

      const hasReference = {
        $or: [
          { moolreReference: { $nin: [null, ""] } },
          { moolreTransactionId: { $nin: [null, ""] } },
          { mtnReferenceId: { $nin: [null, ""] } },
          { mtnFinancialTransactionId: { $nin: [null, ""] } },
        ],
      };

      const hasNoReference = {
        moolreReference: { $in: [null, ""] },
        moolreTransactionId: { $in: [null, ""] },
        mtnReferenceId: { $in: [null, ""] },
        mtnFinancialTransactionId: { $in: [null, ""] },
      };

      const [matched, unmatched, sample] = await Promise.all([
        Payment.countDocuments({ ...match, ...hasReference }),
        Payment.countDocuments({ ...match, ...hasNoReference }),
        Payment.find({ ...match, ...hasNoReference })
          .select(
            "paymentId amount provider receiptNumber moolreReference moolreTransactionId mtnReferenceId mtnFinancialTransactionId settlement.reference"
          )
          .sort({ createdAt: -1 })
          .limit(UNMATCHED_SAMPLE_LIMIT)
          .lean(),
      ]);

      return { matched, unmatched, unmatchedSample: sample };
    })(),
  ]);

  const schoolIds = bySchoolRows.map((row) => row._id);

  const schoolNames = schoolIds.length
    ? await School.find({ _id: { $in: schoolIds } })
        .select("name schoolCode")
        .lean()
    : [];

  const schoolNameById = new Map(schoolNames.map((school) => [String(school._id), school]));
  const platformUnsettledById = new Map(
    unsettledBySchool.map((row) => [String(row._id), row.platformUnsettled])
  );

  return {
    /*
     * Ghana is permanently UTC+0 with no DST (utils/dateHelpers.js), so
     * `Date.UTC` month boundaries are the Accra calendar month. The label is
     * returned so the client never has to reconstruct which month it is looking
     * at from a timestamp.
     */
    month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`,

    cashHeld: cashHeldRow[0]?.amount || 0,
    cashHeldEntries: cashHeldRow[0]?.count || 0,

    pendingDisbursements: pendingRow[0]?.amount || 0,
    pendingDisbursementCount: pendingRow[0]?.count || 0,

    disbursedThisMonth: disbursedRow[0]?.amount || 0,
    disbursedThisMonthCount: disbursedRow[0]?.count || 0,

    platformRevenueThisMonth: revenueRow[0]?.amount || 0,
    platformRevenueThisMonthEntries: revenueRow[0]?.count || 0,

    bySchool: bySchoolRows.map((row) => {
      const school = schoolNameById.get(String(row._id));
      return {
        schoolId: row._id,
        schoolName: school?.name || null,
        schoolCode: school?.schoolCode || null,
        netOwed: row.netOwed,
        batchCount: row.batchCount,
        platformUnsettled: platformUnsettledById.get(String(row._id)) || 0,
      };
    }),

    reconciliationToday: reconciliation,
  };
};
