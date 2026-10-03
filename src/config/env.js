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

// ─────────────── Platform owner ───────────────
//
// There is exactly ONE `super_admin` on this platform, and it is provisioned
// from these three variables at boot by `boot/ensureSuperAdmin.js` — never
// created through an API and never held by more than one account.
//
// `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` are **backend-only**. They must
// never be exposed through a `VITE_*` variable on the frontend: anything prefixed
// `VITE_` is inlined into the shipped JavaScript bundle and is readable by anyone
// who opens devtools, which for a platform owner's password is the same as having
// no password at all.
//
// `SUPER_ADMIN_NAME` is a display name for the account and carries no authority —
// the authority is the email, which is the field the reconcile matches on. It has
// a fallback so an unset name cannot block the boot.
//
// Absent values resolve to `null` rather than throwing. `config/env.js` is
// imported by the test suite, and a module that throws on an unset variable would
// take every test with it. The boot reconciler is the single place that decides a
// missing pair is fatal, because that is the one place where it is: a deployment
// that boots without an owner has no way into `/api/admin/*` at all.
export const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase() || null;
export const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || null;
export const SUPER_ADMIN_NAME = (process.env.SUPER_ADMIN_NAME || 'Platform Operations').trim();

// ─────────────── JWT / Auth ───────────────
export const JWT_EXPIRE = process.env.JWT_EXPIRE || '15m';
export const REFRESH_TOKEN_EXPIRE = process.env.REFRESH_TOKEN_EXPIRE || '7d';
export const EMAIL_OTP_EXPIRE_MINUTES = Number(process.env.EMAIL_OTP_EXPIRE_MINUTES || 15);
export const PASSWORD_RESET_EXPIRE_MINUTES = Number(
  process.env.PASSWORD_RESET_EXPIRE_MINUTES || 30
);

// ─────────────── Team invitations ───────────────
// Length of the random suffix appended to the School ID when minting an
// invitee's default password (see utils/defaultPassword.js). Eight gives ~2.8e11
// distinct suffixes at 31^8, which is far beyond the number of staff any one
// school will ever invite, while keeping the whole password short enough to be
// read aloud over a phone without error.
export const INVITE_PASSWORD_SUFFIX_LENGTH = Number(
  process.env.INVITE_PASSWORD_SUFFIX_LENGTH || 8
);

// How many invitations a single admin may send per hour.
//
// An invite mints a *working credential* and emails it, so the endpoint is a
// credential-minting surface: without a ceiling one compromised admin session
// turns into a mail cannon pointed at an arbitrary list of addresses. 25/hour is
// well above a real hiring day (a school invites a handful of staff a term) and
// still bounds the blast radius.
//
// Counted per admin identity rather than per IP — see the `inviteLimiter` in
// routes/userRoutes.js for why the anonymous `emailLimiter` on the auth routes
// is the wrong limiter to reuse here. Shared with `/users/:userId/resend-invite`
// so resending cannot be used to walk around it.
export const INVITE_RATE_LIMIT_PER_HOUR = Number(
  process.env.INVITE_RATE_LIMIT_PER_HOUR || 25
);

// ─────────────── Client ───────────────
// Origin the browser is on. Every link that lands a human on a page is built
// from this: the email-verification link in authController and the
// password-reset link in templates/emails.js. Those are two separate flows and
// both must resolve to a real route on the deployed frontend — App.jsx defines
// `/verify-email/:token` and `/reset-password/:token` — or the emailed link
// 404s and the user is locked out of their own account.
//
// This is deliberately NOT WEBHOOK_BASE_URL. See that note below.
export const CLIENT_URL = process.env.CLIENT_URL || 'https://sukuupay.netlify.app';

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

// Origin of this service. Used by the keep-alive health check in utils/cron.js,
// which skips itself when this is a loopback address — probing localhost proves
// nothing about whether the public endpoint is reachable.
export const API_URL = process.env.API_URL || '';

// Public API origin, used to build unsubscribe links and List-Unsubscribe headers.
export const API_BASE_URL = process.env.API_BASE_URL || 'https://api.sukuupay.com';

// Backend origin for inbound provider callbacks (Hubtel, MTN, Arkesel).
//
// This is deliberately NOT PAY_LINK_BASE_URL. That is the parent-facing page and
// points at the frontend; provider callbacks are server-to-server POSTs that must
// land on a route this process serves. Building a webhook URL from the frontend
// origin produces a callback the provider cannot reach, and settlement silently
// never arrives.
export const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || API_BASE_URL;

// Origin the keep-alive health check probes. Defaults to API_URL, but is separate
// so a monitoring service can be pointed somewhere else. A loopback value is
// detected and skipped rather than passed over — see utils/cron.js.
export const HEALTH_CHECK_URL = process.env.HEALTH_CHECK_URL || '';

// ─────────────── Pay links (public, parent-facing) ───────────────
// Pay links are served from the public marketing domain, not the admin app.
export const PAY_LINK_BASE_URL = process.env.PAY_LINK_BASE_URL || 'https://sukuupay.com';

// ─────────────── Google Sign-In ───────────────
// Declared **after `CLIENT_URL`** because `GOOGLE_ALLOWED_ORIGINS` falls back to it.
// `const` bindings are in the temporal dead zone until their declaration executes, so
// reading `CLIENT_URL` from a block above it throws
// `ReferenceError: Cannot access 'CLIENT_URL' before initialization` — at import, not
// at call time, which would take down every route rather than just this one.

// The OAuth 2.0 **web client ID** from the Google Cloud console — not the API key, and
// not the secret. It appears in the credential's "Client ID" field and is safe to ship
// to a browser; the value here is used server-side as the `aud` every presented ID
// token must carry, which is what stops a token minted for *someone else's* app being
// replayed at us.
//
// Null rather than '' so "unset" is distinguishable from "set to nothing" and
// `isGoogleAuthConfigured()` can answer without a truthiness trap. Nothing throws at
// import when it is missing — see `services/googleAuth.service.js`.
export const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim() || null;

/**
 * Allowlist of origins permitted to post a Google credential.
 *
 * A CORS restriction is not authentication, so this is defence in depth rather than
 * the boundary — the ID token's signature, issuer, audience and expiry are. It is here
 * because the blast radius of a stolen token is somebody else's account, and an origin
 * allowlist narrows where a token can be lifted from.
 *
 * Compared against the request's `Origin` by `googleAuth.service.js`. Falls back to
 * `CLIENT_URL` so the common case needs no extra configuration, and an empty list
 * refuses every browser origin — fail closed, because an origin check that silently
 * allows everything is not an origin check.
 */
export const GOOGLE_ALLOWED_ORIGINS = (process.env.GOOGLE_ALLOWED_ORIGINS || CLIENT_URL)
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/**
 * Whether a Google-linked account may create itself on first sign-in.
 *
 * **Defaults to `true`**, on the reasoning that it gates nothing meaningful on its own.
 *
 * The real control on account creation is `features.selfSignupEnabled` in
 * `PlatformSettings`, and `googleAuth.controller.js` checks that **before** this.
 * An operator who has closed public registration has already closed it for Google —
 * so this flag cannot be the thing standing between them and open sign-up.
 *
 * What is left is the narrower case: an operator who wants self-signup through the
 * password form but not through a third-party identity. That is the only situation
 * this governs, and it is a preference rather than a security boundary — a Google
 * account is created with `isEmailVerified: true` on the strength of Google's own
 * `email_verified` claim, which is *stronger* evidence of inbox control than the OTP
 * the password path sends. Allowing the weaker-verified path while refusing the
 * stronger one would be backwards.
 *
 * It was default-`false` when this was first written, on the belief that a second
 * closed switch was prudent here. That was overweighting a control that is already
 * dominated by `selfSignupEnabled`, and it had the side effect of making Google look
 * broken on every deployment that had not heard of this variable.
 *
 * Flip it to `false` to keep Google strictly sign-in-only. Existing and invited users
 * are unaffected either way — this governs **creation** only.
 */
export const GOOGLE_ALLOW_SIGNUP = String(
  process.env.GOOGLE_ALLOW_SIGNUP ?? 'true'
).toLowerCase() !== 'false';

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
//
// **No fallback to SECRET, deliberately.** It used to read
// `process.env.WHATSAPP_VERIFY_TOKEN || SECRET`, and that fallback is what made a
// real deployment failure look like a credentials problem: Render had no
// `WHATSAPP_VERIFY_TOKEN` set, so the service silently validated webhooks against
// its JWT signing secret — a value nobody ever registered with Meta — and every
// subscription attempt failed with a bare 403 "Verification failed" while the
// dashboard insisted the URL was wrong.
//
// A missing token is now a missing token. `resolveWebhookChallenge` compares
// against `undefined`, which never matches, and `GET /version` reports
// `verifyTokenSource: 'missing'` with a length of 0, so the cause is legible
// from outside the box instead of requiring a deploy to reproduce.
//
// Set it to any string you choose. Meta stores it verbatim and echoes it back, so
// keep it alphanumeric: a token containing `+`, `/` or `=` has to survive a query
// string in both directions, and that is a class of bug worth not having.
export const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

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