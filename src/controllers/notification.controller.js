import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
} from "../services/notification.service.js";

// ── GET /notifications — list the logged-in user's notifications ──
export const getNotificationsController = async (req, res) => {
  try {
    const result = await listNotifications(req.user, req.query);

    return res.status(200).json({
      success: true,
      message: "Notifications retrieved successfully",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── PUT /notifications/:id/read — mark one notification as read ──
export const markNotificationReadController = async (req, res) => {
  try {
    const notification = await markNotificationRead(req.params.id, req.user);

    return res.status(200).json({
      success: true,
      message: "Notification marked as read",
      data: notification,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── PUT /notifications/read-all — mark all as read ──
export const markAllNotificationsReadController = async (req, res) => {
  try {
    const result = await markAllNotificationsRead(req.user);

    return res.status(200).json({
      success: true,
      message: `${result.updatedCount} notifications marked as read`,
      data: { updatedCount: result.updatedCount },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── DELETE /notifications/:id — delete a notification ──
export const deleteNotificationController = async (req, res) => {
  try {
    const result = await deleteNotification(req.params.id, req.user);

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};
