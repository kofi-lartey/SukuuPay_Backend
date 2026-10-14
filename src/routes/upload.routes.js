import { Router } from "express";
import {
  uploadStudentPhotoController,
  uploadStudentPhotosBulkController,
  uploadSchoolLogoController,
  uploadUserAvatarController,
  deleteUserAvatarController,
} from "../controllers/upload.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import {
  studentPhotoUpload,
  schoolLogoUpload,
  avatarUploadRoute,
  zipUpload,
} from "../middleware/upload.js";

export const uploadRoute = Router();

const requireSchoolAdmin = authorize("super_admin", "school_admin");

// POST /upload/student-photo — single student photo (school is derived from the authenticated user)
uploadRoute.post(
  "/student-photo",
  authenticate,
  requireSchoolAdmin,
  studentPhotoUpload,
  uploadStudentPhotoController
);

// POST /upload/student-photos/bulk — ZIP of photos
uploadRoute.post(
  "/student-photos/bulk",
  authenticate,
  requireSchoolAdmin,
  zipUpload,
  uploadStudentPhotosBulkController
);

// POST /upload/school-logo — school logo (school is derived from the authenticated user)
uploadRoute.post(
  "/school-logo",
  authenticate,
  requireSchoolAdmin,
  schoolLogoUpload,
  uploadSchoolLogoController
);

/**
 * POST /upload/avatar — the signed-in user's own profile picture.
 *
 * Authenticated, and nothing else. Every other route in this file is
 * `requireSchoolAdmin`, because every other route changes something that belongs
 * to a school: a student's photo, the school's logo, the payslips. A profile
 * picture belongs to the **account**, so a teacher setting their own face is not
 * a school-admin action, and an `authorize` here would close the only endpoint
 * in the product a teacher can use about themselves.
 *
 * The subject is never taken from the request body — `uploadUserAvatar` writes
 * to `req.user`, so there is no id to swap and no way to set somebody else's
 * picture from here. Size and format limits answer 413/400 (see `asClientErrors`
 * below) rather than a 500.
 */
uploadRoute.post("/avatar", authenticate, avatarUploadRoute, uploadUserAvatarController);

/**
 * DELETE /upload/avatar — drop it and fall back to initials.
 *
 * Its own verb rather than a flag through the POST, because "remove" is not a
 * picture: it is the one operation a teacher performs on a handset that is about
 * to be handed to somebody else.
 */
uploadRoute.delete("/avatar", authenticate, deleteUserAvatarController);
