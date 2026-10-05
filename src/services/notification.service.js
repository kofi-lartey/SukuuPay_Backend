import mongoose from "mongoose";
import { Notification } from "../models/Notification.js";
import { User } from "../models/userModel.js";
import ApiError from "../utils/ApiError.js";

const resolveSchoolId = (user, explicitSchoolId) => {
  if (user && user.role === "super_admin") {
    return explicitSchoolId ? new mongoose.Types.ObjectId(explicitSchoolId) : null;
  }
  return user && user.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

// ──────────────────── List notifications for the logged-in user ────────────────────
export const listNotifications = async (requester, query) => {
  const schoolId = requester.schoolId;

  const filter = { userId: requester._id };

  if (query.read !== undefined && query.read !== null) {
    filter.read = query.read === "true";
  }
  if (query.type) filter.type = query.type;

  const page = Number(query.page) || 1;
  const perPage = Math.min(Number(query.perPage) || 20, 100);
  const skip = (page - 1) * perPage;

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({
      ...filter,
      read: false,
    }),
  ]);

  return {
    data: notifications,
    meta: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
      unreadCount,
    },
  };
};

// ──────────────────── Mark a single notification as read ────────────────────
export const markNotificationRead = async (notificationId, requester) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: notificationId, userId: requester._id },
    { read: true, readAt: new Date() },
    { returnDocument: 'after' }
  ).lean();

  if (!notification) {
    throw new ApiError("Notification not found", 404, "NOT_FOUND");
  }

  return notification;
};

// ──────────────────── Mark all notifications as read ────────────────────
export const markAllNotificationsRead = async (requester) => {
  const result = await Notification.updateMany(
    { userId: requester._id, read: false },
    { $set: { read: true, readAt: new Date() } }
  );

  return { updatedCount: result.modifiedCount };
};

// ──────────────────── Delete a notification ────────────────────
export const deleteNotification = async (notificationId, requester) => {
  // Notifications are ephemeral; ownership is verified via the userId filter
  // so a user cannot delete another user's notification.
  const result = await Notification.deleteOne({
    _id: notificationId,
    userId: requester._id,
  });

  if (result.deletedCount === 0) {
    throw new ApiError("Notification not found", 404, "NOT_FOUND");
  }

  return { message: "Notification deleted" };
};

// ──────────────────── Service-level: create a notification ────────────────────
// Used by other modules (payments, plans, student imports, etc.) to push
// in-app notifications to a user.
export const createNotification = async ({
  userId,
  schoolId,
  type,
  title,
  message,
  link,
  meta,
}) => {
  if (!userId || !type || !title || !message) {
    throw new ApiError(
      "userId, type, title, and message are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const notification = await Notification.create({
    userId,
    schoolId: schoolId || null,
    type,
    title,
    message,
    link: link || null,
    meta: meta || {},
  });

  return notification.toJSON();
};

// Convenience: resolve schoolId from requester for callers that pass a user.
export const createNotificationForUser = async (requester, payload) => {
  const schoolId = payload.schoolId || resolveSchoolId(requester);
  return createNotification({ ...payload, schoolId });
};

export default { createNotification, createNotificationForUser };
