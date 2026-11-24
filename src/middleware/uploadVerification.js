import multer from "multer";
import cloudinary from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_UPLOAD_FOLDER } from "../config/env.js";

cloudinary.v2.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

const verificationStorage = new CloudinaryStorage({
  cloudinary: cloudinary.v2,
  params: {
    folder: `${CLOUDINARY_UPLOAD_FOLDER}/schools/verification`,
    allowed_formats: ["pdf", "jpg", "jpeg", "png", "webp"],
    transformation: [
      { quality: "auto:good" },
      { fetch_format: "auto" },
    ],
    public_id: (req, file) => {
      const schoolId = req.params?.schoolId || req.body?.schoolId || "unknown";
      const docType = req.body?.documentType || "doc";
      return `school-${schoolId}-${docType}-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    },
    resource_type: "auto",
  },
});

const verificationFileFilter = (req, file, cb) => {
  const allowedMimes = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
  ];
  if (!allowedMimes.includes(file.mimetype)) {
    return cb(new Error("Only PDF, JPG, PNG, and WebP files are allowed"), false);
  }
  cb(null, true);
};

export const uploadVerificationDocument = multer({
  storage: verificationStorage,
  fileFilter: verificationFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
}).single("document");

export const uploadVerificationDocumentRoute = (req, res, next) =>
  uploadVerificationDocument(req, res, (err) => {
    if (!err) return next();
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    err.status = status;
    next(err);
  });

export async function uploadVerificationDocumentBuffer(fileBuffer, schoolId, documentType, originalName) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.v2.uploader.upload_stream(
      {
        folder: `${CLOUDINARY_UPLOAD_FOLDER}/schools/verification`,
        public_id: `school-${schoolId}-${documentType}-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
        resource_type: "auto",
        allowed_formats: ["pdf", "jpg", "jpeg", "png", "webp"],
        transformation: [
          { quality: "auto:good" },
          { fetch_format: "auto" },
        ],
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result?.secure_url || null);
      }
    );
    uploadStream.end(fileBuffer);
  });
}

export async function deleteVerificationDocument(url) {
  if (!url) return;
  try {
    const publicId = extractVerificationPublicId(url);
    if (publicId) {
      await cloudinary.v2.uploader.destroy(publicId, { resource_type: "auto" });
    }
  } catch (error) {
    console.error("Verification document delete error:", error.message);
  }
}

export function extractVerificationPublicId(url) {
  if (!url) return null;
  const matches = url.match(/\/upload\/v\d+\/(.+)\.[a-z0-9]+$/i);
  return matches ? matches[1] : null;
}

import { readUploaded } from "./upload.js";

export const readVerificationUploaded = (file) => readUploaded(file);