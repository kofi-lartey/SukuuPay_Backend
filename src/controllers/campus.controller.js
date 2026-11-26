import {
  listCampuses,
  createCampus,
  getCampus,
  updateCampus,
  archiveCampus,
} from "../services/campus.service.js";

const sendError = (res, error) =>
  res.status(error.status || 500).json({
    success: false,
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
  });

/** GET /api/v2/campuses — list campuses for a school (query: schoolId). */
export const listCampusesController = async (req, res) => {
  try {
    const schoolId = req.query.schoolId || req.user.schoolId;
    const filter = {
      status: req.query.status,
      region: req.query.region,
      page: req.query.page,
      perPage: req.query.perPage,
    };
    const result = await listCampuses(schoolId, filter);

    return res.status(200).json({
      success: true,
      message: "Campuses retrieved successfully",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

/** POST /api/v2/campuses — create campus (body: name, code, address, region, bursarEmail). */
export const createCampusController = async (req, res) => {
  try {
    const campus = await createCampus(req.body, req.user);

    return res.status(201).json({
      success: true,
      message: "Campus created successfully",
      data: campus,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

/** GET /api/v2/campuses/:id — get campus detail. */
export const getCampusController = async (req, res) => {
  try {
    const campus = await getCampus(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Campus retrieved successfully",
      data: campus,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

/** PUT /api/v2/campuses/:id — update campus. */
export const updateCampusController = async (req, res) => {
  try {
    const campus = await updateCampus(req.params.id, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Campus updated successfully",
      data: campus,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

/** DELETE /api/v2/campuses/:id — soft archive (status: archived). */
export const archiveCampusController = async (req, res) => {
  try {
    const result = await archiveCampus(req.params.id, req.user);

    return res.status(200).json({
      success: true,
      message: result.message,
      data: result.campus,
    });
  } catch (error) {
    return sendError(res, error);
  }
};
