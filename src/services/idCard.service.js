import mongoose from "mongoose";
import QRCode from "qrcode";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import { IdCardBatch } from "../models/IdCardBatch.js";
import { Notification } from "../models/Notification.js";
import { createNotification } from "../services/notification.service.js";
import { generatePdfFromTemplate } from "../utils/pdfGenerator.js";
import {
  generateIdCardSheets,
  sheetGeometry,
  DEFAULT_SHEET_LAYOUT,
} from "../utils/idCardSheet.js";
import { getCachedPlatformSettings } from "./platformSettings.service.js";
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

// ──────────────────── Generate a QR code data URL ────────────────────
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

// ──────────────────── Resolve a student with scope check ────────────────────
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

// ──────────────────── Build card data object for the template ────────────────────
const buildCardData = (student, school) => ({
  schoolName: school.name,
  schoolLogo: school.logo,
  studentName: student.studentName,
  studentClass: student.studentClass,
  studentId: student.studentId,
  studentImage: student.studentImage,
  payLink: student.payLink,
  qrCodeUrl: null, // filled async
  emergencyContact:
    student.emergencyContacts?.[0]
      ? `${student.emergencyContacts[0].contactName} (${student.emergencyContacts[0].phone})`
      : student.parents?.find((p) => p.isPrimary)?.parentName || "",
});

// ──────────────────── Single student ID card (on-the-fly PDF) ────────────────────
// Returns a PDF buffer so the controller can stream it directly to the client.
export const generateSingleStudentIdCard = async (studentId, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const student = await findStudentInScope(studentId, schoolId);

  const school = await School.findById(schoolId)
    .select("name logo stamp")
    .lean();
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  const qrDataUrl = student.payLink
    ? await generateQrCodeDataUrl(student.payLink)
    : null;

  const cardData = buildCardData(student, school);
  cardData.qrCodeUrl = qrDataUrl;

  // Generate a single-page PDF.
  //
  // `generatePdfFromTemplate(template, data)` — the template name is the FIRST
  // argument. Both call sites here passed a single object, so `template` received
  // `{ pages, template }` and `data` received `undefined`. Inside the generator that
  // made `pages` equal `[undefined]`, and every page rendered an empty bordered
  // rectangle: the file was a valid PDF, the right number of pages, and completely
  // blank. Nothing errored, which is why it survived.
  //
  // The call sites were fixed rather than the signature. `template` selects the layout
  // and is named in the exported contract and in the JSDoc; making the generator
  // tolerate an object in that position would have hidden the bug for the next caller
  // instead of fixing it.
  const pdfBuffer = await generatePdfFromTemplate("idCard", {
    pages: [cardData],
  });

  return {
    pdfBuffer,
    filename: `id-card-${student.studentId || studentId}-${student.studentName
      .replace(/\s+/g, "-")
      .toLowerCase()}.pdf`,
  };
};

// ──────────────────── Batch generation ────────────────────
export const createIdCardBatch = async (data, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const { studentIds, includeQr = true, includePhoto = true } = data;

  // Validate that all studentIds belong to this school.
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

  // Create the batch record with status "pending".
  const batch = await IdCardBatch.create({
    schoolId,
    studentIds: validStudents.map((s) => s._id),
    totalCards: validStudents.length,
    status: ID_CARD_BATCH_STATUS.PENDING,
    requestedBy: requester._id,
  });

  await auditLog({
    action: "settings.update",
    entity: "IdCardBatch",
    entityId: batch._id,
    userId: requester._id,
    schoolId,
    meta: {
      totalCards: batch.totalCards,
      includeQr,
      includePhoto,
    },
  });

  // Kick off the background PDF generation.
  // In production this would enqueue a BullMQ / Agenda job; here we call the
  // job function directly so the batch is processed without an external queue.
  setImmediate(async () => {
    const { generateIdCards } = await import("../jobs/generateIdCards.job.js");
    generateIdCards(batch._id.toString()).catch((error) => {
      console.error(`[ID-CARD] Batch ${batch._id} generation failed:`, error.message);
    });
  });

  return { batchId: batch._id, status: batch.status };
};

// ──────────────────── Get batch print preview (HTML) ────────────────────
export const getIdCardBatchPreview = async (batchId, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const batch = await IdCardBatch.findOne({
    _id: batchId,
    schoolId,
  }).lean();

  if (!batch) throw new ApiError("Batch not found", 404, "NOT_FOUND");

  // If the batch is still generating, tell the client to retry.
  if (batch.status === ID_CARD_BATCH_STATUS.PENDING) {
    return {
      status: ID_CARD_BATCH_STATUS.PENDING,
      retryAfter: 15,
    };
  }

  if (batch.status === ID_CARD_BATCH_STATUS.FAILED) {
    return {
      status: ID_CARD_BATCH_STATUS.FAILED,
      error: batch.generationError,
    };
  }

  // Load students for preview grid.
  const students = await Student.find({
    _id: { $in: batch.studentIds },
    schoolId,
    deletedAt: null,
  })
    .select("studentName studentClass studentId studentImage payLink")
    .lean();

  const school = await School.findById(schoolId)
    .select("name logo brandColor")
    .lean();

  return {
    status: ID_CARD_BATCH_STATUS.READY,
    html: renderPreviewHtml(school, students, batch),
  };
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
        ${
          student.payLink
            ? `<img class="qr-placeholder" alt="QR code for ${student.studentId}" />`
            : ""
        }
      </div>
    </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ID Card Batch Preview — ${escapeHtml(school?.name || "School")}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f4f6f8; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px; }
    .id-card-preview { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card-header { font-size: 16px; font-weight: bold; text-align: center; margin-bottom: 12px; }
    .student-name { font-size: 14px; font-weight: bold; text-align: center; margin: 8px 0; }
    .student-id, .student-class { font-size: 12px; text-align: center; color: #666; margin: 4px 0; }
    .student-photo { width: 80px; height: 80px; object-fit: cover; display: block; margin: 8px auto; border-radius: 4px; }
    .photo-placeholder { width: 80px; height: 80px; border: 1px dashed #ccc; border-radius: 4px; margin: 8px auto; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #999; }
    .qr-placeholder { width: 60px; height: 60px; border: 1px dashed #ccc; margin: 10px auto; }
    .print-controls { text-align: center; margin: 20px 0; }
    button { padding: 10px 24px; background: #0f766e; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
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

const escapeHtml = (str) => {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

// ──────────────────── Export QR links CSV ────────────────────
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

  // Generate QR code images (async) for each student's payLink.
  const rows = await Promise.all(
    students.map(async (student) => {
      const qrImageUrl =
        student.payLink ? await generateQrCodeDataUrl(student.payLink) : null;

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
    meta: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
    filename: `qr-links-${school.slug || scopedSchoolId.toString()}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`,
  };
};

// ──────────────────── Generate PDF for a batch (called by the job) ────────────────────
// ──────────────────── Download a generated batch PDF ────────────────────
//
// `generateIdCardPdf` uploads the finished PDF to Cloudinary and stores the URL
// on the batch, and then nothing served it: the only batch endpoints were the
// create call and an HTML *preview*. So a batch could be generated, report
// "ready", notify the requester that their cards were ready — and there was no
// URL anywhere a user could open. The artefact existed and was unreachable.
//
// The file is proxied rather than redirected. A redirect would hand the
// Cloudinary URL to the browser, and that URL is the only thing standing between
// a scoped record and a publicly-fetchable PDF of one school's entire student
// body. Proxying keeps the scope check meaningful.
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
    // Not an error: the client polls on this, exactly as it does for the
    // preview. Returning "still working" beats a 409 the caller cannot act on.
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
    throw new ApiError(
      "The generated file could not be retrieved",
      502,
      "PDF_FETCH_FAILED"
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const slug = (requester.schoolSlug || "id-cards")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");

  return {
    status: ID_CARD_BATCH_STATUS.READY,
    buffer,
    filename: `id-cards-${slug}-${batch.totalCards}.pdf`,
  };
};

/** Cards per sheet for a layout name. Thin wrapper so callers read as intent. */
const cardsPerSheet = (layoutName) => sheetGeometry(layoutName).perPage;

export const generateIdCardPdf = async (batchId) => {
  const batch = await IdCardBatch.findById(batchId);
  if (!batch) throw new ApiError("Batch not found", 404, "NOT_FOUND");

  if (batch.status !== ID_CARD_BATCH_STATUS.PENDING) return null;

  batch.status = ID_CARD_BATCH_STATUS.GENERATING;
  await batch.save();

  const school = await School.findById(batch.schoolId)
    .select("name logo stamp brandColor")
    .lean();
  if (!school) throw new ApiError("School not found", 404, "NOT_FOUND");

  const students = await Student.find({
    _id: { $in: batch.studentIds },
    schoolId: batch.schoolId,
    deletedAt: null,
  })
    .select("studentName studentClass studentId studentImage payLink emergencyContacts parents")
    .lean();

  // Build card data for each student and generate QR codes.
  const cards = await Promise.all(
    students.map(async (student) => {
      const cardData = buildCardData(student, school);
      cardData.qrCodeUrl = student.payLink
        ? await generateQrCodeDataUrl(student.payLink)
        : null;
      return cardData;
    })
  );

  try {
    // **Printable sheets, not proof sheets.**
    //
    // This called `generatePdfFromTemplate("idCard", { pages: cards })`, which renders
    // **one card per A4 page** at 40pt margins with 16pt type. That is a proof sheet: it
    // is useful on screen and useless in the hand — 90% of every sheet is empty, and
    // nothing on it is at ID-card size, so cutting it down produces cards that are not
    // CR80 and do not fit a badge holder or a lanyard.
    //
    // `generateIdCardSheets` draws true-size CR80 cards (85.60 × 53.98 mm), five to an
    // A4 sheet by default, with the backs on paired pages in matching slot order so a
    // sheet printed double-sided and cut yields matched cards. The layout is a platform
    // setting, so it can be moved to the denser 8-up without a redeploy.
    //
    // Both produce a PDF of the same shape, so everything downstream — the Cloudinary
    // upload, the notification, the download link — is unchanged.
    const settings = await getCachedPlatformSettings();
    const sheetLayout =
      settings?.idCards?.sheetLayout || DEFAULT_SHEET_LAYOUT;

    const sheetCount = Math.max(1, Math.ceil(cards.length / cardsPerSheet(sheetLayout)));

    const pdfBuffer = await generateIdCardSheets(cards, {
      layout: sheetLayout,
      side: settings?.idCards?.sides || "front_back",
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
    // Recorded so the download page can tell the school what they are about to print
    // ("5 per sheet, double-sided") rather than leaving them to work it out from a
    // one-line print instruction on a PDF.
    batch.sheetLayout = sheetLayout;
    batch.sheetCount = sheetCount;
    batch.cardsPerSheet = cardsPerSheet(sheetLayout);
    await batch.save();

    // Notify the requester that the batch is ready.
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
