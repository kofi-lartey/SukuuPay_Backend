import {
  compileClassReportsFromGrades,
  setTeacherRemarkForClass,
  setHeadRemarkForClass,
  publishClassReports,
  unpublishClassReports,
  getReportReviewQueue,
} from "../../services/admin/recordsApproval.service.js";
import { resolveErrorMessage } from "../../middleware/errorHandler.js";

/**
 * The review-and-publish half of the report card pipeline.
 *
 * The grades-driven counterpart of `controllers/admin/records.controller.js`:
 * that one compiles from a teacher's submitted scores, this one compiles from
 * the class's *approved* grades and adds the review queue, the headmaster's
 * remark, and unpublish. Compile and publish are separate endpoints because
 * they are separate decisions with different people behind them — the headmaster
 * decides the numbers are final and its parents may see them — and one endpoint
 * that did both would publish a half-checked term.
 *
 * Same envelope rules as every controller: token-derived school scope,
 * `resolveErrorMessage` on the error path, audit written by the service.
 */
export const compileClassReportsController = async (req, res) => {
  try {
    const result = await compileClassReportsFromGrades(req.user.schoolId, req.user._id, req.body);
    return res.status(200).json({
      success: true,
      message: `Compiled ${result.compiled} report card${result.compiled === 1 ? "" : "s"} for review`,
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

export const setTeacherRemarkController = async (req, res) => {
  try {
    const result = await setTeacherRemarkForClass(req.user.schoolId, req.user._id, req.body);
    return res.status(200).json({
      success: true,
      message: `Updated remark on ${result.updated} report card${result.updated === 1 ? "" : "s"}`,
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

export const setHeadRemarkController = async (req, res) => {
  try {
    const result = await setHeadRemarkForClass(req.user.schoolId, req.user._id, req.body);
    return res.status(200).json({
      success: true,
      message: `Updated remark on ${result.updated} report card${result.updated === 1 ? "" : "s"}`,
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

export const publishClassReportsController = async (req, res) => {
  try {
    const result = await publishClassReports(req.user.schoolId, req.user._id, req.body);
    return res.status(200).json({
      success: true,
      message: `Published ${result.published} report card${result.published === 1 ? "" : "s"}`,
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

export const unpublishClassReportsController = async (req, res) => {
  try {
    const result = await unpublishClassReports(req.user.schoolId, req.user._id, req.body);
    return res.status(200).json({
      success: true,
      message: `Unpublished ${result.unpublished} report card${result.unpublished === 1 ? "" : "s"}`,
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

export const getReportReviewQueueController = async (req, res) => {
  try {
    const result = await getReportReviewQueue(req.user.schoolId, req.query);
    return res.status(200).json({
      success: true,
      message: "Review queue loaded",
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
