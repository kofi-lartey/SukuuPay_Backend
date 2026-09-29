import Joi from "joi";

export const schoolIdParamSchema = Joi.object({
  schoolId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "Invalid school ID format",
    }),
});

// ── School photo validation flags ──
export const STUDENT_PHOTO_MAX_SIZE = 2 * 1024 * 1024; // 2 MB
export const SCHOOL_LOGO_MAX_SIZE = 1 * 1024 * 1024; // 1 MB
export const ZIP_MAX_SIZE = 50 * 1024 * 1024; // 50 MB

// MIME types accepted for image uploads.
export const IMAGE_MIMETYPES = ["image/jpeg", "image/png", "image/webp"];

export const studentPhotoBodySchema = Joi.object({
  studentId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .allow(null),
});
