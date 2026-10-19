import { getTeacherAttendanceReport } from "../../services/admin/teacherAttendanceReport.service.js";

export const getTeacherAttendanceReportController = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { className } = req.query;
    const result = await getTeacherAttendanceReport(schoolId, { className });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};