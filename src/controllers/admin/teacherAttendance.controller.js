import { markTeacherAttendance, listTeacherAttendance } from "../../services/admin/teacherAttendance.service.js";

export const markTeacherAttendanceController = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const result = await markTeacherAttendance(schoolId, req.user._id, req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const listTeacherAttendanceController = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { className, teacherId } = req.query;
    const result = await listTeacherAttendance(schoolId, { className, teacherId });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};