import mongoose from "mongoose";
import QRCode from "qrcode";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import { IdCardBatch } from "../models/IdCardBatch.js";
import { IdCardTemplate } from "../models/IdCardTemplate.js";
import { createNotification } from "./notification.service.js";
import {
  generateIdCardSheets,
  sheetGeometry,
  DEFAULT_SHEET_LAYOUT,
} from "../utils/idCardSheet.js";
import { resolveCardData, DEFAULT_CARD_FIELDS } from "../utils/idCardContract.js";
import { uploadBuffer } from "../utils/cloudinary.js";
import { CLOUDINARY_UPLOAD_FOLDER } from "../config/env.js";
import { AUDIT_ACTIONS, ID_CARD_BATCH_STATUS } from "../config/constants.js";
import { log as auditLog } from "../utils/auditService.js";
import ApiError from "../utils/ApiError.js";

const resolveSchoolId = (user, explicitSchoolId) => {
  if (user && user.role === "super_admin") {
    return explicitSchoolId ? new mongoose.Types.ObjectId(explicitSchoolId) : null;
  }
  return user && user.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

export const generateQrCodeDataUrl = async (text) => {
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: "M",
      width: 256,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch (error) {
    console.error("[ID-CARD] QR generation failed:", error.message);
    return null;
  }
};

const findStudentInScope = async (studentId, schoolId) => {
  const student = await Student.findOne({
    _id: studentId,
    schoolId,
    deletedAt: null,
  }).lean();

  if (!student) {
    throw new ApiError("Student not found", 404, "STUDENT_NOT_FOUND");
  }
  return student;
};

const buildCardData = (student, school, derived = {}, fields = DEFAULT_CARD_FIELDS) =>
  resolveCardData(student, school, derived, { fields });

// ─────────────────────────── Single card ───────────────────────────

export const generateSingleStudentIdCard = async (studentId, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const student = await findStudentInScope(studentId, schoolId);

  const school = await School.findById(schoolId)
    .select("name logo stamp motto schoolCode brandColor academic.currentYear")
    .lean();
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  const qrDataUrl = student.payLink
    ? await generateQrCodeDataUrl(student.payLink)
    : null;

  const cardData = buildCardData(student, school, { qrCodeUrl: qrDataUrl });

  const pdfBuffer = await generateIdCardSheets([cardData], {
    layout: DEFAULT_SHEET_LAYOUT,
    side: "front_back",
  });

  return {
    pdfBuffer,
    filename: `id-card-${student.studentId || studentId}-${student.studentName
      .replace(/\s+/g, "-")
      .toLowerCase()}.pdf`,
  };
};

// ─────────────────────────── Batch create ───────────────────────────

export const createIdCardBatch = async (data, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const {
    studentIds,
    includeQr = true,
    includePhoto = true,
    useSchoolSettings = true,
    templateId = null,
  } = data;

  const validStudents = await Student.find({
    _id: { $in: studentIds },
    schoolId,
    deletedAt: null,
  })
    .select("_id")
    .lean();

  const validIds = validStudents.map((s) => s._id.toString());
  const invalidCount = studentIds.filter(
    (id) => !validIds.includes(id.toString())
  ).length;

  if (invalidCount > 0) {
    throw new ApiError(
      `${invalidCount} of the provided student IDs do not belong to your school`,
      400,
      "INVALID_STUDENTS"
    );
  }

  let settingsSnapshot;
  let resolvedTemplateId = null;

  if (templateId) {
    const template = await IdCardTemplate.findOne({
      _id: templateId,
      schoolId,
      deletedAt: null,
    }).lean();

    if (!template) {
      throw new ApiError("Template not found", 404, "NOT_FOUND");
    }

    resolvedTemplateId = template._id;
    settingsSnapshot = {
      sheetLayout: template.layout.sheetLayout || DEFAULT_SHEET_LAYOUT,
      sides: template.layout.sides || "front_back",
      includeCutGuides: template.layout.includeCutGuides || false,
      showPhoto: template.fields.showPhoto !== undefined ? template.fields.showPhoto : true,
      showQr: template.fields.showQr !== undefined ? template.fields.showQr : true,
      showStamp: template.fields.showStamp !== undefined ? template.fields.showStamp : true,
      termsOverride: template.text.termsOverride || null,
      footerLeft: template.text.footerLeft || "SUKUUPAY",
      footerRight: template.text.footerRight || null,
    };
  } else if (useSchoolSettings) {
    const school = await School.findById(schoolId)
      .select("settings.idCards")
      .lean();

    settingsSnapshot = {
      sheetLayout: school?.settings?.idCards?.sheetLayout || DEFAULT_SHEET_LAYOUT,
      sides: school?.settings?.idCards?.sides || "front_back",
      includeCutGuides: school?.settings?.idCards?.includeCutGuides || false,
      showPhoto: school?.settings?.idCards?.showPhoto !== false,
      showQr: school?.settings?.idCards?.showQr !== false,
      showStamp: school?.settings?.idCards?.showStamp !== false,
      termsOverride: null,
      footerLeft: "SUKUUPAY",
      footerRight: null,
    };
  } else {
    settingsSnapshot = {
      sheetLayout: DEFAULT_SHEET_LAYOUT,
      sides: "front_back",
      includeCutGuides: false,
      showPhoto: true,
      showQr: true,
      showStamp: true,
      termsOverride: null,
      footerLeft: "SUKUUPAY",
      footerRight: null,
    };
  }

  const batch = await IdCardBatch.create({
    schoolId,
    studentIds: validStudents.map((s) => s._id),
    totalCards: validStudents.length,
    status: ID_CARD_BATCH_STATUS.PENDING,
    requestedBy: requester._id,
    templateId: resolvedTemplateId,
    settingsSnapshot,
  });

  await auditLog({
    action: AUDIT_ACTIONS.ID_CARD_BATCH_CREATE || "id_card.batch.create",
    entity: "IdCardBatch",
    entityId: batch._id,
    userId: requester._id,
    schoolId,
    meta: {
      totalCards: batch.totalCards,
      includeQr,
      includePhoto,
      useSchoolSettings,
      templateId: resolvedTemplateId,
    },
  });

  setImmediate(async () => {
    const { generateIdCards } = await import("../jobs/generateIdCards.job.js");
    generateIdCards(batch._id.toString()).catch((error) => {
      console.error(`[ID-CARD] Batch ${batch._id} generation failed:`, error.message);
    });
  });

  return { batchId: batch._id, status: batch.status };
};

// ─────────────────────────── Batch preview (HTML) ───────────────────────────

export const getIdCardBatchPreview = async (batchId, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const batch = await IdCardBatch.findOne({ _id: batchId, schoolId }).lean();
  if (!batch) throw new ApiError("Batch not found", 404, "NOT_FOUND");

  if (batch.status === ID_CARD_BATCH_STATUS.PENDING) {
    return { status: ID_CARD_BATCH_STATUS.PENDING, retryAfter: 15 };
  }

  if (batch.status === ID_CARD_BATCH_STATUS.FAILED) {
    return { status: ID_CARD_BATCH_STATUS.FAILED, error: batch.generationError };
  }

  const students = await Student.find({
    _id: { $in: batch.studentIds },
    schoolId,
    deletedAt: null,
  })
    .select("studentName studentClass studentId studentImage payLink")
    .lean();

  const school = await School.findById(schoolId)
    .select("name logo brandColor motto schoolCode")
    .lean();

  return {
    status: ID_CARD_BATCH_STATUS.READY,
    html: renderPreviewHtml(school, students, batch),
  };
};

const escapeHtml = (str) => {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

const renderPreviewHtml = (school, students, batch) => {
  const cards = students
    .map(
      (student) => `
    <div class="id-card-preview">
      <div class="card-header">${escapeHtml(school?.name || "School")}</div>
      <div class="card-body">
        <div class="student-name">${escapeHtml(student.studentName)}</div>
        <div class="student-id">ID: ${escapeHtml(student.studentId || "")}</div>
        <div class="student-class">${escapeHtml(student.studentClass)}</div>
        ${
          student.studentImage
            ? `<img class="student-photo" src="${student.studentImage}" alt="Photo" />`
            : '<div class="photo-placeholder">No Photo</div>'
        }
      </div>
    </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>ID Card Batch Preview — ${escapeHtml(school?.name || "School")}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f4f6f8; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px; }
    .id-card-preview { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; }
    .card-header { font-size: 16px; font-weight: bold; text-align: center; margin-bottom: 12px; }
    .student-name { font-size: 14px; font-weight: bold; text-align: center; margin: 8px 0; }
    .student-id, .student-class { font-size: 12px; text-align: center; color: #666; }
    .student-photo { width: 80px; height: 80px; object-fit: cover; display: block; margin: 8px auto; border-radius: 4px; }
    .photo-placeholder { width: 80px; height: 80px; border: 1px dashed #ccc; border-radius: 4px; margin: 8px auto; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #999; }
    .print-controls { text-align: center; margin: 20px 0; }
    button { padding: 10px 24px; background: #0f766e; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="print-controls">
    <button onclick="window.print()">Print All ID Cards</button>
  </div>
  <div class="grid">${cards}</div>
</body>
</html>`;
};

// ─────────────────────────── QR links CSV ───────────────────────────

export const getQrLinksExport = async (schoolId, requester, query) => {
  const scopedSchoolId = resolveSchoolId(requester, schoolId);
  if (!scopedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const school = await School.findById(scopedSchoolId).select("slug").lean();
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  const page = Number(query.page) || 1;
  const perPage = Math.min(Number(query.perPage) || 50, 100);
  const skip = (page - 1) * perPage;

  const [students, total] = await Promise.all([
    Student.find({ schoolId: scopedSchoolId, deletedAt: null })
      .select("studentId studentName studentClass payLink")
      .skip(skip)
      .limit(perPage)
      .lean(),
    Student.countDocuments({ schoolId: scopedSchoolId, deletedAt: null }),
  ]);

  const rows = await Promise.all(
    students.map(async (student) => {
      const qrImageUrl = student.payLink
        ? await generateQrCodeDataUrl(student.payLink)
        : null;

      return {
        studentId: student.studentId || "",
        studentName: student.studentName,
        class: student.studentClass,
        payLink: student.payLink || "",
        qrImageUrl: qrImageUrl || "",
      };
    })
  );

  return {
    rows,
    meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    filename: `qr-links-${school.slug || scopedSchoolId.toString()}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`,
  };
};

// ─────────────────────────── Batch PDF download ───────────────────────────

export const getIdCardBatchPdf = async (batchId, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const batch = await IdCardBatch.findOne({ _id: batchId, schoolId }).lean();
  if (!batch) throw new ApiError("Batch not found", 404, "NOT_FOUND");

  if (
    batch.status === ID_CARD_BATCH_STATUS.PENDING ||
    batch.status === ID_CARD_BATCH_STATUS.GENERATING
  ) {
    return { status: ID_CARD_BATCH_STATUS.PENDING };
  }

  if (batch.status === ID_CARD_BATCH_STATUS.FAILED) {
    throw new ApiError(
      batch.generationError || "ID card batch generation failed",
      409,
      "BATCH_FAILED"
    );
  }

  if (!batch.pdfUrl) {
    throw new ApiError(
      "This batch is marked ready but has no generated file",
      409,
      "PDF_UNAVAILABLE"
    );
  }

  const response = await fetch(batch.pdfUrl);
  if (!response.ok) {
    throw new ApiError("The generated file could not be retrieved", 502, "PDF_FETCH_FAILED");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const slug = (requester.schoolSlug || "id-cards").toLowerCase().replace(/[^a-z0-9]+/g, "-");

  return {
    status: ID_CARD_BATCH_STATUS.READY,
    buffer,
    filename: `id-cards-${slug}-${batch.totalCards}.pdf`,
  };
};

// ─────────────────────────── Batch generation ───────────────────────────

const cardsPerSheet = (layoutName) => sheetGeometry(layoutName).perPage;

export const generateIdCardPdf = async (batchId) => {
  const batch = await IdCardBatch.findById(batchId);
  if (!batch) throw new ApiError("Batch not found", 404, "NOT_FOUND");
  if (batch.status !== ID_CARD_BATCH_STATUS.PENDING) return null;

  batch.status = ID_CARD_BATCH_STATUS.GENERATING;
  await batch.save();

  const school = await School.findById(batch.schoolId)
    .select("name slug logo stamp motto schoolCode brandColor academic.currentYear")
    .lean();
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  const students = await Student.find({
    _id: { $in: batch.studentIds },
    schoolId: batch.schoolId,
    deletedAt: null,
  })
    .select(
      "studentName studentClass studentId studentImage payLink dateOfBirth academicYear emergencyContacts parents"
    )
    .lean();

  const settingsSnapshot = batch.settingsSnapshot || {};
  const termsOverride = settingsSnapshot.termsOverride || null;
  const footerLeft = settingsSnapshot.footerLeft || "SUKUUPAY";
  const footerRight = settingsSnapshot.footerRight || null;

  const cards = await Promise.all(
    students.map(async (student) => {
      const cardData = buildCardData(student, school, {
        qrCodeUrl: student.payLink
          ? await generateQrCodeDataUrl(student.payLink)
          : null,
      });
      cardData.termsOverride = termsOverride;
      cardData.footerLeft = footerLeft;
      cardData.footerRight = footerRight;
      return cardData;
    })
  );

  try {
    const sheetLayout = settingsSnapshot.sheetLayout || DEFAULT_SHEET_LAYOUT;
    const sides = settingsSnapshot.sides || "front_back";
    const sheetCount = Math.max(1, Math.ceil(cards.length / cardsPerSheet(sheetLayout)));

    const pdfBuffer = await generateIdCardSheets(cards, {
      layout: sheetLayout,
      side: sides,
      showQr: settingsSnapshot.showQr !== undefined ? settingsSnapshot.showQr : true,
      showPhoto: settingsSnapshot.showPhoto !== undefined ? settingsSnapshot.showPhoto : true,
      showStamp: settingsSnapshot.showStamp !== undefined ? settingsSnapshot.showStamp : true,
      includeCutGuides: settingsSnapshot.includeCutGuides || false,
    });

    const uploadResult = await uploadBuffer(pdfBuffer, {
      folder: `${CLOUDINARY_UPLOAD_FOLDER}/schools/${school.slug || batch.schoolId}/id-cards`,
      resourceType: "raw",
      format: "pdf",
    });

    batch.pdfUrl = uploadResult?.secure_url || uploadResult?.url;
    batch.publicId = uploadResult?.public_id;
    batch.status = ID_CARD_BATCH_STATUS.READY;
    batch.generationError = null;
    batch.sheetLayout = sheetLayout;
    batch.sheetCount = sheetCount;
    batch.cardsPerSheet = cardsPerSheet(sheetLayout);
    await batch.save();

    await createNotification({
      userId: batch.requestedBy,
      schoolId: batch.schoolId,
      type: "system.alert",
      title: "ID cards ready",
      message: `Your ID card batch (${batch.totalCards} cards) is ready to download. Print at A4, ${batch.cardsPerSheet} cards per sheet, double-sided — flip on the short edge.`,
    });

    return batch;
  } catch (error) {
    batch.status = ID_CARD_BATCH_STATUS.FAILED;
    batch.generationError = error.message;
    await batch.save();

    await createNotification({
      userId: batch.requestedBy,
      schoolId: batch.schoolId,
      type: "system.alert",
      title: "ID card generation failed",
      message: `Your ID card batch could not be generated: ${error.message}. Please try again.`,
    });

    throw error;
  }
};

// ─────────────────────────── Merge batches ───────────────────────────

export const mergeIdCardBatches = async (data, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const { batchIds } = data;
  if (!Array.isArray(batchIds) || batchIds.length === 0) {
    throw new ApiError("At least one batch ID is required", 400, "VALIDATION_ERROR");
  }

  const batches = await IdCardBatch.find({
    _id: { $in: batchIds },
    schoolId,
    deletedAt: null,
  }).lean();

  if (batches.length === 0) {
    throw new ApiError("No valid batches found", 404, "NOT_FOUND");
  }

  const foundIds = batches.map((b) => b._id.toString());
  const missingIds = batchIds.filter((id) => !foundIds.includes(id.toString()));
  if (missingIds.length > 0) {
    throw new ApiError(
      `${missingIds.length} of the provided batch IDs do not belong to your school`,
      403,
      "INVALID_BATCHES"
    );
  }

  const seen = new Set();
  const mergedStudentIds = [];
  for (const batch of batches) {
    if (batch.studentIds) {
      for (const sid of batch.studentIds) {
        const key = sid.toString();
        if (!seen.has(key)) {
          seen.add(key);
          mergedStudentIds.push(sid);
        }
      }
    }
  }

  if (mergedStudentIds.length === 0) {
    throw new ApiError("No students found in the selected batches", 400, "EMPTY_MERGE");
  }

  let settingsSnapshot = null;
  for (const batch of batches) {
    if (batch.settingsSnapshot) {
      settingsSnapshot = batch.settingsSnapshot;
      break;
    }
  }

  const mergedBatch = await IdCardBatch.create({
    schoolId,
    studentIds: mergedStudentIds,
    totalCards: mergedStudentIds.length,
    status: ID_CARD_BATCH_STATUS.PENDING,
    requestedBy: requester._id,
    templateId: batches[0]?.templateId || null,
    settingsSnapshot: settingsSnapshot || undefined,
  });

  await auditLog({
    action: AUDIT_ACTIONS.ID_CARD_BATCH_CREATE || "id_card.batch.create",
    entity: "IdCardBatch",
    entityId: mergedBatch._id,
    userId: requester._id,
    schoolId,
    meta: {
      mergedFrom: batchIds,
      totalCards: mergedBatch.totalCards,
      sourceBatchCount: batches.length,
    },
  });

  setImmediate(async () => {
    const { generateIdCards } = await import("../jobs/generateIdCards.job.js");
    generateIdCards(mergedBatch._id.toString()).catch((error) => {
      console.error(`[ID-CARD] Merged batch ${mergedBatch._id} generation failed:`, error.message);
    });
  });

  return { batchId: mergedBatch._id, status: mergedBatch.status };
};

// ─────────────────────────── List & status ───────────────────────────

export const listIdCardBatches = async (schoolId, query, requester) => {
  const scopedSchoolId = resolveSchoolId(requester, schoolId);
  if (!scopedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const page = Math.max(1, Number(query.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(query.perPage) || 20));
  const skip = (page - 1) * perPage;

  const [batches, total] = await Promise.all([
    IdCardBatch.find({ schoolId: scopedSchoolId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .populate("requestedBy", "name email")
      .lean(),
    IdCardBatch.countDocuments({ schoolId: scopedSchoolId }),
  ]);

  return {
    batches,
    meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
  };
};

export const getIdCardBatchStatus = async (batchId, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const batch = await IdCardBatch.findOne({ _id: batchId, schoolId }).lean();
  if (!batch) throw new ApiError("Batch not found", 404, "NOT_FOUND");

  return {
    batchId: batch._id,
    status: batch.status,
    totalCards: batch.totalCards,
    cardsPerSheet: batch.cardsPerSheet,
    sheetLayout: batch.sheetLayout,
    sheetCount: batch.sheetCount,
    sides: batch.settingsSnapshot?.sides || "front_back",
    generationError: batch.generationError,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    templateId: batch.templateId,
  };
};

export const getIdCardBatchPreviewData = async (batchId, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const batch = await IdCardBatch.findOne({ _id: batchId, schoolId }).lean();
  if (!batch) throw new ApiError("Batch not found", 404, "NOT_FOUND");

  const school = await School.findById(schoolId)
    .select("name logo stamp motto schoolCode brandColor academic.currentYear")
    .lean();
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  const students = await Student.find({
    _id: { $in: batch.studentIds },
    schoolId,
    deletedAt: null,
  })
    .select("studentName studentClass studentId studentImage payLink parents emergencyContacts")
    .lean();

  const cards = await Promise.all(
    students.map(async (student) => {
      const qrCodeUrl = student.payLink
        ? await generateQrCodeDataUrl(student.payLink)
        : null;
      return resolveCardData(student, school, { qrCodeUrl });
    })
  );

  const settingsSnapshot = batch.settingsSnapshot || {};
  const geometry = sheetGeometry(settingsSnapshot.sheetLayout || DEFAULT_SHEET_LAYOUT);

  return {
    batch: {
      _id: batch._id,
      totalCards: batch.totalCards,
      cardsPerSheet: geometry.perPage,
      sheetCount: Math.max(1, Math.ceil(batch.totalCards / geometry.perPage)),
      sides: settingsSnapshot.sides || "front_back",
      sheetLayout: settingsSnapshot.sheetLayout || DEFAULT_SHEET_LAYOUT,
      status: batch.status,
    },
    school: {
      name: school.name,
      logo: school.logo,
      stamp: school.stamp,
      motto: school.motto,
      schoolCode: school.schoolCode,
      brandColor: school.brandColor,
      academicYear: school.academic?.currentYear || new Date().getFullYear().toString(),
    },
    cards,
  };
};

export const getLatestBatch = async (schoolId, requester) => {
  const scopedSchoolId = resolveSchoolId(requester, schoolId);
  if (!scopedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const batch = await IdCardBatch.findOne({
    schoolId: scopedSchoolId,
    status: ID_CARD_BATCH_STATUS.READY,
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!batch) return null;

  const school = await School.findById(scopedSchoolId)
    .select("name logo stamp motto schoolCode brandColor academic.currentYear")
    .lean();

  const students = await Student.find({
    _id: { $in: batch.studentIds },
    schoolId: scopedSchoolId,
    deletedAt: null,
  })
    .select("studentName studentClass studentId studentImage payLink parents emergencyContacts")
    .lean();

  const cards = await Promise.all(
    students.map(async (student) => {
      const qrCodeUrl = student.payLink
        ? await generateQrCodeDataUrl(student.payLink)
        : null;
      return resolveCardData(student, school, { qrCodeUrl });
    })
  );

  const geometry = sheetGeometry(batch.sheetLayout || DEFAULT_SHEET_LAYOUT);

  return {
    batch: {
      _id: batch._id,
      totalCards: batch.totalCards,
      cardsPerSheet: geometry.perPage,
      sheetLayout: batch.sheetLayout,
      sides: batch.settingsSnapshot?.sides || "front_back",
    },
    school: {
      name: school.name,
      logo: school.logo,
      stamp: school.stamp,
      motto: school.motto,
      schoolCode: school.schoolCode,
      brandColor: school.brandColor,
      academicYear: school.academic?.currentYear || new Date().getFullYear().toString(),
    },
    cards,
  };
};