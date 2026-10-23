import {
  getMyClasses,
  getClassRoster,
  getClassSummary,
  getAvailableClasses,
} from "../../services/teacher/classes.service.js";
import {
  getAttendanceForDate,
  getStudentAttendance,
} from "../../services/teacher/attendance.service.js";
import {
  getClassGrades,
  getStudentGrades,
  saveSingleGrade,
  saveBulkGrades,
} from "../../services/teacher/grades.service.js";
import { getTeacherDashboard, acceptCurrentPeriod } from "../../services/teacher/dashboard.service.js";
import { getTeacherSchedule } from "../../services/teacher/schedule.service.js";
import { resolveErrorMessage } from "../../middleware/errorHandler.js";

/**
 * The teacher portal's controllers.
 *
 * They are thin on purpose: the scope check, the term resolution and the
 * arithmetic all live in `services/teacher/*`, and what is left here is the
 * envelope and the error answer.
 *
 * **They read `req.teacher`, not `req.user`.** `teacher.routes.js` resolves the
 * signed-in account plus the school the request is scoped to into that one
 * object (`utils/teacherScope.js:resolveTeacherActor`), because a super admin
 * impersonating a school has a null `schoolId` and would otherwise be refused
 * the portal they were admitted to. Everything below takes that actor and never
 * re-derives a school from a request of its own.
 *
 * Errors are answered by the controller rather than forwarded to
 * `errorHandler.js`, and `resolveErrorMessage` is used for the same reason the
 * other controllers use it — a 4xx message is written for a teacher to read,
 * and a 5xx is not. `error.code` is echoed when present so the client can route
 * on `FORBIDDEN_SCOPE` without parsing the prose.
 */
const failure = (res, error) =>
  res.status(error.status || 500).json({
    success: false,
    message: resolveErrorMessage(error),
    ...(error.code ? { code: error.code } : {}),
  });

// ── Dashboard ──
export const getDashboardController = async (req, res) => {
  try {
    const data = await getTeacherDashboard(req.teacher);
    return res
      .status(200)
      .json({ success: true, message: "Dashboard loaded", data });
  } catch (error) {
    return failure(res, error);
  }
};

// ── Classes ──
export const getMyClassesController = async (req, res) => {
  try {
    const data = await getMyClasses(req.teacher);
    return res
      .status(200)
      .json({ success: true, message: "Classes loaded", data });
  } catch (error) {
    return failure(res, error);
  }
};

export const getClassRosterController = async (req, res) => {
  try {
    const data = await getClassRoster(req.teacher, req.query);
    return res
      .status(200)
      .json({ success: true, message: "Roster loaded", data });
  } catch (error) {
    return failure(res, error);
  }
};

export const getClassSummaryController = async (req, res) => {
  try {
    const data = await getClassSummary(req.teacher, req.params.className, req.query);
    return res
      .status(200)
      .json({ success: true, message: "Summary loaded", data });
  } catch (error) {
    return failure(res, error);
  }
};

// ── Attendance ──
export const getAttendanceForDateController = async (req, res) => {
  try {
    const data = await getAttendanceForDate(req.teacher, req.query);
    return res
      .status(200)
      .json({ success: true, message: "Attendance loaded", data });
  } catch (error) {
    return failure(res, error);
  }
};

export const getStudentAttendanceController = async (req, res) => {
  try {
    const data = await getStudentAttendance(req.teacher, req.params.studentId, req.query);
    return res
      .status(200)
      .json({ success: true, message: "Attendance loaded", data });
  } catch (error) {
    return failure(res, error);
  }
};

// ── Grades ──
export const getClassGradesController = async (req, res) => {
  try {
    const data = await getClassGrades(req.teacher, req.query);
    return res
      .status(200)
      .json({ success: true, message: "Grades loaded", data });
  } catch (error) {
    return failure(res, error);
  }
};

export const getStudentGradesController = async (req, res) => {
  try {
    const data = await getStudentGrades(req.teacher, req.params.studentId, req.query);
    return res
      .status(200)
      .json({ success: true, message: "Grades loaded", data });
  } catch (error) {
    return failure(res, error);
  }
};

export const saveSingleGradeController = async (req, res) => {
  try {
    const data = await saveSingleGrade(req.teacher, req.body);
    return res
      .status(200)
      .json({ success: true, message: "Grade saved", data });
  } catch (error) {
    return failure(res, error);
  }
};

export const saveBulkGradesController = async (req, res) => {
  try {
    const data = await saveBulkGrades(req.teacher, req.body);
    return res.status(200).json({
      success: true,
      // The count the toast shows is the one the teacher cares about, and it is
      // derived from the same `saved`/`attempted` the payload reports.
      message: `Saved ${data.saved} of ${data.attempted} grades`,
      data,
    });
  } catch (error) {
    return failure(res, error);
  }
};

// ── Schedule ──
export const getScheduleController = async (req, res) => {
  try {
    const data = await getTeacherSchedule(req.teacher);
    return res
      .status(200)
      .json({ success: true, message: "Schedule loaded", data });
  } catch (error) {
    return failure(res, error);
  }
};

// ── Available classes ──
export const getAvailableClassesController = async (req, res) => {
  try {
    const data = await getAvailableClasses(req.teacher);
    return res.status(200).json({
      success: true,
      message: "Classes loaded",
      data,
    });
  } catch (error) {
    return failure(res, error);
  }
};


export const acceptCurrentPeriodController = async (req, res) => {
  try {
    const data = await acceptCurrentPeriod(
      req.teacher._id,
      req.teacher.schoolId,
      req.body.timetableId,
      req.body.day,
      req.body.periodNumber
    );
    return res.status(200).json({ success: true, message: "Period accepted", data });
  } catch (error) {
    return failure(res, error);
  }
};
