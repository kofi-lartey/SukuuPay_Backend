// ──────────────────── Platform constants ────────────────────
// Central, importable source of truth for enums and limits used across
// modules. Services and validators import from here so magic strings never
// drift.

export const ROLES = {
  SUPER_ADMIN: "super_admin",
  SCHOOL_ADMIN: "school_admin",
  ACCOUNTANT: "accountant",
  TEACHER: "teacher",
  VIEWER: "viewer",
};

export const USER_ROLES = Object.values(ROLES);

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
  /** A parent wrote in about a balance, a payment or a schedule. */
  PARENT_MESSAGE: "parent.message",
  /** A parent attached a voice note to the pay portal. Carries `meta.audioUrl`. */
  PARENT_AUDIO_MESSAGE: "parent.audio_message",
};

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
export const SMS_PROVIDERS = ["hubtel", "arke", "mnotify"];

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
export const WEBHOOK_PROVIDERS = ["hubtel", "arkesel"];

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
