import mongoose from "mongoose";
import { TeacherStudentMessage } from "../models/TeacherStudentMessage.js";
import { TeacherAssignment } from "../models/TeacherAssignment.js";
import { Student } from "../models/studentModel.js";
import { User } from "../models/userModel.js";
import ApiError from "../utils/ApiError.js";
import { uploadAudioBuffer, cloudinary } from "../utils/cloudinary.js";

const resolveSchoolId = (user) => (user?.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null);

const assertAssignment = async (schoolId, teacherId, studentId) => {
  const assignment = await TeacherAssignment.findOne({
    schoolId,
    teacherId,
    studentId,
    removedAt: null,
  }).lean();
  if (!assignment) {
    throw new ApiError("This student is not assigned to you", 403, "NOT_ASSIGNED");
  }
  return assignment;
};

export const listTeacherStudents = async (teacherActor) => {
  const schoolId = new mongoose.Types.ObjectId(teacherActor.schoolId);
  const teacherId = new mongoose.Types.ObjectId(teacherActor._id);
  const assignments = await TeacherAssignment.find({ schoolId, teacherId, removedAt: null })
    .populate("studentId")
    .lean();

  const seen = new Set();
  const students = [];
  for (const a of assignments) {
    const s = a.studentId;
    if (!s || seen.has(String(s._id))) continue;
    seen.add(String(s._id));
    students.push({
      id: s._id,
      studentId: s.studentId,
      name: s.studentName,
      className: s.studentClass,
      status: s.status,
      tag: a.tag || "",
      assignedClassName: a.className || s.studentClass,
    });
  }
  students.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return students;
};

export const listTeacherTeachersForStudent = async (studentUser) => {
  if (!studentUser?.studentId) {
    throw new ApiError("Student account is not linked to a student record", 403, "STUDENT_NOT_LINKED");
  }
  const student = await Student.findById(studentUser.studentId).lean();
  if (!student) throw new ApiError("Student not found", 404, "NOT_FOUND");
  const assignments = await TeacherAssignment.find({
    schoolId: student.schoolId,
    studentId: student._id,
    removedAt: null,
  })
    .populate("teacherId", "name avatar assignedClasses")
    .lean();

  const seen = new Set();
  const teachers = [];
  for (const a of assignments) {
    const t = a.teacherId;
    if (!t || seen.has(String(t._id))) continue;
    seen.add(String(t._id));
    teachers.push({
      id: t._id,
      name: t.name,
      avatar: t.avatar || null,
      tag: a.tag || "",
      className: a.className || student.studentClass,
    });
  }
  return teachers;
};

export const listThread = async ({ schoolId, teacherId, studentId, page = 1, perPage = 50 }) => {
  const filter = {
    schoolId: new mongoose.Types.ObjectId(schoolId),
    teacherId: new mongoose.Types.ObjectId(teacherId),
    studentId: new mongoose.Types.ObjectId(studentId),
    deletedAt: null,
  };
  const skip = (Math.max(1, Number(page) || 1) - 1) * Math.min(Math.max(1, Number(perPage) || 50), 100);
  const limit = Math.min(Math.max(1, Number(perPage) || 50), 100);
  const [rows, total] = await Promise.all([
    TeacherStudentMessage.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
    TeacherStudentMessage.countDocuments(filter),
  ]);
  return {
    data: rows,
    meta: { page: Math.max(1, Number(page) || 1), perPage: limit, total, totalPages: Math.ceil(total / limit) || 1 },
  };
};

export const sendMessage = async ({ schoolId, teacherId, studentId, senderRole, senderUserId, text, files = [] }) => {
  const schoolObj = new mongoose.Types.ObjectId(schoolId);
  const teacherObj = new mongoose.Types.ObjectId(teacherId);
  const studentObj = new mongoose.Types.ObjectId(studentId);

  await assertAssignment(schoolObj, teacherObj, studentObj);

  const cleanText = text ? String(text).trim() : "";
  const attachments = [];

  for (const f of files) {
    if (!f || !f.buffer) continue;
    if (f.kind === "audio") {
      try {
        const uploaded = await uploadAudioBuffer(f.buffer, {
          mimeType: f.mimetype,
          folder: `sukuupay/teacher-messages/${schoolId}`,
          resourceType: "video",
          format: "m4a",
          audioCodec: "aac",
          timeout: 60000,
        });
        attachments.push({
          kind: "audio",
          url: uploaded.url,
          publicId: uploaded.publicId,
          mimeType: f.mimetype,
          bytes: uploaded.bytes,
          originalName: f.originalname || null,
          durationSeconds: uploaded.duration,
        });
      } catch (e) {
        console.error("Audio upload failed:", e?.message || e);
        // Fallback: keep the audio inline so the message is not lost.
        attachments.push({
          kind: "audio",
          url: `data:${f.mimetype};base64,${f.buffer.toString("base64")}`,
          publicId: null,
          mimeType: f.mimetype,
          bytes: f.buffer.length,
          originalName: f.originalname || null,
          durationSeconds: null,
        });
      }
    } else {
      try {
        const result = await new Promise((resolve, reject) => {
          cloudinary.v2.uploader.upload(
            `data:${f.mimetype};base64,${f.buffer.toString("base64")}`,
            {
              folder: `sukuupay/teacher-messages/${schoolId}`,
              resource_type: "auto",
            },
            (err, res) => (err ? reject(err) : resolve(res))
          );
        });
        attachments.push({
          kind: "file",
          url: result.secure_url,
          publicId: result.public_id,
          mimeType: f.mimetype,
          bytes: result.bytes || f.size,
          originalName: f.originalname || null,
          durationSeconds: null,
        });
      } catch (e) {
        console.error("File upload failed:", e?.message || e);
        attachments.push({
          kind: "file",
          url: `data:${f.mimetype};base64,${f.buffer.toString("base64")}`,
          publicId: null,
          mimeType: f.mimetype,
          bytes: f.buffer.length,
          originalName: f.originalname || null,
          durationSeconds: null,
        });
      }
    }
  }

  if (!cleanText && attachments.length === 0) {
    throw new ApiError("Write a message or attach a file", 400, "MESSAGE_EMPTY");
  }

  const doc = await TeacherStudentMessage.create({
    schoolId: schoolObj,
    teacherId: teacherObj,
    studentId: studentObj,
    senderRole,
    senderUserId: new mongoose.Types.ObjectId(senderUserId),
    body: cleanText || null,
    attachments,
  });
  return doc.toJSON();
};

export const markRead = async (messageId, user) => {
  const doc = await TeacherStudentMessage.findById(messageId);
  if (!doc) throw new ApiError("Message not found", 404, "NOT_FOUND");
  // scope check
  if (user.role === "teacher") {
    if (String(doc.teacherId) !== String(user._id)) throw new ApiError("Forbidden", 403, "FORBIDDEN");
  } else if (user.role === "student") {
    if (String(doc.studentId) !== String(user.studentId)) throw new ApiError("Forbidden", 403, "FORBIDDEN");
  } else {
    throw new ApiError("Forbidden", 403, "FORBIDDEN");
  }
  if (!doc.readAt && String(doc.senderUserId) !== String(user._id)) {
    doc.readAt = new Date();
    doc.readBy = user._id;
    await doc.save();
  }
  return doc.toJSON();
};

const EDIT_WINDOW_MS = 15 * 60 * 1000;

export const editMessage = async (messageId, user, text) => {
  const doc = await TeacherStudentMessage.findById(messageId);
  if (!doc || doc.deletedAt) throw new ApiError("Message not found", 404, "NOT_FOUND");
  if (String(doc.senderUserId) !== String(user._id)) throw new ApiError("Forbidden", 403, "FORBIDDEN");
  if (Date.now() - new Date(doc.createdAt).getTime() > EDIT_WINDOW_MS) {
    throw new ApiError("Edit window has expired", 403, "EDIT_EXPIRED");
  }
  const clean = String(text || "").trim();
  if (!clean && (!doc.attachments || doc.attachments.length === 0)) {
    throw new ApiError("Message cannot be empty", 400, "MESSAGE_EMPTY");
  }
  doc.body = clean || doc.body;
  doc.editedAt = new Date();
  await doc.save();
  return doc.toJSON();
};

export const deleteMessage = async (messageId, user) => {
  const doc = await TeacherStudentMessage.findById(messageId);
  if (!doc || doc.deletedAt) throw new ApiError("Message not found", 404, "NOT_FOUND");
  if (String(doc.senderUserId) !== String(user._id)) throw new ApiError("Forbidden", 403, "FORBIDDEN");
  if (Date.now() - new Date(doc.createdAt).getTime() > EDIT_WINDOW_MS) {
    throw new ApiError("Delete window has expired", 403, "DELETE_EXPIRED");
  }
  doc.deletedAt = new Date();
  doc.body = null;
  doc.attachments = [];
  await doc.save();
  return { deleted: true, id: doc._id };
};

export default {
  listTeacherStudents,
  listTeacherTeachersForStudent,
  listThread,
  sendMessage,
  markRead,
  editMessage,
  deleteMessage,
};
