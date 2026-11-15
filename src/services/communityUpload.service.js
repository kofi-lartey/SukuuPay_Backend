import { cloudinary } from "../utils/cloudinary.js";
import { sniffMime, agreesWithDeclared } from "../utils/fileType.js";
import { CLOUDINARY_UPLOAD_FOLDER } from "../config/env.js";

/**
 * Uploads one community attachment and returns the `media[]` entry to store.
 *
 * ## Why the bytes are checked here and nowhere else
 *
 * `file.mimetype` is set by the browser and is trivially forged — a renamed
 * executable arrives as `image/png`. Every other upload route in this codebase
 * validates that claim, which is fine for a picture a school uploaded of its own
 * student and is not fine for a file that gets served back to other students in
 * a shared thread. So the real gate is `sniffMime`, and a declared type that
 * disagrees with the bytes is a rejection rather than a correction: a request
 * whose header and payload tell different stories is either a broken client or
 * one trying something.
 *
 * `resource_type: "auto"` lets Cloudinary pick image/video/raw per asset. The
 * other services pass `"image"` because they only ever receive images; sending
 * that with a PDF would make Cloudinary reject it as an invalid image.
 */
export const uploadCommunityAttachment = async (file, schoolId) => {
  if (!file?.buffer?.length) {
    throw Object.assign(new Error("No file was uploaded"), { status: 400, code: "NO_FILE" });
  }

  const sniffed = sniffMime(file.buffer);
  if (!sniffed) {
    throw Object.assign(new Error("That file type is not supported"), {
      status: 400,
      code: "UNSUPPORTED_TYPE",
    });
  }

  if (!agreesWithDeclared(file.mimetype, sniffed)) {
    throw Object.assign(
      new Error(`That file is not really ${file.mimetype}`),
      { status: 400, code: "MIME_MISMATCH" }
    );
  }

  const result = await new Promise((resolve, reject) => {
    cloudinary.v2.uploader.upload(
      `data:${sniffed.mime};base64,${file.buffer.toString("base64")}`,
      {
        // Per-school folder, so a school's attachments can be found (and, if it
        // ever has to, deleted) without scanning every other tenant's files.
        folder: `${CLOUDINARY_UPLOAD_FOLDER}/schools/${schoolId}/community`,
        resource_type: "auto",
      },
      (error, uploaded) => (error ? reject(error) : resolve(uploaded))
    );
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    mimeType: sniffed.mime,
    bytes: result.bytes || file.size,
    originalName: file.originalname || null,
    // Cloudinary probes a duration for audio and video assets it can read; raw
    // formats it cannot probe come back without one. Nullable all the way through
    // rather than defaulted to zero: a 40-second note rendered as "0:00" is worse
    // than no number at all, because the player can still fill it in on first play.
    durationSeconds: typeof result.duration === "number" ? result.duration : null,
  };
};