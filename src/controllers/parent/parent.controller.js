import {
  getStudentAttendanceForTerm,
} from "../../services/parent/attendance.service.js";
import {
  getStudentRecordsForTerm,
} from "../../services/parent/records.service.js";
import {
  getStudentTimetable,
} from "../../services/parent/timetable.service.js";
import { resolveErrorMessage } from "../../middleware/errorHandler.js";

/**
 * The parent portal's academic reads: attendance, records, timetable.
 *
 * Every handler here is unauthenticated — the pay token in the path is the
 * credential — so each one follows the two rules the payment-surface controllers
 * in `controllers/payment.controller.js` already follow:
 *
 *  1. **The token never reaches a log line in the clear.** Each service hashes
 *     it before writing its audit entry (`utils/tokens.js:hashTokenForLog`), and
 *     nothing here echoes it back either.
 *  2. **The audit entry is written by the service, not by this controller.**
 *     `AuditLog.entityId` is an ObjectId, and the response projection deliberately
 *     does not carry a student's `_id` — the portal answers with `studentId`
 *     ("PBS-2026-0001") instead. Logging from here would mean either writing the
 *     internal id into the response or dropping the entry, and a dropped entry is
 *     how this product lost a whole feature's audit trail once already.
 *
 * The controllers are therefore thin: call the service, shape the envelope, and
 * answer errors through `resolveErrorMessage`, which is what stops a 5xx
 * message from being shown to a parent holding a pay link.
 */
export const getParentAttendanceController = async (req, res) => {
  try {
    const { token } = req.params;
    const { term } = req.query;
    const data = await getStudentAttendanceForTerm(token, { term });

    return res.status(200).json({
      success: true,
      message: "Attendance retrieved",
      data,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export const getParentRecordsController = async (req, res) => {
  try {
    const { token } = req.params;
    const { term } = req.query;
    // `null` when the term has no published card. 200, not 404 — an unpublished
    // term is a state, not a failure, and the portal renders its empty state.
    const data = await getStudentRecordsForTerm(token, { term });

    return res.status(200).json({
      success: true,
      message: data ? "Records retrieved" : "No records published yet",
      data,
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
 * `GET /pay/:token/records.pdf` — the report card as a download.
 *
 * Answers plain text, not JSON, on both failure paths. A parent who lands here
 * has clicked "Download report card", so the response body is read by a browser
 * download prompt rather than by the app's error boundary — a JSON envelope
 * would appear as the file's entire contents.
 *
 * The PDF itself is fetched from the school's stored URL (Cloudinary) rather
 * than regenerated on each request: the card is a point-in-time record of a
 * published term, and recompiling it from live attendance would rewrite history
 * every time a parent downloaded it.
 */
export const getParentRecordsPdfController = async (req, res) => {
  try {
    const { token } = req.params;
    const { term } = req.query;
    const data = await getStudentRecordsForTerm(token, { term });

    if (!data || !data.pdfUrl) {
      return res
        .status(404)
        .type("text/plain")
        .send("Report card has not been published for this term.");
    }

    const upstream = await fetch(data.pdfUrl);
    if (!upstream.ok) {
      return res
        .status(502)
        .type("text/plain")
        .send("Report card could not be retrieved. Please contact the school.");
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="report-${data.studentId}-${String(term || "Term 2").replace(/\s/g, "")}.pdf"`
    );
    res.setHeader("Content-Length", String(buffer.length));
    return res.status(200).send(buffer);
  } catch (error) {
    return res
      .status(error.status || 500)
      .type("text/plain")
      .send(error.status ? error.message : "Could not stream the report card.");
  }
};

export const getParentTimetableController = async (req, res) => {
  try {
    const { token } = req.params;
    const { weekOf } = req.query;
    const data = await getStudentTimetable(token, { weekOf });

    return res.status(200).json({
      success: true,
      message: "Timetable retrieved",
      data,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};
