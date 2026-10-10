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
 * Collects `attachments` into the shape Brevo's v3 API expects.
 *
 * Brevo takes an array of `{ name, content }`, where `content` is the whole
 * file base64-encoded. A Buffer is converted here rather than by the caller
 * so a call site never holds a base64 copy of a PDF it did not need, and so a
 * non-Buffer input is rejected at the boundary instead of becoming
 * `"[object Object]"` in the request body and arriving as an empty file.
 *
 * Each attachment is capped at Brevo's documented 10 MB. A receipt PDF is
 * ~25 KB, so the limit is far away, but a caller that one day attaches a
 * school report should get a clear error rather than a provider rejection
 * half a send in.
 */
const toBrevoAttachments = (attachments) => {
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

  return (attachments || [])
    .map((file) => {
      if (!file?.name) {
        throw new EmailTransportError('An attachment requires a name', {
          status: 400,
          code: 'EMAIL_ATTACHMENT_INVALID',
        });
      }
      if (Buffer.isBuffer(file.content)) {
        if (file.content.length > MAX_ATTACHMENT_BYTES) {
          throw new EmailTransportError(
            `Attachment "${file.name}" is ${Math.ceil(file.content.length / 1024)} KB, over the 10 MB limit`,
            { status: 400, code: 'EMAIL_ATTACHMENT_TOO_LARGE' }
          );
        }
        return { name: String(file.name), content: file.content.toString('base64') };
      }
      if (typeof file.content === 'string') {
        // Already base64, so a caller holding a stored file need not decode it
        // just to have it re-encoded here.
        return { name: String(file.name), content: file.content };
      }
      throw new EmailTransportError(
        `Attachment "${file.name}" must be a Buffer or a base64 string`,
        { status: 400, code: 'EMAIL_ATTACHMENT_INVALID' }
      );
    });
};

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
 *   v3 API key -> `xkeysib-…` — sent in the `api-key` header
 *   SMTP key   -> `xsmtpsib-…` — used only to log in over SMTP
 * An SMTP key sent as an API key is rejected with a bare
 * `401 {"message":"Key not found"}`, which reads like an expired credential and
 * sends you hunting through the deployment's environment settings.
 *
 * The API-key prefix is matched as `xkeys` and not the full `xkeysib-`. Real
 * Brevo API keys start `xkeysib-` — the `ib` is a Sendinblue holdover — and
 * this guard originally required `xkeys-`, which rejected a perfectly good key
 * with "does not look like a Brevo v3 API key". That is the same mistake as
 * testing for `xsmtps-` and missing `xsmtpsib-`; both are avoided by matching
 * the stable leading stem and treating the suffix as variable.
 *
 * Note this only recognises a key's *shape*. It cannot tell a valid key from a
 * revoked, truncated, or copy-paste-mangled one; Brevo answers all of those
 * with the same 401, and only a real request distinguishes them.
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
        'BREVO_API_KEY is an SMTP key (xsmtpsib-…), not a v3 API key (xkeysib-…). ' +
        'Create an API key under Brevo → SMTP & API → API Keys → Generate a new API key, ' +
        'and set that here. The current value is the SMTP password, which the v3 REST API ' +
        'never accepts.',
      status: 500,
    };
  }

  if (!/^xkeys/i.test(key)) {
    return {
      code: 'EMAIL_KEY_MALFORMED',
      message:
        'BREVO_API_KEY does not look like a Brevo v3 API key (expected an xkeysib-… prefix). ' +
        'Check that the right value was copied from Brevo → SMTP & API → API Keys.',
      status: 500,
    };
  }

  return null;
};

/**
 * Validates the sender identity before it goes anywhere.
 *
 * A missing `SMTP_FROM` used to produce the most unhelpful failure in this
 * file: the sender was set as `{ name: SMTP_FROM_NAME, email: undefined }`,
 * and `JSON.stringify` **drops keys whose value is `undefined`** — so the
 * request left this process with no `sender` at all. Brevo then rejected it
 * with a 400 about a null sender, which reads as a malformed payload rather
 * than "the deployment never set SMTP_FROM". Validating it here means the
 * message names the variable that is missing.
 *
 * @returns {{ code: string, message: string, status: number }|null} null when valid.
 */
export const validateBrevoSender = () => {
  if (!SMTP_FROM) {
    return {
      code: 'EMAIL_SENDER_MISSING',
      message:
        'SMTP_FROM is not configured, so the email has no sender. Set it to a ' +
        'verified sender address in the deployment environment (Brevo → Senders, ' +
        'Domains & Dedicated IPs → Senders).',
      status: 500,
    };
  }
  return null;
};

/**
 * Recognises Brevo's IP-allowlist rejection and names the address to allowlist.
 *
 * Brevo answers a 401 for several distinct reasons, and they previously all
 * read as one: "the key is invalid". That sent an operator to regenerate a
 * perfectly good API key when the actual fault was an account-level IP
 * restriction on the sender's network. The message and the rejected address
 * both come from the provider's own body — the IP is the server's outbound
 * address, which Brevo has already told the account owner, so repeating it
 * costs nothing and saves a round of guessing at which of several egress
 * addresses to allowlist.
 *
 * @param {number} status
 * @param {string} details the provider's raw response body
 * @returns {{ code: string, message: string, status: number }|null} null when not a match.
 */
const unrecognisedIpError = (status, details) => {
  if (status !== 401) return null;
  if (!/unrecognised ip address|authorised_ips|authorized_ips/i.test(details)) return null;
  const ip = (details.match(/(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1] || 'the server';
  return {
    code: 'EMAIL_IP_NOT_AUTHORISED',
    message:
      `Brevo refused the request because ${ip} is not on this account's authorised IP ` +
      'list. Add it at Brevo → Senders, Domains & Dedicated IPs → Security → ' +
      'Authorised IPs, or turn the IP restriction off, then retry.',
    status: 502,
  };
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
  attachments,
}) => {
  const keyProblem = validateBrevoApiKey(BREVO_API_KEY);
  if (keyProblem) {
    throw new EmailTransportError(keyProblem.message, {
      status: keyProblem.status,
      code: keyProblem.code,
    });
  }

  const senderProblem = validateBrevoSender();
  if (senderProblem) {
    throw new EmailTransportError(senderProblem.message, {
      status: senderProblem.status,
      code: senderProblem.code,
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
  if (attachments?.length) body.attachment = attachments;

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

    // Brevo answers 401 for more than one reason and the raw body says which.
    // An unrecognised egress IP is an account security setting, not a
    // credential problem, and reporting it as "your key is invalid" sends the
    // operator to regenerate a key that was never wrong.
    const ipProblem = unrecognisedIpError(response.status, details);
    if (ipProblem) {
      throw new EmailTransportError(ipProblem.message, {
        status: ipProblem.status,
        code: ipProblem.code,
        providerStatus: response.status,
        providerBody: details,
      });
    }

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

/**
 * Sends a transactional email with one or more file attachments.
 *
 * This is the delivery path for documents a parent has to keep: the fee
 * receipt, the ID sheet, an export. It is the same Brevo transport as
 * `sendEmail` — there is only one email provider in this codebase — with the
 * one thing a receipt needs added: an `attachment` array carrying the file
 * bytes.
 *
 * **The attachment is a real attachment, not a link.** A parent who receives
 * a receipt as a URL has to open a browser on a phone, log in somewhere, and
 * wait; the same parent with a PDF attached can forward it to a spouse
 * abroad, print it with Chrome's "Save as PDF" to a PDF, or hand the email to
 * a landlord. The file is the artefact.
 *
 * A base64 body inflates the request by ~33%, which is why a single send
 * carries a whole PDF rather than being called per section. A receipt is
 * ~25 KB raw, so this is not a size problem.
 *
 * @param {object} payload the same shape as `sendEmail`, plus
 *   `attachments: Array<{ name: string, content: Buffer|string }>`
 * @returns {Promise<{ messageId: string|null }>}
 */
export const sendEmailWithAttachment = async (payload) => {
  const { attachments, ...base } = payload;

  if (!attachments || !attachments.length) {
    throw new EmailTransportError('sendEmailWithAttachment requires at least one attachment', {
      status: 400,
      code: 'EMAIL_ATTACHMENT_MISSING',
    });
  }

  return sendEmail({ ...base, attachments: toBrevoAttachments(attachments) });
};

export default sendEmail;
