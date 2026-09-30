import {
  createStudent,
  bulkCreateStudents,
  listStudents,
  getStudentStats,
  getStudentProfile,
  getStudentById,
  updateStudent,
  deleteStudent,
  restoreStudent,
  suspendStudent,
  reactivateStudent,
  removeStudent,
  transferStudentClass,
  regeneratePayLink,
  exportStudents,
  promoteStudent,
  bulkPromoteStudents,
  previewPromotion,
  repeatStudent,
  clearRepeat,
  graduateStudent,
  bulkGraduateStudents,
  transferOutStudent,
  getAlumni,
  getCohorts,
  getCohortDetail,
  addParent,
  getParents,
  updateParent,
  setPrimaryParent,
  removeParent,
  bulkUpdateStudents,
  bulkArchiveStudents,
  bulkSetStatus,
  bulkRegeneratePayLinks,
} from "../services/student.service.js";

/**
 * The one error responder for every controller in this module.
 *
 * `ApiError` in the service carries a `code` on ~30 distinct conditions
 * (`INVALID_CLASS`, `MAX_REPEATS_EXCEEDED`, `BULK_LIMIT_EXCEEDED`,
 * `STUDENT_REPEATING`, …) and every controller previously returned only
 * `{ success, message }`, so all of that was thrown away. A client could not
 * branch on a code and had to string-match an English sentence, which breaks the
 * moment the copy is edited. `api.js` on the frontend already branches on
 * `data.code` for `SCHOOL_NOT_LINKED`, so the contract exists — this module
 * just never sent it.
 */
const fail = (res, error) =>
  res.status(error.status || 500).json({
    success: false,
    message: error.message,
    code: error.code || "INTERNAL_ERROR",
  });

// ─────────────────────────────────────────────
// CREATE STUDENT (single)
// ─────────────────────────────────────────────
export const createStudentController = async (req, res) => {
  try {
    const student = await createStudent(req.body, req.user);

    return res.status(201).json({
      success: true,
      message: "Student created successfully",
      data: student,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// BULK CREATE STUDENTS
// ─────────────────────────────────────────────
export const bulkCreateStudentsController = async (req, res) => {
  try {
    const result = await bulkCreateStudents(req.file, req.body, req.user);

    if (result.created === 0) {
      return res.status(400).json({
        success: false,
        message: `No valid students were imported (${result.failed} rows failed validation)`,
        data: {
          created: 0,
          failed: result.failed,
          errors: result.errors,
        },
      });
    }

    return res.status(201).json({
      success: true,
      message: `${result.created} students imported successfully, ${result.failed} rows failed`,
      data: {
        created: result.created,
        failed: result.failed,
        errors: result.errors,
      },
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// LIST STUDENTS
// ─────────────────────────────────────────────
export const listStudentsController = async (req, res) => {
  try {
    const result = await listStudents(req.query, req.user);

    return res.status(200).json({
      success: true,
      message: "Students retrieved successfully",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// ROSTER AGGREGATES (the Students module KPI band)
// ─────────────────────────────────────────────
export const getStudentStatsController = async (req, res) => {
  try {
    const data = await getStudentStats(req.query, req.user);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// STUDENT PROFILE PREVIEW (one aggregate, one render)
// ─────────────────────────────────────────────
export const getStudentProfileController = async (req, res) => {
  try {
    const data = await getStudentProfile(req.params.id, req.user, {
      includeDeleted: req.query.includeDeleted === "true",
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// GET SINGLE STUDENT
// ─────────────────────────────────────────────
export const getStudentController = async (req, res) => {
  try {
    const student = await getStudentById(req.params.id, req.user);

    return res.status(200).json({
      success: true,
      message: "Student retrieved successfully",
      data: student,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// UPDATE STUDENT
// ─────────────────────────────────────────────
export const updateStudentController = async (req, res) => {
  try {
    const student = await updateStudent(req.params.id, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Student updated successfully",
      data: student,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// DELETE STUDENT (soft)
// ─────────────────────────────────────────────
export const deleteStudentController = async (req, res) => {
  try {
    const result = await deleteStudent(req.params.id, req.user);

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// RESTORE AN ARCHIVED STUDENT
// ─────────────────────────────────────────────
export const restoreStudentController = async (req, res) => {
  try {
    const student = await restoreStudent(req.params.id, req.user);
    return res.status(200).json({
      success: true,
      message: "Student restored to the roster",
      data: student,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// CLEAR REPEAT
// ─────────────────────────────────────────────
export const clearRepeatController = async (req, res) => {
  try {
    const student = await clearRepeat(req.params.id, req.body, req.user);
    return res.status(200).json({
      success: true,
      message: "Repeat flag cleared",
      data: student,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// BULK UPDATE STUDENTS
// ─────────────────────────────────────────────
export const bulkUpdateStudentsController = async (req, res) => {
  try {
    const result = await bulkUpdateStudents(req.body, req.user);
    return res.status(200).json({
      success: true,
      message: result.committed
        ? `${result.updated} students updated`
        : `Preview of ${result.matched} students — nothing was written`,
      data: result,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// BULK ARCHIVE STUDENTS
// ─────────────────────────────────────────────
export const bulkArchiveStudentsController = async (req, res) => {
  try {
    const result = await bulkArchiveStudents(req.body, req.user);
    // 409 rather than 200 when the archive was refused for outstanding
    // balances: the request was understood and deliberately not performed, and
    // a 200 would let a client treat it as a success it was not.
    if (result.requiresForce) {
      return res.status(409).json({
        success: false,
        message: `${result.failed} students have an outstanding balance. Re-send with force to archive them anyway.`,
        code: "OUTSTANDING_BALANCE",
        data: result,
      });
    }
    return res.status(200).json({
      success: true,
      message: result.committed
        ? `${result.archived} students archived`
        : `Preview of ${result.matched} students — nothing was written`,
      data: result,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// BULK SET STATUS
// ─────────────────────────────────────────────
export const bulkSetStatusController = async (req, res) => {
  try {
    const result = await bulkSetStatus(req.body, req.user);
    return res.status(200).json({
      success: true,
      message: result.committed
        ? `${result.changed} students updated`
        : `Preview of ${result.matched} students — nothing was written`,
      data: result,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// BULK REGENERATE PAY LINKS
// ─────────────────────────────────────────────
export const bulkRegeneratePayLinksController = async (req, res) => {
  try {
    const result = await bulkRegeneratePayLinks(req.body, req.user);
    return res.status(200).json({
      success: true,
      message: result.committed
        ? `${result.regenerated} pay links regenerated`
        : `Preview of ${result.matched} students — nothing was written`,
      data: result,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// SUSPEND STUDENT
// ─────────────────────────────────────────────
export const suspendStudentController = async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "Suspension reason is required",
      });
    }

    const student = await suspendStudent(req.params.id, reason, req.user);

    return res.status(200).json({
      success: true,
      message: "Student suspended successfully",
      data: student,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// REACTIVATE STUDENT
// ─────────────────────────────────────────────
export const reactivateStudentController = async (req, res) => {
  try {
    const student = await reactivateStudent(req.params.id, req.user);

    return res.status(200).json({
      success: true,
      message: "Student reactivated successfully",
      data: student,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// REMOVE / ARCHIVE STUDENT
// ─────────────────────────────────────────────
export const removeStudentController = async (req, res) => {
  try {
    const result = await removeStudent(req.params.id, req.user);

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// TRANSFER CLASS
// ─────────────────────────────────────────────
export const transferStudentController = async (req, res) => {
  try {
    const { newClass, reason } = req.body;

    const student = await transferStudentClass(req.params.id, newClass, reason, req.user);

    return res.status(200).json({
      success: true,
      message: "Student transferred to new class successfully",
      data: student,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// REGENERATE PAY LINK
// ─────────────────────────────────────────────
export const regeneratePayLinkController = async (req, res) => {
  try {
    const notify = req.query.notify === "true";

    const result = await regeneratePayLink(req.params.id, req.user, { notify });

    return res.status(200).json({
      success: true,
      message: "Pay link regenerated successfully",
      data: result,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// EXPORT STUDENTS
// ─────────────────────────────────────────────
export const exportStudentsController = async (req, res) => {
  try {
    const result = await exportStudents(req.query, req.user);

    res.setHeader("Content-Type", result.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.set("Content-Length", String(result.content.length));

    return res.send(result.content);
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// PROMOTE SINGLE STUDENT
// ─────────────────────────────────────────────
export const promoteStudentController = async (req, res) => {
  try {
    const student = await promoteStudent(req.params.id, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Student promoted successfully",
      data: { student },
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// BULK PROMOTE STUDENTS
// ─────────────────────────────────────────────
export const bulkPromoteStudentsController = async (req, res) => {
  try {
    const schoolId = req.params.schoolId;
    const result = await bulkPromoteStudents(schoolId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Bulk promotion completed",
      data: result,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// PREVIEW PROMOTION
// ─────────────────────────────────────────────
export const previewPromotionController = async (req, res) => {
  try {
    const result = await previewPromotion(req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Promotion preview generated",
      data: result,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// REPEAT STUDENT
// ─────────────────────────────────────────────
export const repeatStudentController = async (req, res) => {
  try {
    const student = await repeatStudent(req.params.id, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Student marked as repeating",
      data: { student },
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// GRADUATE SINGLE STUDENT
// ─────────────────────────────────────────────
export const graduateStudentController = async (req, res) => {
  try {
    const result = await graduateStudent(req.params.id, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Student graduated successfully",
      data: result,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// BULK GRADUATE STUDENTS
// ─────────────────────────────────────────────
export const bulkGraduateStudentsController = async (req, res) => {
  try {
    const schoolId = req.params.schoolId;
    const result = await bulkGraduateStudents(schoolId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Bulk graduation completed",
      data: result,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// TRANSFER OUT STUDENT
// ─────────────────────────────────────────────
export const transferOutStudentController = async (req, res) => {
  try {
    const result = await transferOutStudent(req.params.id, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Student transfer recorded",
      data: result,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// GET ALUMNI
// ─────────────────────────────────────────────
export const getAlumniController = async (req, res) => {
  try {
    const result = await getAlumni(req.query, req.user);

    return res.status(200).json({
      success: true,
      message: "Alumni retrieved successfully",
      data: result,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// GET COHORTS
// ─────────────────────────────────────────────
export const getCohortsController = async (req, res) => {
  try {
    const result = await getCohorts(req.query, req.user);

    return res.status(200).json({
      success: true,
      message: "Cohorts retrieved successfully",
      data: result,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// GET COHORT DETAIL
// ─────────────────────────────────────────────
export const getCohortDetailController = async (req, res) => {
  try {
    const result = await getCohortDetail(req.params.cohortId, req.query, req.user);

    return res.status(200).json({
      success: true,
      message: "Cohort details retrieved successfully",
      data: result,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// ADD PARENT TO STUDENT
// ─────────────────────────────────────────────
export const addParentController = async (req, res) => {
  try {
    const student = await addParent(req.params.id, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Parent added successfully",
      data: { student },
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// LIST PARENTS FOR STUDENT
// ─────────────────────────────────────────────
export const getParentsController = async (req, res) => {
  try {
    const parents = await getParents(req.params.id, req.user);

    return res.status(200).json({
      success: true,
      message: "Parents retrieved successfully",
      data: { parents },
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// UPDATE PARENT INFO
// ─────────────────────────────────────────────
export const updateParentController = async (req, res) => {
  try {
    // Both params come from the route now. The routes were mounted at
    // `/parents/:parentId` while the controllers read `req.params.id`, so
    // `studentId` was `undefined`, the lookup was `findOne({ _id: undefined })`
    // and every one of the three parent writes 400'd.
    const student = await updateParent(
      req.params.id,
      req.params.parentId,
      req.body,
      req.user
    );

    return res.status(200).json({
      success: true,
      message: "Parent updated successfully",
      data: { student },
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// SET PARENT AS PRIMARY
// ─────────────────────────────────────────────
export const setPrimaryParentController = async (req, res) => {
  try {
    const student = await setPrimaryParent(req.params.id, req.params.parentId, req.user);

    return res.status(200).json({
      success: true,
      message: "Primary parent set successfully",
      data: { student },
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ─────────────────────────────────────────────
// REMOVE PARENT
// ─────────────────────────────────────────────
export const removeParentController = async (req, res) => {
  try {
    const student = await removeParent(req.params.id, req.params.parentId, req.user);

    return res.status(200).json({
      success: true,
      message: "Parent removed successfully",
      data: { student },
    });
  } catch (error) {
    return fail(res, error);
  }
};
