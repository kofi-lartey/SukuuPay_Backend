import { uploadCommunityAttachment } from "../services/communityUpload.service.js";

/**
 * `POST /api/community/upload` — one attachment, returned as a `media[]` entry.
 *
 * The client uploads the file first and then posts the message with the returned
 * `url`/`publicId`, rather than sending the bytes with the comment. Two reasons,
 * both learned from the parent voice-note path: a multipart comment body has to
 * be validated by a schema that cannot see `req.file`, and a failed message would
 * otherwise leave an orphaned asset billed to the account with no row pointing at
 * it. Uploading first means the asset exists before any row does, and a client
 * that never sends the message is the only way to orphan one.
 */
export const uploadCommunityFileController = async (req, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) {
      return res.status(403).json({
        success: false,
        message: "Your account is not linked to a school",
        code: "SCHOOL_ACCESS_DENIED",
      });
    }

    const media = await uploadCommunityAttachment(req.file, schoolId);
    return res.status(201).json({ success: true, data: media });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code || "UPLOAD_FAILED",
    });
  }
};

export default uploadCommunityFileController;