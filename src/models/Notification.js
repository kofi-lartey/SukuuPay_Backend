import mongoose from "mongoose";

const NOTIFICATION_TYPES = [
  "payment.received",
  "plan.created",
  "plan.accepted",
  "plan.overdue",
  "student.imported",
  "sms.sent",
  "subscription.expiring",
  // An unlinked account asking to join this school. Routed to existing admins
  // because a school code alone must never grant access — see SchoolJoinRequest.
  "school.join_request",
  "system.alert",

  // ── Raised by the public parent pay portal ──
  // A parent asked to split a balance, from the pay link, with no account. This
  // is the school's queue entry for work it has to do by hand, which is why it
  // needs a type of its own: "plan.created" means a bursar already approved
  // something, and a dashboard filtering on that would hide every request forever.
  "plan.requested",

  // A parent wrote in through their pay link about a balance, a payment or a
  // schedule. Not support-chat — one message, no thread — but it needs to reach the
  // bursar's notifications and not be lost in the SMS log where nothing surfaces it.
  "parent.message",
];

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      index: true,
    },
    type: {
      type: String,
      enum: NOTIFICATION_TYPES,
      required: true,
    },
    title: {
      type: String,
      required: true,
      maxlength: 120,
    },
    message: {
      type: String,
      required: true,
      maxlength: 500,
    },
    link: {
      type: String,
      default: null,
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });

// Auto-delete after 90 days so the collection does not grow unbounded.
notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 }
);

notificationSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const Notification = mongoose.model("Notification", notificationSchema);
export { NOTIFICATION_TYPES };
