import {
  bulkMarkAttendance,
  autoMarkPresent,
} from "../../services/admin/attendance.service.js";
import { resolveErrorMessage } from "../../middleware/errorHandler.js";

/**
 * The register, written by a teacher or a school administrator.
 *
 * `req.user.schoolId` is the scope, always. The services re-check every student
 * against it before a write, because a route-level assumption about the caller's
 * school is not a check: an ObjectId in a payload is attacker-controlled, and
 * the only thing standing between one bursar and another school's register is a
 * comparison that happens before the write rather than after it.
 *
 * Errors are answered here rather than forwarded, so the API never depends on
 * `errorHandler.js` seeing them — and a 5xx message is never shown to a caller.
 */
export const bulkMarkAttendanceController = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const result = await bulkMarkAttendance(schoolId, req.user._id, req.body);

    return res.status(200).json({
      success: true,
      message: `Attendance saved for ${result.saved} student${result.saved === 1 ? "" : "s"}`,
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

export const autoMarkPresentController = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const result = await autoMarkPresent(schoolId, req.user._id, req.body);

    return res.status(200).json({
      success: true,
      message: "Marked present",
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
