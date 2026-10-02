import mongoose from "mongoose";

/**
 * The closed set of audit actions.
 *
 * Re-exported at the foot of this file, because it is a *contract*, not a local
 * detail: the validation layer filters on it, and the Activity Log screen offers
 * it as a dropdown. It used to be reachable only as the schema's own enum while
 * `validations/auditLog.validation.js` held a hand-copied 14 of these 27 — so
 * every action added below after that copy was written was unwritable through
 * the only endpoint that can filter on it.
 */
const AUDIT_ACTIONS = [
  "student.create",
  "student.update",
  "student.delete",
  "payment.success",
  "payment.failed",
  "plan.create",
  "plan.accept",
  "plan.cancel",
  "sms.send",
  "school.update",
  "user.login",
  "user.invite",
  "settings.update",
  "markup.update",
  "gateway_mode.update",
  "whatsapp.send",
  "whatsapp.bulk_send",
  "whatsapp.template_create",
  "webhook.received",
  "sms.dlr_update",
  "sms.bulk_send",
  "sms.job_cancel",
  "sms.template_create",
  "sms.template_update",
  "sms.template_delete",
  "sms.credit_topup",
  "sms.test_send",
  // Reading a report is an auditable act, and it was the one financial action
  // with a stub logger: nine report endpoints called a local `console.log` and
  // wrote nothing, so a bursar exporting the arrears ledger left no trace. For a
  // GES-facing audit trail, who looked at a debtors list is as much evidence as
  // who changed it.
  "report.viewed",
  // Who changed someone's access, and who removed an account.
  //
  // `user.invite` covers creating a colleague. These two cover everything after
  // that, and neither was logged: a role change and a removal are the two actions
  // with the widest blast radius in the product — one promotes somebody to a
  // school's full governance, the other destroys a person's access and every
  // session they hold — and both were invisible in the trail. A bursar asked to
  // prove who changed a colleague's permissions had nothing to show.
  //
  // A role change is also the route by which the platform owner could be demoted,
  // so the entry records both sides of the transition rather than only the new
  // value: "who had it, who has it now" is the whole question.
  "user.role_change",
  "user.remove",
];

const auditLogSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      // Null for platform-wide events that belong to no single school — a
      // webhook receipt for a payment or message this deployment could not
      // place, for example. Reads always filter on a concrete schoolId, so
      // these entries are simply absent from any school's log, which is the
      // correct outcome: a school must not see another school's traffic.
      default: null,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    action: {
      type: String,
      enum: AUDIT_ACTIONS,
      required: true,
      index: true,
    },
    entity: {
      type: String,
      required: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
    },
    before: {
      type: mongoose.Schema.Types.Mixed,
    },
    after: {
      type: mongoose.Schema.Types.Mixed,
    },
    ip: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: null,
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Compound indexes for the most common query patterns.
auditLogSchema.index({ schoolId: 1, createdAt: -1 });
auditLogSchema.index({ userId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

auditLogSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
export { AUDIT_ACTIONS };
