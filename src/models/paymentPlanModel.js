import mongoose from "mongoose";

// ──────────────────── Installment subdocument ────────────────────
const installmentSchema = new mongoose.Schema(
  {
    installmentNumber: {
      type: Number,
      required: true,
      min: 1,
    },
    amount: {
      type: Number, // pesewas
      required: true,
      min: 1,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "paid", "partial", "overdue", "waived"],
      default: "pending",
      index: true,
    },
    amountPaid: {
      type: Number, // pesewas
      default: 0,
      min: 0,
    },
    paidAt: {
      type: Date,
      default: null,
    },
    paymentIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Payment",
      },
    ],
    reminderSentAt: {
      type: Date,
      default: null,
    },
    overdueNotifiedAt: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
  },
  { _id: true }
);

// ──────────────────── Payment plan schema ────────────────────
const paymentPlanModel = new mongoose.Schema(
  {
    // ── Identity & scope ──
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

    // ── Term scope ──
    //
    // A plan *is* term-scoped — "3-Month Plan" means "these three months of
    // Term 1 fees" — but nothing recorded that, so the compliance dashboard had
    // no way to answer the only question a school asks about its plans: how is
    // Term 1 going? Every plan ever written was in scope at once, which made
    // the figures a rolling total across years rather than a term's position.
    //
    // Denormalised from `School.academic` at creation rather than resolved on
    // read, because a school's current term moves on and a plan does not: a plan
    // created in Term 1 was always a Term 1 plan, even after the school rolls
    // over to Term 2.
    term: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    academicYear: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },

    // ── Plan basics ──
    planName: {
      type: String, // e.g. "3-Month Plan", "Term 1 Split"
      default: "Custom Plan",
      trim: true,
      maxlength: 100,
    },
    totalAmount: {
      type: Number, // pesewas — locked at creation
      required: true,
      min: 1,
    },
    numberOfInstallments: {
      type: Number,
      required: true,
      min: 2,
      max: 6,
    },
    interval: {
      type: String,
      enum: ["weekly", "biweekly", "monthly", "custom"],
      required: true,
      default: "monthly",
    },

    // ── Installments ──
    installments: {
      type: [installmentSchema],
      validate: {
        validator: function (v) {
          return v.length === this.numberOfInstallments;
        },
        message: "Number of installments must match numberOfInstallments",
      },
    },

    // ── Progress (all recomputed in the pre-save hook) ──
    totalPaid: {
      type: Number, // pesewas
      default: 0,
      min: 0,
    },
    totalRemaining: {
      type: Number, // pesewas
      default: 0,
      min: 0,
    },
    progressPercent: {
      type: Number, // 0-100
      default: 0,
      min: 0,
      max: 100,
    },
    installmentsPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    installmentsMissed: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ── Status ──
    planStatus: {
      type: String,
      enum: [
        "pending_acceptance", // created by an admin, waiting for the parent
        "active", // parent accepted, plan is running
        "completed", // every installment settled
        "defaulted", // 2+ installments missed
        "cancelled", // admin or parent cancelled
        "expired", // end date passed without completion
      ],
      default: "pending_acceptance",
      index: true,
    },

    // ── Acceptance ──
    acceptedAt: {
      type: Date,
      default: null,
    },
    acceptedVia: {
      type: String,
      enum: ["sms", "whatsapp", "admin_manual", null],
      default: null,
    },
    acceptanceToken: {
      type: String, // 6-char code the parent replies with
      select: false,
      default: null,
    },

    // ── Timing ──
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date, // due date of the last installment
      required: true,
    },
    lastReminderSentAt: {
      type: Date,
      default: null,
    },
    lastOverdueCheckAt: {
      type: Date,
      default: null,
    },

    // ── Cancellation ──
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    cancellationReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: "",
    },

    // ── Notes ──
    adminNotes: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },

    // ── Provenance ──
    //
    // `createdBy` was `required: true`, which is right for a plan a bursar wrote
    // but impossible for one a *parent* asked for: the public pay portal creates
    // plans from a pay token, with no user behind the request. Requiring it there
    // would have forced the portal to either mint a fake user id — putting a
    // non-existent actor in the audit log, which is worse than an honest null —
    // or to skip the audit trail entirely.
    //
    // So it is nullable, and `requestSource` is what makes a null *legible*
    // instead of ambiguous: an admin-created plan with a null creator is a bug, a
    // parent-requested one is routine, and an auditor can now tell them apart.
    // `createPaymentPlan` still requires a user, so this is a statement about the
    // portal rather than a loosening of the admin path.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    requestSource: {
      type: String,
      enum: ["admin", "parent_portal", null],
      default: null,
      index: true,
    },
    /**
     * Who asked, when a parent asked.
     *
     * Only populated for `requestSource: "parent_portal"`. This is deliberately a
     * *copy* of the contact details rather than a pointer into `Student.parents`:
     * the parent's own name and number are what they typed into the request, which
     * is frequently not what the school has on file (the mother is the contact, the
     * father pays), and the school needs to answer the request at the number that
     * was actually given. Overwriting the student record from an unauthenticated
     * endpoint would also be a way to rewrite a child's guardian list by guessing
     * a token.
     */
    requestedBy: {
      parentName: { type: String, trim: true, maxlength: 100, default: "" },
      parentPhone: { type: String, trim: true, maxlength: 32, default: "" },
      notes: { type: String, trim: true, maxlength: 500, default: "" },
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
// Compound indexes are declared here; single-field ones carry `index: true` on
// the path itself, including `deletedAt`. Declaring the same key in both places
// makes Mongoose warn and silently drop one definition — harmless while both are
// plain, but it would discard options such as a TTL or `unique` if either side
// ever grew them.
paymentPlanModel.index({ studentId: 1, planStatus: 1 });
paymentPlanModel.index({ schoolId: 1, planStatus: 1 });
paymentPlanModel.index({ schoolId: 1, "installments.dueDate": 1 });
paymentPlanModel.index({ endDate: 1, planStatus: 1 });
// The compliance dashboard's term filter, and the `{schoolId, term}` shape the
// term's compliance card reads. Without this the filter is a scan of every plan
// the school has ever written.
paymentPlanModel.index({ schoolId: 1, term: 1, planStatus: 1 });
// Unique across plans. The partial filter keeps plans without a token (they
// store an explicit null) out of the index so they never collide.
paymentPlanModel.index(
  { acceptanceToken: 1 },
  {
    unique: true,
    partialFilterExpression: { acceptanceToken: { $type: "string" } },
  }
);

// ── Progress recomputation ──
// Exported so callers (and tests) can refresh a plan's derived figures without
// going through a full document save.
export const recomputePlanProgress = (plan) => {
  // Recompute every progress figure from the installment array so the counters
  // can never drift from the source of truth.
  const paid = plan.installments.reduce((sum, i) => sum + (i.amountPaid || 0), 0);
  plan.totalPaid = paid;
  plan.totalRemaining = Math.max(plan.totalAmount - paid, 0);
  plan.progressPercent = plan.totalAmount
    ? Math.round((paid / plan.totalAmount) * 100)
    : 0;

  plan.installmentsPaid = plan.installments.filter((i) => i.status === "paid").length;
  plan.installmentsMissed = plan.installments.filter((i) => i.status === "overdue").length;

  // A waived installment counts as settled (the admin forgave it), so a plan
  // whose installments are all paid-or-waived is complete.
  const settled = plan.installments.filter(
    (i) => i.status === "paid" || i.status === "waived"
  ).length;

  // Auto-complete the plan.
  if (settled === plan.numberOfInstallments && plan.planStatus === "active") {
    plan.planStatus = "completed";
  }

  // Auto-default once 2+ installments have been missed.
  if (plan.installmentsMissed >= 2 && plan.planStatus === "active") {
    plan.planStatus = "defaulted";
  }

  return plan;
};

// ── Pre-save hooks ──
// No `next` parameter: mongoose does not supply a callback to a pre-save hook,
// so declaring one would shadow an unrelated argument and throw on every save.
paymentPlanModel.pre("save", function () {
  recomputePlanProgress(this);
});

// ── toJSON: strip internal/secret fields ──
paymentPlanModel.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    // The acceptance token is only ever exposed through the acceptance flow.
    delete ret.acceptanceToken;
    return ret;
  },
});

export const PaymentPlan = mongoose.model("PaymentPlan", paymentPlanModel);
