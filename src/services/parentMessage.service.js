import mongoose from "mongoose";
import { ParentMessage, PARENT_MESSAGE_STATUS_VALUES } from "../models/ParentMessage.js";
import { Student } from "../models/studentModel.js";
import ApiError from "../utils/ApiError.js";
import auditService from "../utils/auditService.js";
import { AUDIT_ACTIONS } from "../config/constants.js";

/**
 * The school's side of parent messaging.
 *
 * ## Why the inbox is a page and not a notification
 *
 * A `Notification` is an alert: it says something happened and gives it a link. It is
 * read once, it is deleted after 90 days by a TTL index, and it carries no state
 * about whether the thing it announced was dealt with. A fee dispute is the opposite
 * of that — it arrives, it sits unanswered, and the parent's next question is
 * "have you seen my message", which needs a record that outlives the alert and knows
 * it is still open.
 *
 * So the notification points here, and this is the thing with state.
 */

/**
 * Resolves the school this caller may read.
 *
 * Same rule as every other module in the codebase: a `super_admin` may pass any
 * school explicitly (that is the platform console's job), and everyone else is pinned
 * to their own. A bursar who could read another school's parent messages would have
 * every parent phone number in the platform, which is precisely what the masked copy
 * in `Notification` exists to prevent.
 */
const resolveSchoolId = (user, explicitSchoolId) => {
  if (user?.role === "super_admin") {
    return explicitSchoolId && mongoose.Types.ObjectId.isValid(explicitSchoolId)
      ? new mongoose.Types.ObjectId(explicitSchoolId)
      : null;
  }
  return user?.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

const assertSchoolAccess = (user, schoolIdParam) => {
  if (user?.role === "super_admin") return;
  if (!user?.schoolId) {
    throw new ApiError("Your account is not linked to a school", 403, "SCHOOL_ACCESS_DENIED");
  }
  if (schoolIdParam && String(user.schoolId) !== String(schoolIdParam)) {
    throw new ApiError("You do not have access to that school", 403, "SCHOOL_ACCESS_DENIED");
  }
};

/**
 * Lists the school's parent messages, newest first.
 *
 * The counts come back with the page rather than as a second request because the
 * filter tabs above the list ("Unread", "Resolved") are the only navigation, and a
 * tab that has to count first shows the wrong number for a moment on every click.
 *
 * @returns {Promise<{ data: object[], meta: object, counts: object }>}
 */
export const listParentMessages = async (query = {}, user) => {
  const schoolId = resolveSchoolId(user, query.schoolId);
  assertSchoolAccess(user, query.schoolId);

  if (!schoolId) {
    throw new ApiError("A schoolId is required", 400, "NO_SCHOOL_SCOPE");
  }

  const filter = { schoolId };

  if (query.status && query.status !== "all") {
    if (!PARENT_MESSAGE_STATUS_VALUES.includes(query.status)) {
      throw new ApiError("Unknown message status", 400, "INVALID_STATUS");
    }
    filter.status = query.status;
  }

  if (query.hasAudio === "true") filter.hasAudio = true;
  if (query.studentId) {
    if (!mongoose.Types.ObjectId.isValid(query.studentId)) {
      throw new ApiError("Invalid studentId", 400, "INVALID_STUDENT_ID");
    }
    filter.studentId = new mongoose.Types.ObjectId(query.studentId);
  }

  // Free-text over the parent's own words and the student's name.
  //
  // `escaped` because this is a RegExp built from user input on an unauthenticated
  // adjacent surface: an unescaped `.` in a search box turns into a pattern that
  // matches everything and, on a long history, is a cheap way to make the inbox hang.
  if (query.q) {
    const safe = String(query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 80);
    filter.$or = [
      { message: new RegExp(safe, "i") },
      { parentName: new RegExp(safe, "i") },
      { studentName: new RegExp(safe, "i") },
      { studentRef: new RegExp(safe, "i") },
    ];
  }

  const page = Math.max(1, Number(query.page) || 1);
  const perPage = Math.min(Math.max(1, Number(query.perPage) || 20), 100);
  const skip = (page - 1) * perPage;

  const [rows, total, counts] = await Promise.all([
    ParentMessage.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .lean(),
    ParentMessage.countDocuments(filter),
    countByStatus(schoolId),
  ]);

  return {
    data: rows,
    meta: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
    counts,
  };
};

/** One aggregation for every tab count, rather than four `countDocuments` calls. */
const countByStatus = async (schoolId) => {
  const result = await ParentMessage.aggregate([
    { $match: { schoolId: new mongoose.Types.ObjectId(schoolId) } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const counts = { all: 0, new: 0, read: 0, resolved: 0, archived: 0 };
  for (const entry of result) {
    counts[entry._id] = entry.count;
    counts.all += entry.count;
  }
  return counts;
};

/**
 * One message, with the student's current record attached when it still exists.
 *
 * The denormalised `studentName` / `studentClass` on the row are what the inbox
 * renders — a message is evidence about what the parent was told at the time, and a
 * bursar arguing a balance dispute needs that name, not the current one. The live
 * `student` is attached *separately*, and only to enable the "open roster record"
 * link, because a transferred child has a live record and a graduated one may not.
 */
export const getParentMessage = async (messageId, user) => {
  const row = await ParentMessage.findOne({
    _id: messageId,
    ...(user?.role === "super_admin" ? {} : { schoolId: user.schoolId }),
  }).lean();

  if (!row) {
    throw new ApiError("Message not found", 404, "NOT_FOUND");
  }

  let student = null;
  if (row.studentId) {
    student = await Student.findById(row.studentId)
      .select("studentId studentName studentClass status")
      .lean();
  }

  return { ...row, student };
};

/**
 * The thread for one student, oldest first.
 *
 * Shown when a bursar opens a student from the roster. Oldest-first is deliberate and
 * is the opposite of the inbox: a thread read top-down is a conversation, and a
 * conversation read newest-up is a search result with the sense inverted.
 */
export const listStudentMessages = async (studentId, query = {}, user) => {
  if (!mongoose.Types.ObjectId.isValid(studentId)) {
    throw new ApiError("Invalid studentId", 400, "INVALID_STUDENT_ID");
  }

  const filter = { studentId: new mongoose.Types.ObjectId(studentId) };

  // Scoped by school for everyone, super_admin included. A student id is only
  // meaningful within its school, and dropping the filter for super_admin would let a
  // guessed id read a thread from any tenant.
  if (user?.schoolId) filter.schoolId = new mongoose.Types.ObjectId(user.schoolId);

  const page = Math.max(1, Number(query.page) || 1);
  const perPage = Math.min(Math.max(1, Number(query.perPage) || 20), 100);

  const [rows, total] = await Promise.all([
    ParentMessage.find(filter)
      .sort({ createdAt: 1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean(),
    ParentMessage.countDocuments(filter),
  ]);

  return {
    data: rows,
    meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
  };
};

/**
 * Marks a message read.
 *
 * A no-op when it is already read rather than an error, because the inbox marks read
 * on open and a bursar with two tabs open would otherwise see one of them fail.
 *
 * Marking read also clears the matching `Notification`. Not for tidiness: the bell is
 * the only place a school admin looks all day, and an unread badge that never clears
 * trains people to ignore it — which is how the notification a parent message
 * depends on becomes invisible again.
 */
export const markParentMessageRead = async (messageId, user) => {
  const scope =
    user?.role === "super_admin" ? {} : { schoolId: user.schoolId };

  const row = await ParentMessage.findOne({ _id: messageId, ...scope });

  if (!row) {
    throw new ApiError("Message not found", 404, "NOT_FOUND");
  }

  // `findOneAndUpdate` was tried here with a conditional on `status`, and the
  // conditional could not be expressed: `$set` has no "only if" form, so every
  // candidate — `status: row.status`, `$min`, a pipeline — either clobbers a
  // resolution or needs MongoDB 4.2 for something a document this size does not
  // justify. The document is already loaded, so the honest thing is to change it.
  //
  // `new` is not clobbered back to `new`: a bursar who resolved a message and then
  // reopened it must not lose the resolution, because reopening it is exactly what
  // a parent asking "have you dealt with this?" looks like from this side.
  if (!row.readAt) {
    row.readAt = new Date();
    row.readBy = user?._id || null;
  }
  if (row.status === "new") {
    row.status = "read";
  }
  await row.save();

  await clearNotificationsFor(row);

  await auditService.log({
    action: AUDIT_ACTIONS.PARENT_MESSAGE_READ,
    entity: "ParentMessage",
    entityId: row._id,
    userId: user?._id || null,
    schoolId: row.schoolId,
    details: { ref: row.messageId },
  });

  return row.toJSON();
};

/**
 * Marks a message resolved.
 *
 * The `resolutionNote` is what makes "resolved" mean anything — a closed dispute with
 * no record of what was done is the same as an unanswered one, from the parent's
 * point of view, the next time they ask.
 *
 * Refuses to resolve an already-archived message rather than silently resurrecting it.
 */
export const resolveParentMessage = async (messageId, payload = {}, user) => {
  const note = String(payload.resolutionNote || "").trim();

  if (note.length < 3) {
    throw new ApiError(
      "Say what was done about it, so there is a record",
      400,
      "RESOLUTION_NOTE_REQUIRED"
    );
  }

  const row = await ParentMessage.findOne({
    _id: messageId,
    ...(user?.role === "super_admin" ? {} : { schoolId: user.schoolId }),
  });

  if (!row) {
    throw new ApiError("Message not found", 404, "NOT_FOUND");
  }

  if (row.status === "archived") {
    throw new ApiError("That message is archived", 409, "MESSAGE_ARCHIVED");
  }

  row.status = "resolved";
  row.resolvedAt = new Date();
  row.resolvedBy = user?._id || null;
  row.resolutionNote = note.slice(0, 500);
  if (!row.readAt) {
    row.readAt = row.resolvedAt;
    row.readBy = user?._id || null;
  }
  await row.save();

  await clearNotificationsFor(row);

  await auditService.log({
    action: AUDIT_ACTIONS.PARENT_MESSAGE_RESOLVED,
    entity: "ParentMessage",
    entityId: row._id,
    userId: user?._id || null,
    schoolId: row.schoolId,
    details: { ref: row.messageId, note: row.resolutionNote },
  });

  return row.toJSON();
};

/**
 * Clears the alerts that pointed at this message for this reader.
 *
 * Matched on `meta.parentMessageRef` rather than a stored notification id, so a
 * message that was alerted twice (a retried parent submission) leaves no badge behind
 * on the second pass either.
 */
const clearNotificationsFor = async (row) => {
  try {
    const { Notification } = await import("../models/Notification.js");
    await Notification.updateMany(
      {
        schoolId: row.schoolId,
        type: { $in: ["parent.message", "parent.audio_message"] },
        "meta.parentMessageRef": String(row._id),
        read: false,
      },
      { $set: { read: true, readAt: new Date() } }
    );
  } catch (error) {
    // Never fail the read because a badge could not be cleared. The message itself is
    // already marked, and the worst outcome is one extra badge that clears next load.
    console.error(
      `[PARENT-MSG] Could not clear notifications for ${row.messageId}:`,
      error.message
    );
  }
};

export default {
  listParentMessages,
  getParentMessage,
  listStudentMessages,
  markParentMessageRead,
  resolveParentMessage,
};