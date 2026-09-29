import { emailMessagingRoute } from './routes/emailMessaging.routes.js';
import { EmailMessage } from './models/emailMessageModel.js';
import { EmailJob } from './models/emailJobModel.js';
import { EmailPreference } from './models/emailPreferenceModel.js';
import { IdempotencyRecord } from './models/idempotencyModel.js';
import { renderEmailTemplate, listEmailTemplates, EMAIL_TEMPLATES } from './templates/emails.js';
import { sendEmail, EmailTransportError } from './services/emailService.js';
import { htmlToText } from './utils/htmlToText.js';
import { escapeHtml, escapeUrl } from './utils/escapeHtml.js';
import { consumeRateLimit, resetRateLimits } from './utils/rateLimiter.js';
import { formatCedis, formatAccraDate } from './utils/formatters.js';
import {
  sendSingleEmailSchema,
  sendBulkEmailSchema,
  emailHistoryQuerySchema,
  providerEventSchema,
  unsubscribeQuerySchema,
} from './validations/emailMessaging.validation.js';

let failures = 0;
const assert = (label, cond) => {
  if (!cond) {
    failures += 1;
    console.error('FAIL:', label);
  } else {
    console.log('ok  ', label);
  }
};

// ── wiring ──
const paths = emailMessagingRoute.stack
  .filter((layer) => layer.route)
  .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
assert('router mounted', paths.length === 9);
assert('has single', paths.includes('POST /email/single'));
assert('has bulk', paths.includes('POST /email/bulk/:schoolId'));
assert('has history', paths.includes('GET /email/history'));
assert('has webhook', paths.includes('POST /email/webhooks/brevo'));
assert('has unsubscribe GET+POST', paths.includes('GET /email/unsubscribe') && paths.includes('POST /email/unsubscribe'));
assert('has job cancel', paths.includes('POST /email/jobs/:jobId/cancel'));
assert('models registered', EmailMessage.modelName && EmailJob.modelName && EmailPreference.modelName && IdempotencyRecord.modelName);

// ── formatters ──
assert('formatCedis', formatCedis(55000) === 'GHS 550.00');
assert('formatAccraDate', formatAccraDate('2026-10-15T12:00:00.000Z') === '15 Oct 2026');

// ── escaping ──
assert('escapes script', escapeHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;');
assert('escapes quotes', escapeHtml(`a"b'c&d`) === 'a&quot;b&#39;c&amp;d');
assert('escapeUrl drops javascript:', escapeUrl('javascript:alert(1)') === '');
assert('escapeUrl allows https', escapeUrl('https://a.example/p?x=1') === 'https://a.example/p?x=1');

// ── htmlToText ──
const text = htmlToText('<p>Hello <strong>Ama</strong></p><p>Balance: GHS 550.00</p><p>a<br />b</p>');
assert('htmlToText keeps words', text.includes('Hello Ama') && text.includes('GHS 550.00'));
assert('htmlToText paragraph breaks', text.includes('\n\n'));
assert('htmlToText br', text.includes('a\nb'));
assert('htmlToText decodes entities', htmlToHtmlEntityCheck());
function htmlToHtmlEntityCheck() {
  return htmlToText('<p>Tom &amp; Jerry &#65;</p>').includes('Tom & Jerry A');
}
assert('htmlToText strips script', !htmlToText('<script>bad()</script><p>ok</p>').includes('bad()'));

// ── templates ──
const list = listEmailTemplates();
assert('public templates only', list.length === 5 && !list.some((t) => t.internalOnly));
assert('registry size', Object.keys(EMAIL_TEMPLATES).length === 9);

const rendered = renderEmailTemplate('balance_statement', {
  parentName: 'Kwabena Mensah',
  studentName: 'Ama Serwaa',
  studentClass: 'Basic 7',
  balance: 55000,
  deadline: '2026-10-15T00:00:00.000Z',
  payLink: 'https://pay.sukuupay.com/abc',
});
assert('rendered subject', rendered.subject === 'Outstanding fees for Ama Serwaa (Basic 7)');
assert('rendered html', rendered.html.includes('<!DOCTYPE html>') && rendered.html.includes('GHS 550.00'));
assert('rendered text part exists', rendered.text && rendered.text.includes('GHS 550.00'));
assert('deadline formatted', rendered.html.includes('15 Oct 2026'));
assert('pay link rendered', rendered.html.includes('https://pay.sukuupay.com/abc'));

// injection: a parent-supplied name must not become markup
const injected = renderEmailTemplate('balance_statement', {
  parentName: '<img src=x onerror=alert(1)>',
  studentName: '</h2><script>bad()</script>',
  studentClass: 'Basic 7',
  balance: 100,
  deadline: '2026-10-15T00:00:00.000Z',
  payLink: '',
});
assert('injection escaped in html', !injected.html.includes('<script>bad()') && !injected.html.includes('onerror=alert'));
assert('injection escaped in subject', !injected.subject.includes('<script>'));

// missing variables
let missingCode = null;
try {
  renderEmailTemplate('balance_statement', { parentName: 'X', studentName: 'Y' });
} catch (error) {
  missingCode = error.code;
}
assert('missing variables rejected', missingCode === 'EMAIL_TEMPLATE_MISSING_VARIABLES');

// text shell for auth templates
const otp = renderEmailTemplate('verification_email', { name: 'Ama', otp: '123456', expiresInMinutes: 15 });
assert('otp text part', otp.text.includes('Verification code: 123456'));
assert('otp html part', otp.html.includes('123456'));

// ── validation ──
const singleOk = sendSingleEmailSchema.validate({
  to: 'parent@example.com',
  template: 'balance_statement',
  variables: { balance: 1 },
});
assert('single validates', !singleOk.error);
const singleNoBody = sendSingleEmailSchema.validate({ to: 'a@b.com' });
assert('single requires template or body', !!singleNoBody.error);
const singleNoAddress = sendSingleEmailSchema.validate({ template: 'balance_statement' });
assert('single requires to or studentId', !!singleNoAddress.error);
const singleBoth = sendSingleEmailSchema.validate({ to: 'a@b.com', studentId: '65f4c5d6e7f8a9b0c1d2e3f4', template: 'balance_statement' });
assert('single rejects to+studentId', !!singleBoth.error);
const singleIndexed = sendSingleEmailSchema.validate({
  studentId: '65f4c5d6e7f8a9b0c1d2e3f4',
  recipient: 'primary_indexed',
  template: 'balance_statement',
});
assert('indexed needs index', !!singleIndexed.error);
const singleIndexedOk = sendSingleEmailSchema.validate({
  studentId: '65f4c5d6e7f8a9b0c1d2e3f4',
  recipient: 'primary_indexed',
  recipientIndex: 1,
  template: 'balance_statement',
});
assert('indexed with index ok', !singleIndexedOk.error);
const singleCustom = sendSingleEmailSchema.validate({
  to: 'a@b.com',
  subject: 'Hi',
  html: '<p>hi</p>',
  text: 'hi',
});
assert('custom body ok', !singleCustom.error);
const singleHalfBody = sendSingleEmailSchema.validate({ to: 'a@b.com', subject: 'Hi', html: '<p>hi</p>' });
assert('custom body needs text', !!singleHalfBody.error);
const singlePastSchedule = sendSingleEmailSchema.validate({ to: 'a@b.com', template: 'balance_statement', scheduleAt: '2020-01-01' });
assert('scheduleAt in past rejected', !!singlePastSchedule.error);
const singleBadEmail = sendSingleEmailSchema.validate({ to: 'not-an-email', template: 'balance_statement' });
assert('bad email rejected', !!singleBadEmail.error);

const bulkOk = sendBulkEmailSchema.validate({ recipients: { target: 'all' }, template: 'announcement', confirmBroadscope: true });
assert('bulk validates', !bulkOk.error);
const bulkClassNoClass = sendBulkEmailSchema.validate({ recipients: { target: 'class' }, template: 'announcement' });
assert('target class needs class', !!bulkClassNoClass.error);
const bulkIndividualNoIds = sendBulkEmailSchema.validate({ recipients: { target: 'individual' }, template: 'announcement' });
assert('target individual needs ids', !!bulkIndividualNoIds.error);
const bulkBadBand = sendBulkEmailSchema.validate({ recipients: { target: 'balance', balanceRanges: ['nope'] }, template: 'announcement' });
assert('bad balance band rejected', !!bulkBadBand.error);
const bulkBadStatus = sendBulkEmailSchema.validate({ recipients: { target: 'all' }, template: 'announcement', status: ['bogus'] });
assert('bad student status rejected', !!bulkBadStatus.error);

const hq = emailHistoryQuerySchema.validate({});
assert('history defaults', hq.value.page === 1 && hq.value.perPage === 20);
const hqBounce = emailHistoryQuerySchema.validate({ hasBounce: true, status: 'bounced' });
assert('hasBounce + status rejected', !!hqBounce.error);
const hqRange = emailHistoryQuerySchema.validate({ from: '2026-09-10T00:00:00.000Z', toDate: '2026-09-01T00:00:00.000Z' });
assert('inverted range rejected', !!hqRange.error);
const hqPerPage = emailHistoryQuerySchema.validate({ perPage: 500 });
assert('perPage cap enforced', !!hqPerPage.error);

assert('provider events validate', !providerEventSchema.validate({ events: [{ messageId: 'x', event: 'delivered' }] }).error);
assert('unknown provider event rejected', !!providerEventSchema.validate({ events: [{ messageId: 'x', event: 'exploded' }] }).error);
assert('empty events rejected', !!providerEventSchema.validate({ events: [] }).error);
assert('unsubscribe validates', !unsubscribeQuerySchema.validate({ email: 'a@b.com', token: 'a'.repeat(32) }).error);
assert('short token rejected', !!unsubscribeQuerySchema.validate({ email: 'a@b.com', token: 'abc' }).error);

// ── rate limiter ──
resetRateLimits();
let limited = false;
for (let i = 0; i < 4; i += 1) {
  try {
    consumeRateLimit('test:key', 3, 60_000);
  } catch (error) {
    limited = error.status === 429 && error.retryAfter > 0;
  }
}
assert('rate limiter trips with retryAfter', limited);
resetRateLimits();

// ── transport (no API key configured → typed error, not a raw throw) ──
const err = await sendEmail({ to: 'a@b.com', subject: 'x', html: '<p>x</p>' }).then(
  () => null,
  (error) => error
);
assert('transport throws typed error', err instanceof EmailTransportError);
assert('transport error has status+code', Boolean(err?.status && err?.code));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll email module checks passed.');
if (failures) process.exitCode = 1;
