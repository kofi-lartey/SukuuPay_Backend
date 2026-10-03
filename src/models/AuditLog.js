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
  // A reversal row rather than a mutation of the original, so this is a separate
  // action and not a `payment.*` status. Must stay in step with `AUDIT_ACTIONS` in
  // `config/constants.js` — see the note there about `"REFUND_PAYMENT"` having been
  // written by `payment.service.js` and silently failing this enum for the life of
  // the feature.
  "refund.payment",
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
  "user.email_verified",
  // Google sign-in is a separate action from `user.login` rather than a note on it:
  // it skips the OTP step, so "how did this account get verified" is answerable from
  // the trail alone, and an operator auditing an account wants to see which accounts
  // have never been through the email flow at all.
  "user.google_login",
  "user.google_signup",
  "user.role_change",
  "user.remove",
  // ── Platform console ──
  //
  // A separate namespace rather than more `school.*` / `user.*` entries, because
  // these are the actions of an actor who is deliberately outside every tenant:
  // the platform owner, acting on the platform, not on a school. Grouped under
  // `admin.` so `GET /admin/audit-logs?action=` can answer "what did the owner do"
  // with one prefix filter, and so a school reading its own log can recognise at a
  // glance that these rows came from outside.
  //
  // Every one of them is written by a route in `routes/admin.routes.js`, and the
  // group has a property the earlier ones do not: they are the actions whose
  // absence would be worth money.
  //
  //   - impersonation is the owner seeing a tenant's data, so start and end are
  //     both recorded. An open-ended `start` is indistinguishable from a session
  //     that ran all night unless the end exists to close it.
  //   - a disbursement approval moves a school's money. So does a refund.
  //   - an export is a read, and the one read a school cannot audit itself: the
  //     ledger CSV leaves the platform with the tenant's whole financial history.
  "admin.impersonate_start",
  "admin.impersonate_end",
  "admin.school_create",
  "admin.school_update",
  "admin.school_archive",
  "admin.markup_update",
  "admin.platform_fee_update",
  "admin.gateway_mode_update",
  "admin.subscription_update",
  "admin.feature_flags_update",
  "admin.tags_update",
  "admin.notes_update",
  "admin.user_status_update",
  "admin.user_password_reset",
  "admin.user_verification_resend",
  "admin.disbursement_create",
  "admin.disbursement_approve",
  "admin.disbursement_retry",
  "admin.payment_refund",
  "admin.announcement_create",
  "admin.announcement_update",
  "admin.announcement_delete",
  "admin.sms_broadcast",
  "admin.sms_credit_topup",
  "admin.maintenance_mode",
  "admin.export",
  // Written by `jobs/healthCheck.job.js`, not by a request. It is here because a
  // job that stops running is invisible in every other way — and an operator
  // reading a week of health entries can see the gap that says so.
  "health.check",
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
