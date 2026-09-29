import {
  authenticateHubtel,
  authenticateArkesel,
  authenticateMtn,
  handleHubtelPaymentWebhook,
  handleMtnPaymentWebhook,
  handleSmsDeliveryReport,
} from '../services/inboundWebhooks.service.js';

// ── POST /webhooks/hubtel/payment — Hubtel payment confirmation ──
export const hubtelPaymentWebhookController = async (req, res) => {
  try {
    // Authenticated first: this endpoint settles payments, so an unauthenticated
    // caller must never reach the settlement path.
    const auth = authenticateHubtel({
      header: req.get('x-hubtel-signature') || req.get('x-hubtel-signature-512'),
      rawBody: req.rawBody,
    });

    const result = await handleHubtelPaymentWebhook(req.body, {
      endpoint: 'webhooks/hubtel/payment',
      signatureVerified: auth.enforced,
      ip: req.ip,
    });

    // Always 2xx: Hubtel retries a non-2xx, and a retry of a settlement that
    // already succeeded would be a second chance to double-credit the parent.
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error.status === 401) {
      return res.status(401).json({
        success: false,
        message: error.message,
        code: error.code,
      });
    }

    console.error('Hubtel payment webhook error:', error);
    // A 5xx here is deliberate: the callback was authenticated but could not be
    // applied, and Hubtel must retry until it is.
    return res.status(500).json({
      success: false,
      message: 'Failed to process Hubtel payment webhook',
    });
  }
};

// ── POST /webhooks/mtn/payment — MTN transaction result ──
export const mtnPaymentWebhookController = async (req, res) => {
  try {
    // MTN posts no keyed signature, so the shared secret configured on MTN's side
    // is the only available proof of origin. See authenticateMtn for why this
    // endpoint is not strongly authenticated.
    const auth = authenticateMtn({
      providedSecret: req.get('x-mtn-webhook-secret') || req.body?.secret || req.query?.secret,
    });

    const result = await handleMtnPaymentWebhook(req.body, {
      endpoint: 'webhooks/mtn/payment',
      signatureVerified: auth.enforced,
      ip: req.ip,
    });

    // Always 2xx: MTN retries a non-2xx, and a retry of a settlement that
    // already succeeded would be a second chance to double-credit the parent.
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error.status === 401) {
      return res.status(401).json({
        success: false,
        message: error.message,
        code: error.code,
      });
    }

    console.error('MTN payment webhook error:', error);
    // A 5xx here is deliberate: the callback was accepted but could not be
    // applied, and MTN must retry until it is.
    return res.status(500).json({
      success: false,
      message: 'Failed to process MTN payment webhook',
    });
  }
};

// ── POST /webhooks/hubtel/sms — Hubtel SMS delivery report ──
export const hubtelSmsWebhookController = async (req, res) => {
  try {
    const auth = authenticateHubtel({
      header: req.get('x-hubtel-signature') || req.get('x-hubtel-signature-512'),
      rawBody: req.rawBody,
    });

    const result = await handleSmsDeliveryReport('hubtel', req.body);

    return res.status(200).json({
      success: true,
      data: { ...result, signatureVerified: auth.enforced },
    });
  } catch (error) {
    if (error.status === 401) {
      return res.status(401).json({
        success: false,
        message: error.message,
        code: error.code,
      });
    }

    console.error('Hubtel SMS webhook error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process Hubtel SMS delivery report',
    });
  }
};

// ── POST /webhooks/arkesel/sms — Arkesel SMS delivery report ──
export const arkeselSmsWebhookController = async (req, res) => {
  try {
    // Arkesel posts a form body, so the key arrives as a field rather than a
    // header; the signature header is accepted as the alternative.
    const auth = authenticateArkesel({
      signatureHeader: req.get('x-arkesel-signature'),
      providedApiKey: req.body?.api_key || req.body?.apiKey || req.query?.api_key,
      rawBody: req.rawBody,
    });

    const result = await handleSmsDeliveryReport('arkesel', req.body);

    return res.status(200).json({
      success: true,
      data: { ...result, signatureVerified: auth.enforced, authMethod: auth.method },
    });
  } catch (error) {
    if (error.status === 401) {
      return res.status(401).json({
        success: false,
        message: error.message,
        code: error.code,
      });
    }

    console.error('Arkesel SMS webhook error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process Arkesel SMS delivery report',
    });
  }
};
