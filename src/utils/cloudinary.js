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

export { cloudinary };
export default cloudinary;
