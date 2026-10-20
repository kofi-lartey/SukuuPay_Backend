import mongoose from "mongoose";

/**
 * A school's request to buy SMS credit, and the approval that releases it.
 *
 * ## Why this is a collection and not a `Payment`
 *
 * The obvious design is to mint a `Payment` row and hang the approval off it. That was
 * the plan, and it was wrong on inspection: **`Payment.studentId` is `required: true`**
 * (`models/paymentModel.js`), and a school buying credit has no student. Relaxing it
 * would have reached into a core model that the settlement path
 * (`applyPaymentToStudent(payment.studentId, …)`), the Daily Payments report's
 * `$lookup`, the CSV export and four compound indexes all assume is always present.
 * Worse, the damage would have been silent rather than loud: an SMS purchase in the
 * fee ledger renders in Daily Payments as **"Unknown student"**, which is precisely the
 * kind of invented row the Reports module refuses to draw.
 *
 * A school's credit purchase is not a parent fee payment. It belongs beside the
 * `SmsCreditTopUp` ledger it ultimately writes to, and the payment detail lives here as
 * a subdocument — the same shape `smsCreditTopUpModel.js` already uses for
 * `reference` / `amountPes` / `provider`.
 *
 * ## What is money and what is not
 *
 * `unitPricePes` and `totalPes` are **frozen at creation**, from
 * `PlatformSettings.sms.ratePesewas`. Changing the rate must never retroactively
 * alter what a school agreed to, so the quote the bursar saw and the amount charged are
 * the same two numbers, read from this row and never from settings at read time.
 *
 * ## The states, and why money-in is not approval
 *
 *   awaiting_payment  created, the school has not paid
 *   awaiting_approval  MTN confirmed the money — a human still has to release the units
 *   approved           units drawn from the pool and credited to the school
 *   rejected           refused. Refundable, and the UI must say so
 *   cancelled          withdrawn by the school before paying
 *
 * `awaiting_approval` exists because the product requirement is that an admin *approves*
 * every purchase. A webhook that auto-credited on confirmation would make the whole
 * feature decorative, so `fulfil` deliberately stops at "tell an admin".
 */
const SMS_REQUEST_STATUSES = [
  "awaiting_payment",
  "awaiting_approval",
  "approved",
  "rejected",
  "cancelled",
];
const SMS_REQUEST_STATUS_VALUES = SMS_REQUEST_STATUSES;

const smsPurchaseRequestSchema = new mongoose.Schema(
  {
    /** Quoted to the school and shown in the admin queue. `SMS-REQ-YYYYMMDD-XXXXXX`. */
    requestId: { type: String, default: null },

    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },

    /** The staff member who asked. Not the school's owner — someone has to be named. */
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    units: {
      type: Number,
      required: true,
      min: 1,
      // Bounded by the same ceiling `admin.sms.validation.js` uses for a console
      // top-up, so the two paths cannot disagree about what a reasonable order is. A
      // school asking for 2 million units is a mistake or an abuse, and either way it
      // should not be payable.
      max: 200000,
    },

    /** Frozen at creation. See the class comment. */
    unitPricePes: { type: Number, required: true, min: 0 },

    /** Frozen: `units * unitPricePes`. */
    totalPes: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      enum: SMS_REQUEST_STATUS_VALUES,
      default: "awaiting_payment",
      index: true,
    },

    /**
     * The payment, inline.
     *
     * `reference` is our own public id and is what the school quotes; `externalId` is
     * the gateway's transaction id and is what a support conversation with MTN needs.
     * Both are kept because they are not interchangeable and only one of them is
     * meaningful to any given party.
     */
    payment: {
      /** e.g. `SMS-PAY-20260918-7KQ2M1`. Unique, and partial so a null reference is not a value. */
      reference: { type: String, default: null, trim: true },
      provider: { type: String, enum: ["mtn", "hubtel"], default: "mtn" },
      status: {
        type: String,
        enum: ["pending", "processing", "completed", "failed", "refunded"],
        default: "pending",
      },
      /** MTN's own transaction id. Null until a callback or a query resolves it. */
      financialTransactionId: { type: String, default: null, trim: true },
      /** The MTN `external_id` we sent, echoed back on the webhook. */
      externalId: { type: String, default: null, trim: true },
      /** The number prompted. Kept for a support dispute about a prompt. */
      phoneNumber: { type: String, default: null, trim: true },
      promptedAt: { type: Date, default: null },
      completedAt: { type: Date, default: null },
      /** Set when the gateway or the network refused. Shown to the school. */
      failureReason: { type: String, default: null, maxlength: 300 },
    },

    /**
     * The pool entry that released the units.
     *
     * Set on `approved`, and unique-sparse below — so a second approval cannot find a
     * free slot by writing `null` twice. See the index note.
     */
    poolEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PlatformSmsPoolEntry",
      default: null,
    },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },

    /** Required on a rejection. See `rejectSmsPurchaseRequest`. */
    decisionNote: { type: String, default: null, trim: true, maxlength: 300 },
    rejectionReason: { type: String, default: null, trim: true, maxlength: 300 },

    /**
     * Whether a refund was issued against a rejected request.
     *
     * A rejection takes the money and returns the units, so the two facts have to be
     * separable: a bursar asking "was I refunded for the request I cancelled?" needs
     * to know whether the refund actually went, not whether a rejection was recorded.
     */
    refundedAt: { type: Date, default: null },
    refundReference: { type: String, default: null, trim: true },
  },
  { timestamps: true }
);

/**
 * The school inbox and the admin queue.
 *
 * Both are `{schoolId, status, createdAt:-1}`: a school wants "mine, newest first, and
 * show me the ones still waiting", and the console wants the same thing across every
 * school. One index serves both.
 */
smsPurchaseRequestSchema.index({ schoolId: 1, status: 1, createdAt: -1 });

/** The console's approval queue across all schools. */
smsPurchaseRequestSchema.index({ status: 1, createdAt: -1 });

/**
 * At most one payment per request.
 *
 * **Partial, and the comment that used to sit here was wrong about MongoDB.**
 * It said a sparse index was enough because `payment.reference` is null until
 * the gateway is called. Sparse skips a *missing* field; `payment.reference`
 * defaults to null, so it is present, and it is indexed — as null. A sparse
 * unique index therefore allows exactly one un-initiated request in the entire
 * collection, and the second school's first request dies on E11000 with
 * `keyValue: { 'payment.reference': null }`. The partial filter is what keeps
 * the guarantee where it belongs — on the requests that carry a reference.
 */
smsPurchaseRequestSchema.index(
  { "payment.reference": 1 },
  {
    unique: true,
    partialFilterExpression: { "payment.reference": { $type: "string" } },
  }
);

/**
 * One request id per request — the handle it is quoted by.
 *
 * **Partial, and it has to be.** `requestId` defaults to null and is minted in
 * a pre-save hook, so a row that skipped the hook would carry an explicit
 * null — and MongoDB's unique index treats that as a present value and indexes
 * it as null. One such row and the collection can never hold another. The
 * partial filter keeps the uniqueness for the rows that carry an id and takes
 * the rest out of it.
 */
smsPurchaseRequestSchema.index(
  { requestId: 1 },
  { unique: true, partialFilterExpression: { requestId: { $type: "string" } } }
);

/**
 * **At most one allocation per request.**
 *
 * The idempotency guarantee for approval, and the most load-bearing index in this
 * file. `approveSmsPurchaseRequest` inserts a `PlatformSmsPoolEntry` carrying this
 * request's id; a second approval — a double-click, a retried request, two console
 * operators — collides on this index and is refused rather than allocating the units
 * twice.
 *
 * **Partial, not sparse.** `poolEntryId` defaults to null, and MongoDB's `sparse`
 * skips only a *missing* field — an explicit `null` is indexed, and indexed as
 * null. A sparse unique index over it therefore means *one request that has not
 * been approved per database*, and the second unapproved request dies on E11000
 * with `keyValue: { poolEntryId: null }`. The partial filter keeps the guarantee
 * where it belongs — on the approvals — and lets the requests waiting for one
 * exist.
 */
smsPurchaseRequestSchema.index(
  { poolEntryId: 1 },
  { unique: true, partialFilterExpression: { poolEntryId: { $type: "objectId" } } }
);

/**
 * Mints `requestId` before first write, in the shape used across the product.
 *
 * **No `next` parameter.** Mongoose 7 removed the callback argument from hooks, so a
 * hook declaring `next` and calling it threw `TypeError: next is not a function` on every
 * save — which here means a school's SMS credit purchase could not be recorded, and the
 * console's approve button had nothing to act on. Same defect as `ParentMessage.js`.
 */
smsPurchaseRequestSchema.pre("save", function mintRequestId() {
  if (!this.requestId) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    this.requestId = `SMS-REQ-${dateStr}-${Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()}`;
  }
});

smsPurchaseRequestSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export { SMS_REQUEST_STATUSES, SMS_REQUEST_STATUS_VALUES };
export const SmsPurchaseRequest = mongoose.model(
  "SmsPurchaseRequest",
  smsPurchaseRequestSchema
);
export default SmsPurchaseRequest;