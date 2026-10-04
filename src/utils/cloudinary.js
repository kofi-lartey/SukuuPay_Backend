import cloudinary from 'cloudinary';
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_UPLOAD_FOLDER } from '../config/env.js';

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

// Uploads a raw Buffer to Cloudinary.  Used for post-processing flows where
// image data is resized/validated before being handed to Cloudinary.
export const uploadBuffer = async (buffer, options = {}) => {
  const timestamp = Date.now();
  const publicId = `sukuupay-${timestamp}-${Math.round(Math.random() * 1e9)}`;
  const folder = options.folder || CLOUDINARY_UPLOAD_FOLDER;
  const transformation = options.transformation || [];
  const resourceType = options.resourceType || "image";

  return new Promise((resolve, reject) => {
    cloudinary.v2.uploader.upload(
      `data:image/png;base64,${buffer.toString("base64")}`,
      {
        folder,
        public_id: publicId,
        resource_type: resourceType,
        transformation,
        ...options,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
  });
};

// Uploads from a readable stream (used by ZIP bulk upload).
export const uploadStream = async (stream, options = {}) => {
  const timestamp = Date.now();
  const publicId = `sukuupay-${timestamp}-${Math.round(Math.random() * 1e9)}`;
  const folder = options.folder || CLOUDINARY_UPLOAD_FOLDER;

  return new Promise((resolve, reject) => {
    const upload = cloudinary.v2.uploader.upload_stream(
      {
        folder,
        public_id: publicId,
        resource_type: options.resourceType || "image",
        transformation: options.transformation || [],
        ...options,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );

    stream.pipe(upload);
  });
};

/**
 * Uploads an audio buffer to Cloudinary.
 *
 * Split out from `uploadBuffer` because that helper is not parameterised for this and
 * cannot be made to be: it builds its data URI as `data:image/png;base64,` **hardcoded**,
 * so handing it an MP3 produced a payload Cloudinary rejected as a corrupt image. Making
 * it generic by swapping the prefix for `${mimeType}` would have silently changed the
 * behaviour of every existing caller — the ID card pipeline and the student photo
 * pipeline both rely on that prefix being right for their PNG buffers, and neither
 * passes a mime type today.
 *
 * `resource_type: "video"` is not a mistake. Cloudinary files audio under the video
 * resource type; sending `audio/*` gets it filed as a media asset with a poster frame
 * and a duration, which is exactly what the bursar's player wants. An unknown
 * `resource_type` returns 400.
 *
 * No transformation is applied. Re-encoding a voice note to squeeze a few kilobytes
 * would also strip the container the browser needs to seek, and these are already
 * capped at 5 MB at the multer boundary.
 *
 * @param {Buffer} buffer
 * @param {{ folder?: string, mimeType?: string, publicIdPrefix?: string }} options
 * @returns {Promise<{ url: string, publicId: string, bytes: number, duration: number|null }>}
 */
export const uploadAudioBuffer = async (buffer, options = {}) => {
  const mimeType = options.mimeType || "application/octet-stream";
  const folder = options.folder || CLOUDINARY_UPLOAD_FOLDER;
  const prefix = options.publicIdPrefix || "parent-audio";

  // Cloudinary caps a single raw upload well below this; the multer limit is the
  // real gate and is set lower. A base64 payload is ~4/3 the buffer, so a buffer
  // that large would not survive JSON either.
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Audio buffer is empty");
  }

  const dataUri = `data:${mimeType};base64,${buffer.toString("base64")}`;

  const result = await new Promise((resolve, reject) => {
    cloudinary.v2.uploader.upload(
      dataUri,
      {
        folder,
        resource_type: "video",
        public_id: `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
        // `audio_codec: "none"` stops Cloudinary generating an audio-only
        // transcoded derivative that nothing in the product serves. We store the
        // original and stream it.
        audio_codec: "none",
      },
      (error, res) => {
        if (error) reject(error);
        else resolve(res);
      }
    );
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    bytes: result.bytes ?? buffer.length,
    // `duration` is absent for formats Cloudinary cannot probe (raw WAV), which is
    // why it is nullable all the way through to the model rather than defaulted to
    // zero — a zero would render as "0:00 recorded" on a note that is 40 seconds long.
    duration: typeof result.duration === "number" ? result.duration : null,
  };
};

export { cloudinary };
export default cloudinary;
