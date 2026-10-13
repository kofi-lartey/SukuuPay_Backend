import {
  compileClassReportCards,
  publishClassReportCards,
} from "../../services/admin/records.service.js";
import { resolveErrorMessage } from "../../middleware/errorHandler.js";

/**
 * Report card compilation and publication.
 *
 * Compiling and publishing are separate endpoints because they are separate
 * decisions with different people behind them: the class teacher assembles the
 * numbers, and the headteacher decides the term's grades are final and its
 * parents may see them. One endpoint that did both would mean every compile
 * published, and a half-typed score would be on a parent's phone before anyone
 * had checked it.
 *
 * The run-time gate is `requireSchoolAdmin` (see the routes); this controller
 * contributes the `schoolId` scope and the envelope, and nothing else.
 */
export const compileClassReportCardsController = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const result = await compileClassReportCards(schoolId, req.user._id, req.body);

    return res.status(200).json({
      success: true,
      message: `Compiled ${result.compiled} report card${result.compiled === 1 ? "" : "s"}`,
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

export const publishClassReportCardsController = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const result = await publishClassReportCards(schoolId, req.user._id, req.body);

    return res.status(200).json({
      success: true,
      message: result.published
        ? `Published ${result.published} report card${result.published === 1 ? "" : "s"}`
        : "No draft report cards to publish",
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
