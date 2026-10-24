import {
  listTeacherStudents,
  listTeacherAssignmentCounts,
  assignStudents,
  assignStudentsByClass,
  unassignStudents,
} from "../../services/admin/teacherAssignment.service.js";
import {
  detectAssignmentDrift,
  repairAssignmentDrift,
} from "../../services/admin/teacherClassLink.js";
import { resolveErrorMessage } from "../../middleware/errorHandler.js";

/**
 * The teacher-assignment controllers.
 *
 * Same contract as `class.controller.js`: resolve the school scope from the
 * token, shape the envelope, and let the service throw. Nothing here decides
 * whether a caller *may* assign — that is the route's `requireSchoolAdmin`, and
 * duplicating it here would be a second gate to forget.
 *
 * The counts endpoint is `GET /users/teacher-assignment-counts` rather than a
 * field on `GET /users`, because it is a different question with a different
 * shape: `GET /users` returns the staff roster, and adding per-teacher student
 * counts to it would make every consumer of that list — the assign-teacher
 * picker, the user-management table — carry an aggregation it does not want.
 */
export const listTeacherStudentsController = async (req, res) => {
  try {
    const result = await listTeacherStudents(
      req.user.schoolId,
      req.params.teacherId,
      req.query
    );
    return res.status(200).json({
      success: true,
      message: "Teacher students loaded",
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

export const listTeacherAssignmentCountsController = async (req, res) => {
  try {
    const counts = await listTeacherAssignmentCounts(req.user.schoolId);
    // Drift is returned with the counts so the console can show the repair
    // affordance on the same load as the tallies it contradicts, rather than
    // making an admin discover the mismatch by asking a teacher why their page
    // is empty.
    const drift = await detectAssignmentDrift(req.user.schoolId);
    return res.status(200).json({
      success: true,
      message: "Assignment counts loaded",
      data: { counts, drift },
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
 * `POST /admin/users/teacher-assignment-drift/repair`
 *
 * Writes the `assignedClasses` slots that existing class-mediated rows imply.
 * The fix for teachers whose console shows children but whose portal shows
 * none — rows written before `syncClassTeacher` existed, or against service
 * code from before it was deployed.
 */
export const repairAssignmentDriftController = async (req, res) => {
  try {
    const { teacherId } = req.body || {};
    const result = await repairAssignmentDrift(req.user.schoolId, teacherId);
    return res.status(200).json({
      success: true,
      message: result.repaired
        ? `Synced ${result.classes} class${result.classes === 1 ? "" : "es"} for ${result.repaired} teacher${result.repaired === 1 ? "" : "s"}.`
        : "Nothing to sync — every assignment is already on the portal.",
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

export const assignStudentsController = async (req, res) => {
  try {
    // `className` on the body selects the class path: the resolver would
    // otherwise have to guess, and a body that names both a class and a list is
    // refused by validation rather than half-honoured here.
    const { studentIds, className, role, subjects, canMarkAttendance } = req.body;
    const result = className
      ? await assignStudentsByClass(
          req.user.schoolId,
          req.user._id,
          req.params.teacherId,
          className,
          { role, subjects, canMarkAttendance }
        )
      : await assignStudents(req.user.schoolId, req.user._id, req.params.teacherId, studentIds);

    return res.status(200).json({
      success: true,
      message: className
        ? `Assigned ${result.assigned} student${result.assigned === 1 ? "" : "s"} from ${className}.`
        : `Assigned ${result.assigned} student${result.assigned === 1 ? "" : "s"}.`,
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

export const unassignStudentsController = async (req, res) => {
  try {
    const result = await unassignStudents(
      req.user.schoolId,
      req.user._id,
      req.params.teacherId,
      req.body
    );
    return res.status(200).json({
      success: true,
      message: `Removed ${result.removed} student${result.removed === 1 ? "" : "s"}${
        result.skipped ? ` — ${result.skipped} left alone (assigned with a class).` : "."
      }`,
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
