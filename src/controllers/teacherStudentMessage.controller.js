import {
  listTeacherStudents,
  listTeacherTeachersForStudent,
  listThread,
  sendMessage,
  markRead,
  editMessage,
  deleteMessage,
} from "../services/teacherStudentMessage.service.js";
import { resolveErrorMessage } from "../middleware/errorHandler.js";

const fail = (res, error) =>
  res.status(error.status || 500).json({
    success: false,
    message: resolveErrorMessage(error),
    ...(error.code ? { code: error.code } : {}),
  });

const collectFiles = (req) => {
  const out = [];
  const files = req.files || {};
  for (const field of Object.keys(files)) {
    for (const f of files[field] || []) {
      out.push({
        kind: field === "audio" ? "audio" : "file",
        buffer: f.buffer,
        mimetype: f.mimetype,
        originalname: f.originalname,
        size: f.size,
      });
    }
  }
  // single req.file fallback
  if (req.file) {
    out.push({
      kind: req.file.fieldname === "audio" ? "audio" : "file",
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: req.file.originalname,
      size: req.file.size,
    });
  }
  return out;
};

export const getTeacherStudentsController = async (req, res) => {
  try {
    const data = await listTeacherStudents(req.teacher);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
};

export const getTeacherStudentMessagesController = async (req, res) => {
  try {
    const result = await listThread({
      schoolId: req.teacher.schoolId,
      teacherId: req.teacher._id,
      studentId: req.params.studentId,
      page: req.query.page,
      perPage: req.query.perPage,
    });
    return res.status(200).json({ success: true, data: result.data, meta: result.meta });
  } catch (error) {
    return fail(res, error);
  }
};

export const sendTeacherStudentMessageController = async (req, res) => {
  try {
    const data = await sendMessage({
      schoolId: req.teacher.schoolId,
      teacherId: req.teacher._id,
      studentId: req.params.studentId,
      senderRole: "teacher",
      senderUserId: req.teacher._id,
      text: req.body?.text || req.body?.message || req.body?.body,
      files: collectFiles(req),
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
};

export const getStudentTeachersController = async (req, res) => {
  try {
    const data = await listTeacherTeachersForStudent(req.user);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
};

export const getStudentTeacherMessagesController = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const result = await listThread({
      schoolId,
      teacherId: req.params.teacherId,
      studentId: req.user.studentId,
      page: req.query.page,
      perPage: req.query.perPage,
    });
    return res.status(200).json({ success: true, data: result.data, meta: result.meta });
  } catch (error) {
    return fail(res, error);
  }
};

export const sendStudentTeacherMessageController = async (req, res) => {
  try {
    const data = await sendMessage({
      schoolId: req.user.schoolId,
      teacherId: req.params.teacherId,
      studentId: req.user.studentId,
      senderRole: "student",
      senderUserId: req.user._id,
      text: req.body?.text || req.body?.message || req.body?.body,
      files: collectFiles(req),
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
};

export const editTeacherStudentMessageController = async (req, res) => {
  try {
    const data = await editMessage(req.params.messageId, req.user, req.body?.text || req.body?.body || req.body?.message);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
};

export const deleteTeacherStudentMessageController = async (req, res) => {
  try {
    const data = await deleteMessage(req.params.messageId, req.user);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
};
export const markTeacherStudentMessageReadController = async (req, res) => {
  try {
    const data = await markRead(req.params.messageId, req.user);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
};
