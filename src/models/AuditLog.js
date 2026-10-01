import mongoose from "mongoose";

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
