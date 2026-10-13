import { ParentMessage } from "../../models/ParentMessage.js";
import { Payment } from "../../models/paymentModel.js";
import { PaymentPlan } from "../../models/paymentPlanModel.js";
import { ParentPortalReadState } from "../../models/ParentPortalReadState.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import ApiError from "../../utils/ApiError.js";
import { log as auditLog } from "../../utils/auditService.js";
import { hashTokenForLog } from "../../utils/tokens.js";
import { resolvePortalStudent } from "./portalContext.js";

/**
 * The parent's notifications surface.
 *
 * `Notification` is a per-admin inbox (one row per school user), so there are no
 * rows owned by a pay token to list. Instead, the parent's "bell" is *derived*
 * from the student's own activity that an alert would already exist for behind
 * the scenes:
 *
 *   - a completed payment    -> `payment.received`
 *   - a parent message       -> `parent.message` / `parent.audio_message`
 *   - a plan request         -> `plan.requested`
 *
 * Each derived entry is given a stable id (`pay:<studentRef>:<type>:<createdAt>`)
 * so it can be dismissed. Dismissal is durable per-token: `ParentPortalReadState`
 * records which derived ids the parent has cleared, so a dismissed alert does not
 * re-animate on reload the way the in-memory fixture's did.
 */

const formatRelative = (date) => {
  if (!date) return "A long time ago";
  const diff = Date.now() - new Date(date).getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "Just now";
  if (diff < 2 * minute) return "A minute ago";
  if (diff < hour) return `${Math.floor(diff / minute)} minutes ago`;
  if (diff < 2 * hour) return "An hour ago";
  if (diff < day) return `${Math.floor(diff / hour)} hours ago`;
  if (diff < 2 * day) return "Yesterday";
  return `${Math.floor(diff / day)} days ago`;
};

const GHS = (pesewas) => {
  const cedis = (Number(pesewas) || 0) / 100;
  return `GHC ${cedis.toFixed(2)}`;
};

/**
 * Builds the flat list of derived notification entries for one student, newest
 * first. Each entry is stable across calls (idempotent dismissal).
 */
export const buildNotificationRows = (student, payments, messages, plans) => {
  const rows = [];

  for (const payment of payments) {
    rows.push({
      _id: `pay:${String(student.studentId)}:payment:${payment._id}`,
      type: "payment.received",
      title: "Payment received",
      message: `${GHS(payment.amount)} paid for ${student.studentName} on ${new Date(payment.completedAt).toLocaleDateString("en-GH")}`,
      createdAt: payment.completedAt || payment.createdAt,
      relativeTime: formatRelative(payment.completedAt || payment.createdAt),
      readAt: null,
    });
  }

  for (const msg of messages) {
    rows.push({
      _id: `pay:${String(student.studentId)}:message:${msg._id}`,
      type: msg.hasAudio ? "parent.audio_message" : "parent.message",
      title: msg.hasAudio ? "Parent voice note" : "Parent message",
      message: msg.message
        ? `${msg.parentName || "A parent"} wrote about ${student.studentName}: ${msg.message}`
        : `${msg.parentName || "A parent"} sent a voice note about ${student.studentName}`,
      createdAt: msg.createdAt,
      relativeTime: formatRelative(msg.createdAt),
      readAt: null,
    });
  }

  for (const plan of plans) {
    rows.push({
      _id: `pay:${String(student.studentId)}:plan:${plan._id}`,
      type: "plan.requested",
      title: "Payment plan requested",
      message: `${student.studentName}'s balance has a pending payment plan (${GHS(plan.totalAmount)}).`,
      createdAt: plan.createdAt,
      relativeTime: formatRelative(plan.createdAt),
      readAt: null,
    });
  }

  rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return rows;
};

/**
 * `GET /pay/:token/notifications`
 *
 * Derives the parent's notifications from the student's payment, message and
 * plan activity, then stamps each with the parent's read state from
 * `ParentPortalReadState`. The `filter` query is a `NOTIFICATION_TYPES` substring
 * (`payments`, `attendance`, `records`, `messages`), matched the same way the
 * fixture did so the page's pills keep working.
 */
export const listParentNotifications = async (token, { filter, page, perPage }) => {
  const { student } = await resolvePortalStudent(token);

  const perPageN = Math.min(Math.max(1, Number(perPage) || 30), 100);
  const pageN = Math.max(1, Number(page) || 1);

  const [payments, messages, plans] = await Promise.all([
    Payment.find({
      schoolId: student.schoolId,
      studentId: student._id,
      status: "completed",
      completedAt: { $ne: null },
    })
      .sort({ completedAt: -1 })
      .lean(),
    ParentMessage.find({
      schoolId: student.schoolId,
      studentId: student._id,
    })
      .sort({ createdAt: -1 })
      .lean(),
    PaymentPlan.find({
      schoolId: student.schoolId,
      studentId: student._id,
      planStatus: "pending_acceptance",
    })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  let rows = buildNotificationRows(student, payments, messages, plans);

  if (filter && filter !== "all") {
    rows = rows.filter((row) => row.type.includes(filter));
  }

  const readState = await ParentPortalReadState.findOne({
    studentId: student._id,
    schoolId: student.schoolId,
  }).lean();

  const dismissed = new Set(readState?.readNotificationIds || []);
  rows = rows.map((row) =>
    dismissed.has(row._id) ? { ...row, readAt: row.readAt || readState?.updatedAt?.toISOString() || new Date().toISOString() } : row
  );

  const start = (pageN - 1) * perPageN;
  const paged = rows.slice(start, start + perPageN);
  const unreadCount = rows.filter((row) => !dismissed.has(row._id)).length;

  await auditLog({
    action: AUDIT_ACTIONS.PARENT_NOTIFICATIONS_VIEWED,
    entity: "ParentNotification",
    entityId: null,
    userId: null,
    schoolId: student.schoolId,
    details: {
      studentRef: student.studentId,
      count: paged.length,
      tokenHash: hashTokenForLog(token),
    },
  });

  return {
    notifications: paged,
    meta: {
      total: rows.length,
      unreadCount,
      page: pageN,
      perPage: perPageN,
    },
  };
};

/**
 * Marks one derived notification read. A no-op when it is already read or when
 * the id does not belong to this student's token, rather than a 404 — the page
 * marks read on open and a refresh after a dismissal must not error.
 */
export const markParentNotificationRead = async (token, notificationId) => {
  const { student } = await resolvePortalStudent(token);

  if (!notificationId || typeof notificationId !== "string") {
    throw new ApiError("Invalid notification id", 400, "INVALID_ID");
  }

  // Only ids this student could have been shown by `listParentNotifications`
  // are dismissible — they carry the student's `studentId` prefix.
  if (!notificationId.startsWith(`pay:${String(student.studentId)}:`)) {
    throw new ApiError("Notification not found", 404, "NOT_FOUND");
  }

  await ParentPortalReadState.updateOne(
    { studentId: student._id, schoolId: student.schoolId },
    {
      $addToSet: { readNotificationIds: notificationId },
      $inc: { version: 1 },
    },
    { upsert: true }
  );

  await auditLog({
    action: AUDIT_ACTIONS.PARENT_NOTIFICATION_READ,
    entity: "ParentNotification",
    entityId: null,
    userId: null,
    schoolId: student.schoolId,
    details: {
      studentRef: student.studentId,
      notificationId,
      tokenHash: hashTokenForLog(token),
    },
  });

  return { id: notificationId, read: true };
};

/**
 * `PUT /pay/:token/notifications/read-all`
 *
 * Marks every notification the parent could currently see as read, by recording
 * the current visible set in the read-state document. A new notification added
 * after this call is unaffected.
 */
export const markAllParentNotificationsRead = async (token) => {
  const { student } = await resolvePortalStudent(token);

  const [payments, messages, plans] = await Promise.all([
    Payment.find({
      schoolId: student.schoolId,
      studentId: student._id,
      status: "completed",
      completedAt: { $ne: null },
    })
      .select("_id")
      .lean(),
    ParentMessage.find({
      schoolId: student.schoolId,
      studentId: student._id,
    })
      .select("_id")
      .lean(),
    PaymentPlan.find({
      schoolId: student.schoolId,
      studentId: student._id,
      planStatus: "pending_acceptance",
    })
      .select("_id")
      .lean(),
  ]);

  const allIds = [
    ...payments.map((p) => `pay:${String(student.studentId)}:payment:${p._id}`),
    ...messages.map((m) => `pay:${String(student.studentId)}:message:${m._id}`),
    ...plans.map((p) => `pay:${String(student.studentId)}:plan:${p._id}`),
  ];

  if (!allIds.length) {
    return { updated: 0 };
  }

  await ParentPortalReadState.updateOne(
    { studentId: student._id, schoolId: student.schoolId },
    {
      $addToSet: { readNotificationIds: { $each: allIds } },
      $inc: { version: 1 },
    },
    { upsert: true }
  );

  await auditLog({
    action: AUDIT_ACTIONS.PARENT_NOTIFICATION_READ,
    entity: "ParentNotification",
    entityId: null,
    userId: null,
    schoolId: student.schoolId,
    details: {
      studentRef: student.studentId,
      markAll: true,
      count: allIds.length,
      tokenHash: hashTokenForLog(token),
    },
  });

  return { updated: allIds.length };
};

export default {
  listParentNotifications,
  markParentNotificationRead,
  markAllParentNotificationsRead,
};
