import multer from "multer";
import cloudinary from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_UPLOAD_FOLDER } from "../config/env.js";

cloudinary.v2.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

const logoStorage = new CloudinaryStorage({
  cloudinary: cloudinary.v2,
  params: {
    folder: `${CLOUDINARY_UPLOAD_FOLDER}/schools/logos`,
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [
      { width: 400, height: 400, crop: "limit" },
      { quality: "auto:good" },
      { fetch_format: "auto" },
    ],
    public_id: (req, file) => `school-logo-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
  },
});

const stampStorage = new CloudinaryStorage({
  cloudinary: cloudinary.v2,
  params: {
    folder: `${CLOUDINARY_UPLOAD_FOLDER}/schools/stamps`,
    allowed_formats: ["png"],
    transformation: [
      { width: 400, height: 400, crop: "limit" },
      { quality: "auto:good" },
      { fetch_format: "png" },
    ],
    public_id: (req, file) => `school-stamp-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMimes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedMimes.includes(file.mimetype)) {
    return cb(new Error("Only JPG, PNG, and WebP images are allowed"), false);
  }
  cb(null, true);
};

const stampFileFilter = (req, file, cb) => {
  if (file.mimetype !== "image/png") {
    return cb(new Error("Only PNG images are allowed for stamps"), false);
  }
  cb(null, true);
};

export const uploadLogo = multer({
  storage: logoStorage,
  fileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
  },
}).single("logo");

export const uploadStamp = multer({
  storage: stampStorage,
  fileFilter: stampFileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
  },
}).single("stamp");

// ─────────────────────────────────────────────
// STUDENT PHOTO UPLOAD
// Uses in-memory storage so the service layer can validate dimensions
// with sharp and resize to 400×400 before handing to Cloudinary.
// In-memory because we need to process the buffer, not hand it off raw.
// ─────────────────────────────────────────────
const studentPhotoStorage = multer.memoryStorage();

export const studentPhotoUpload = multer({
  storage: studentPhotoStorage,
  fileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2 MB
    files: 1,
  },
}).single("file");

// ─────────────────────────────────────────────
// SCHOOL LOGO UPLOAD
// Smaller max size (1 MB) — logos are displayed small and do not need the
// resolution of a student photo.
// ─────────────────────────────────────────────
const schoolLogoStorage = multer.memoryStorage();

export const schoolLogoUpload = multer({
  storage: schoolLogoStorage,
  fileFilter,
  limits: {
    fileSize: 1 * 1024 * 1024, // 1 MB
    files: 1,
  },
}).single("file");

// ─────────────────────────────────────────────
// ZIP UPLOAD (bulk student photos)
// In-memory storage: the archive is extracted and processed in-process.
// ─────────────────────────────────────────────
const zipStorage = multer.memoryStorage();

const zipFileFilter = (req, file, cb) => {
  if (file.mimetype === "application/zip" || file.mimetype === "application/x-zip-compressed") {
    cb(null, true);
  } else {
    cb(new Error("A ZIP archive is required"), false);
  }
};

export const zipUpload = multer({
  storage: zipStorage,
  fileFilter: zipFileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB
    files: 1,
  },
}).single("file");

// ─────────────────────────────────────────────
// BULK IMPORT (CSV / Excel)
// In-memory storage: the file is parsed in-process, never persisted to disk
// or Cloudinary, so the caller controls cleanup automatically.
// ─────────────────────────────────────────────
const bulkStorage = multer.memoryStorage();

const bulkFileFilter = (req, file, cb) => {
  const allowedMimes = [
    "text/csv",
    "application/csv",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
  ];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only CSV and Excel files are allowed"), false);
  }
};

export const uploadBulk = multer({
  storage: bulkStorage,
  fileFilter: bulkFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
}).single("file");

export const deleteFromCloudinary = async (publicId) => {
  if (!publicId) return;
  try {
    await cloudinary.v2.uploader.destroy(publicId);
  } catch (error) {
    console.error("Cloudinary delete error:", error.message);
  }
};

export const extractPublicId = (url) => {
  if (!url) return null;
  // Matches both image and raw resource URLs, e.g.:
  //  /image/upload/v123456/filename.jpg
  //  /raw/upload/v123456/filename.pdf
  const matches = url.match(/\/upload\/v\d+\/([^/]+)\.([a-z0-9]+)/i);
  return matches ? matches[1] : null;
};

export default {
  uploadLogo,
  uploadStamp,
  uploadBulk,
  studentPhotoUpload,
  schoolLogoUpload,
  zipUpload,
  deleteFromCloudinary,
  extractPublicId,
};