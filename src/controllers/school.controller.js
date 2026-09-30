import {
  createSchool,
  listSchools,
  getSchoolById,
  updateSchool,
  updateSchoolLogo,
  updateSchoolStamp,
  suspendSchool,
  archiveSchool,
  unsuspendSchool,
  provisionSchoolForUser,
  requestToJoinSchool,
  listJoinRequests,
  decideJoinRequest,
} from "../services/school.service.js";
import { extractPublicId, deleteFromCloudinary } from "../middleware/upload.js";

// ─────────────────────────────────────────────
// CREATE SCHOOL
// ─────────────────────────────────────────────
export const createSchoolController = async (req, res) => {
  try {
    const stampUrl = req.file?.path || null;
    const school = await createSchool(req.body, req.user._id, stampUrl);

    return res.status(201).json({
      success: true,
      message: "School created successfully",
      data: school,
    });
  } catch (error) {
    // cleanup uploaded file if DB write failed
    if (req.file) {
      const publicId = extractPublicId(req.file.path);
      if (publicId) {
        await deleteFromCloudinary(publicId).catch(() => {});
      }
    }

    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// PROVISION OWN SCHOOL (self-service)
// ─────────────────────────────────────────────

/**
 * `POST /schools/me`
 *
 * The endpoint that gives an unlinked account a way forward. It is not
 * `POST /schools`: that route stays super_admin-only, because it takes an
 * arbitrary `createdBy` and creates schools on someone else's behalf. This one
 * takes the school identity from the caller's own body and can only ever link
 * the caller to it.
 *
 * Returns `201` when it created the school and `200` when the caller was already
 * linked (idempotent replay) — both carry the refreshed `user` so the client
 * does not need a second request to learn its new `schoolId`.
 */
export const createMySchoolController = async (req, res) => {
  try {
    const result = await provisionSchoolForUser(req.body, req.user);

    return res.status(result.created ? 201 : 200).json({
      success: true,
      message: result.created
        ? "School created and linked to your account"
        : "School already linked to your account",
      data: result.school,
      user: result.user,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ─────────────────────────────────────────────
// JOIN AN EXISTING SCHOOL
// ─────────────────────────────────────────────

/**
 * `POST /schools/join`
 *
 * `202`: the request is recorded and the school's admins have been notified.
 * The applicant is not linked yet and will not be until someone approves — the
 * school code identifies the school, it does not authenticate the person.
 */
export const joinSchoolController = async (req, res) => {
  try {
    const { schoolCode, applicantName, applicantPosition } = req.body;
    const result = await requestToJoinSchool(req.user, {
      schoolCode,
      applicantName,
      applicantPosition,
    });

    return res.status(202).json({
      success: true,
      message: result.created
        ? "Request sent. Your headteacher must approve it before you get access."
        : "Your request is already awaiting approval.",
      data: {
        requestId: result.request._id,
        status: result.request.status,
        schoolName: result.school.name,
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

/** `GET /schools/join-requests` — pending and decided requests for my school. */
export const listJoinRequestsController = async (req, res) => {
  try {
    const data = await listJoinRequests(req.user);

    return res.status(200).json({
      success: true,
      message: "Join requests retrieved successfully",
      data,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

/** `PUT /schools/join-requests/:requestId` — approve or reject. */
export const decideJoinRequestController = async (req, res) => {
  try {
    const { decision, note } = req.body;
    const result = await decideJoinRequest(req.user, req.params.requestId, {
      decision,
      note,
    });

    return res.status(200).json({
      success: true,
      message:
        decision === "approved"
          ? "Request approved and the applicant can now access the school"
          : "Request rejected",
      data: result.request,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ─────────────────────────────────────────────
// LIST SCHOOLS
// ─────────────────────────────────────────────

export const listSchoolsController = async (req, res) => {
  try {
    const result = await listSchools(req.query);

    return res.status(200).json({
      success: true,
      message: "Schools retrieved successfully",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET SINGLE SCHOOL
// ─────────────────────────────────────────────
export const getSchoolController = async (req, res) => {
  try {
    const school = await getSchoolById(req.params.schoolId, req.user);

    return res.status(200).json({
      success: true,
      message: "School retrieved successfully",
      data: school,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// UPDATE SCHOOL
// ─────────────────────────────────────────────
export const updateSchoolController = async (req, res) => {
  try {
    const school = await updateSchool(req.params.schoolId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "School updated successfully",
      data: school,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// UPDATE SCHOOL LOGO
// ─────────────────────────────────────────────
export const updateSchoolLogoController = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No logo file uploaded",
      });
    }

    const logoUrl = req.file.path;
    const school = await getSchoolById(req.params.schoolId, req.user);

    if (school.logo) {
      const publicId = extractPublicId(school.logo);
      if (publicId) {
        await deleteFromCloudinary(publicId).catch(() => {});
      }
    }

    const result = await updateSchoolLogo(
      req.params.schoolId,
      logoUrl,
      school.logo,
      req.user
    );

    return res.status(200).json({
      success: true,
      message: "Logo updated successfully",
      data: result,
    });
  } catch (error) {
    // cleanup the newly uploaded file if something failed
    if (req.file) {
      const publicId = extractPublicId(req.file.path);
      if (publicId) {
        await deleteFromCloudinary(publicId).catch(() => {});
      }
    }

    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// UPDATE SCHOOL STAMP
// ─────────────────────────────────────────────
export const updateSchoolStampController = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No stamp file uploaded",
      });
    }

    const stampUrl = req.file.path;
    const school = await getSchoolById(req.params.schoolId, req.user);

    if (school.stamp) {
      const publicId = extractPublicId(school.stamp);
      if (publicId) {
        await deleteFromCloudinary(publicId).catch(() => {});
      }
    }

    const result = await updateSchoolStamp(
      req.params.schoolId,
      stampUrl,
      school.stamp,
      req.user
    );

    return res.status(200).json({
      success: true,
      message: "Stamp updated successfully",
      data: result,
    });
  } catch (error) {
    if (req.file) {
      const publicId = extractPublicId(req.file.path);
      if (publicId) {
        await deleteFromCloudinary(publicId).catch(() => {});
      }
    }

    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// SUSPEND SCHOOL
// ─────────────────────────────────────────────
export const suspendSchoolController = async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "Suspension reason is required",
      });
    }

    const school = await suspendSchool(req.params.schoolId, reason, req.user);

    return res.status(200).json({
      success: true,
      message: "School suspended successfully",
      data: school,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// ARCHIVE SCHOOL
// ─────────────────────────────────────────────
export const archiveSchoolController = async (req, res) => {
  try {
    const result = await archiveSchool(req.params.schoolId, req.user);

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};