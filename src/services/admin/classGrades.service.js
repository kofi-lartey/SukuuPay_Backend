import { Grade } from "../../models/Grade.js";

export const getAdminClassGrades = async (schoolId, { className, subject, term, academicYear }) => {
  const filter = { schoolId, deletedAt: null };
  if (className) filter.className = className;
  if (subject) filter.subject = subject;
  if (term) filter.term = term;
  if (academicYear) filter.academicYear = academicYear;
  const grades = await Grade.find(filter)
    .populate("studentId", "studentName")
    .select("studentId className subject score maxScore grade approvalStatus recordedAt")
    .sort({ studentId: 1 })
    .lean();
  return { grades: grades.map((g) => ({ ...g, studentName: g.studentId?.studentName || g.studentId })) };
};