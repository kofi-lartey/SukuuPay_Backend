// ──────────────────── ApiError ────────────────────
// A thin, conventional error class that every service layer file in this
// project uses.  The `status` property (HTTP status code) and `code`
// (machine-readable identifier) are read by the controller catch-block which
// does: `res.status(error.status || 500).json({ success: false, message: error.message })`.

class ApiError extends Error {
  constructor(message, status = 500, code = "INTERNAL_ERROR", meta = {}) {
    super(message);
    this.status = status;
    this.code = code;
    // `meta` is an optional bag of structured context for the audit log.
    this.meta = meta;
    Error.captureStackTrace(this, this.constructor);
  }
}

export default ApiError;
