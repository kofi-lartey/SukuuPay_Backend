import mongoose from "mongoose";

const classSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true },
    className: { type: String, required: true }, // e.g., "JHS 2A"
    level: { type: String, default: "" },
    room: { type: String, default: "" },

    // ─── THE CLASS TEACHER (Form Master) ───
    classTeacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    // ─── SUBJECT TEACHERS ───
    subjectTeachers: [
      {
        subject: { type: String, required: true },
        teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        canMarkAttendance: { type: Boolean, default: false }, // If a subject teacher needs attendance rights
      }
    ],

    subjects: [{ type: String, trim: true }],
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const Class = mongoose.model("Class", classSchema);
