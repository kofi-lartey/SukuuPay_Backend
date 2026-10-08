import {
  createIdCardBatch,
  getIdCardBatchPdf,
  getQrLinksExport,
  generateSingleStudentIdCard,
  getIdCardBatchPreviewData,
  getIdCardBatchStatus,
  mergeIdCardBatches,
  listIdCardBatches,
  getLatestBatch,
} from "../services/idCard.service.js";
import { streamCsv } from "../utils/csvWriter.js";
import { sheetGeometry } from "../utils/idCardSheet.js";

// ── GET /id-cards/batch/:batchId/pdf — download a generated batch PDF ──────
export const getIdCardBatchPdfController = async (req, res) => {
  try {
    const result = await getIdCardBatchPdf(req.params.batchId, req.user);

    // Same polling contract as the preview endpoint: 202 with `status:
    // "pending"` while the background job is still running. The client is
    // expected to retry, so this must not look like a failure.
    if (result.status === "pending") {
      return res.status(202).json({
        success: true,
        message: "Batch is still being generated",
        data: { status: "pending" },
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.set("Content-Length", String(result.buffer.length));

    return res.send(result.buffer);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

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

// ── GET /id-cards/batch/:batchId/preview-data — full card data for React print preview ──
export const getIdCardBatchPreviewDataController = async (req, res) => {
  try {
    const result = await getIdCardBatchPreviewData(req.params.batchId, req.user);

    return res.status(200).json({
      success: true,
      message: "Batch preview data retrieved",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── GET /id-cards/batch/:batchId/status — batch status for polling ──
export const getIdCardBatchStatusController = async (req, res) => {
  try {
    const result = await getIdCardBatchStatus(req.params.batchId, req.user);

    return res.status(200).json({
      success: true,
      message: "Batch status retrieved",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── POST /id-cards/batch/merge — merge multiple batches into a new one ──
export const mergeIdCardBatchesController = async (req, res) => {
  try {
    const result = await mergeIdCardBatches(req.body, req.user);

    return res.status(202).json({
      success: true,
      message: "Merged batch creation started",
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

// ── GET /id-cards/batches — list recent batches for the school ──
export const listIdCardBatchesController = async (req, res) => {
  try {
    const schoolId = req.params.schoolId || req.user?.schoolId;
    const result = await listIdCardBatches(schoolId, req.query, req.user);

    return res.status(200).json({
      success: true,
      message: "Batches retrieved",
      data: result.batches,
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── GET /id-cards/batches/latest — get the latest ready batch for preview ──
export const getLatestBatchController = async (req, res) => {
  try {
    const schoolId = req.query.schoolId || req.user?.schoolId;
    const result = await getLatestBatch(schoolId, req.user);

    if (!result) {
      return res.status(200).json({
        success: true,
        message: "No ready batches found",
        data: null,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Latest batch retrieved",
      data: result,
    });
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
