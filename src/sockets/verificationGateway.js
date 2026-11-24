let ioInstance = null;

export function setVerificationIO(io) {
  ioInstance = io;
}

export function emitVerificationUpdate(schoolId, payload) {
  if (!ioInstance) return;
  const room = `school:${schoolId}`;
  ioInstance.to(room).emit("verification:updated", {
    schoolId,
    verificationStatus: payload.verificationStatus,
    verificationTier: payload.verificationTier,
    rejectionReason: payload.rejectionReason || "",
    verifiedAt: payload.verifiedAt || null,
    timestamp: new Date().toISOString(),
  });
}

export function emitDocumentReviewUpdate(schoolId, payload) {
  if (!ioInstance) return;
  const room = `school:${schoolId}`;
  ioInstance.to(room).emit("verification:document_reviewed", {
    schoolId,
    documentType: payload.documentType,
    reviewStatus: payload.reviewStatus,
    reviewNote: payload.reviewNote || "",
    timestamp: new Date().toISOString(),
  });
}