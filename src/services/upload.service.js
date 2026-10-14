import sharp from "sharp";
import AdmZip from "adm-zip";
import mongoose from "mongoose";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import ApiError from "../utils/ApiError.js";
import { uploadBuffer } from "../utils/cloudinary.js";
import { extractPublicId, deleteFromCloudinary } from "../middleware/upload.js";
import { CLOUDINARY_UPLOAD_FOLDER } from "../config/env.js";

const resolveSchoolId = (user, explicitSchoolId) => {
  if (user && user.role === "super_admin") {
    return explicitSchoolId ? new mongoose.Types.ObjectId(explicitSchoolId) : null;
  }
  return user && user.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

const MIN_DIMENSION = 200;

// ──────────────────── Validate dimensions via sharp ────────────────────
const validateImageDimensions = async (buffer, minDimension = MIN_DIMENSION) => {
  try {
    const metadata = await sharp(buffer).metadata();
    if (metadata.width < minDimension || metadata.height < minDimension) {
      throw new ApiError(
        `Image dimensions must be at least ${minDimension}x${minDimension} (got ${metadata.width}x${metadata.height})`,
        400,
        "IMAGE_TOO_SMALL"
      );
    }
    return metadata;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("Invalid or corrupted image file", 400, "INVALID_IMAGE");
  }
};

// ──────────────────── Upload a single student photo ────────────────────
export const uploadStudentPhoto = async (file, studentId, user) => {
  if (!file) {
    throw new ApiError("No file provided", 400, "NO_FILE");
  }

  const schoolId = resolveSchoolId(user);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  // Validate MIME type.
  const allowedMimes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedMimes.includes(file.mimetype)) {
    throw new ApiError(
      "Only JPG, PNG, and WebP images are allowed",
      400,
      "INVALID_MIME"
    );
  }

  // Validate file size via the buffer length (multer memory storage).
  if (file.buffer.length > 2 * 1024 * 1024) {
    throw new ApiError("Image must be smaller than 2MB", 400, "FILE_TOO_LARGE");
  }

  // Validate dimensions (min 200x200) then resize to 400x400 cover.
  await validateImageDimensions(file.buffer, MIN_DIMENSION);
  const resizedBuffer = await sharp(file.buffer)
    .resize(400, 400, {
      fit: "cover",
      position: "center",
    })
    .toFormat(file.mimetype === "image/png" ? "png" : "webp")
    .toBuffer();

  // Resolve the student up front, and read the old public id *without mutating
  // the record*.
  //
  // This used to null `studentImage` and save **before** the upload, and its
  // failure path then deleted the old Cloudinary asset. So any failed replace —
  // a dropped connection, a Cloudinary outage — left the student with
  // `studentImage: null` *and* no asset behind the old URL: the photo was gone
  // permanently, from a request the user was told had simply errored. The old
  // reference is now held only in memory and the record is written once, after
  // the new image is known to exist.
  let oldPublicId = null;
  let student = null;

  if (studentId) {
    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      throw new ApiError("Invalid student ID", 400, "INVALID_ID");
    }

    student = await Student.findOne({
      _id: studentId,
      schoolId,
      deletedAt: null,
    });
    if (!student) {
      throw new ApiError("Student not found", 404, "STUDENT_NOT_FOUND");
    }

    oldPublicId = student.studentImage ? extractPublicId(student.studentImage) : null;
  }

  let uploadResult;
  try {
    uploadResult = await uploadBuffer(resizedBuffer, {
      folder: `${CLOUDINARY_UPLOAD_FOLDER}/schools/students/photos`,
      transformation: [
        { width: 400, height: 400, crop: "fill", gravity: "center" },
        { quality: "auto:good" },
        { fetch_format: "auto" },
      ],
      resourceType: "image",
    });
  } catch (cloudinaryError) {
    // Nothing has been written and nothing is deleted: the student's existing
    // photo is still both referenced and stored, which is the whole point of
    // only mutating after a successful upload.
    throw new ApiError("Failed to upload image to Cloudinary", 500, "UPLOAD_FAILED");
  }

  const imageUrl = uploadResult?.secure_url || uploadResult?.url;
  const publicId = uploadResult?.public_id;

  // Update the student with the new image URL, now that the asset exists.
  if (student) {
    student.studentImage = imageUrl;
    await student.save({ validateBeforeSave: false });
  }

  // Clean up the old Cloudinary image — only after the new one is safely
  // recorded, so the record can never point at a deleted asset.
  if (oldPublicId) {
    await deleteFromCloudinary(oldPublicId).catch(() => {});
  }

  return {
    url: imageUrl,
    publicId,
    width: uploadResult?.width || 400,
    height: uploadResult?.height || 400,
  };
};

// ──────────────────── Bulk upload student photos from a ZIP ────────────────────
export const uploadStudentPhotosBulk = async (file, user) => {
  if (!file) {
    throw new ApiError("No ZIP file provided", 400, "NO_FILE");
  }

  // ZIP files are not multipart/mixed-image — detect by extension/mimetype.
  const isZip =
    file.mimetype === "application/zip" ||
    file.mimetype === "application/x-zip-compressed" ||
    (file.originalname || "").toLowerCase().endsWith(".zip");

  if (!isZip) {
    throw new ApiError("A ZIP archive is required", 400, "INVALID_FILE_TYPE");
  }

  const schoolId = resolveSchoolId(user);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  // Verify the ZIP is not too large.
  if (file.buffer.length > 50 * 1024 * 1024) {
    throw new ApiError("ZIP file must be smaller than 50MB", 400, "FILE_TOO_LARGE");
  }

  const uploaded = [];
  const skipped = [];
  const errors = [];

  let zip;
  try {
    zip = new AdmZip(file.buffer);
  } catch (error) {
    throw new ApiError("Could not parse ZIP archive", 400, "INVALID_ZIP");
  }

  const entries = zip.getEntries();
  if (entries.length > 2000) {
    throw new ApiError("ZIP file contains too many files (max 2000)", 400, "ZIP_TOO_LARGE");
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const filename = entry.entryName;
    // Filename must match a studentId pattern like PBS-2026-0001.jpg
    const studentIdMatch = filename.match(/^(STU-[\w-]+\.jpg|STU-[\w-]+\.png|STU-[\w-]+|[\w-]+)\.([a-z0-9]+)$/i);

    // Try a simpler approach: strip extension and check if it matches a student document
    const extMatch = filename.match(/^([a-f0-9]{24})\.\w+$/i); // ObjectId match
    const nameMatch = filename.match(/^(.+?)[\._-](\d{4})?\.(jpg|jpeg|png|webp)$/i);

    let studentIdLookup = null;

    // First try: 24-char hex ObjectId
    if (extMatch) {
      studentIdLookup = extMatch[1];
    } else if (nameMatch) {
      // Try to match the name part against student.studentId (e.g., PBS-2026-0001)
      const namePart = nameMatch[1];
      const student = await Student.findOne({
        schoolId,
        $or: [
          { studentId: namePart },
          { studentId: nameMatch[0].split(".")[0] },
        ],
        deletedAt: null,
      }).select("_id").lean();

      if (student) {
        studentIdLookup = student._id.toString();
      }
    }

    if (!studentIdLookup) {
      skipped.push({ file: filename, reason: "No matching student" });
      continue;
    }

    const imageBuffer = entry.getData().toBuffer();
    const imageMime = `image/${filename.split(".").pop().toLowerCase()}`;

    if (!["image/jpeg", "image/png", "image/webp"].includes(imageMime)) {
      errors.push({ file: filename, reason: "Not a valid image type" });
      continue;
    }

    try {
      // Validate dimensions and resize.
      const resizedBuffer = await sharp(imageBuffer)
        .resize(400, 400, { fit: "cover", position: "center" })
        .toBuffer();

      const uploadResult = await uploadBuffer(resizedBuffer, {
        folder: `${CLOUDINARY_UPLOAD_FOLDER}/schools/students/photos`,
        resourceType: "image",
      });

      const imageUrl = uploadResult?.secure_url || uploadResult?.url;

      await Student.updateOne(
        { _id: studentIdLookup, schoolId, deletedAt: null },
        { $set: { studentImage: imageUrl } }
      );

      uploaded.push({ file: filename, studentId: studentIdLookup, url: imageUrl });
    } catch (error) {
      errors.push({ file: filename, reason: error.message });
    }
  }

  return {
    uploaded: uploaded.length,
    skipped: skipped.length + errors.length,
    errors: [...skipped, ...errors],
    uploadedFiles: uploaded,
  };
};

// ──────────────────── Upload school logo ────────────────────
// ──────────────────── Upload a user avatar ────────────────────
/**
 * Replaces the signed-in user's profile picture.
 *
 * Own-account only, and deliberately not scoped to a school: the subject of the
 * upload is the caller, so a super_admin with no school and a teacher in one
 * both get here. The route therefore carries `authenticate` and nothing else —
 * an `authorize("school_admin")` gate would make the one endpoint a teacher can
 * act on about *themselves* unreachable, which is the opposite of what a
 * profile picture is for.
 *
 * Follows the corrected delete order `uploadStudentPhoto` learned the hard way:
 * the old public id is read and held in memory, the record is written **once**,
 * after the new asset exists, and the old asset is only destroyed afterwards.
 * Nulling `user.avatar` first means a Cloudinary outage takes the previous
 * picture with it — and the teacher is told the request simply failed.
 */
export const uploadUserAvatar = async (file, user) => {
  if (!file) {
    throw new ApiError("No image file provided", 400, "NO_FILE");
  }

  const allowedMimes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedMimes.includes(file.mimetype)) {
    throw new ApiError("Only JPG, PNG, and WebP images are allowed", 400, "INVALID_MIME");
  }

  if (file.buffer.length > 2 * 1024 * 1024) {
    throw new ApiError("Image must be smaller than 2MB", 400, "FILE_TOO_LARGE");
  }

  // 128 rather than the 200 a student photo demands. An avatar is displayed at
  // 40–96 px and is often the only thing a teacher can find about themselves
  // that is a photograph — a cropped headshot off a school ID is smaller than
  // this, and rejecting it teaches them the feature does not work.
  await validateImageDimensions(file.buffer, 128);

  // Square cover crop, at the size the rail and the profile screen actually
  // render. `fit: cover` with a centred gravity is what makes a phone portrait
  // behave: the face is what has to survive, not the aspect ratio.
  const resizedBuffer = await sharp(file.buffer)
    .resize(256, 256, { fit: "cover", position: "center" })
    .toFormat(file.mimetype === "image/png" ? "png" : "webp")
    .toBuffer();

  // Read before writing. See the comment above.
  const oldPublicId = user.avatar ? extractPublicId(user.avatar) : null;

  let uploadResult;
  try {
    uploadResult = await uploadBuffer(resizedBuffer, {
      folder: `${CLOUDINARY_UPLOAD_FOLDER}/users/avatars`,
      transformation: [
        { width: 256, height: 256, crop: "fill", gravity: "center" },
        { quality: "auto:good" },
        { fetch_format: "auto" },
      ],
      resourceType: "image",
    });
  } catch (cloudinaryError) {
    throw new ApiError("Failed to upload your picture", 500, "UPLOAD_FAILED");
  }

  const avatarUrl = uploadResult?.secure_url || uploadResult?.url;
  const publicId = uploadResult?.public_id;

  if (!avatarUrl) {
    throw new ApiError("Failed to upload your picture", 500, "UPLOAD_FAILED");
  }

  user.avatar = avatarUrl;
  await user.save();

  if (oldPublicId) {
    await deleteFromCloudinary(oldPublicId).catch(() => {});
  }

  return { url: avatarUrl, publicId };
};

/**
 * Removes the signed-in user's avatar, falling back to their initials.
 *
 * Separate from the upload rather than a special value through it, because
 * "remove" is the one operation a teacher performs on a picture that is not
 * theirs to keep — a shared staff-room handset should not be showing the last
 * person's face.
 */
export const removeUserAvatar = async (user) => {
  if (!user.avatar) {
    return { url: null, publicId: null };
  }

  const oldPublicId = extractPublicId(user.avatar);

  user.avatar = null;
  await user.save();

  if (oldPublicId) {
    await deleteFromCloudinary(oldPublicId).catch(() => {});
  }

  return { url: null, publicId: null };
};

// ──────────────────── Upload school logo ────────────────────
export const uploadSchoolLogo = async (file, schoolId, user) => {
  if (!file) {
    throw new ApiError("No logo file provided", 400, "NO_FILE");
  }

  const scopedSchoolId = resolveSchoolId(user, schoolId);
  if (!scopedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const allowedMimes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedMimes.includes(file.mimetype)) {
    throw new ApiError(
      "Only JPG, PNG, and WebP images are allowed",
      400,
      "INVALID_MIME"
    );
  }

  if (file.buffer.length > 1 * 1024 * 1024) {
    throw new ApiError("Logo must be smaller than 1MB", 400, "FILE_TOO_LARGE");
  }

  // Auto-crop to square 512x512 after dimension validation.
  await validateImageDimensions(file.buffer, 200);
  const resizedBuffer = await sharp(file.buffer)
    .resize(512, 512, {
      fit: "cover",
      position: "center",
    })
    .toFormat("png")
    .toBuffer();

  const school = await School.findOne({ _id: scopedSchoolId, deletedAt: null });
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  // Delete old logo from Cloudinary.
  let oldPublicId = null;
  if (school.logo) {
    oldPublicId = extractPublicId(school.logo);
  }

  let uploadResult;
  try {
    uploadResult = await uploadBuffer(resizedBuffer, {
      folder: `${CLOUDINARY_UPLOAD_FOLDER}/schools/logos`,
      transformation: [
        { width: 512, height: 512, crop: "fill", gravity: "center" },
        { quality: "auto:good" },
        { fetch_format: "auto" },
      ],
      resourceType: "image",
    });
  } catch (cloudinaryError) {
    throw new ApiError("Failed to upload logo to Cloudinary", 500, "UPLOAD_FAILED");
  }

  const logoUrl = uploadResult?.secure_url || uploadResult?.url;
  const publicId = uploadResult?.public_id;

  school.logo = logoUrl;
  await school.save();

  // Clean up old logo.
  if (oldPublicId) {
    await deleteFromCloudinary(oldPublicId).catch(() => {});
  }

  return {
    url: logoUrl,
    publicId,
  };
};
