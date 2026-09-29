import {
  sendSingleEmail,
  sendBulkEmail,
  getEmailHistory,
  getEmailJob,
  cancelEmailJob,
  handleProviderEvents,
  processUnsubscribe,
  getEmailTemplates,
} from '../services/emailMessaging.service.js';

const idempotencyKey = (req) => req.headers['idempotency-key'] || null;

// ─────────────────────────────────────────────
// SEND ONE EMAIL
// ─────────────────────────────────────────────
export const sendSingleEmailController = async (req, res) => {
  try {
    const result = await sendSingleEmail(req.body, req.user, { idempotencyKey: idempotencyKey(req) });

    return res.status(200).json({
      success: true,
      message: result.replayed ? 'Email already sent (idempotent replay)' : 'Email queued for delivery',
      replayed: Boolean(result.replayed),
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// BULK EMAIL
// ─────────────────────────────────────────────
export const sendBulkEmailController = async (req, res) => {
  try {
    const result = await sendBulkEmail(req.params.schoolId, req.body, req.user, {
      idempotencyKey: idempotencyKey(req),
    });

    return res.status(202).json({
      success: true,
      message: result.replayed
        ? 'Bulk email already accepted (idempotent replay)'
        : 'Bulk email accepted and queued for delivery',
      replayed: Boolean(result.replayed),
      data: result.data,
    });
  } catch (error) {
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// EMAIL HISTORY
// ─────────────────────────────────────────────
export const getEmailHistoryController = async (req, res) => {
  try {
    const result = await getEmailHistory(req.query, req.user);

    return res.status(200).json({
      success: true,
      message: 'Email history retrieved successfully',
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
// BULK JOB STATUS
// ─────────────────────────────────────────────
export const getEmailJobController = async (req, res) => {
  try {
    const job = await getEmailJob(req.params.jobId, req.user);

    return res.status(200).json({
      success: true,
      message: 'Bulk email job retrieved successfully',
      data: job,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// CANCEL BULK JOB
// ─────────────────────────────────────────────
export const cancelEmailJobController = async (req, res) => {
  try {
    const result = await cancelEmailJob(req.params.jobId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: 'Cancellation requested. Messages already sent cannot be recalled.',
      data: result,
    });
  } catch (error) {
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// PROVIDER EVENTS (no auth — verified by secret header)
// ─────────────────────────────────────────────
export const providerEventsController = async (req, res) => {
  try {
    // The header name is whatever is configured on the provider's event
    // account, so the legacy spelling is accepted alongside the corrected one.
    const providedSecret =
      req.get('X-Brevo-Event-Secret') || req.get('X-Bravo-Event-Secret');
    const result = await handleProviderEvents(req.body, providedSecret);

    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// UNSUBSCRIBE (public, token-signed)
// ─────────────────────────────────────────────
// The List-Unsubscribe header points here, so it is deliberately public; the
// signed token is the authorisation.
export const unsubscribeController = async (req, res) => {
  try {
    const { email, token } = req.method === 'GET' ? req.query : req.body;
    const result = await processUnsubscribe(email, token);

    return res.status(200).json({
      success: true,
      message: 'You have been unsubscribed from SukuuPay emails.',
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
// TEMPLATE CATALOGUE
// ─────────────────────────────────────────────
export const getEmailTemplatesController = async (req, res) => {
  try {
    const templates = getEmailTemplates({
      includeInternal: req.query.includeInternal === 'true' && req.user?.role === 'super_admin',
    });

    return res.status(200).json({
      success: true,
      message: 'Email templates retrieved successfully',
      data: templates,
      meta: { total: templates.length },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};
