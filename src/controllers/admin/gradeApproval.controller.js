import {
  submitClassGrades,
  approveClassGrades,
  rejectClassGrades,
  reopenRejectedGrades,
  getGradeApprovalQueue,
} from "../../services/admin/gradeApproval.service.js";
import { resolveErrorMessage } from "../../middleware/errorHandler.js";

/**
 * The grade approval workflow's controllers — submit, approve, reject, reopen
 * and the review queue.
 *
 * Like every controller here, they are thin: supply the school scope from the
 * caller's own token, call the service, shape the envelope. The audit entries
 * are written by the service (never from here), and every error is answered
 * through `resolveErrorMessage` so a 4xx reads as the reason a headmaster can
 * act on and a 5xx never reaches the browser. The `schoolId` is `req.user.schoolId`
 * and is never taken from the body — that is what stops one school reaching
 * another's marks.
 */
export const submitClassGradesController = async (req, res) => {
  try {
    const result = await submitClassGrades(req.user.schoolId, req.user._id, req.body);
    return res.status(200).json({
      success: true,
      message: `Submitted ${result.submitted} grade${result.submitted === 1 ? "" : "s"}`,
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

export const approveClassGradesController = async (req, res) => {
  try {
    const result = await approveClassGrades(req.user.schoolId, req.user._id, req.body);
    return res.status(200).json({
      success: true,
      message: `Approved ${result.approved} grade${result.approved === 1 ? "" : "s"}`,
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

export const rejectClassGradesController = async (req, res) => {
  try {
    const result = await rejectClassGrades(req.user.schoolId, req.user._id, req.body);
    return res.status(200).json({
      success: true,
      message: `Rejected ${result.rejected} grade${result.rejected === 1 ? "" : "s"}`,
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

export const reopenRejectedGradesController = async (req, res) => {
  try {
    const result = await reopenRejectedGrades(req.user.schoolId, req.user._id, req.body);
    return res.status(200).json({
      success: true,
      message: `Reopened ${result.reopened} grade${result.reopened === 1 ? "" : "s"}`,
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

export const getGradeApprovalQueueController = async (req, res) => {
  try {
    const result = await getGradeApprovalQueue(req.user.schoolId, req.query);
    return res.status(200).json({
      success: true,
      message: "Approval queue loaded",
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
