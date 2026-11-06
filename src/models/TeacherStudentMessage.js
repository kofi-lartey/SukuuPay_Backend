import mongoose from "mongoose";

const ATTACHMENT_KINDS = ["audio", "file"];

const attachmentSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ATTACHMENT_KINDS, required: true },
    url: { type: String, required: true },
    publicId: { type: String, default: null },
    mimeType: { type: String, default: null },
    bytes: { type: Number, default: null, min: 0 },
    originalName: { type: String, default: null, trim: true, maxlength: 255 },
    durationSeconds: { type: Number, default: null, min: 0 },
  },
  { _id: false }
);

const teacherStudentMessageSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },
    senderRole: {
      type: String,
      enum: ["teacher", "student"],
      required: true,
    },
    senderUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    body: {
      type: String,
      default: null,
      trim: true,
      maxlength: 4000,
    },
    attachments: {
      type: [attachmentSchema],
      default: [],
    },
    readAt: { type: Date, default: null },
    readBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

teacherStudentMessageSchema.index({ schoolId: 1, teacherId: 1, studentId: 1, createdAt: 1 });
teacherStudentMessageSchema.index({ studentId: 1, createdAt: 1 });

teacherStudentMessageSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    if (Array.isArray(ret.attachments)) {
      ret.attachments = ret.attachments.map((a) => {
        if (a && a.publicId) delete a.publicId;
        return a;
      });
    }
    return ret;
  },
});

export const TeacherStudentMessage = mongoose.model(
  "TeacherStudentMessage",
  teacherStudentMessageSchema
);
export default TeacherStudentMessage;
