import {
  createIdCardBatch,
  getIdCardBatchPreview,
  getQrLinksExport,
  generateSingleStudentIdCard,
} from "../services/idCard.service.js";
import { streamCsv } from "../utils/csvWriter.js";

// ── POST /id-cards/batch — create a batch and trigger background PDF generation ──
export const createIdCardBatchController = async (req, res) => {
  try {
    const result = await createIdCardBatch(req.body, req.user);

    return res.status(202).json({
      success: true,
      message: "ID card batch creation started",
      data: {
        batchId: result.batchId,
        status: result.status,
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── GET /id-cards/:studentId — single student ID card PDF (streamed) ──
export const getStudentIdCardController = async (req, res) => {
  try {
    const result = await generateSingleStudentIdCard(req.params.studentId, req.user);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${result.filename}"`
    );
    res.set("Content-Length", String(result.pdfBuffer.length));

    return res.send(result.pdfBuffer);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── GET /id-cards/batch/:batchId — batch print preview (HTML or pending status) ──
export const getIdCardBatchPreviewController = async (req, res) => {
  try {
    const result = await getIdCardBatchPreview(req.params.batchId, req.user);

    // Batch still generating → tell the client to retry.
    if (result.status === "pending") {
      return res.status(202).json({
        success: true,
        message: "Batch is still being generated",
        data: { status: "pending", retryAfter: result.retryAfter || 15 },
      });
    }

    if (result.status === "failed") {
      return res.status(500).json({
        success: false,
        message: "ID card batch generation failed",
        data: { status: "failed", error: result.error },
      });
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(result.html);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── GET /id-cards/qr-links/:schoolId — export all student QR pay-links as CSV ──
export const getQrLinksExportController = async (req, res) => {
  try {
    const result = await getQrLinksExport(req.params.schoolId, req.user, req.query);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${result.filename}"`
    );

    const columns = [
      { key: "studentId", header: "Student ID" },
      { key: "studentName", header: "Student Name" },
      { key: "class", header: "Class" },
      { key: "payLink", header: "Pay Link" },
      { key: "qrImageUrl", header: "QR Image URL" },
    ];

    streamCsv(res, columns, result.rows);
  } catch (error) {
    if (!res.headersSent) {
      return res.status(error.status || 500).json({
        success: false,
        message: error.message,
      });
    }
    res.end();
  }
};
