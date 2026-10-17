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

  // Parent → school messaging. See the note on `PARENT_MESSAGE_SENT` in
  // `config/constants.js`: these were attempted as `"PARENT_CONTACTED_SCHOOL"`, which
  // is in neither this list nor that map, so the write failed Mongoose validation
  // inside a try/catch that only logged. Any value added here must be added there
  // too, or the entry silently does not exist.
  "parent.message_sent",
  "parent.message_read",
  "parent.message_resolved",

  // Regulated SMS credit purchase. Kept separate because the questions asked of an
  // audit log differ per action: "who asked" is an access question, "who released the
  // units" is a money question, and "what did we buy from Arkesel" is a cost one. A
  // single `sms.updated` answers none of them.
  //
  // NOTE: any value added here must also be added to `AUDIT_ACTIONS` in
  // `config/constants.js`. The two have drifted before, and
  // `tests/contractTests.test.js` fails when they disagree — but that test asserts the
  // *parity*, not the intent, so it would happily pass with two wrong values.
  "sms.credit_request",
  "sms.pool_topup",
  "sms.request_approve",
  "sms.request_reject",

  // Advertisement requests. `ad.request` is school-originated and `ad.review` is the
  // moderator's decision — separate because "who asked" is a different question from
  // "who decided", and an audit log that conflates them answers neither.
  "ad.request",
  "ad.review",

  // ─────────────────────────────────────────────
  // Recovered vocabulary
  // ─────────────────────────────────────────────
  //
  // These were in use for years and **written to no audit row at all**:
  // `utils/auditService.log` catches the ValidationError an out-of-enum action raises,
  // so the request succeeded and the audit entry did not exist. Fifty-three call sites
  // across ten services — `CREATE`, `UPDATE`, `BULK_ARCHIVE`, `ANALYTICS_READ`,
  // `PROVISION_SCHOOL` — in UPPER_SNAKE while the surrounding vocabulary is dotted
  // lowercase.
  //
  // Normalised rather than added as written, so there is one convention.
  // `scripts/find-invalid-audit-actions.mjs` reports any literal outside this enum, and
  // `tests/contractTests.test.js` fails if this list and `AUDIT_ACTIONS` in
  // `config/constants.js` disagree.
  //
  // Any value added here must also be added there.
  //
  // ── Student lifecycle ──
  "student.archive",
  "student.restore",
  "student.suspend",
  "student.unsuspend",
  "student.reactivate",
  "student.promote",
  "student.graduate",
  "student.repeat_flag",
  "student.repeat_clear",
  "student.transfer_class",
  "student.transfer_out",
  "student.pay_link_regenerate",
  "student.parent_add",
  "student.parent_update",
  "student.parent_remove",
  "student.parent_primary_set",

  // ── Bulk operations ──
  // Prefixed `bulk.` so "was this one student or the whole school" is answerable from
  // the action alone.
  "bulk.student_create",
  "bulk.student_update",
  "bulk.student_archive",
  "bulk.student_graduate",
  "bulk.student_promote",
  "bulk.student_validate",
  "bulk.student_status",
  "bulk.student_pay_link_regenerate",

  // ── Payment plans ──
  "plan.update",
  "plan.prepay",
  "plan.payment_applied",
  "plan.installment_update",
  "plan.request",

  // ── Payments ──
  "payment.initiate",
  "payment.record_manual",
  "payment.settlement_applied",

  // ── Email ──
  "email.send",
  "email.bulk_send",
  "email.job_cancel",

  // ── School lifecycle ──
  // `school.archive` is deliberately distinct from `student.archive`. An earlier pass
  // normalised both from the bare word `ARCHIVE`, which would have made archiving a
  // school indistinguishable from archiving a student.
  "school.archive",
  "school.provision",
  "school.join_request",
  "school.join_approved",
  "school.join_rejected",

  // School assets
  //
  // Not `settings.update`, which means a *platform* setting changed.
  "school.logo_update",
  "school.stamp_update",

  // ── Academics: attendance, report cards, timetables ──────────────────────
  //
  // The three school-side writes on the academic surface. Each is its own action
  // rather than one `academic.update`, because the questions asked of each are
  // different: "who marked the roll on the day X students were absent" is an
  // attendance question, "who published a term's cards" is a disclosure question
  // (it is the moment a parent can first see a grade), and "who rewrote the
  // timetable" is a scheduling question. One action answers none of them.
  //
  // `attendance.auto_mark` is separate from `attendance.bulk_mark` because it is
  // the one mark no teacher typed: it was inferred from a handset's position, so
  // "why is this student marked present when the register says he arrived at
  // 09:40" is answerable from the trail alone.
  "attendance.bulk_mark",
  "attendance.auto_mark",
  "report_card.compile",
  "report_card.publish",
  "timetable.upsert",
  "timetable.submit",
  "timetable.withdraw",
  "timetable.approve",
  "timetable.reject",

  // ── Grade approval workflow ─────────────────────────────────────────────
  // Submit (a teacher sends a class in), approve and reject (a headmaster
  // signs off or sends it back with a reason), and reopen (a rejected block
  // goes back to draft to be edited). Kept distinct for the same reason the
  // grade writes above are: each answers a different question about who did
  // what to a mark before a parent ever saw it.
  //
  // Parity: any value here must also appear in `AUDIT_ACTIONS` in
  // `config/constants.js` (see the note near the top of this file).
  "grade.submit",
  "grade.approve",
  "grade.reject",
  "grade.reopen",

  // ── Class and subject-teacher management ────────────────────────────────
  // The decisions the headmaster makes about who teaches what, recorded as the
  // decision rather than the underlying `User.assignedClasses` row. Create and
  // archive a class name; assign the class teacher (the no-subject slot);
  // attach and detach a subject teacher.
  "class.create",
  "class.archive",
  "class.assign_teacher",
  "class.assign_subject_teacher",
  "class.unassign_subject_teacher",

  // ── Report card review, beyond compile and publish ───────────────────────
  // The headmaster's remark, and the withdrawal of a published card back into
  // review so an error can be corrected before it is republished.
  "report_card.head_remark",
  "report_card.unpublish",

  // Publishing a timetable, distinct from writing one.
  "timetable.publish",
  // Deactivating (removing from views without hard-delete), republishing,
  // and the teacher-initiated removal-request lifecycle.
  "timetable.deactivate",
  "timetable.republish",
  "timetable.remove",
  "timetable.removal_request",
  "timetable.removal_withdraw",
  "timetable.removal_approve",
  "timetable.removal_reject",

  // ── Teacher grade book writes ──
  //
  // The teacher portal's two grade writes, and the pair that answers "who put
  // this mark in and when" for the school-side marks that never appear on a
  // published card until a headteacher compiles them.
  //
  // Separate from each other for the reason the parent-messaging entries are
  // separate from each other: a single save is one student's correction and the
  // question is "who moved this child's mark", while a bulk save is a term's
  // column and the question is "how much of the class actually landed". Both
  // histories are wanted, and a single action can only hold one of them.
  //
  // As with every entry here, any value added must also be added to
  // `AUDIT_ACTIONS` in `config/constants.js` — see the note above.
  "teacher.grade.save",
  "teacher.grade.bulk.save",

  // ── Parent portal reads ───────────────────────────────────────────────────
  //
  // Unauthenticated reads, keyed by a hashed pay token. A parent opening
  // attendance, records or timetable is a record of a student's data leaving the
  // platform to a holder of that link, which is exactly the access question a
  // school asks when it asks "who has been looking at this". The token is hashed
  // before it reaches this document — see `utils/tokens.js:hashTokenForLog`.
  "parent.attendance_viewed",
  "parent.records_viewed",
  "parent.timetable_viewed",
  "parent.conversations_viewed",
  "parent.conversation_viewed",
  "parent.notifications_viewed",
  "parent.notification_read",
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
