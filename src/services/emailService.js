import {
  BREVO_API_KEY,
  BREVO_API_URL,
  SMTP_FROM,
  SMTP_FROM_NAME,
} from '../config/env.js';
import { htmlToText } from '../utils/htmlToText.js';

/**
 * Typed transport failure. `status` is the HTTP status the API layer should
 * surface; `code` lets callers branch without matching on message text.
 */
export class EmailTransportError extends Error {
  constructor(message, { status = 502, code = 'EMAIL_PROVIDER_ERROR', providerStatus = null, providerBody = null } = {}) {
    super(message);
    this.name = 'EmailTransportError';
    this.status = status;
    this.code = code;
    this.providerStatus = providerStatus;
    this.providerBody = providerBody;
    Error.captureStackTrace(this, this.constructor);
  }
}

const toRecipient = (entry) =>
  typeof entry === 'string' ? { email: entry } : { email: entry.email, name: entry.name };

const toRecipients = (list) => (list || []).map(toRecipient).filter((r) => r.email);

/**
 * Sends a transactional email through the Brevo (formerly Sendinblue) REST API.
 *
 * A plain-text part is always sent: `text` when the caller supplies one, or a
 * rendering derived from `html`. A text-only client and a spam filter both need
 * it, so a message without it is a non-compliant message.
 *
 * @param {{ to: string|{email:string,name?:string}, toName?: string, subject: string,
 *   html?: string, text?: string, replyTo?: string, cc?: Array, bcc?: Array,
 *   tags?: Array, headers?: Record<string,string>, scheduledAt?: string|Date }} payload
 * @returns {Promise<{ messageId: string|null }>}
 */
/**
 * Validates a Brevo credential before it is sent anywhere.
 *
 * Brevo issues two unrelated credentials and they are easy to swap:
 *   v3 API key -> `xkeys-...`  — sent in the `api-key` header
 *   SMTP key   -> `xsmtpsib-...` — used only to log in over SMTP
 * An SMTP key sent as an API key is rejected with a bare
 * `401 {"message":"Key not found"}`, which reads like an expired credential and
 * sends you hunting through the deployment's environment settings.
 *
 * Exported so it can be tested against each credential shape directly, without
 * the env bootstrap re-reading `.env` and swapping the value back mid-run.
 *
 * @param {string|undefined} key
 * @returns {{ code: string, message: string, status: number }|null} null when valid.
 */
export const validateBrevoApiKey = (key) => {
  if (!key) {
    return {
      code: 'EMAIL_NOT_CONFIGURED',
      message: 'BREVO_API_KEY is not configured',
      status: 500,
    };
  }

  if (/^xsmtps/i.test(key)) {
    return {
      code: 'EMAIL_KEY_IS_SMTP_NOT_API',
      message:
        'BREVO_API_KEY is an SMTP key (xsmtpsib-…), not a v3 API key (xkeys-…). ' +
        'Create an API key under Brevo → SMTP & API → API Keys → Generate a new API key, ' +
        'and set that here. The current value is the SMTP password, which the v3 REST API ' +
        'never accepts.',
      status: 500,
    };
  }

  if (!key.startsWith('xkeys-')) {
    return {
      code: 'EMAIL_KEY_MALFORMED',
      message:
        'BREVO_API_KEY does not look like a Brevo v3 API key (expected an xkeys-… prefix). ' +
        'Check that the right value was copied from Brevo → SMTP & API → API Keys.',
      status: 500,
    };
  }

  return null;
};

export const sendEmail = async ({
  to,
  toName,
  subject,
  html,
  text,
  replyTo,
  cc,
  bcc,
  tags,
  headers,
  scheduledAt,
}) => {
  const keyProblem = validateBrevoApiKey(BREVO_API_KEY);
  if (keyProblem) {
    throw new EmailTransportError(keyProblem.message, {
      status: keyProblem.status,
      code: keyProblem.code,
    });
  }

  const toList = toRecipients(Array.isArray(to) ? to : [to]);
  if (!toList.length) {
    throw new EmailTransportError('At least one recipient is required', {
      status: 400,
      code: 'EMAIL_NO_RECIPIENT',
    });
  }
  // `toName` is the legacy single-recipient convenience; a structured `to`
  // entry wins when both are present.
  const finalTo = toList.map((recipient) =>
    recipient.name || !toName ? recipient : { ...recipient, name: toName }
  );

  const body = {
    sender: { name: SMTP_FROM_NAME, email: SMTP_FROM },
    to: finalTo,
    subject,
  };

  const derivedText = text ?? htmlToText(html);
  if (derivedText) body.textContent = derivedText;
  if (html) body.htmlContent = html;

  const ccList = toRecipients(cc);
  if (ccList.length) body.cc = ccList;

  const bccList = toRecipients(bcc);
  if (bccList.length) body.bcc = bccList;

  if (replyTo) body.replyTo = { email: replyTo };
  if (tags?.length) body.tags = tags;
  if (headers && Object.keys(headers).length) body.headers = headers;
  if (scheduledAt) body.scheduledAt = new Date(scheduledAt).toISOString();

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': BREVO_API_KEY,
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const details = await response.text();

    // Brevo answers a bad or revoked key with `401 {"message":"Key not found",
    // "code":"unauthorized"}` and gives no hint about which key is wrong. Spell
    // out the likeliest cause so this does not read as a transient outage.
    if (response.status === 401) {
      throw new EmailTransportError(
        'Brevo rejected the API key (401 unauthorized). The key is invalid, ' +
          'revoked, or belongs to a different Brevo account. Check BREVO_API_KEY ' +
          'in the deployment environment — note that an SMTP key (xsmtpsib-…) is not ' +
          'an API key and is always rejected here. Provider said: ' +
          details,
        {
          status: 502,
          code: 'EMAIL_KEY_REJECTED',
          providerStatus: response.status,
          providerBody: details,
        }
      );
    }

    throw new EmailTransportError(`Brevo request failed (${response.status}): ${details}`, {
      status: 502,
      code: 'EMAIL_PROVIDER_REJECTED',
      providerStatus: response.status,
      providerBody: details,
    });
  }

  const payload = await response.json();
  return { messageId: payload?.messageId ?? null, raw: payload };
};

export default sendEmail;
