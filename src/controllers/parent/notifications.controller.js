import { resolveErrorMessage } from "../../middleware/errorHandler.js";
import {
  listParentNotifications,
  markParentNotificationRead,
  markAllParentNotificationsRead,
} from "../../services/parent/notifications.service.js";

/**
 * The parent's notifications surface, mounted at `/pay/:token/notifications...`
 * from `routes/index.js`. See `controllers/parent/messages.controller.js` for why
 * these are thin, token-keyed, and why the token never reaches a log line.
 */

export const getNotificationsController = async (req, res) => {
  try {
    const { token } = req.params;
    const { filter, page, perPage } = req.query;
    const data = await listParentNotifications(token, { filter, page, perPage });

    return res.status(200).json({ success: true, message: "Notifications retrieved", data });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export const markNotificationReadController = async (req, res) => {
  try {
    const { token, id } = req.params;
    const data = await markParentNotificationRead(token, id);    return res.status(200).json({ success: true, message: "Notification marked read", data });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export const markAllNotificationsReadController = async (req, res) => {
  try {
    const { token } = req.params;
    const data = await markAllParentNotificationsRead(token);

    return res.status(200).json({ success: true, message: "All notifications marked read", data });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export default {
  getNotificationsController,
  markNotificationReadController,
  markAllNotificationsReadController,
};
