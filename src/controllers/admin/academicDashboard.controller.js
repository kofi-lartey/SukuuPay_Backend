import { getAcademicOverview } from "../../services/admin/academicDashboard.service.js";
import { resolveErrorMessage } from "../../middleware/errorHandler.js";

/**
 * The headmaster's academic overview. No input beyond the token scope and an
 * optional `term`/`academicYear` in the query (already validated), so this is
 * the whole handler: resolve the school from the token, call the service, shape
 * the envelope. The term and year come from the query, not the body, so the
 * numbers are re-derivable and cacheable and a `GET` bookmark reproduces them.
 */
export const getAcademicOverviewController = async (req, res) => {
  try {
    const result = await getAcademicOverview(req.user.schoolId, req.query);
    return res.status(200).json({
      success: true,
      message: "Academic overview loaded",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};
