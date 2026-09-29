import { Router } from "express";
import {
  getNotificationsController,
  markNotificationReadController,
  markAllNotificationsReadController,
  deleteNotificationController,
} from "../controllers/notification.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  notificationQuerySchema,
  notificationIdParamSchema,
} from "../validations/notification.validation.js";

export const notificationRoute = Router();

// GET /notifications — list notifications for the logged-in user
notificationRoute.get(
  "/",
  authenticate,
  validate(notificationQuerySchema, "query"),
  getNotificationsController
);

// PUT /notifications/:id/read — mark one as read
notificationRoute.put(
  "/:id/read",
  authenticate,
  validate(notificationIdParamSchema, "params"),
  markNotificationReadController
);

// PUT /notifications/read-all — mark all as read
notificationRoute.put(
  "/read-all",
  authenticate,
  markAllNotificationsReadController
);

// DELETE /notifications/:id — delete a notification
notificationRoute.delete(
  "/:id",
  authenticate,
  validate(notificationIdParamSchema, "params"),
  deleteNotificationController
);
