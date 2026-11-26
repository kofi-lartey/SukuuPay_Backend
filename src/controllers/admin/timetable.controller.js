import {
  upsertTimetable,
  saveTimetableForClass,
  getTimetable,
  listTimetables,
  publishTimetable,
  publishApprovedTimetable,
  importTimetable,
  submitTimetable,
  withdrawTimetable,
  approveTimetable,
  rejectTimetable,
  listSubmissions,
  listTimetablesForTeacher,
  getTimetableForTeacher,
  deactivateTimetable,
  republishTimetable,
  removeTimetable,
  listRemovalRequests,
  confirmRemoval,
  rejectRemovalRequest,
  requestTimetableRemoval,
  withdrawRemovalRequest,
} from "../../services/admin/timetable.service.js";
import { resolveErrorMessage } from "../../middleware/errorHandler.js";

/**
 * A class timetable, written in full.
 *
 * A `PUT` rather than a `POST`: the body describes the whole timetable rather
 * than adding a lesson to one, and a request that omits Wednesday means
 * "Wednesday has no lessons" — which is what a `PUT` means. A `POST /timetable`
 * would read as "add these", and the client would have no way to *remove* a row
 * without a delete endpoint per period.
 *
 * The response is the stored document, not the request: it carries the periods
 * that were dropped for being incomplete and the `status` the timetable is now
 * in, so the console re-renders from the server's version rather than from what
 * the form believed it sent.
 */
export const upsertTimetableController = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const result = await upsertTimetable(schoolId, req.user._id, req.body, { actorRole: req.user.role });

    return res.status(200).json({
      success: true,
      message: "Timetable saved",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * The admin console's save — the `PUT /admin/timetables` entry, which checks the
 * class exists before writing (404 `CLASS_NOT_FOUND` if it does not). The older
 * `upsertTimetableController` above stays for `PUT /admin/timetable`, which
 * predates the class-list guard and deliberately does not enforce it.
 */
export const saveTimetableForClassController = async (req, res) => {
  try {
    const result = await saveTimetableForClass(
      req.user.schoolId,
      req.user._id,
      req.body,
      { actorRole: req.user.role }
    );
    return res.status(201).json({ success: true, message: "Timetable saved", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/** Read one class's timetable. `data` is null when the class has none. */
export const getTimetableController = async (req, res) => {
  try {
    const result = await getTimetable(req.user.schoolId, req.params.className, req.query);
    return res.status(200).json({ success: true, message: "Timetable loaded", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/** Every timetable in the school, as the console index. */
export const listTimetablesController = async (req, res) => {
  try {
    const result = await listTimetables(req.user.schoolId, req.query);
    return res.status(200).json({ success: true, message: "Timetables loaded", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/** Publish a class's timetable, making it readable through the parent portal. */
export const publishTimetableController = async (req, res) => {
  try {
    const result = await publishApprovedTimetable(req.user.schoolId, req.user._id, req.body);
    return res.status(200).json({ success: true, message: "Timetable published", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * POST /admin/timetables/upload — build a class timetable from a CSV/Excel file.
 *
 * Multer runs before this, so `req.file` is the parsed spreadsheet buffer and
 * `req.body` carries `className`, `term`, `academicYear` and optional `status`.
 * The file is never stored to disk or Cloudinary — it is parsed in memory and
 * written through the same guarded upsert as the form.
 */
export const importTimetableController = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "A CSV or Excel file is required",
        code: "NO_FILE",
      });
    }

    const result = await importTimetable(
      req.user.schoolId,
      req.user._id,
      req.file.buffer,
      req.file.originalname,
      {
        className: req.body.className,
        term: req.body.term,
        academicYear: req.body.academicYear,
        status: req.body.status || "draft",
      },
      { actorRole: req.user.role }
    );

    return res.status(200).json({
      success: true,
      message: `Timetable imported — ${result.imported} lesson(s) written`,
      data: result.timetable,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
      ...(error.meta ? { meta: error.meta } : {}),
    });
  }
};

/**
 * POST /admin/timetables/:className/submit — teacher sends their draft for review.
 */
export const submitTimetableController = async (req, res) => {
  try {
    const { className } = req.params;
    const result = await submitTimetable(req.user.schoolId, req.user._id, {
      className,
      term: req.body.term,
      academicYear: req.body.academicYear,
      teacherName: req.user.name,
    });
    return res.status(200).json({
      success: true,
      message: "Timetable submitted for approval",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * POST /admin/timetables/:className/withdraw — teacher pulls their submission back.
 */
export const withdrawTimetableController = async (req, res) => {
  try {
    const { className } = req.params;
    const result = await withdrawTimetable(req.user.schoolId, req.user._id, {
      className,
      term: req.body.term,
      academicYear: req.body.academicYear,
    });
    return res.status(200).json({
      success: true,
      message: "Timetable withdrawn — back to draft",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * POST /admin/timetables/:className/approve — administrator signs off a submission.
 */
export const approveTimetableController = async (req, res) => {
  try {
    const { className } = req.params;
    const result = await approveTimetable(req.user.schoolId, req.user._id, {
      className,
      term: req.body.term,
      academicYear: req.body.academicYear,
      comment: req.body.comment,
    });
    return res.status(200).json({
      success: true,
      message: "Timetable approved",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * POST /admin/timetables/:className/reject — administrator sends a submission back.
 */
export const rejectTimetableController = async (req, res) => {
  try {
    const { className } = req.params;
    const result = await rejectTimetable(req.user.schoolId, req.user._id, {
      className,
      term: req.body.term,
      academicYear: req.body.academicYear,
      reason: req.body.reason,
    });
    return res.status(200).json({
      success: true,
      message: "Timetable rejected",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * GET /admin/timetables/submissions — the administrator's review queue.
 */
export const listSubmissionsController = async (req, res) => {
  try {
    const result = await listSubmissions(req.user.schoolId, {
      term: req.query.term,
      academicYear: req.query.academicYear,
    });
    return res.status(200).json({
      success: true,
      message: "Submissions loaded",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * GET /teacher/timetables — the teacher's own timetables.
 */
export const listTimetablesForTeacherController = async (req, res) => {
  try {
    const result = await listTimetablesForTeacher(req.teacher.schoolId, req.teacher._id, {
      term: req.query.term,
      academicYear: req.query.academicYear,
    });
    return res.status(200).json({
      success: true,
      message: "Timetables loaded",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
       message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * POST /admin/timetables/deactivate — remove a published timetable from views
 * without hard-deleting it.
 */
export const deactivateTimetableController = async (req, res) => {
  try {
    const result = await deactivateTimetable(req.user.schoolId, req.user._id, req.body);
    return res.status(200).json({ success: true, message: "Timetable deactivated", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * POST /admin/timetables/republish — re-publish a deactivated timetable.
 */
export const republishTimetableController = async (req, res) => {
  try {
    const result = await republishTimetable(req.user.schoolId, req.user._id, req.body);
    return res.status(200).json({ success: true, message: "Timetable republished", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * DELETE /admin/timetables/:className/remove — permanently remove a timetable.
 */
export const removeTimetableController = async (req, res) => {
  try {
    const { className } = req.params;
    const result = await removeTimetable(req.user.schoolId, req.user._id, {
      className,
      term: req.query.term,
      academicYear: req.query.academicYear,
    });
    return res.status(200).json({ success: true, message: "Timetable removed", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * GET /admin/timetables/removal-requests — the admin's removal request queue.
 */
export const listRemovalRequestsController = async (req, res) => {
  try {
    const result = await listRemovalRequests(req.user.schoolId);
    return res.status(200).json({ success: true, message: "Removal requests loaded", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * POST /admin/timetables/:className/confirm-removal — confirm a removal request.
 */
export const confirmRemovalController = async (req, res) => {
  try {
    const { className } = req.params;
    const result = await confirmRemoval(req.user.schoolId, req.user._id, {
      className,
      term: req.body.term,
      academicYear: req.body.academicYear,
    });
    return res.status(200).json({ success: true, message: "Removal confirmed", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * POST /admin/timetables/:className/reject-removal — reject a removal request.
 */
export const rejectRemovalController = async (req, res) => {
  try {
    const { className } = req.params;
    const result = await rejectRemovalRequest(req.user.schoolId, req.user._id, {
      className,
      term: req.body.term,
      academicYear: req.body.academicYear,
    });
    return res.status(200).json({ success: true, message: "Removal request rejected", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * POST /teacher/timetables/:className/request-removal — teacher requests removal.
 */
export const requestRemovalController = async (req, res) => {
  try {
    const { className } = req.params;
    const result = await requestTimetableRemoval(req.teacher.schoolId, req.teacher._id, {
      className,
      term: req.body.term,
      academicYear: req.body.academicYear,
      reason: req.body.reason,
    });
    return res.status(200).json({ success: true, message: "Removal request submitted", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

/**
 * POST /teacher/timetables/:className/withdraw-removal — teacher withdraws a removal request.
 */
export const withdrawRemovalController = async (req, res) => {
  try {
    const { className } = req.params;
    const result = await withdrawRemovalRequest(req.teacher.schoolId, req.teacher._id, {
      className,
      term: req.body.term,
      academicYear: req.body.academicYear,
    });
    return res.status(200).json({ success: true, message: "Removal request withdrawn", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};
export const getTimetableForTeacherController = async (req, res) => {
  try {
    const { className } = req.params;
    const result = await getTimetableForTeacher(
      req.teacher.schoolId,
      req.teacher._id,
      className,
      { term: req.query.term, academicYear: req.query.academicYear }
    );
    return res.status(200).json({
      success: true,
      message: "Timetable loaded",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};
