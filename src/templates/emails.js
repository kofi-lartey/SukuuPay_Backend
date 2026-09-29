import { CLIENT_URL } from '../config/env.js';
import { formatCedis, formatAccraDate } from '../utils/formatters.js';
import { escapeHtml } from '../utils/escapeHtml.js';

// ──────────────────── Layout primitives ────────────────────
// Every interpolated value is escaped. Nothing that reaches an HTML body is
// trusted, including student and parent names, which a parent controls.

const shell = (title, body) => `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(16,24,40,0.1);">
            <tr>
              <td style="background:#0f766e;padding:24px 32px;">
                <h1 style="margin:0;font-size:20px;color:#ffffff;">SukuuPay</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h2 style="margin:0 0 16px;font-size:18px;color:#111827;">${escapeHtml(title)}</h2>
                ${body}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;">
                <p style="margin:0;">If you did not request this email, you can safely ignore it.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

// A heading plus body lines, joined for the plain-text alternative.
const textShell = (title, lines) =>
  [title, '', ...lines.filter((line) => line !== null && line !== undefined)]
    .join('\n')
    .trim();

const paragraph = (html) => `<p style="margin:0 0 12px;line-height:1.6;">${html}</p>`;

const codeBlock = (otp) => `<div style="margin:24px 0;padding:20px;background:#f0fdfa;border:1px dashed #0f766e;border-radius:10px;text-align:center;">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#0f766e;">Verification code</p>
    <p style="margin:0;font-size:34px;font-weight:700;letter-spacing:10px;color:#111827;">${escapeHtml(otp)}</p>
  </div>`;

const button = (url, label) => {
  const href = escapeHtml(url);
  if (!href) return '';
  return `<p style="margin:24px 0;">
    <a href="${href}" style="display:inline-block;padding:12px 24px;background:#0f766e;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">${escapeHtml(label)}</a>
  </p>
  <p style="margin:0;font-size:12px;color:#6b7280;word-break:break-all;">If the button does not work, copy this link:<br />${href}</p>`;
};

const buttonText = (url, label) => `${label}: ${url}`;

// ──────────────────── Placeholder handling ────────────────────

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/** Unique {{token}} names appearing in a string. */
const findTokens = (source = '') => {
  const tokens = new Set();
  let match = TOKEN_PATTERN.exec(String(source ?? ''));
  while (match) {
    tokens.add(match[1]);
    match = TOKEN_PATTERN.exec(String(source ?? ''));
  }
  return [...tokens];
};

/**
 * Substitutes {{tokens}} and reports any brace left behind. A value shaped like
 * a token but not matching the pattern (e.g. "{{balance") is malformed and is
 * reported rather than shipped to a parent.
 */
const substitute = (source, variables) => {
  const output = String(source ?? '').replace(TOKEN_PATTERN, (_full, key) => {
    const value = variables[key];
    return value === undefined || value === null ? '' : String(value);
  });

  const stray = output.replace(TOKEN_PATTERN, '').match(/\{\{|\}\}/);
  if (stray) {
    const error = new Error(`Malformed placeholder near "${stray[0]}"`);
    error.code = 'EMAIL_TEMPLATE_MALFORMED';
    throw error;
  }

  return output;
};

const findMissing = (source, variables) =>
  findTokens(source).filter(
    (key) => variables[key] === undefined || variables[key] === null || variables[key] === ''
  );
// ──────────────────── Platform transactional templates ────────────────────

export const verificationEmail = ({ name, otp, expiresInMinutes }) => ({
  subject: 'Verify your SukuuPay email address',
  html: shell(
    'Verify your email address',
    `${paragraph(`Hi ${escapeHtml(name)},`)}
     ${paragraph(
       `Thanks for creating your SukuuPay school account. Enter the code below to verify your email address. This code expires in ${escapeHtml(expiresInMinutes)} minutes.`
     )}
     ${codeBlock(otp)}
     ${paragraph('If you did not create a SukuuPay account, please ignore this email.')}`
  ),
  text: textShell('Verify your email address', [
    `Hi ${name},`,
    `Thanks for creating your SukuuPay school account. Enter the code below to verify your email address. This code expires in ${expiresInMinutes} minutes.`,
    `Verification code: ${otp}`,
    'If you did not create a SukuuPay account, please ignore this email.',
  ]),
});

export const passwordResetEmail = ({ name, token, expiresInMinutes }) => ({
  subject: 'Reset your SukuuPay password',
  html: shell(
    'Reset your password',
    `${paragraph(`Hi ${escapeHtml(name)},`)}
     ${paragraph(
       `We received a request to reset your password. This link expires in ${escapeHtml(expiresInMinutes)} minutes.`
     )}
     ${button(`${CLIENT_URL}/reset-password/${token}`, 'Reset password')}
     ${paragraph('If you did not request a password reset, your password will remain unchanged.')}`
  ),
  text: textShell('Reset your password', [
    `Hi ${name},`,
    `We received a request to reset your password. This link expires in ${expiresInMinutes} minutes.`,
    buttonText(`${CLIENT_URL}/reset-password/${token}`, 'Reset password'),
    'If you did not request a password reset, your password will remain unchanged.',
  ]),
});

export const passwordChangedEmail = ({ name }) => ({
  subject: 'Your SukuuPay password was changed',
  html: shell(
    'Password changed',
    `${paragraph(`Hi ${escapeHtml(name)},`)}
     ${paragraph(
       'Your password was just changed and all other sessions were signed out. If this was not you, reset your password immediately and contact support.'
     )}`
  ),
  text: textShell('Password changed', [
    `Hi ${name},`,
    'Your password was just changed and all other sessions were signed out. If this was not you, reset your password immediately and contact support.',
  ]),
});

export const invitationEmail = ({ name, otp, expiresInMinutes, inviter }) => ({
  subject: 'You have been invited to join SukuuPay',
  html: shell(
    'You have been invited to join SukuuPay',
    `${paragraph(`Hi ${escapeHtml(name)},`)}
     ${paragraph(
       `${escapeHtml(inviter || 'A school administrator')} has invited you to join SukuuPay. Enter the code below to verify your email address and complete your registration. This code expires in ${escapeHtml(expiresInMinutes)} minutes.`
     )}
     ${codeBlock(otp)}
     ${paragraph('If you did not expect this invitation, you can safely ignore this email.')}`
  ),
  text: textShell('You have been invited to join SukuuPay', [
    `Hi ${name},`,
    `${inviter || 'A school administrator'} has invited you to join SukuuPay. Enter the code below to verify your email address and complete your registration. This code expires in ${expiresInMinutes} minutes.`,
    `Verification code: ${otp}`,
    'If you did not expect this invitation, you can safely ignore this email.',
  ]),
});

// ──────────────────── School communication templates ────────────────────

const balanceStatement = ({ parentName, studentName, studentClass, balance, deadline, payLink }) => ({
  subject: `Outstanding fees for ${studentName}${studentClass ? ` (${studentClass})` : ''}`,
  html: shell(
    'Outstanding fees',
    `${paragraph(`Dear ${escapeHtml(parentName)},`)}
     ${paragraph(
       `This is to inform you that ${escapeHtml(studentName)}${
         studentClass ? ` in ${escapeHtml(studentClass)}` : ''
       } has an outstanding school fees balance of <strong>${formatCedis(balance)}</strong>.`
     )}
     ${paragraph(`Please settle the balance by <strong>${formatAccraDate(deadline)}</strong>.`)}
     ${button(payLink, 'Pay now')}`
  ),
  text: textShell('Outstanding fees', [
    `Dear ${parentName},`,
    `This is to inform you that ${studentName}${
      studentClass ? ` in ${studentClass}` : ''
    } has an outstanding school fees balance of ${formatCedis(balance)}.`,
    `Please settle the balance by ${formatAccraDate(deadline)}.`,
    payLink ? buttonText(payLink, 'Pay now') : null,
  ]),
});

const paymentReceipt = ({ parentName, studentName, amount, paymentId, paidAt }) => ({
  subject: `Payment receipt for ${studentName}`,
  html: shell(
    'Payment received',
    `${paragraph(`Dear ${escapeHtml(parentName)},`)}
     ${paragraph(
       `We have received your payment of <strong>${formatCedis(amount)}</strong> for ${escapeHtml(studentName)} on <strong>${formatAccraDate(paidAt)}</strong>.`
     )}
     ${paragraph(`Reference: ${escapeHtml(paymentId)}`)}
     ${paragraph('Thank you. Please keep this email for your records.')}`
  ),
  text: textShell('Payment received', [
    `Dear ${parentName},`,
    `We have received your payment of ${formatCedis(amount)} for ${studentName} on ${formatAccraDate(paidAt)}.`,
    `Reference: ${paymentId}`,
    'Thank you. Please keep this email for your records.',
  ]),
});

const paymentPlanInstallment = ({
  parentName,
  studentName,
  installmentNumber,
  totalInstallments,
  dueDate,
  amount,
  payLink,
}) => ({
  subject: `Installment ${installmentNumber} due for ${studentName}`,
  html: shell(
    'Payment plan installment due',
    `${paragraph(`Dear ${escapeHtml(parentName)},`)}
     ${paragraph(
       `Installment <strong>${escapeHtml(installmentNumber)}</strong> of ${escapeHtml(totalInstallments)} for ${escapeHtml(studentName)} is due on <strong>${formatAccraDate(dueDate)}</strong>.`
     )}
     ${paragraph(`Amount due: <strong>${formatCedis(amount)}</strong>`)}
     ${button(payLink, 'Pay this installment')}`
  ),
  text: textShell('Payment plan installment due', [
    `Dear ${parentName},`,
    `Installment ${installmentNumber} of ${totalInstallments} for ${studentName} is due on ${formatAccraDate(dueDate)}.`,
    `Amount due: ${formatCedis(amount)}`,
    payLink ? buttonText(payLink, 'Pay this installment') : null,
  ]),
});

const termReportNotice = ({ schoolName, term, releaseDate }) => ({
  subject: `${term} reports are now available`,
  html: shell(
    `${term} reports are available`,
    `${paragraph('Dear Parent,')}
     ${paragraph(
       `${escapeHtml(schoolName)} has released ${escapeHtml(term)} reports. They are available from <strong>${formatAccraDate(releaseDate)}</strong>.`
     )}
     ${paragraph('Please contact the school office if you need a printed copy.')}`
  ),
  text: textShell(`${term} reports are available`, [
    'Dear Parent,',
    `${schoolName} has released ${term} reports. They are available from ${formatAccraDate(releaseDate)}.`,
    'Please contact the school office if you need a printed copy.',
  ]),
});

// `body` is a free-text announcement from a school administrator, so newlines
// become paragraphs and everything is escaped.
const announcement = ({ schoolName, headline, body, closingDate }) => ({
  subject: `Notice from ${schoolName}: ${headline}`,
  html: shell(
    headline,
    `${paragraph('Dear Parent,')}` +
      `<div style="margin:0 0 12px;line-height:1.6;">${escapeHtml(body).replace(/\n/g, '<br />')}</div>` +
      (closingDate
        ? paragraph(`This notice closes on <strong>${formatAccraDate(closingDate)}</strong>.`)
        : '')
  ),
  text: textShell(headline, [
    'Dear Parent,',
    body,
    closingDate ? `This notice closes on ${formatAccraDate(closingDate)}.` : null,
  ]),
});

// ──────────────────── Template registry ────────────────────

/**
 * Every sendable template. `internalOnly` templates back the platform's own
 * auth mail and are not offered to school admins through the bulk endpoint.
 * `variables` lists everything a template can use; `optional` names the subset
 * that may be omitted — a student with no pay link still gets a statement,
 * just without the button. `build` returns { subject, html, text }.
 */
export const EMAIL_TEMPLATES = {
  verification_email: {
    label: 'Email verification code',
    internalOnly: true,
    variables: ['name', 'otp', 'expiresInMinutes'],
    build: verificationEmail,
  },
  password_reset: {
    label: 'Password reset',
    internalOnly: true,
    variables: ['name', 'token', 'expiresInMinutes'],
    build: passwordResetEmail,
  },
  password_changed: {
    label: 'Password changed notice',
    internalOnly: true,
    variables: ['name'],
    build: passwordChangedEmail,
  },
  invitation: {
    label: 'Account invitation',
    internalOnly: true,
    variables: ['name', 'otp', 'expiresInMinutes', 'inviter'],
    optional: ['inviter'],
    build: invitationEmail,
  },
  balance_statement: {
    label: 'Balance statement',
    internalOnly: false,
    variables: ['parentName', 'studentName', 'studentClass', 'balance', 'deadline', 'payLink'],
    // A student record may carry no pay link; the statement still renders
    // without the payment button rather than failing to send.
    optional: ['studentClass', 'payLink'],
    build: balanceStatement,
  },
  payment_receipt: {
    label: 'Payment receipt',
    internalOnly: false,
    variables: ['parentName', 'studentName', 'amount', 'paymentId', 'paidAt'],
    build: paymentReceipt,
  },
  payment_plan_installment: {
    label: 'Payment plan installment reminder',
    internalOnly: false,
    variables: [
      'parentName', 'studentName', 'installmentNumber', 'totalInstallments',
      'dueDate', 'amount', 'payLink',
    ],
    optional: ['payLink'],
    build: paymentPlanInstallment,
  },
  term_report_notice: {
    label: 'Term report release notice',
    internalOnly: false,
    variables: ['schoolName', 'term', 'releaseDate'],
    build: termReportNotice,
  },
  announcement: {
    label: 'General announcement',
    internalOnly: false,
    variables: ['schoolName', 'headline', 'body', 'closingDate'],
    optional: ['closingDate'],
    build: announcement,
  },
};

export const isEmailTemplate = (name) => Object.hasOwn(EMAIL_TEMPLATES, name);

/** Template metadata for listing — never includes the builder function. */
export const listEmailTemplates = ({ includeInternal = false } = {}) =>
  Object.entries(EMAIL_TEMPLATES)
    .filter(([, template]) => includeInternal || !template.internalOnly)
    .map(([name, template]) => ({
      name,
      label: template.label,
      internalOnly: template.internalOnly,
      variables: template.variables,
      requiredVariables: template.variables.filter((key) => !template.optional?.includes(key)),
      optionalVariables: template.optional || [],
    }));

/**
 * Validates and renders a named template.
 *
 * Throws with `code: 'EMAIL_TEMPLATE_NOT_FOUND'`,
 * `code: 'EMAIL_TEMPLATE_MISSING_VARIABLES'` (carrying `missing`), or
 * `code: 'EMAIL_TEMPLATE_MALFORMED'` so the service layer can map each to the
 * right HTTP status instead of leaking a raw error.
 */
export const renderEmailTemplate = (name, variables = {}) => {
  const template = EMAIL_TEMPLATES[name];
  if (!template) {
    const error = new Error(`Template "${name}" not found`);
    error.code = 'EMAIL_TEMPLATE_NOT_FOUND';
    throw error;
  }

  const missing = template.variables.filter(
    (key) =>
      !template.optional?.includes(key) &&
      (variables[key] === undefined || variables[key] === null || variables[key] === '')
  );

  if (missing.length) {
    const requiredCount = template.variables.length - (template.optional?.length || 0);
    const error = new Error(
      `Template ${name} requires ${requiredCount} variables but ${
        requiredCount - missing.length
      } were supplied: missing ${missing.join(', ')}`
    );
    error.code = 'EMAIL_TEMPLATE_MISSING_VARIABLES';
    error.missing = missing;
    throw error;
  }

  const built = template.build(variables);

  // Substitute over the rendered output too: a token that survived formatting
  // would otherwise reach a parent as literal "{{balance}}".
  const rendered = {};
  for (const field of ['subject', 'html', 'text']) {
    rendered[field] = substitute(built[field], variables);
  }

  if (!rendered.subject?.trim()) {
    const error = new Error(`Template ${name} rendered an empty subject line`);
    error.code = 'EMAIL_TEMPLATE_MALFORMED';
    throw error;
  }

  return rendered;
};

export { findTokens, findMissing, substitute, shell, textShell };
