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
};

// Notification types — matches the Notification `type` field enum.
export const NOTIFICATION_TYPES = {
  PAYMENT_RECEIVED: "payment.received",
  PLAN_CREATED: "plan.created",
  PLAN_ACCEPTED: "plan.accepted",
  PLAN_OVERDUE: "plan.overdue",
  STUDENT_IMPORTED: "student.imported",
  SMS_SENT: "sms.sent",
  SUBSCRIPTION_EXPIRING: "subscription.expiring",
  SYSTEM_ALERT: "system.alert",
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
};

// Academic term validation
export const ACADEMIC_TERMS = ["Term 1", "Term 2", "Term 3"];

// Grading system options
export const GRADING_SYSTEMS = ["WAEC", "IB", "Cambridge", "Custom"];

// School types
export const SCHOOL_TYPES = ["public", "private", "international", "mission", "charter"];
