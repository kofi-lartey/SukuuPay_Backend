import {
  createStudent,
  bulkCreateStudents,
  listStudents,
  getStudentById,
  updateStudent,
  deleteStudent,
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
} from "../services/student.service.js";

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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// UPDATE PARENT INFO
// ─────────────────────────────────────────────
export const updateParentController = async (req, res) => {
  try {
    const student = await updateParent(req.params.id, req.params.parentId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Parent updated successfully",
      data: { student },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};
