import { TeacherAttendance } from "../../models/TeacherAttendance.js";

export const markTeacherAttendance = async (schoolId, userId, { teacherId, className, date, status }) => {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  const row = await TeacherAttendance.findOneAndUpdate(
    { schoolId, teacherId, className, date: d },
    { $set: { schoolId, teacherId, className, date: d, status, markedBy: userId, markedAt: new Date(), deletedAt: null } },
    { upsert: true, new: true }
  ).lean();
  return row;
};

export const listTeacherAttendance = async (schoolId, { className, teacherId } = {}) => {
  const filter = { schoolId, deletedAt: null };
  if (className) filter.className = className;
  if (teacherId) filter.teacherId = teacherId;
  const rows = await TeacherAttendance.find(filter)
    .populate("teacherId", "name email")
    .sort({ date: -1 })
    .lean();
  return { records: rows };
};