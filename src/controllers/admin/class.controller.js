import {
  listClasses,
  createClass,
  archiveClass,
  assignClassTeacher,
  assignSubjectTeacher,
  unassignSubjectTeacher,
  getClassAssignments,
} from "../../services/admin/class.service.js";
import { resolveErrorMessage } from "../../middleware/errorHandler.js";

/**
 * Class and teacher management.
 *
 * A class is a *name* in this product, so the class being acted on is named in
 * the path (`:className`, URL-encoded) rather than addressed by an id there is
 * no document to carry — see `services/admin/class.service.js`. The controllers
 * still do the two things a controller is for and nothing else: resolve the
 * school scope from the token, and shape the envelope. Every error goes through
 * `resolveErrorMessage`; every audit entry is written by the service.
 */

export const listClassesController = async (req, res) => {
  try {
    const result = await listClasses(req.user.schoolId, req.query);
    return res.status(200).json({ success: true, message: "Classes loaded", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export const createClassController = async (req, res) => {
  try {
    const result = await createClass(req.user.schoolId, req.user._id, req.body);
    return res.status(201).json({ success: true, message: "Class created", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export const archiveClassController = async (req, res) => {
  try {
    const result = await archiveClass(req.user.schoolId, req.user._id, req.params.className);
    return res.status(200).json({ success: true, message: "Class archived", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export const getClassAssignmentsController = async (req, res) => {
  try {
    const result = await getClassAssignments(req.user.schoolId, req.params.className);
    return res.status(200).json({
      success: true,
      message: "Assignments loaded",
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

export const assignClassTeacherController = async (req, res) => {
  try {
    const result = await assignClassTeacher(
      req.user.schoolId,
      req.user._id,
      req.params.className,
      req.body.teacherId
    );
    return res.status(200).json({ success: true, message: "Class teacher assigned", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: resolveErrorMessage(error),
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

export const assignSubjectTeacherController = async (req, res) => {
  try {
    const result = await assignSubjectTeacher(
      req.user.schoolId,
      req.user._id,
      req.params.className,
      req.body
    );
    return res.status(200).json({
      success: true,
      message: "Subject teacher assigned",
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

export const unassignSubjectTeacherController = async (req, res) => {
  try {
    const result = await unassignSubjectTeacher(
      req.user.schoolId,
      req.user._id,
      req.params.className,
      req.params.subject
    );
    return res.status(200).json({
      success: true,
      message: "Subject teacher removed",
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
