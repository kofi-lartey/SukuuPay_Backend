import mongoose from "mongoose";
import { ParentMessage } from "../../models/ParentMessage.js";
import ApiError from "../../utils/ApiError.js";
import { log as auditLog } from "../../utils/auditService.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import { hashTokenForLog } from "../../utils/tokens.js";
import { uploadAudioBuffer } from "../../utils/cloudinary.js";
import { CLOUDINARY_UPLOAD_FOLDER } from "../../config/env.js";
import { PARENT_AUDIO_MIME_TYPES } from "../../models/ParentMessage.js";
import { resolvePortalStudent } from "./portalContext.js";

/**
 * The parent's side of messaging with the school.
 *
 * A pay link names one student, so every message under it belongs to that one
 * conversation channel between the parent and the school office. The frontend's
 * `useConversations` therefore expects a list whose items each carry a
 * `threadId`, and that id is the student's own `studentId` — stable whether the
 * school renames or transfers the child, and meaningless outside this link.
 *
 * Each conversation summary is a single `$group` over that student's messages:
 * one bounded scan over the indexed `{ schoolId, studentId }` prefix, newest
 * message first, with the unread count folded in so the inbox needs no second
 * request the way a badge-then-fetch tab does.
 */

const formatRelative = (date) => {
  if (!date) return "A long time ago";
  const diff = Date.now() - new Date(date).getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "Just now";
  if (diff < 2 * minute) return "A minute ago";
  if (diff < hour) return `${Math.floor(diff / minute)} minutes ago`;
  if (diff < 2 * hour) return "An hour ago";
  if (diff < day) return `${Math.floor(diff / hour)} hours ago`;
  if (diff < 2 * day) return "Yesterday";
  return `${Math.floor(diff / day)} days ago`;
};

const recipientLabel = (school, student) => {
  const name = school?.name || "School Office";
  return `${name} · School`;
};

const recipientInitials = (school, student) => {
  const base = school?.name || student?.studentName || "S";
  const parts = String(base).split(/\s+/).slice(0, 2);
  if (parts.length < 2 && student?.studentName) {
    return student.studentName
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase();
  }
  return parts.map((p) => p[0]).join("").toUpperCase();
};

/**
 * `GET /pay/:token/messages`
 *
 * One conversation row per student this token has written to. A pay link is
 * single-student, so this is at most one row today — but it is aggregated per
 * student so a shared link (or a future family-scoped token) is a list, not a
 * special case. Newest message first.
 */
export const listParentConversations = async (token, { page, perPage } = {}) => {
  const { student, school } = await resolvePortalStudent(token);

  const perPageN = Math.min(Math.max(1, Number(perPage) || 30), 100);
  const pageN = Math.max(1, Number(page) || 1);

  const threads = await ParentMessage.aggregate([
    {
      $match: {
        schoolId: new mongoose.Types.ObjectId(student.schoolId),
        studentId: new mongoose.Types.ObjectId(student._id),
      },
    },
    {
      $sort: { createdAt: -1 }
    },
    {
      $group: {
        _id: "$studentId",
        lastCreatedAt: { $max: "$createdAt" },
        lastMessage: { $first: "$message" },
        lastHasAudio: { $first: "$hasAudio" },
        unreadCount: { $sum: { $cond: [{ $eq: ["$status", "new"] }, 1, 0] } },
      },
    },
    { $sort: { lastCreatedAt: -1 } },
    { $skip: (pageN - 1) * perPageN },
    { $limit: perPageN },
  ]);

  // Only use a thread if it belongs to the current student (defensive guard
  // against any cross-tenant leakage).
  const last = threads.find((t) => String(t._id) === String(student._id)) || threads[0];
  if (last && String(last._id) !== String(student._id)) {
    const conversations = [];
    await auditLog({
      action: AUDIT_ACTIONS.PARENT_CONVERSATIONS_VIEWED,
      entity: "ParentMessage",
      entityId: student._id,
      userId: null,
      schoolId: student.schoolId,
      details: { studentRef: student.studentId, tokenHash: hashTokenForLog(token) },
    });
    return {
      conversations,
      meta: {
        total: 0,
        unreadCount: 0,
      },
    };
  }

  const conversations =
    last && last._id
      ? [
          {
            threadId: student.studentId,
            subject:
              last.lastMessage && String(last.lastMessage).length > 120
                ? `${String(last.lastMessage).slice(0, 120)}â€¦`
                : last.lastMessage || "Voice note about your fees",
            recipient: recipientLabel(school, student),
            initials: recipientInitials(school, student),
            lastMessage: last.lastHasAudio
              ? "[voice note]"
              : last.lastMessage || "",
            relativeTime: formatRelative(last.lastCreatedAt),
            unreadCount: last.unreadCount,
          },
        ]
      : [];

  await auditLog({
    action: AUDIT_ACTIONS.PARENT_CONVERSATIONS_VIEWED,
    entity: "ParentMessage",
    entityId: student._id,
    userId: null,
    schoolId: student.schoolId,
    details: { studentRef: student.studentId, tokenHash: hashTokenForLog(token) },
  });

  return {
    conversations,
    meta: {
      total: conversations.length,
      unreadCount:
        conversations.length && last
          ? last.unreadCount
          : 0,
    },
  };
};

/**
 * `GET /pay/:token/messages/:threadId`
 *
 * The thread for this student, oldest first. `threadId` must equal the student's
 * `studentId` — the token cannot read another child's thread.
 */
export const getParentConversation = async (token, threadId) => {
  const { student, school } = await resolvePortalStudent(token);

  if (threadId && String(threadId) !== String(student.studentId)) {
    throw new ApiError(
      "That conversation does not exist on this link",
      404,
      "NOT_FOUND"
    );
  }

  const rows = await ParentMessage.find({
    schoolId: new mongoose.Types.ObjectId(student.schoolId),
    studentId: new mongoose.Types.ObjectId(student._id),
  })
    .sort({ createdAt: 1 })
    .lean();

  // Extra safety: only return if all rows belong to this student
  if (rows.length > 0) {
    const isAllForThisStudent = rows.every(
      (r) =>
        String(r.studentId) === String(student._id) &&
        String(r.schoolId) === String(student.schoolId)
    );
    if (!isAllForThisStudent) {
      throw new ApiError(
        "That conversation does not exist on this link",
        404,
        "NOT_FOUND"
      );
    }
  }

  if (!rows.length) {
    throw new ApiError(
      "That conversation does not exist on this link",
      404,
      "NOT_FOUND"
    );
  }

  const conversation = {
    threadId: student.studentId,
    subject:
      rows[rows.length - 1].message || "Voice note about your fees",
    recipient: recipientLabel(school, student),
    initials: recipientInitials(school, student),
  };

  const messages = rows.map((row) => ({
    _id: String(row._id),
    body: row.message || "",
    author: "parent",
    relativeTime: formatRelative(row.createdAt),
    timestamp: row.createdAt.toISOString(),
    hasAudio: row.hasAudio,
    audioUrl: row.audio?.url || null,
    audioUploadFailure: row.audioUploadFailure || null,
  }));

  return { conversation, messages };
};

/**
 * `POST /pay/:token/messages`
 *
 * A parent sends a new message on their student's thread. The `threadId` in the
 * body is the student's `studentId` and is validated for parity with the token,
 * but it is not a write target — the token already scopes the write to its one
 * student. A message needs text or an audio attachment; both empty is rejected.
 *
 * `file` is the multer `req.file` memory Buffer produced by
 * `uploadParentAudioRoute`. The magic-byte check and the Cloudinary upload
 * mirror `pay.service.js:notifySchool` exactly, because a malformed blob that
 * slipped past the recorder's client-side guard must fail here, not in the
 * bursar's audio player.
 */
export const createParentMessage = async (token, { subject, body, threadId }, file) => {
  const { student, school } = await resolvePortalStudent(token);

  if (threadId && String(threadId) !== String(student.studentId)) {
    throw new ApiError(
      "That conversation does not exist on this link",
      404,
      "NOT_FOUND"
    );
  }

  const text = String(body || "").trim();

  if (!text && !file) {
    throw new ApiError(
      "Write something, or attach a voice note.",
      400,
      "EMPTY_MESSAGE"
    );
  }

  // The pay token names a student, not a person — the parent is whoever holds it.
  // Pull their name and phone off the student's `parents` array (primary first,
  // then the first on file) so the `ParentMessage` row, which is `required` on
  // `parentPhone`, does not throw a validation error mid-request. A student with
  // no parent contact on record falls back to the school's published number —
  // which a bursar can actually call back on — rather than an empty string that
  // passes `required` but leaves the row unactionable.
  const primaryParent =
    student.parents?.find((p) => p?.isPrimary) ||
    student.parents?.[0] ||
    {};
  const parentName =
    primaryParent?.parentName || student.studentName || "Parent";
  const parentPhone =
    primaryParent?.phone || school?.phone || "no-callback-on-file";

  let audioMeta = null;
  let audioFailure = null;

  if (file) {
    // Multer's `mimetype` is client-supplied and lies whenever the frontend is
    // confused; the first four bytes never lie.
    const head = file.buffer.slice(0, 4);
    const headerHex = head.toString("hex").toLowerCase();
    const isWebM = headerHex.startsWith("1a45dfa3");
    const isMP4 = headerHex.startsWith("000000");
    const isOgg = headerHex.startsWith("4f676753");
    const isWav = headerHex.startsWith("52494646");
    const isMp3 =
      headerHex.startsWith("494433") ||
      headerHex.startsWith("fffb") ||
      headerHex.startsWith("fff3");

    if (!isWebM && !isMP4 && !isOgg && !isWav && !isMp3) {
      throw new ApiError(
        "That voice note is not in a format we can process. Please record again, or write your message.",
        400,
        "AUDIO_BAD_HEADER",
        { headerHex }
      );
    }

    try {
      audioMeta = await uploadAudioBuffer(file.buffer, {
        mimeType: file.mimetype,
        folder: `${CLOUDINARY_UPLOAD_FOLDER}/schools/${String(student.schoolId)}/parent-messages`,
        resourceType: "video",
        format: "m4a",
        audioCodec: "aac",
        timeout: 60000,
      });
    } catch (error) {
      // If Cloudinary rejected the file but the parent also wrote text, keep the
      // text and record why the audio is missing — the same contract the
      // `notify-school` flow has. A parent told "send failed" because one half of
      // a mixed message lost a battle with the codec is told to try again with
      // no way to keep the words they already wrote.
      audioFailure =
        "We could not save your voice note right now. The school will still see your written message.";
      console.error(
        `[PARENT-MSG] Audio upload failed for ${student.studentId}:`,
        error.message
      );
    }
  }

  const row = await ParentMessage.create({
    schoolId: student.schoolId,
    studentId: student._id,
    studentRef: student.studentId,
    studentName: student.studentName,
    studentClass: student.studentClass,
    parentName: parentName,
    parentPhone: parentPhone,
    message: text || null,
    audio: audioMeta
      ? {
          url: audioMeta.url,
          publicId: audioMeta.publicId,
          mimeType: file?.mimetype,
          bytes: audioMeta.bytes,
          durationSeconds: audioMeta.duration ?? null,
        }
      : undefined,
    hasAudio: Boolean(audioMeta),
    audioUploadFailure: audioFailure,
    status: "new",
    ip: null,
  });

  await auditLog({
    action: AUDIT_ACTIONS.PARENT_MESSAGE_SENT,
    entity: "ParentMessage",
    entityId: row._id,
    userId: null,
    schoolId: student.schoolId,
    details: {
      ref: row.messageId,
      studentRef: student.studentId,
       chars: text.length,
       hasAudio: Boolean(audioMeta),
       audioBytes: audioMeta?.bytes ?? null,
       audioUploadFailure: audioFailure,
       tokenHash: hashTokenForLog(token),
    },
  });

  return {
    id: String(row._id),
    threadId: student.studentId,
    at: formatRelative(row.createdAt),
  };
};

/**
 * `PUT /pay/:token/messages/:threadId/read`
 *
 * Marks this student's unread messages read. A no-op when there are none rather
 * than a 404 — the page marks read on open and a refresh should not error.
 */
export const markParentConversationRead = async (token, threadId) => {
  const { student } = await resolvePortalStudent(token);

  if (threadId && String(threadId) !== String(student.studentId)) {
    throw new ApiError(
      "That conversation does not exist on this link",
      404,
      "NOT_FOUND"
    );
  }

  const result = await ParentMessage.updateMany(
    {
      schoolId: new mongoose.Types.ObjectId(student.schoolId),
      studentId: new mongoose.Types.ObjectId(student._id),
      status: "new",
    },
    { $set: { status: "read", readAt: new Date() } }
  );

  await auditLog({
    action: AUDIT_ACTIONS.PARENT_MESSAGE_READ,
    entity: "ParentMessage",
    entityId: null,
    userId: null,
    schoolId: student.schoolId,
    details: {
      studentRef: student.studentId,
      updated: result.modifiedCount,
      tokenHash: hashTokenForLog(token),
    },
  });

  return { threadId: student.studentId, updated: result.modifiedCount };
};

export default {
  listParentConversations,
  getParentConversation,
  createParentMessage,
  markParentConversationRead,
};
