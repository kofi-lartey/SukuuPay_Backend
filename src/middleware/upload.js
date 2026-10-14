import multer from "multer";
import cloudinary from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_UPLOAD_FOLDER } from "../config/env.js";
import { PARENT_AUDIO_MIME_TYPES } from "../models/ParentMessage.js";

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

// ─────────────────────────────────────────────
// SCHOOL AD CREATIVE
// Ads render at a fixed 16:9 inside the auth CTA panel, so the creative is
// cropped and served at the exact size the slider asks for. Handing the client
// an untransformed original is what makes a carousel tank LCP.
// `fetch_format: auto` lets Cloudinary serve AVIF/WebP per request.
// ─────────────────────────────────────────────
const adStorage = new CloudinaryStorage({
  cloudinary: cloudinary.v2,
  params: {
    folder: `${CLOUDINARY_UPLOAD_FOLDER}/ads`,
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [
      { width: 960, height: 540, crop: "fill", gravity: "auto" },
      { quality: "auto:good" },
      { fetch_format: "auto" },
    ],
    public_id: (req, file) => `school-ad-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
  },
});

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

export const uploadSchoolAd = multer({
  storage: adStorage,
  fileFilter,
  limits: {
    fileSize: 3 * 1024 * 1024,
    files: 1,
  },
}).single("image");

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
// USER AVATAR UPLOAD
// Memory storage, like the school logo: the picture is a portrait cropped to a
// square by the service, not a file to hand off raw.
//
// Smaller ceiling than a student photo (2 MB) and, unlike the school logo's
// 1 MB, still generous enough for a modern phone camera original — a 12 MP
// portrait is ~4 MB in memory but a screenshot or a WhatsApp-forwarded photo is
// well under it, and a teacher who has to shrink a file before uploading simply
// does not upload one.
// ─────────────────────────────────────────────
const avatarStorage = multer.memoryStorage();

export const avatarUpload = multer({
  storage: avatarStorage,
  fileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2 MB
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
    "text/plain",
    "application/octet-stream",
  ];
  const allowedExtensions = [".csv", ".xlsx", ".xls", ".xlsm"];
  const ext = file.originalname.slice(-5).toLowerCase();
  const matchesExt = allowedExtensions.some((e) => file.originalname.toLowerCase().endsWith(e));
  if (allowedMimes.includes(file.mimetype) || matchesExt) {
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

// ─────────────────────────────────────────────
// PARENT VOICE NOTES
// In-memory storage, not CloudinaryStorage, because the upload has to be matched to
// a `ParentMessage` row and Cloudinary's storage engine would hand the file straight
// to Cloudinary before the service knows whether the message is valid. Two uploads
// from an unauthenticated parent endpoint — one rejected for an empty message, one
// for a missing parent phone — would otherwise leave orphans billed against the
// account with no row pointing at them.
//
// `allowed_formats` covers the four containers `MediaRecorder` emits across the
// browsers this portal is used on. The filter checks `mimetype` rather than
// `originalname` because browsers disagree about the extension they attach to a
// `Blob` — Safari writes `.mp4` to an `audio/mp4` blob and Firefox writes `.webm`
// to `audio/webm`, but a desktop Chrome on some platforms reports
// `audio/webm;codecs=opus`, which is an exact-string match failure waiting to happen.
// ─────────────────────────────────────────────
const parentAudioStorage = multer.memoryStorage();

const parentAudioFileFilter = (req, file, cb) => {
  if (!PARENT_AUDIO_MIME_TYPES.includes(file.mimetype)) {
    return cb(
      new Error(
        `That audio format is not supported. Record from this page, or send a written message instead.`
      ),
      false
    );
  }
  cb(null, true);
};

export const uploadParentAudio = multer({
  storage: parentAudioStorage,
  fileFilter: parentAudioFileFilter,
  limits: {
    // 5 MB. A parent speaking for a minute is roughly 500 KB as Opus; this is ten
    // times that, which is generous for a voice note and still small enough that a
    // buffer never threatens the process. Crossed by the client-side cap first, so
    // this is the backstop for a client that ignores it.
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },
}).single("audio");

/**
 * Wraps a multer middleware so its failures arrive as client errors.
 *
 * Multer signals a rejected file by calling `next(new Error(...))` — and a `MulterError`
 * for its own limits. Neither carries a `.status`, so without this every oversized or
 * wrong-format upload fell through `errorHandler` to a 500 with the body
 * `"Something went wrong"`. On an unauthenticated parent endpoint that is the worst
 * possible answer to a question a parent can act on: they are told to retry something
 * that will never succeed, because the real cause was their browser's codec.
 *
 * The `fileFilter` rejections this translates are deliberately given the handler's
 * own message, which is written for the parent rather than for a log line.
 *
 * @param {import('express').RequestHandler} middleware a multer middleware
 * @returns {import('express').RequestHandler}
 */
export const asClientErrors = (middleware) => (req, res, next) =>
  middleware(req, res, (err) => {
    if (!err) return next();

    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    err.status = status;
    err.code = err.code || err.code;

    next(err);
  });

/** The parent voice-note upload, as a route-ready middleware. */
export const uploadParentAudioRoute = asClientErrors(uploadParentAudio);

/**
 * The avatar upload, as a route-ready middleware.
 *
 * Wrapped for the same reason as the voice note: an oversized or wrong-format
 * picture arrives as a multer error with no `.status`, which would otherwise
 * surface as a 500 telling a teacher "something went wrong" about a file they
 * can plainly see is too big. Mount this rather than the raw `avatarUpload`.
 */
export const avatarUploadRoute = asClientErrors(avatarUpload);

/**
 * Makes an accepted upload visible to the **body**, so a Joi schema can see it.
 *
 * ## The bug this exists to prevent
 *
 * `multer` does not put an uploaded file in `req.body`. It removes it from the
 * multipart payload and sets `req.file`, leaving `req.body` with the *text fields
 * only*. So for `POST /pay/:token/notify-school` sent as multipart with a voice note
 * and nothing typed:
 *
 *   req.body = { parentName, parentPhone }   ← no `audio`
 *   req.file = <the recording>
 *
 * The schema's "a message **or** a recording" rule reads `value.audio`, finds it
 * `undefined`, and answers **422** — so a parent who recorded a voice note was told to
 * write a message instead. The recorder was unusable on its own, which is the one case
 * it exists for.
 *
 * The schema's own comment reasoned that a per-field custom "has no request" and could
 * only see what Joi had produced. That is true, and it is the trap: the value Joi is
 * given genuinely does not contain the file, so the rule was correct about its inputs
 * and wrong about the world.
 *
 * ## Why a marker rather than loosening the schema
 *
 * Copying the whole file onto `req.body` would be worse than it sounds: Joi would then
 * deep-clone a multi-megabyte `Buffer` on every validation pass, and `stripUnknown`
 * would hand the controller a second copy of the audio that `req.file` already holds.
 *
 * So this sets a **truthy placeholder**. The rule only ever asks "was a file attached",
 * which `true` answers, and the real bytes stay on `req.file` where the controller reads
 * them. Idempotent: a request with no file is left completely untouched, so the plain
 * JSON path cannot be affected.
 *
 * Mounted between `uploadParentAudio` and `validate`.
 */
const exposeUploadToBody = (field = 'audio') => (req, _res, next) => {
  if (req.file && !req.body?.[field]) {
    // `req.body` is guaranteed here: multer has run, so it exists and is an object.
    req.body[field] = { filename: req.file.filename, size: req.file.size };
  }
  next();
};

/** As above, wired for the pay portal's voice-note field. */
export const exposeParentAudioToBody = exposeUploadToBody('audio');

export const deleteFromCloudinary = async (publicId) => {
  if (!publicId) return;
  try {
    await cloudinary.v2.uploader.destroy(publicId);
  } catch (error) {
    console.error("Cloudinary delete error:", error.message);
  }
};

/**
 * The Cloudinary URL and public id of a multer file, whatever shape they arrive in.
 *
 * ## Why this exists
 *
 * `multer-storage-cloudinary@4` does **not** put the Cloudinary response on `req.file`.
 * It maps it onto multer's own field names:
 *
 *     callback(undefined, {
 *       path: resp.secure_url,     // the URL
 *       size: resp.bytes,
 *       filename: resp.public_id,  // the public id
 *     });
 *
 * Versions 1 and 2 merged the whole response, so `req.file.secure_url` existed. Code
 * written against that shape still asks for it, and on v4 it is `undefined` — **always**,
 * not intermittently. So `uploaded.secure_url || imageUrl` silently discarded every
 * uploaded file and fell through to the pasted-URL branch, and the ad endpoints answered
 * *"an image is required"* about a request that had carried a picture in every field.
 * `req.file.public_id` failed the same way, which also meant every orphan-cleanup path
 * called `deleteFromCloudinary(undefined)` and leaked the asset it existed to remove.
 *
 * ## Both shapes are accepted
 *
 * `path`/`secure_url` and `filename`/`public_id` respectively, `secure_url`/`public_id`
 * first. A library upgrade that restores the old shape must not turn every upload back
 * into a no-op, and reading both means this file does not have to be changed when it
 * does.
 *
 * `filename` is safe to read here **because only a `CloudinaryStorage`-backed multer
 * ever reaches these helpers**, and for that engine `filename` is the public id. On a
 * `memoryStorage` or `diskStorage` file it would be the client's filename instead — so
 * these are not for arbitrary `req.file` objects.
 *
 * @param {object|null} file a `req.file` produced by a `CloudinaryStorage` multer
 * @returns {{ url: string|null, publicId: string|null }}
 */
export const readUploaded = (file) => ({
  url: file?.path || file?.secure_url || null,
  publicId: file?.public_id || file?.filename || null,
});

export const extractPublicId = (url) => {
  if (!url) return null;
  // Matches image, raw and video resource URLs, e.g.:
  //  /image/upload/v123456/filename.jpg
  //  /image/upload/v123456/sukuuPay/ads/school-ad-1699.webp
  //  /raw/upload/v123456/filename.pdf
  //
  // **The folder is part of the public id, so the capture cannot stop at the first
  // segment.** Every upload in this file sets `folder`, so the URL always carries one
  // and the old `([^/]+)` returned the bare folder name — `sukuuPay` for an ad, which
  // is not a deletable asset. `deleteFromCloudinary("sukuuPay")` fails, and every
  // cleanup that used this to tidy an orphaned upload was quietly keeping it.
  //
  // The version segment is not part of the id, so the capture starts after it. The
  // extension is dropped because that is what Cloudinary's `destroy` expects, and
  // `resource_type` is not part of the id either — `destroy` infers it from the asset,
  // and passing a guessed one is how the wrong asset gets destroyed.
  const matches = url.match(/\/upload\/v\d+\/(.+)\.[a-z0-9]+$/i);
  return matches ? matches[1] : null;
};

export default {
  uploadLogo,
  uploadStamp,
  uploadSchoolAd,
  uploadBulk,
  uploadParentAudio,
  uploadParentAudioRoute,
  exposeParentAudioToBody,
  studentPhotoUpload,
  schoolLogoUpload,
  avatarUpload,
  avatarUploadRoute,
  zipUpload,
  deleteFromCloudinary,
  extractPublicId,
  readUploaded,
};