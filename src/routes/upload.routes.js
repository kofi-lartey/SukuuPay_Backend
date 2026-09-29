import { Router } from "express";
import {
  uploadStudentPhotoController,
  uploadStudentPhotosBulkController,
  uploadSchoolLogoController,
} from "../controllers/upload.controller.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import {
  studentPhotoUpload,
  schoolLogoUpload,
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
