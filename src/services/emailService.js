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
  if (!BREVO_API_KEY) {
    throw new EmailTransportError('BREVO_API_KEY is not configured', {
      status: 500,
      code: 'EMAIL_NOT_CONFIGURED',
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
