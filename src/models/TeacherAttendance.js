import mongoose from "mongoose";

const teacherAttendanceSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true, index: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    className: { type: String, required: true, trim: true, index: true },
    timetableId: { type: mongoose.Schema.Types.ObjectId, ref: "Timetable", default: null, index: true },
    subject: { type: String, default: "" },
    periodNumber: { type: Number, default: null },
    arrivedAt: { type: Date, default: null },
    minutesLate: { type: Number, default: 0 },
    date: { type: Date, required: true, index: true },
    status: { type: String, enum: ["attended", "missed", "present", "late"], required: true },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    markedAt: { type: Date, default: Date.now },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

teacherAttendanceSchema.index({ schoolId: 1, teacherId: 1, date: 1, timetableId: 1, periodNumber: 1 }, { unique: true });

export const TeacherAttendance = mongoose.model("TeacherAttendance", teacherAttendanceSchema);