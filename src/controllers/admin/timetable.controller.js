import {
  upsertTimetable,
  saveTimetableForClass,
  getTimetable,
  listTimetables,
  publishTimetable,
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
    const result = await upsertTimetable(schoolId, req.user._id, req.body);

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
    const result = await saveTimetableForClass(req.user.schoolId, req.user._id, req.body);
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
    const result = await publishTimetable(req.user.schoolId, req.user._id, req.body);
    return res.status(200).json({ success: true, message: "Timetable published", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};
