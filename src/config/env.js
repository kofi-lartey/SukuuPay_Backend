import dotenv from 'dotenv';

dotenv.config();
export const PORT = process.env.PORT || 2345;
export const MONGODB_URI = process.env.MONGODB_URI;
export const SECRET = process.env.JWT_SECRET;
export const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
export const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
export const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
export const CLOUDINARY_UPLOAD_FOLDER = process.env.CLOUDINARY_UPLOAD_FOLDER;

export const NODE_ENV = process.env.NODE_ENV || 'development';

// ─────────────── JWT / Auth ───────────────
export const JWT_EXPIRE = process.env.JWT_EXPIRE || '15m';
export const REFRESH_TOKEN_EXPIRE = process.env.REFRESH_TOKEN_EXPIRE || '7d';
export const EMAIL_OTP_EXPIRE_MINUTES = Number(process.env.EMAIL_OTP_EXPIRE_MINUTES || 15);
export const PASSWORD_RESET_EXPIRE_MINUTES = Number(
  process.env.PASSWORD_RESET_EXPIRE_MINUTES || 30
);

// ─────────────── Client ───────────────
export const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

// ─────────────── Brevo ───────────────
export const BREVO_API_KEY = process.env.BREVO_API_KEY;
export const BREVO_API_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
export const SMTP_FROM = process.env.SMTP_FROM;
export const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'SukuuPay';

// Shared secret Brevo echoes in the X-Brevo-Event-Secret header on every
// transactional event. MUST be set: without it the delivery webhook is an
// unauthenticated endpoint that mutates delivery state.
// The old misspelling BRAVO_EVENT_SECRET is still honoured so existing
// deployments keep working; new setups should set BREVO_EVENT_SECRET.
export const BREVO_EVENT_SECRET =
  process.env.BREVO_EVENT_SECRET || process.env.BRAVO_EVENT_SECRET || process.env.BREVO_WEBHOOK_SECRET;

// Provider daily sending quota for the platform sender identity. There is no
// prepaid balance — sending is bounded by this count, which resets at 00:00
// Accra (UTC+0, so also UTC midnight).
export const EMAIL_DAILY_QUOTA = Number(process.env.EMAIL_DAILY_QUOTA || 1000);

// Concurrency for in-process bulk email jobs.
export const EMAIL_JOB_CONCURRENCY = Number(process.env.EMAIL_JOB_CONCURRENCY || 3);

// Public API origin, used to build unsubscribe links and List-Unsubscribe headers.
export const API_BASE_URL = process.env.API_BASE_URL || 'https://api.sukuupay.com';

// ─────────────── Pay links (public, parent-facing) ───────────────
// Pay links are served from the public marketing domain, not the admin app.
export const PAY_LINK_BASE_URL = process.env.PAY_LINK_BASE_URL || 'https://sukuupay.com';

// ─────────────── API metadata (GET /version) ───────────────
export const API_NAME = process.env.API_NAME || 'SukuuPay API';
// Bumped by hand when the public contract changes. Deliberately independent of
// the npm package version: this is what API clients pin against.
export const API_VERSION = process.env.API_VERSION || '1.0.0';
export const API_COMMIT = process.env.APP_COMMIT || process.env.GIT_COMMIT || null;
export const API_BUILD_DATE = process.env.APP_BUILD_DATE || null;

// ─────────────── WhatsApp (Meta Cloud API) ───────────────
// Channel switch for Version 2. While false, every user-initiated WhatsApp call
// is refused with 501 WHATSAPP_COMING_SOON_V2 before it writes anything, and the
// inbound webhook acknowledges without processing. Flip to true to switch the
// channel on once Meta business verification is complete.
export const WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED === 'true';

// The exact text a client receives while the channel is disabled. Exported so
// the frontend and the API can never drift apart on the wording.
export const WHATSAPP_COMING_SOON_MESSAGE =
  process.env.WHATSAPP_COMING_SOON_MESSAGE ||
  'WhatsApp messaging is coming soon in Version 2.';

// App secret used to verify the X-Hub-Signature-256 header on every inbound
// Meta webhook. MUST be set in production: without it the webhook is an
// unauthenticated endpoint that writes messages into the conversation history.
export const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET;

// The token Meta echoes back during webhook subscription (GET /whatsapp/webhook
// ?hub.verify_token=...). Chosen by us, compared against the query string.
export const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || SECRET;

export const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
export const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
export const WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
export const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';
export const WHATSAPP_GRAPH_BASE_URL =
  process.env.WHATSAPP_GRAPH_BASE_URL || `https://graph.facebook.com/${WHATSAPP_API_VERSION}`;

// Meta refuses free-form business-initiated text outside the customer service
// window, so the window length is a business rule here, not a provider default.
export const WHATSAPP_SERVICE_WINDOW_HOURS = Number(process.env.WHATSAPP_SERVICE_WINDOW_HOURS || 24);

export const WHATSAPP_DAILY_QUOTA = Number(process.env.WHATSAPP_DAILY_QUOTA || 1000);
export const WHATSAPP_JOB_CONCURRENCY = Number(process.env.WHATSAPP_JOB_CONCURRENCY || 3);
export const MAX_BULK_WHATSAPP_RECIPIENTS = Number(process.env.MAX_BULK_WHATSAPP_RECIPIENTS || 5000);
export const WHATSAPP_REQUEST_TIMEOUT_MS = Number(process.env.WHATSAPP_REQUEST_TIMEOUT_MS || 15000);

// ─────────────── Inbound third-party webhooks ───────────────
// Shared secret for POST /webhooks/hubtel/payment. Hubtel signs the raw body
// with HMAC-SHA512 using the account API key and sends X-Hubtel-Signature.
export const HUBTEL_WEBHOOK_SECRET = process.env.HUBTEL_WEBHOOK_SECRET || process.env.HUBTEL_API_KEY;

// Shared secret for the Arkesel SMS delivery callback. Arkesel either repeats
// the account key in the `api_key` form field or signs the body; both are
// accepted and at least one must be present in production.
export const ARKESEL_WEBHOOK_SECRET = process.env.ARKESEL_WEBHOOK_SECRET;
export const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY;

// ─────────────── SMS gateway ───────────────
// Provider used when a school has not chosen one. Per-school override lives on
// `school.sms.provider`, so this is only the platform-wide default.
export const SMS_DEFAULT_PROVIDER = process.env.SMS_DEFAULT_PROVIDER || 'arke';

// Arkesel send API. The API key is shared above with the DLR callback, because
// it authenticates both directions.
export const ARKESEL_API_URL = process.env.ARKESEL_API_URL;
export const ARKESEL_SENDER_ID = process.env.ARKESEL_SENDER_ID;
export const ARKESEL_TIMEOUT_MS = Number(process.env.ARKESEL_TIMEOUT_MS || 15000);

// Public HTTPS URL for Arkesel's delivery reports (DLR).
//
// Without this, every send stays `submitted` forever: Arkesel accepts the
// message, the carrier decides the outcome, and the report is POSTed to a URL
// that either does not exist or, on localhost, cannot be reached from outside.
// The failure is silent — a delivered message and a carrier-dropped one look
// identical.
//
// Set this to a tunnel or deployed host, and pass it per-send so Arkesel knows
// where to report. Note the asymmetry with MTN: MTN's sandbox returns simulated
// statuses, Arkesel's do not — a message that is dropped by the carrier is
// dropped silently unless a DLR URL is configured.
export const ARKESEL_CALLBACK_URL = process.env.ARKESEL_CALLBACK_URL;

// ─────────────── MTN MoMo (primary payment gateway) ───────────────
// Environment: 'sandbox' or 'production'
export const MTN_ENVIRONMENT = process.env.MTN_ENVIRONMENT || 'sandbox';

// Sandbox base URL
const MTN_SANDBOX_BASE = 'https://sandbox.momodeveloper.mtn.com';
// Production base URL (per OpCo; default to Ghana)
const MTN_PRODUCTION_BASE = process.env.MTN_PRODUCTION_BASE_URL || 'https://api.mtn.com';

export const MTN_BASE_URL =
  process.env.MTN_BASE_URL ||
  (MTN_ENVIRONMENT === 'production' ? MTN_PRODUCTION_BASE : MTN_SANDBOX_BASE);

// Per-product subscription keys from the MTN developer portal
export const MTN_COLLECTION_SUBSCRIPTION_KEY = process.env.MTN_COLLECTION_SUBSCRIPTION_KEY;
export const MTN_DISBURSEMENT_SUBSCRIPTION_KEY = process.env.MTN_DISBURSEMENT_SUBSCRIPTION_KEY;
export const MTN_REMITTANCE_SUBSCRIPTION_KEY = process.env.MTN_REMITTANCE_SUBSCRIPTION_KEY;

// API user credentials (UUID + key) from the MTN OVA/partner dashboard
export const MTN_API_USER = process.env.MTN_API_USER;
export const MTN_API_KEY = process.env.MTN_API_KEY;

// Target environment header value (sandbox, mtnghana, mtnuganda, etc.)
export const MTN_TARGET_ENVIRONMENT = process.env.MTN_TARGET_ENVIRONMENT || MTN_ENVIRONMENT;

// OAuth token endpoint path (shared by all products)
export const MTN_TOKEN_PATH = process.env.MTN_TOKEN_PATH || '/token/';
// Token expiry in seconds (default 3600)
export const MTN_TOKEN_EXPIRY = Number(process.env.MTN_TOKEN_EXPIRY || 3600);

// Request timeout in milliseconds
export const MTN_REQUEST_TIMEOUT_MS = Number(process.env.MTN_REQUEST_TIMEOUT_MS || 30000);

// Currency for this deployment (GHS for Ghana)
export const MTN_CURRENCY = process.env.MTN_CURRENCY || 'GHS';

// Callback host for webhook registration
export const MTN_CALLBACK_HOST = process.env.MTN_CALLBACK_HOST || '';

// Shared secret for POST /webhooks/mtn/payment.
//
// MTN's Collections callback carries no keyed signature, so unlike Hubtel and
// Meta there is no provider-signed proof of origin — the origin is asserted by a
// secret we configure on MTN's side and echo back. It is therefore weaker than
// the other two webhooks; the settlement claim in payment.service.js is what
// actually prevents a duplicate credit. Set it before going to production.
export const MTN_WEBHOOK_SECRET = process.env.MTN_WEBHOOK_SECRET;

// Primary gateway preference: 'mtn' or 'hubtel'
export const PRIMARY_PAYMENT_GATEWAY = process.env.PRIMARY_PAYMENT_GATEWAY || 'mtn';

// A webhook that cannot be authenticated must not silently mutate money or
// delivery state. When a secret is missing the endpoints refuse the request in
// production and only warn-and-allow in development.
export const WEBHOOK_AUTH_ENFORCED =
  process.env.WEBHOOK_AUTH_ENFORCED ?? (NODE_ENV === 'production' ? 'true' : 'false');