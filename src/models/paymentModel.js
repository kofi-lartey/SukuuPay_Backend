import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    // ── Identity ──
    paymentId: {
      type: String,
      unique: true,
      trim: true,
      index: true,
    },

    // ── References ──
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    // Set when the payment settles an installment on a payment plan; the
    // webhook uses it to apply the money to the right plan.
    paymentPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PaymentPlan",
      default: null,
      index: true,
    },

    // ── Payment details ──
    amount: {
      type: Number,
      required: true,
      // **No `min`**, because a refund row is written with a negative amount.
      //
      // `refundPayment` in payment.service.js records the reversal as its own
      // Payment with `amount: -refundAmount` — a deliberate design choice, so the
      // ledger stays additive and a full reversal shows up alongside the original
      // row that cancelled it. `min: 0` rejected that document at validation, so
      // `POST /payments/:paymentId/refund` failed with a 500 on *every* refund,
      // including partial ones. The invariant this field actually has is "a
      // payment is not zero", which is asserted below; the sign is meaningful and
      // carries the direction of the entry.
      validate: {
        validator: (value) => value !== 0,
        message: "A payment amount cannot be zero — use the status field to void a payment",
      },
      validate: {
        validator: (v) => Number.isInteger(v),
        message: "Amount must be an integer number of pesewas",
      },
    },
    currency: {
      type: String,
      default: "GHS",
      enum: ["GHS"],
    },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "cancelled", "refunded"],
      default: "pending",
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: ["momo", "card", "bank_transfer", "cash"],
      default: "momo",
    },
    provider: {
      type: String,
      enum: ["hubtel", "arke", "mnotify", "manual", "mtn"],
      default: "hubtel",
      index: true,
    },

    // ── MTN MoMo specific fields ──
    mtnReferenceId: {
      type: String,
      default: null,
      index: true,
    },
    mtnFinancialTransactionId: {
      type: String,
      default: null,
      index: true,
    },
    mtnResponseCode: {
      type: String,
      default: null,
    },
    mtnResponseMessage: {
      type: String,
      default: null,
    },
    mtnStatusReason: {
      type: String,
      default: null,
    },

    // ── Hubtel/MoMo specific fields ──
    hubtelTransactionId: {
      type: String,
      default: null,
      index: true,
    },
    hubtelOrderId: {
      type: String,
      default: null,
    },
    hubtelResponseCode: {
      type: String,
      default: null,
    },
    hubtelResponseMessage: {
      type: String,
      default: null,
    },
    momoPhoneNumber: {
      type: String,
      default: null,
    },
    momoNetwork: {
      type: String,
      enum: ["MTN", "VODAFONE", "AIRTELTELIGO", "UNKNOWN"],
      default: "UNKNOWN",
    },

    // ── Description & metadata ──
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    invoiceNumber: {
      type: String,
      trim: true,
      maxlength: 50,
    },
    feesBreakdown: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },

    // ── Timestamps ──
    initiatedAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },
    refundedAt: {
      type: Date,
      default: null,
    },

    // ── Webhook / callback data ──
    webhookPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    webhookReceivedAt: {
      type: Date,
      default: null,
    },

    // ── Settlement ──
    // The stamp that makes a payment confirmation idempotent. A gateway retries
    // until it gets a 2xx, and the same "payment succeeded" callback routinely
    // arrives two or three times; without this claim each retry would run the
    // $inc on the student's totalPaid again and credit the parent multiple
    // times. Set atomically, before the balance updates, so two concurrent
    // retries cannot both win.
    settlement: {
      appliedAt: { type: Date, default: null },
      reference: { type: String, default: null },
    },

    // ── Receipt ──
    receiptNumber: {
      type: String,
      unique: true,
      trim: true,
      index: true,
    },
    receiptGeneratedAt: {
      type: Date,
      default: null,
    },

    // ── Audit ──
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

// ── Indexes ──
paymentSchema.index({ schoolId: 1, status: 1 });
paymentSchema.index({ schoolId: 1, createdAt: -1 });
paymentSchema.index({ studentId: 1, status: 1 });
paymentSchema.index({ paymentPlanId: 1, status: 1 });

// ── Pre-save hooks ──
// No `next` parameter: mongoose does not supply a callback to a pre-save hook,
// so declaring one would shadow an unrelated argument and throw on every save.
paymentSchema.pre("save", async function () {
  // Auto-generate paymentId if missing
  if (!this.paymentId) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    this.paymentId = `PAY-${dateStr}-${random}`;
  }

  // Auto-generate receipt number for completed payments
  if (this.status === "completed" && !this.receiptNumber) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const count = await mongoose.model("Payment").countDocuments({
      schoolId: this.schoolId,
      status: "completed",
      createdAt: {
        $gte: new Date(new Date().setHours(0, 0, 0, 0)),
        $lt: new Date(new Date().setHours(23, 59, 59, 999)),
      },
    });
    this.receiptNumber = `RCP-${dateStr}-${String(count + 1).padStart(4, "0")}`;
    this.receiptGeneratedAt = new Date();
  }

  // Set completedAt when status changes to completed
  if (this.isModified("status") && this.status === "completed" && !this.completedAt) {
    this.completedAt = new Date();
  }

  // Set failedAt when status changes to failed
  if (this.isModified("status") && this.status === "failed" && !this.failedAt) {
    this.failedAt = new Date();
  }

  // Set refundedAt when status changes to refunded
  if (this.isModified("status") && this.status === "refunded" && !this.refundedAt) {
    this.refundedAt = new Date();
  }
});

// ── toJSON: strip sensitive fields ──
paymentSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    delete ret.webhookPayload;
    return ret;
  },
});

export const Payment = mongoose.model("Payment", paymentSchema);