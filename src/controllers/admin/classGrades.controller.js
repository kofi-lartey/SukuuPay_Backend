import { getAdminClassGrades } from "../../services/admin/classGrades.service.js";

export const getAdminClassGradesController = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { className, subject, term, academicYear } = req.query;
    const result = await getAdminClassGrades(schoolId, { className, subject, term, academicYear });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};