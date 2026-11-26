// ──────────────────── Platform constants ────────────────────
// Central, importable source of truth for enums and limits used across
// modules. Services and validators import from here so magic strings never
// drift.

export const ROLES = {
  SUPER_ADMIN: "super_admin",
  SCHOOL_ADMIN: "school_admin",
  ACCOUNTANT: "accountant",
  TEACHER: "teacher",
};

export const USER_ROLES = Object.values(ROLES);

/**
 * The roles that never run the setup wizard: they join a school that already
 * exists by entering its school code, and wait for an admin of that school to
 * approve them (`SchoolJoinRequest`).
 *
 * Only `school_admin` provisions a school. Every other self-signup role is a
 * member of somebody else's staff, so walking them through steps 2–5 — payment
 * setup, importing students, pricing, sending reminders — would ask them to
 * configure a school they do not own, and can only end in a 403.
 *
 * Read by `onboardingBlock` in `controllers/authController.js`, which turns it
 * into the `flow` and `nextRoute` the client routes on. The frontend mirrors it
 * in `frontend/src/utils/constants.js` as `joinsSchoolByCode`.
 */
export const SCHOOL_JOIN_ROLES = [
  ROLES.ACCOUNTANT,
  ROLES.TEACHER,
];

// Audit action types — matches the AuditLog `action` field enum.
export const AUDIT_ACTIONS = {
  STUDENT_CREATE: "student.create",
  STUDENT_UPDATE: "student.update",
  STUDENT_DELETE: "student.delete",
  PAYMENT_SUCCESS: "payment.success",
  PAYMENT_FAILED: "payment.failed",
  // A reversal is its own Payment with a negative amount, not a flag on the
  // original — so this is a distinct action rather than another `payment.*` status.
  // It was previously written as `"REFUND_PAYMENT"`, which is in neither this map nor
  // the `AuditLog.action` enum, so every refund in the product wrote **no audit
  // entry at all**: `auditService.log` swallowed the resulting ValidationError into a
  // `console.error`. The action the code asked for and the action the schema accepts
  // had to be the same string; they are now, and `tests/platformConsole.test.js`
  // asserts parity in both directions.
  REFUND_PAYMENT: "refund.payment",
  PLAN_CREATE: "plan.create",
  PLAN_ACCEPT: "plan.accept",
  PLAN_CANCEL: "plan.cancel",
  SMS_SEND: "sms.send",
  SCHOOL_UPDATE: "school.update",
  USER_LOGIN: "user.login",
  USER_INVITE: "user.invite",
  SETTINGS_UPDATE: "settings.update",
  MARKUP_UPDATE: "markup.update",
  GATEWAY_MODE_UPDATE: "gateway_mode.update",
  WHATSAPP_SEND: "whatsapp.send",
  WHATSAPP_BULK_SEND: "whatsapp.bulk_send",
  WHATSAPP_TEMPLATE_CREATE: "whatsapp.template_create",
  WEBHOOK_RECEIVED: "webhook.received",
  SMS_DLR_UPDATE: "sms.dlr_update",
  SMS_BULK_SEND: "sms.bulk_send",
  SMS_JOB_CANCEL: "sms.job_cancel",
  SMS_TEMPLATE_CREATE: "sms.template_create",
  SMS_TEMPLATE_UPDATE: "sms.template_update",
  SMS_TEMPLATE_DELETE: "sms.template_delete",
  SMS_CREDIT_TOPUP: "sms.credit_topup",
  SMS_TEST_SEND: "sms.test_send",
  REPORT_VIEWED: "report.viewed",
  // Must stay in step with the `AUDIT_ACTIONS` array in `models/AuditLog.js` —
  // that array is the schema enum, so a value present here and absent there is a
  // Mongoose ValidationError that `utils/auditService.log` swallows into a
  // `console.error`. The entry then does not exist, and nobody finds out.
  USER_EMAIL_VERIFIED: "user.email_verified",
  USER_GOOGLE_LOGIN: "user.google_login",
  USER_GOOGLE_SIGNUP: "user.google_signup",
  USER_ROLE_CHANGE: "user.role_change",
  USER_REMOVE: "user.remove",

  // ── Financial batches ──
  //
  // A batch is the bursar's signed packet of disbursements for a term. Four
  // actors, four actions: who drafted it, who signed it, who approved it, and
  // who rejected it. Each is a different role with a different blast radius,
  // and a single `financial.batch` status would conflate them — "who signed"
  // is the bursar and "who approved" is the headmaster, and a regulator asking
  // either question needs a different answer.
  FINANCIAL_BATCH_CREATED: "financial.batch_created",
  FINANCIAL_BATCH_SIGNED: "financial.batch_signed",
  FINANCIAL_BATCH_APPROVED: "financial.batch_approved",
  FINANCIAL_BATCH_REJECTED: "financial.batch_rejected",

  // ── Report exports / downloads ──
  //
  // `report.exported` is the moment the file leaves the platform and
  // `report.download` is the click that fetched it. Both are distinct from
  // `report.viewed` (the on-screen read) because an export is the act that
  // puts the school's whole financial history in someone's hands, and a school
  // asking "who took this data" wants the exporter's name, not the viewer's.
  REPORT_EXPORTED: "report.exported",
  REPORT_DOWNLOAD: "report.download",

  // ── Platform console ──
  //
  // Namespaced `admin.*` because these are the platform owner's actions taken
  // *outside* every tenant, not more variations on a school's own operations. Same
  // enum-parity obligation as the two entries above: every value here is also in
  // `models/AuditLog.js`, and the two files drifting apart is how an audit entry
  // silently fails to write.
  ADMIN_IMPERSONATE_START: "admin.impersonate_start",
  ADMIN_IMPERSONATE_END: "admin.impersonate_end",
  ADMIN_SCHOOL_CREATE: "admin.school_create",
  ADMIN_SCHOOL_UPDATE: "admin.school_update",
  ADMIN_SCHOOL_ARCHIVE: "admin.school_archive",
  ADMIN_MARKUP_UPDATE: "admin.markup_update",
  ADMIN_PLATFORM_FEE_UPDATE: "admin.platform_fee_update",
  ADMIN_GATEWAY_MODE_UPDATE: "admin.gateway_mode_update",
  ADMIN_SUBSCRIPTION_UPDATE: "admin.subscription_update",
  ADMIN_FEATURE_FLAGS_UPDATE: "admin.feature_flags_update",
  ADMIN_TAGS_UPDATE: "admin.tags_update",
  ADMIN_NOTES_UPDATE: "admin.notes_update",
  ADMIN_USER_STATUS_UPDATE: "admin.user_status_update",
  ADMIN_USER_PASSWORD_RESET: "admin.user_password_reset",
  ADMIN_USER_VERIFICATION_RESEND: "admin.user_verification_resend",
  ADMIN_DISBURSEMENT_CREATE: "admin.disbursement_create",
  ADMIN_DISBURSEMENT_APPROVE: "admin.disbursement_approve",
  ADMIN_DISBURSEMENT_RETRY: "admin.disbursement_retry",
  ADMIN_PAYMENT_REFUND: "admin.payment_refund",
  ADMIN_ANNOUNCEMENT_CREATE: "admin.announcement_create",
  ADMIN_ANNOUNCEMENT_UPDATE: "admin.announcement_update",
  ADMIN_ANNOUNCEMENT_DELETE: "admin.announcement_delete",
  ADMIN_SMS_BROADCAST: "admin.sms_broadcast",
  ADMIN_SMS_CREDIT_TOPUP: "admin.sms_credit_topup",
  ADMIN_MAINTENANCE_MODE: "admin.maintenance_mode",
  ADMIN_EXPORT: "admin.export",
  HEALTH_CHECK: "health.check",

  // ── Parent → school messaging ──
  //
  // These three were previously attempted as `"PARENT_CONTACTED_SCHOOL"` — an
  // UPPER_SNAKE string in a codebase whose action vocabulary is lower-case dotted,
  // present in neither this map nor the `AuditLog` enum. `utils/auditService.log`
  // swallows the resulting Mongoose ValidationError into a `console.error`, so for
  // the life of the feature **every parent message wrote no audit row at all** and
  // nobody found out, because the endpoint still returned 200. A bursar asked to
  // prove that a particular parent contacted the school about a balance dispute had
  // nothing to show. The three states a message moves through are recorded
  // separately rather than as one "contacted" action, because the interesting
  // question later is not whether it arrived but whether anyone dealt with it.
  PARENT_MESSAGE_SENT: "parent.message_sent",
  PARENT_MESSAGE_READ: "parent.message_read",
  PARENT_MESSAGE_RESOLVED: "parent.message_resolved",

  // ── Regulated SMS credit purchase ──
  //
  // Distinct actions for requesting, topping the pool up, approving and rejecting,
  // because the questions asked of an audit log differ per action: "who asked" is an
  // access question, "who released the units" is a money question, and "what did we
  // buy from Arkesel" is a cost question. One `sms.updated` entry answers none of them.
  SMS_CREDIT_REQUEST: "sms.credit_request",
  SMS_POOL_TOPUP: "sms.pool_topup",
  SMS_REQUEST_APPROVE: "sms.request_approve",
  SMS_REQUEST_REJECT: "sms.request_reject",

  // ── Advertisement requests ──
  // `ad.review` covers both decisions on purpose — approving and rejecting are the
  // same act (a moderator looked at a submission) and the outcome is on the row. The
  // school-originated `ad.request` is separate because "who asked" is a different
  // question from "who decided".
  AD_REQUEST: "ad.request",
  AD_REVIEW: "ad.review",

  // ─────────────────────────────────────────────
  // Recovered vocabulary
  // ─────────────────────────────────────────────
  //
  // These were in use for years and **written to no audit row at all**.
  //
  // `utils/auditService.log` catches the Mongoose ValidationError an out-of-enum action
  // produces and logs it, so the request succeeded and the audit entry simply did not
  // exist. Fifty-three call sites were affected — `CREATE`, `UPDATE`, `REMOVE`,
  // `BULK_ARCHIVE`, `ANALYTICS_READ`, `PROVISION_SCHOOL` — in UPPER_SNAKE while the
  // vocabulary around them is dotted lowercase. The audit log for a whole school year
  // was missing its student lifecycle, its bulk operations and its plan changes, and the
  // only symptom was a console line nobody was reading.
  //
  // They are normalised rather than added-as-written, so there is one convention. Two
  // judgement calls worth knowing about:
  //
  //  - **Bulk operations get their own `bulk.` prefix.** The question an audit log is
  //    usually asked is "was this one student or the whole school", and a prefix answers
  //    it without reading the entity id.
  //  - **`ANALYTICS_READ` became `report.viewed`**, which already existed for exactly
  //    that. Ten call sites had been inventing their own word for it.
  //
  // `scripts/find-invalid-audit-actions.mjs` reports any literal outside the enum, and
  // `tests/contractTests.test.js` fails the build if this map and the schema disagree.
  // Run the sweep after touching either.
  //
  // ── Student lifecycle ──
  STUDENT_ARCHIVE: "student.archive",
  STUDENT_RESTORE: "student.restore",
  STUDENT_SUSPEND: "student.suspend",
  STUDENT_UNSUSPEND: "student.unsuspend",
  STUDENT_REACTIVATE: "student.reactivate",
  STUDENT_PROMOTE: "student.promote",
  STUDENT_GRADUATE: "student.graduate",
  STUDENT_REPEAT_FLAG: "student.repeat_flag",
  STUDENT_REPEAT_CLEAR: "student.repeat_clear",
  STUDENT_TRANSFER_CLASS: "student.transfer_class",
  STUDENT_TRANSFER_OUT: "student.transfer_out",
  STUDENT_PAY_LINK_REGENERATE: "student.pay_link_regenerate",
  STUDENT_PARENT_ADD: "student.parent_add",
  STUDENT_PARENT_UPDATE: "student.parent_update",
  STUDENT_PARENT_REMOVE: "student.parent_remove",
  STUDENT_PARENT_PRIMARY_SET: "student.parent_primary_set",

  // ── Bulk operations ──
  BULK_STUDENT_CREATE: "bulk.student_create",
  BULK_STUDENT_UPDATE: "bulk.student_update",
  BULK_STUDENT_ARCHIVE: "bulk.student_archive",
  BULK_STUDENT_GRADUATE: "bulk.student_graduate",
  BULK_STUDENT_PROMOTE: "bulk.student_promote",
  BULK_STUDENT_VALIDATE: "bulk.student_validate",
  BULK_STUDENT_STATUS: "bulk.student_status",
  BULK_STUDENT_PAY_LINK_REGENERATE: "bulk.student_pay_link_regenerate",

  // ── Payment plans ──
  PLAN_UPDATE: "plan.update",
  PLAN_PREPAY: "plan.prepay",
  PLAN_PAYMENT_APPLIED: "plan.payment_applied",
  PLAN_INSTALLMENT_UPDATE: "plan.installment_update",
  PLAN_REQUEST: "plan.request",

  // ── Payments ──
  PAYMENT_INITIATE: "payment.initiate",
  PAYMENT_RECORD_MANUAL: "payment.record_manual",
  PAYMENT_SETTLEMENT_APPLIED: "payment.settlement_applied",

  // ── Email ──
  EMAIL_SEND: "email.send",
  EMAIL_BULK_SEND: "email.bulk_send",
  EMAIL_JOB_CANCEL: "email.job_cancel",

  // ── School lifecycle ──
  // `school.archive` is deliberately distinct from `student.archive`. An earlier pass at
  // this normalised both from the bare word `ARCHIVE`, which would have made archiving a
  // school indistinguishable from archiving a student.
  SCHOOL_ARCHIVE: "school.archive",
  SCHOOL_PROVISION: "school.provision",
  SCHOOL_JOIN_REQUEST: "school.join_request",
  SCHOOL_JOIN_APPROVED: "school.join_approved",
  SCHOOL_JOIN_REJECTED: "school.join_rejected",

  // ── School assets ──
  // `school.logo_update` rather than the existing `settings.update`, which means a
  // *platform* setting changed. Conflating the two makes the settings audit answer a
  // question it was never asked.
  SCHOOL_LOGO_UPDATE: "school.logo_update",
  SCHOOL_STAMP_UPDATE: "school.stamp_update",

  // ── Campus lifecycle ──
  // Campuses belong to a school on the Campus plan. Each mutation is its own action
  // so an auditor can answer "who created this site", "who changed it", and
  // "who retired it" separately.
  CAMPUS_CREATE: "campus.create",
  CAMPUS_UPDATE: "campus.update",
  CAMPUS_ARCHIVE: "campus.archive",

  // ── Academics: attendance, report cards, timetables ──
  //
  // Three writes, three actions, because the questions asked of each are
  // different — see the note beside the matching entries in `models/AuditLog.js`.
  // `report_card.publish` is the one worth singling out: it is the instant a
  // draft becomes readable by anyone holding the student's pay link, so it is the
  // disclosure boundary and the only entry in this group a headteacher will ever
  // be asked to prove.
  ATTENDANCE_BULK_MARK: "attendance.bulk_mark",
  ATTENDANCE_AUTO_MARK: "attendance.auto_mark",
  REPORT_CARD_COMPILE: "report_card.compile",
  REPORT_CARD_PUBLISH: "report_card.publish",
  TIMETABLE_UPSERT: "timetable.upsert",
  TIMETABLE_SUBMIT: "timetable.submit",
  TIMETABLE_WITHDRAW: "timetable.withdraw",
  TIMETABLE_APPROVE: "timetable.approve",
  TIMETABLE_REJECT: "timetable.reject",
  TIMETABLE_DEACTIVATE: "timetable.deactivate",
  TIMETABLE_REPUBLISH: "timetable.republish",
  TIMETABLE_REMOVE: "timetable.remove",
  TIMETABLE_REMOVAL_REQUEST: "timetable.removal_request",
  TIMETABLE_REMOVAL_WITHDRAW: "timetable.removal_withdraw",
  TIMETABLE_REMOVAL_APPROVE: "timetable.removal_approve",
  TIMETABLE_REMOVAL_REJECT: "timetable.removal_reject",

  // ── Grade approval workflow ─────────────────────────────────────────────
  //
  // The review layer the headmaster runs over the marks a class teacher typed.
  // Four actions rather than one `grade.update`, because the four questions an
  // auditor asks are different: "who sent this class in for review", "who
  // signed it off", "who sent it back and why", and "who reopened a rejected
  // block". The first and last are a teacher's; the middle two are a
  // headmaster's. Every value here must also appear in the `AUDIT_ACTIONS`
  // enum in `models/AuditLog.js` — see the parity note there.
  GRADE_SUBMIT: "grade.submit",
  GRADE_APPROVE: "grade.approve",
  GRADE_REJECT: "grade.reject",
  GRADE_REOPEN: "grade.reopen",

  // ── Class and subject-teacher management ────────────────────────────────
  //
  // Classes are names (`School.academic.classes`), not documents, and a
  // teacher's link to a class lives on their own account
  // (`User.assignedClasses`). So "assigning a teacher" is a write to a *user*,
  // and `class.*` here names the *decision* rather than the row it wrote. The
  // questions differ: creating a class, retiring one, naming the class teacher
  // (the class-teacher slot, no subject), attaching a subject teacher to a
  // subject, and detaching one again.
  CLASS_CREATE: "class.create",
  CLASS_ARCHIVE: "class.archive",
  CLASS_ASSIGN_TEACHER: "class.assign_teacher",
  CLASS_ASSIGN_SUBJECT_TEACHER: "class.assign_subject_teacher",
  CLASS_UNASSIGN_SUBJECT_TEACHER: "class.unassign_subject_teacher",

  // ── Report card review, beyond compile and publish ───────────────────────
  //
  // The headmaster's remark and the withdrawal of a published card. Unpublish
  // is the correction path: an error found after the parents have seen it sends
  // `published → review`, and the trail must show who pulled it back. PUBLISH
  // above is reused for the disclosure moment itself — one action, one meaning.
  REPORT_CARD_HEAD_REMARK: "report_card.head_remark",
  REPORT_CARD_UNPUBLISH: "report_card.unpublish",

  // Publishing a timetable is a separate action from writing one (`upsert`
  // above): writing is a schedule change, publishing is the moment the grid
  // becomes readable through every pay link in that class.
  TIMETABLE_PUBLISH: "timetable.publish",

  // ── Teacher grade book writes ──
  //
  // The teacher portal's two grade writes, namespaced `teacher.*` so they sort
  // beside the school-side academic actions and read as what they are: a class
  // teacher entering marks, not a headteacher publishing a term.
  //
  // Two actions rather than one, because the questions asked of each are
  // different. A single save is a correction — "why did this child's mark move
  // from 62 to 68" — and the answer must name one student and one score. A bulk
  // save is a term's column going in at once, and the answer that matters is
  // "how many of the 45 landed and how many failed", which is a count, not a
  // name. One action would have to record one of those and drop the other.
  //
  // Neither is `report_card.compile`: compiling reads the grade book and turns
  // it into a terminal report, and it already has its own entry above. These
  // two are the marks themselves.
  TEACHER_GRADE_SAVE: "teacher.grade.save",
  TEACHER_GRADE_BULK_SAVE: "teacher.grade.bulk.save",

  // ── Teacher punctuality ──
  //
  // A teacher accepting their current period through the dashboard's
  // CurrentPeriodWidget, and the scheduled sweep that marks periods the
  // teacher never accepted as missed. The accept is a person's action — it
  // names the teacher, and the audit row says so. The sweep is the
  // scheduler's: there is no actor, so `userId` is null and the row is the
  // durable record that the sweep ran and what it marked.
  TEACHER_PERIOD_ACCEPT: "teacher.period.accept",
  TEACHER_ATTENDANCE_SWEEP: "teacher.attendance.sweep",

  // ── Parent portal reads ──
  // Unauthenticated reads through a pay token, hashed before logging
  // (`utils/tokens.js:hashTokenForLog`). Recorded for the same reason
  // `report.viewed` is: an access to a student's record is evidence whether or
  // not anything changed, and a school asking "who has seen this child's grades"
  // deserves an answer that is more specific than "nobody knows".
  PARENT_ATTENDANCE_VIEWED: "parent.attendance_viewed",
  PARENT_RECORDS_VIEWED: "parent.records_viewed",
  PARENT_TIMETABLE_VIEWED: "parent.timetable_viewed",
  PARENT_CONVERSATIONS_VIEWED: "parent.conversations_viewed",
  PARENT_CONVERSATION_VIEWED: "parent.conversation_viewed",
  PARENT_NOTIFICATIONS_VIEWED: "parent.notifications_viewed",
  PARENT_NOTIFICATION_READ: "parent.notification_read",

  // ── Financial batches (multi-signatory approvals) ──
  //
  // A disbursement batch moves money only after it has been created, signed by
  // the required signatories, and approved. The three states are separate
  // actions because the questions asked of them are different: "who proposed
  // this batch", "who signed it", and "who released the funds". A rejection is
  // recorded too, so an audit trail can show a batch was stopped rather than
  // simply never finished.
  FINANCIAL_BATCH_CREATED: "financial.batch_created",
  FINANCIAL_BATCH_SIGNED: "financial.batch_signed",
  FINANCIAL_BATCH_APPROVED: "financial.batch_approved",
  FINANCIAL_BATCH_REJECTED: "financial.batch_rejected",
};

/**
 * Every audit action, as a flat array.
 *
 * Exported because `GET /admin/audit-logs` validates `action` against the enum, and
 * a filter dropdown built from `Object.values(AUDIT_ACTIONS)` can only offer actions
 * that a caller can actually pass. The alternative — a hand-written list in the
 * validation schema — is how `auditLog.validation.js` ended up holding 14 of the
 * 27 that existed, and every action added afterwards was unwritable through the one
 * endpoint that filters on it.
 */
export const AUDIT_ACTION_VALUES = Object.values(AUDIT_ACTIONS);

// Notification types — matches the Notification `type` field enum.
//
// **This map and the enum in `models/Notification.js` had drifted**: this side held
// 8 values while the schema held 11, and the three missing ones were exactly the types
// raised from the public parent pay portal. Nothing threw — `Notification.type` is
// validated against the *model's* enum, which was the longer list — so every parent
// message wrote its row successfully. What broke was every read path that filters on
// this map: `validations/notification.validation.js` validated `?type=` against a
// hand-written copy of this list, so `GET /notifications?type=parent.message` returned
// 422 for a type that demonstrably existed in the collection. The school could not
// open the one inbox that was supposed to tell them a parent had called.
//
// The values below are now declared here and imported by the validation schema, so
// there is one list to keep correct rather than three.
export const NOTIFICATION_TYPES = {
  PAYMENT_RECEIVED: "payment.received",
  PLAN_CREATED: "plan.created",
  PLAN_ACCEPTED: "plan.accepted",
  PLAN_OVERDUE: "plan.overdue",
  STUDENT_IMPORTED: "student.imported",
  SMS_SENT: "sms.sent",
  SUBSCRIPTION_EXPIRING: "subscription.expiring",
  SYSTEM_ALERT: "system.alert",

  // ── Raised from the public parent pay portal ──
  /** An unlinked account asking to join a school. Routed to existing admins. */
  SCHOOL_JOIN_REQUEST: "school.join_request",
  /** A parent asked to split a balance. The school's queue entry for manual work. */
  PLAN_REQUESTED: "plan.requested",
  /** A parent cancelled their own payment plan. The school is told the balance is due again. */
  PLAN_CANCELLED: "plan.cancelled",
  /** A parent wrote in about a balance, a payment or a schedule. */
  PARENT_MESSAGE: "parent.message",
  /** A parent attached a voice note to the pay portal. Carries `meta.audioUrl`. */
  PARENT_AUDIO_MESSAGE: "parent.audio_message",

  // ── Regulated SMS credit purchase ──
  /** A school asked to buy credit and is awaiting its MoMo prompt or its payment. */
  SMS_REQUEST: "sms.request",
  /** An admin released the units. Goes to the school, not the platform. */
  SMS_REQUEST_APPROVED: "sms.request_approved",
  SMS_REQUEST_REJECTED: "sms.request_rejected",

  // ── Advertisement requests ──
  /** A school submitted an advertisement for review. Goes to the platform. */
  AD_REQUEST: "ad.request",
  AD_APPROVED: "ad.approved",
  AD_REJECTED: "ad.rejected",
};

/**
 * What a `Payment` — or, since SMS and ID-card purchases deliberately do **not** mint
 * one, an order's inline `payment` subdocument — is paying for.
 *
 * Present because "what did this money buy?" is a question that has to have an answer
 * on the row, not in the service that happened to create it. A school admin looking at
 * a receipt needs it, and a support conversation about an unexplained debit needs it.
 *
 * `studentId` is `required: true` on `Payment`, so a school's credit purchase cannot be
 * a `Payment` without loosening a field that settlement, the Daily Payments report and
 * four compound indexes all depend on — and would then render in that report as
 * "Unknown student". So these live on their own collections instead, and this list is
 * the vocabulary they share.
 */
export const PURCHASE_PURPOSES = ["sms_credit", "id_card_print"];

/** States a `SmsPurchaseRequest` moves through. Mirrored on the model's enum. */
export const SMS_REQUEST_STATUS = {
  AWAITING_PAYMENT: "awaiting_payment",
  AWAITING_VERIFICATION: "awaiting_verification",
  AWAITING_APPROVAL: "awaiting_approval",
  APPROVED: "approved",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
};
export const SMS_REQUEST_STATUS_VALUES = Object.values(SMS_REQUEST_STATUS);

/** Sign convention for the pool ledger — see `models/PlatformSmsPoolEntry.js`. */
export const PLATFORM_SMS_POOL_DIRECTIONS = ["topup", "allocation", "reversal"];
export const PLATFORM_SMS_POOL_DIRECTION_VALUES = PLATFORM_SMS_POOL_DIRECTIONS;

export const NOTIFICATION_TYPE_VALUES = Object.values(NOTIFICATION_TYPES);

// ID card batch statuses
export const ID_CARD_BATCH_STATUS = {
  PENDING: "pending",
  GENERATING: "generating",
  READY: "ready",
  FAILED: "failed",
};

export const ID_CARD_BATCH_STATUS_VALUES = Object.values(ID_CARD_BATCH_STATUS);

// MoMo networks for payment configuration
export const MOMO_NETWORKS = ["MTN", "VODAFONE", "AIRTELTELIGO"];

// SMS providers
//
// `moolre` is first because it is the platform default: Moolre carries both
// payments and SMS on one wallet, so a school on Moolre needs one vendor and
// one balance. The others remain for schools that have not migrated.
export const SMS_PROVIDERS = ["moolre", "arke", "mnotify"];

// ── WhatsApp ──
// Message categories, shared by single sends, bulk jobs and the conversation log.
export const WHATSAPP_MESSAGE_TYPES = [
  "general",
  "balance",
  "payment",
  "payment_plan",
  "academic",
  "announcement",
  "emergency",
  "receipt",
];

// Delivery state of one message. Terminal states are the last three; the
// conversation view and the DMR reconciliation both key off that grouping.
export const WHATSAPP_MESSAGE_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "ignored",
];

// What kind of payload the message actually is. Kept separate from `type`
// (business category) because a template is both an approved "template" and,
// say, a "payment_plan" message.
export const WHATSAPP_MESSAGE_KINDS = [
  "text",
  "template",
  "image",
  "document",
  "interactive",
  "status",
  "unsupported",
];

// Template lifecycle. A template may only be sent while it is `approved`,
// which is what Meta's own console enforces.
export const WHATSAPP_TEMPLATE_STATUSES = [
  "draft",
  "pending",
  "approved",
  "rejected",
  "paused",
];

// WhatsApp template categories, as Meta names them.
export const WHATSAPP_TEMPLATE_CATEGORIES = [
  "MARKETING",
  "UTILITY",
  "AUTHENTICATION",
];

// ── SMS delivery reports ──
// `unknown` exists because providers report codes we have not mapped yet; the
// raw payload is retained so the mapping can be extended without a data loss.
export const SMS_DELIVERY_STATUSES = [
  "queued",
  "submitted",
  "sent",
  "delivered",
  "failed",
  "rejected",
  "unknown",
];

// ── Inbound webhook providers ──
export const WEBHOOK_PROVIDERS = ["arkesel"];

// ── SMS reminders ──
// Business category of a fee-reminder SMS. `custom` is the free-form bucket; the
// rest exist so a school can filter its history by *why* something was sent
// without parsing the body text, which is a lossy way to ask that question.
export const SMS_CATEGORIES = [
  "fee_reminder",
  "overdue",
  "final_warning",
  "payment_receipt",
  "installment_due",
  "announcement",
  "pta",
  "custom",
];

// How a broadcast chose its recipients. Each resolves to a Student query at send
// time rather than to a stored list, so "all owing" reflects the ledger as of
// the moment of sending, not as of when the job was accepted.
export const SMS_AUDIENCE_TYPES = [
  "all_owing",
  "overdue",
  "installment_due_soon",
  // Installment-plan families who have either slipped a tranche or have one
  // about to come due. Not derivable from the two rules above: `overdue` here
  // means past the *term deadline* plus its grace period, whereas a plan can be
  // in default months before the term is up. This is the union the compliance
  // dashboard's "chase the at-risk" action needs, and it is why the two notions
  // are kept apart rather than folded into one flag.
  "at_risk",
  "class",
  "students",
  "all",
];

// Bulk-send lifecycle. `scheduled` is a `queued` job that has a future
// `scheduledAt`; it is stored distinctly so the UI can separate "waiting its
// turn" from "waiting for the clock".
export const SMS_JOB_STATUSES = [
  "queued",
  "scheduled",
  "processing",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
];

// The four preset templates seeded per school on first use. `required` is a hint
// to the composer's token row, not a rule — a school may send a custom template
// with any subset of tokens.
export const SMS_PRESET_TEMPLATES = [
  {
    key: "gentle_prompt",
    name: "Gentle Prompt",
    category: "fee_reminder",
    body: "Dear {parentName}, {studentName} owes GHC {balance} for this term at {schoolName}. Please pay via MTN MoMo, Telecel Cash or AirtelTigo: {payLink}",
    requiredTokens: ["balance", "payLink"],
  },
  {
    key: "final_warning",
    name: "Final Warning",
    category: "final_warning",
    body: "Dear {parentName}, this is a final reminder for {studentName}'s GHC {balance} outstanding at {schoolName}. Fees must be cleared by {dueDate}. Pay now: {payLink}",
    requiredTokens: ["balance", "dueDate", "payLink"],
  },
  {
    key: "pta_special",
    name: "PTA Special",
    category: "pta",
    body: "Dear {parentName}, the PTA of {schoolName} requests GHC {balance} from you for {studentName}. Pay via {payLink}. Thank you.",
    requiredTokens: ["balance", "payLink"],
  },
  {
    key: "custom",
    name: "Custom Message",
    category: "custom",
    body: "Dear {parentName}, kindly settle the outstanding balance of GHC {balance} for {studentName} at {schoolName}. Payment link: {payLink}",
    requiredTokens: ["balance", "payLink"],
  },
];

// The token vocabulary offered in the composer. A template may use any subset, and
// in any order, and may repeat one.
export const SMS_TOKENS = [
  "parentName",
  "studentName",
  "studentClass",
  "balance",
  "amountPaid",
  "dueDate",
  "schoolName",
  "payLink",
  "term",
];

// ── Limits ──
export const LIMITS = {
  AUDIT_LOG_CSV_CAP: 50000,
  MAX_UPLOAD_SIZE_STUDENT_PHOTO: 2 * 1024 * 1024, // 2 MB
  MAX_UPLOAD_SIZE_SCHOOL_LOGO: 1 * 1024 * 1024, // 1 MB
  MAX_UPLOAD_SIZE_ZIP: 50 * 1024 * 1024, // 50 MB
  MAX_BULK_PHOTO_FILES: 2000,
  MIN_IMAGE_DIMENSION: 200,
  ID_CARD_PHOTO_SIZE: 400,
  SCHOOL_LOGO_SIZE: 512,
  NOTIFICATIONS_TTL_DAYS: 90,
  MAX_CLASSES_PER_SCHOOL: 50,
  MAX_CLASSES_PER_BULK: 50,
  MAX_NOTIFICATIONS_PAGE: 100,
  MAX_AUDIT_LOG_PAGE: 100,
  MAX_CONVERSATION_PAGE: 100,
  MAX_WHATSAPP_MESSAGE_BODY: 4096,
  MAX_SMS_MESSAGE_BODY: 480, // a single SMS part; longer copy is concatenated by the gateway
  // A part is 160 GSM-7 characters, so 10 parts is a 1,600-character message.
  // The cap is a cost decision, not a technical limit: past 10 parts the send
  // costs more than the reminder is worth to most schools, and the composer
  // shows the running cost so a user chooses to overspend rather than tripping
  // a limit they cannot see.
  MAX_SMS_PARTS: 10,
  // Recipients one request may name explicitly. Bulk sends are resolved server
  // side from filters; this bounds the hand-picked list, which is the only path
  // that scales with the request body.
  MAX_SMS_SEND_BATCH: 500,
  // Recipient ceiling for one broadcast. 10,000 parents is beyond any Ghanaian
  // school's enrolment, so exceeding it is a filter bug rather than a real
  // send — caught before the job is created, not during it.
  MAX_SMS_JOB_BATCH: 10000,
  MAX_SMS_CREDIT_TOP_UP_UNITS: 1000000,
  // How far ahead a broadcast can be scheduled. Beyond a fortnight the "send
  // later" affordance starts to be a calendar reminder wearing a send button's
  // clothes, and the balance shown at scheduling will be stale by the time it
  // runs.
  MAX_SMS_SCHEDULE_DAYS: 14,
};

// What one SMS credit is worth, in pesewas — GHC 0.12 per delivered message.
//
// A top-level export rather than a `LIMITS` key, because it is a price and not a
// ceiling. It lives here for the same reason: two places need it and they must
// not disagree. The composer's "estimated broadcast cost" and the balance pill
// that shows the cedi equivalent beside the credit count both multiply by it, and
// a bursar who sees "1,420 (GHC 170.40)" in the header and "GHC 10.44" in the
// composer is doing 1420 × 0.12 in their head and had better get the same answer
// both times.
export const SMS_CREDIT_RATE_PES = 12;

// Academic term validation
export const ACADEMIC_TERMS = ["Term 1", "Term 2", "Term 3"];

// Grading system options
export const GRADING_SYSTEMS = ["WAEC", "IB", "Cambridge", "Custom"];

// School types
export const SCHOOL_TYPES = ["public", "private", "international", "mission", "charter"];

// ── Campus tier ──
//
// The subscription plan that unlocks multi-campus operation, and the capability
// flags that plan is expected to carry. Kept as plain exports so plan checks and
// feature gates read the same strings rather than re-typing them.
export const CAMPUS_PLAN = "campus";
export const CAMPUS_FEATURE_FLAGS = [
  "multi_campus",
  "multi_signatory",
  "moe_reports",
  "lms_multi_campus",
];

// ── Subscription plan normalization ──
//
// `subscription.plan` may be stored with a status suffix concatenated to it
// (e.g. `"campusactive"` instead of `"campus"`). Every plan comparison reads
// the raw enum value, so a concatenated value never matches `CAMPUS_PLAN` and
// silently revokes campus entitlements. Strip any trailing status suffix so the
// plan portion is recovered; already-clean values pass through unchanged.
export const SUBSCRIPTION_PLANS = [
  "trial", "free", "starter", "growth",
];
export const SUBSCRIPTION_STATUSES = ["active", "suspended", "expired", "cancelled", "pending"];

// ── Legacy plan aliases ──
//
// The published tier structure is Free / Starter / Growth. Older records
// (and any status-suffixed value such as `"premiumactive"`) may still carry
// a retired plan name. Map every retired name onto its surviving tier so a
// legacy school keeps the entitlements and billing it was sold:
//
//   basic      → free     (the old entry-level paid name, now Free)
//   standard   → starter  (the old mid name, now Starter)
//   premium    → growth   (the old top name, now Growth — GH₵ 275)
//   enterprise → growth   (custom top tier folds into Growth)
export const LEGACY_PLAN_ALIASES = {
  basic: "free",
  standard: "starter",
  premium: "growth",
  enterprise: "growth",
};

/**
 * Recover the plan portion of a `subscription.plan` value that may carry a
 * status suffix (e.g. `"campusactive"` -> `"campus"`). Clean values pass
 * through unchanged. Unknown values are returned as-is so callers can still
 * surface them in error metadata.
 */
export const normalizePlan = (plan) => {
  if (!plan || typeof plan !== "string") return plan;
  const lower = plan.toLowerCase();
  if (SUBSCRIPTION_PLANS.includes(lower)) return plan;
  for (const status of SUBSCRIPTION_STATUSES) {
    if (lower.endsWith(status)) {
      const candidate = plan.slice(0, -status.length);
      if (SUBSCRIPTION_PLANS.includes(candidate.toLowerCase())) return candidate;
      // A retired name with a status suffix (e.g. "premiumactive").
      const aliased = LEGACY_PLAN_ALIASES[candidate.toLowerCase()];
      if (aliased) return aliased;
    }
  }
  // A bare retired name (e.g. "premium").
  return LEGACY_PLAN_ALIASES[lower] || plan;
};
