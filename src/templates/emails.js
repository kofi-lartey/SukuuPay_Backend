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

/**
 * A two-column key/value table, for the one email that has to carry a
 * credential. Credentials get a table rather than a paragraph because a
 * recipient copying `email` and `password` out of running prose reliably
 * captures a trailing full stop, and the difference between a working sign-in
 * and a 401 is the sentence's last character.
 *
 * `password` is rendered in a monospace face at a deliberate size so the
 * case-sensitive characters can be told apart — `l` from `1`, `O` from `0`. The
 * generator already avoids the ambiguous glyphs (see utils/defaultPassword.js),
 * but a reader should not have to know that to read it correctly.
 */
const credentialsTable = ({ email, password, loginUrl, schoolCode }) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
    <tr>
      <td style="padding:12px 16px;background:#f9fafb;border-bottom:1px solid #e5e7eb;width:38%;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b7280;font-weight:700;">Email</td>
      <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;font-size:14px;font-weight:600;color:#111827;word-break:break-all;">${escapeHtml(email)}</td>
    </tr>
    <tr>
      <td style="padding:12px 16px;background:#f9fafb;border-bottom:1px solid #e5e7eb;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b7280;font-weight:700;">Temporary password</td>
      <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;font-family:'Courier New',Consolas,monospace;font-size:16px;font-weight:700;letter-spacing:1px;color:#111827;word-break:break-all;">${escapeHtml(password)}</td>
    </tr>
    <tr>
      <td style="padding:12px 16px;background:#f9fafb;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b7280;font-weight:700;">School ID</td>
      <td style="padding:12px 16px;font-family:'Courier New',Consolas,monospace;font-size:14px;font-weight:700;color:#111827;">${escapeHtml(schoolCode)}</td>
    </tr>
  </table>`;

const credentialsTableText = ({ email, password, schoolCode, loginUrl }) => [
  `Email: ${email}`,
  `Temporary password: ${password}`,
  `School ID: ${schoolCode}`,
  `Sign in: ${loginUrl}`,
];

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

/**
 * The team invitation.
 *
 * Replaces the OTP-only version this used to be. That email asked the recipient
 * to "enter the code to complete your registration" — which is self-service
 * signup language, applied to a user an administrator had already created. The
 * account existed; `status: 'invited'` and `isEmailVerified: false` meant the
 * only way forward was to prove they controlled the mailbox. It worked, but it
 * handed a person who had just been hired a second puzzle before they could see
 * the system they were hired into, and the default password that had been
 * generated was never mentioned — so a teacher who never checked their junk
 * folder was simply stuck.
 *
 * This version carries the three things the flow actually needs:
 *
 *   1. A formal notification of the invitation, naming the administrator who
 *      issued it. That name is load-bearing rather than decorative: a stranger
 *      from "SukuuPay" asking for a password is a phishing pattern that every
 *      security-awareness training teaches people to recognise, and "Kweku
 *      Mensah, Bursar, Prampram Basic" appearing above the credentials is
 *      precisely what distinguishes this mail from that one.
 *   2. The login credentials — email and the temporary default password.
 *   3. That administrator's name and position, stated twice (once in the
 *      opening, once in the signature) because a recipient who skim-reads is
 *      far more likely to act on either than on both.
 *
 * The change-password instruction is not optional garnish. The password is a
 * default the recipient did not choose and an administrator already knows, so
 * every property of it is a property of *two* people knowing it. It has to be
 * changed on first sign-in, and the `mustChangePassword` flag the controller
 * writes is what a client would use to enforce that.
 */
export const invitationEmail = ({
  name,
  email,
  password,
  schoolCode,
  schoolName,
  inviter,
  inviterRole,
  inviterPosition,
  role,
  loginUrl,
  isResend = false,
}) => {
  const inviterName = inviter || 'A school administrator';
  // "Headteacher" reads as a title; "Headmaster" does not. Used only when the
  // inviter recorded no position of their own.
  const inviterTitle = inviterPosition || (inviterRole === 'school_admin' ? 'School Administrator' : 'SukuuPay Administrator');
  const inviteeRoleLine = role
    ? ` You have been added to the school's SukuuPay account with the <strong>${escapeHtml(role)}</strong> role.`
    : '';

  const opening = isResend
    ? `This is a re-send of your SukuuPay invitation from <strong>${escapeHtml(inviterName)}</strong>${schoolName ? ` of <strong>${escapeHtml(schoolName)}</strong>` : ''}. Your previous temporary password has been replaced with the one below — the earlier one no longer works.`
    : `${escapeHtml(inviterName)} has formally invited you to join SukuuPay${schoolName ? ` on behalf of <strong>${escapeHtml(schoolName)}</strong>` : ''}.${inviteeRoleLine} Your account has been created and is ready to use.`;

  const subject = isResend
    ? 'Your SukuuPay invitation has been re-sent'
    : `You have been invited to join SukuuPay${schoolName ? ` — ${schoolName}` : ''}`;

  return {
    subject,
    html: shell(
      isResend ? 'Your SukuuPay invitation (re-sent)' : 'You have been invited to join SukuuPay',
      `${paragraph(`Dear ${escapeHtml(name)},`)}
       ${paragraph(opening)}
       ${paragraph(
         'Please sign in with the credentials below. They have been generated for you by your school administrator.'
       )}
       ${credentialsTable({ email, password, schoolCode, loginUrl })}
       ${button(loginUrl, 'Sign in to SukuuPay')}
       ${paragraph(
         '<strong>Change this password after signing in.</strong> It is a temporary default and is known to your school administrator, so it must not be left as your working password.'
       )}
       ${paragraph(
         'If you were not expecting this invitation, do not sign in — ignore this email and contact your school administrator.'
       )}
       ${paragraph(
         `Yours faithfully,<br /><strong>${escapeHtml(inviterName)}</strong><br />${escapeHtml(inviterTitle)}${schoolName ? `<br />${escapeHtml(schoolName)}` : ''}`
       )}`
    ),
    text: textShell(isResend ? 'Your SukuuPay invitation (re-sent)' : 'You have been invited to join SukuuPay', [
      `Dear ${name},`,
      isResend
        ? `This is a re-send of your SukuuPay invitation from ${inviterName}${schoolName ? ` of ${schoolName}` : ''}. Your previous temporary password has been replaced with the one below — the earlier one no longer works.`
        : `${inviterName} has formally invited you to join SukuuPay${schoolName ? ` on behalf of ${schoolName}` : ''}.${role ? ` You have been added with the ${role} role.` : ''} Your account has been created and is ready to use.`,
      'Please sign in with the credentials below. They have been generated for you by your school administrator.',
      ...credentialsTableText({ email, password, schoolCode, loginUrl }),
      'Change this password after signing in. It is a temporary default and is known to your school administrator.',
      'If you were not expecting this invitation, do not sign in — ignore this email and contact your school administrator.',
      '',
      'Yours faithfully,',
      inviterName,
      inviterTitle,
      ...(schoolName ? [schoolName] : []),
    ]),
  };
};

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
