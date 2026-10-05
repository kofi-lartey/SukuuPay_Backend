import mongoose from "mongoose";
import { NOTIFICATION_TYPE_VALUES } from "../config/constants.js";

/*
 * The enum is the shared list, imported rather than written out here.
 *
 * This file carried its own copy of eleven values. `config/constants.js` had grown to
 * eighteen — `parent.audio_message`, `sms.request`, `sms.request_approved`,
 * `sms.request_rejected`, `ad.request`, `ad.approved`, `ad.rejected` were added to it
 * and never to this list — and `Notification.type` is `enum`-validated against *this*
 * one. So Mongoose rejected every notification carrying one of those seven types.
 *
 * The failure was invisible in the worst way. `notifyAdmins` in `pay.service.js:818`
 * catches the write error and returns `{ written: 0 }`, deliberately, so that a failed
 * announcement cannot turn a parent's successful request into an error they retry. The
 * consequence is that **a parent's voice note created its `ParentMessage` row and
 * notified nobody**: no bell entry, no badge, no "waiting for an answer" count. The
 * message existed, in the inbox, and nobody was told. The same held for every SMS
 * credit purchase notification and every advertisement request.
 *
 * Importing the values makes that impossible to repeat. A type is now addable in one
 * place, and it is filterable (`validations/notification.validation.js` reads the same
 * export), storable and renderable the moment it exists.
 */
const NOTIFICATION_TYPES = NOTIFICATION_TYPE_VALUES;

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

// Re-exported so any importer of this module's list keeps working. It is now the same
// array as `NOTIFICATION_TYPE_VALUES`, which is the point: there is one list.
export { NOTIFICATION_TYPES };
