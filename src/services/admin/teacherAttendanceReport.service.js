import { Attendance } from "../../models/Attendance.js";
import { Student } from "../../models/studentModel.js";

export const getTeacherAttendanceReport = async (schoolId, { className } = {}) => {
  if (!className) {
    return { className: null, students: [], kpis: {}, registerLog: [], trend: [] };
  }

  const students = await Student.find({ schoolId, studentClass: className, deletedAt: null, status: "active" })
    .select("_id studentName")
    .lean();

  const studentIds = students.map((s) => s._id);
  const rows = await Attendance.find({
    schoolId,
    className,
    studentId: { $in: studentIds },
    deletedAt: null,
    status: { $in: ["present", "late", "absent"] },
  })
    .select("studentId status date markedAt markedBy")
    .sort({ date: 1 })
    .lean();

  const byStudent = new Map();
  for (const r of rows) {
    const key = String(r.studentId);
    const t = byStudent.get(key) || { present: 0, late: 0, absent: 0, total: 0 };
    if (r.status === "present") t.present += 1;
    if (r.status === "late") t.late += 1;
    if (r.status === "absent") t.absent += 1;
    t.total += 1;
    byStudent.set(key, t);
  }

  const studentList = students.map((s) => {
    const t = byStudent.get(String(s._id)) || { present: 0, late: 0, absent: 0, total: 0 };
    const rate = t.total > 0 ? Math.round(((t.present + t.late) / t.total) * 1000) / 10 : 0;
    return {
      name: s.studentName,
      present: t.present,
      late: t.late,
      absent: t.absent,
      total: t.total,
      rate,
    };
  });

  const totalPresent = studentList.reduce((a, s) => a + s.present + s.late, 0);
  const totalRecords = studentList.reduce((a, s) => a + s.total, 0);
  const overallRate = totalRecords > 0 ? Math.round((totalPresent / totalRecords) * 1000) / 10 : 0;

  // Register log: group by date
  const byDate = new Map();
  for (const r of rows) {
    const dateKey = new Date(r.date).toISOString().slice(0, 10);
    if (!byDate.has(dateKey)) byDate.set(dateKey, { date: dateKey, markedAt: r.markedAt, count: 0, present: 0, late: 0, total: 0 });
    const entry = byDate.get(dateKey);
    entry.count += 1;
    entry.total += 1;
    if (r.status === "present") entry.present += 1;
    if (r.status === "late") entry.late += 1;
    if (r.markedAt && (!entry.markedAt || r.markedAt < entry.markedAt)) {
      entry.markedAt = r.markedAt;
    }
  }
  const registerLog = [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      date: d.date,
      submittedAt: d.markedAt,
      count: d.count,
    }));

  const lateSubmissions = registerLog.filter((d) => {
    if (!d.submittedAt) return false;
    const t = new Date(d.submittedAt);
    return t.getHours() > 9 || (t.getHours() === 9 && t.getMinutes() > 0);
  }).length;

  const chronic = studentList.filter((s) => s.rate < 75 && s.total > 0).length;

  // Monthly trend - last 6 months
  const trendMap = new Map();
  for (const r of rows) {
    const d = new Date(r.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!trendMap.has(key)) trendMap.set(key, { month: key, present: 0, late: 0, total: 0 });
    const t = trendMap.get(key);
    t.total += 1;
    if (r.status === "present") t.present += 1;
    if (r.status === "late") t.late += 1;
  }
  const trend = [...trendMap.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6)
    .map((m) => ({
      month: m.month,
      rate: m.total > 0 ? Math.round(((m.present + m.late) / m.total) * 1000) / 10 : 0,
      present: m.present,
      late: m.late,
      absent: m.total - m.present - m.late,
    }));

  return {
    className,
    kpis: {
      overallRate,
      registerSubmissionRate: registerLog.length > 0 ? 100 : 0,
      lateSubmissions,
      chronicAbsentees: chronic,
    },
    students: studentList,
    registerLog,
    trend,
  };
};