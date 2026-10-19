import mongoose from "mongoose";

const teacherAttendanceSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true, index: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    className: { type: String, required: true, trim: true, index: true },
    date: { type: Date, required: true, index: true },
    status: { type: String, enum: ["attended", "missed"], required: true },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    markedAt: { type: Date, default: Date.now },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

teacherAttendanceSchema.index({ schoolId: 1, teacherId: 1, className: 1, date: 1 }, { unique: true });

export const TeacherAttendance = mongoose.model("TeacherAttendance", teacherAttendanceSchema);