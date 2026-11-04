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
export const JWT_EXPIRE = process.env.JWT_EXPIRE || '4h';
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
//
// **The default is the deployed host.** It used to be `https://api.sukuupay.com`,
// a domain that does not resolve — so on any deployment that had not overridden
// it, every email unsubscribe link pointed at a host that does not exist, and
// the webhook base inherited the same dead address. The backend is served from
// Render; this is that address.
export const API_BASE_URL = process.env.API_BASE_URL || 'https://sukuupay-backend.onrender.com';

// The business email Moolre requires when generating a hosted payment link.
//
// It is the **merchant's** address, not the payer's — Moolre uses it for the
// payment notification. The school's own address is preferred at call time; this
// is the platform fallback for a school that has none on file.
export const MOOLRE_CHECKOUT_EMAIL =
  (process.env.MOOLRE_CHECKOUT_EMAIL || process.env.SUPER_ADMIN_EMAIL || '').trim() || null;

// Backend origin for inbound provider callbacks (Moolre, MTN, Arkesel).
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
// Shared secret for the Arkesel SMS delivery callback. Arkesel either repeats
// the account key in the `api_key` form field or signs the body; both are
// accepted and at least one must be present in production.
export const ARKESEL_WEBHOOK_SECRET = process.env.ARKESEL_WEBHOOK_SECRET;
export const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY;

// ─────────────── SMS gateway ───────────────
// Provider used when a school has not chosen one. Per-school override lives on
// `school.sms.provider`, so this is only the platform-wide default.
//
// Moolre is the default because it is the same vendor that collects the
// payments: one account, one balance, one vendor relationship to reconcile
// against. Arkesel stays selectable per school for the schools still on it.
export const SMS_DEFAULT_PROVIDER = process.env.SMS_DEFAULT_PROVIDER || 'moolre';

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
// MTN's Collections callback carries no keyed signature, so unlike Meta there
// is no provider-signed proof of origin — the origin is asserted by a secret
// we configure on MTN's side and echo back. It is therefore weaker than the
// other webhook; the settlement claim in payment.service.js is what actually
// prevents a duplicate credit. Set it before going to production.
export const MTN_WEBHOOK_SECRET = process.env.MTN_WEBHOOK_SECRET;

// Primary gateway preference: 'moolre' | 'mtn'
//
// Moolre is the primary: a Ghanaian EPSP licensed by the Bank of Ghana that
// reaches MTN MoMo, Telecel Cash and AT Money through one integration, and
// carries SMS on the same wallet.
export const PRIMARY_PAYMENT_GATEWAY = process.env.PRIMARY_PAYMENT_GATEWAY || 'moolre';

// ── Moolre ──
//
// Four credentials, not one, and they are not interchangeable:
//
//   MOOLRE_API_USER   — the account username, sent as `X-API-USER`
//   MOOLRE_API_KEY    — the private key, for account / transfer / payment ops
//   MOOLRE_PUBLIC_KEY — the public key, for payment-initiation (hosted checkout)
//   MOOLRE_ACCOUNT_NUMBER — the merchant wallet, sent on nearly every call
//
// A missing one is a configuration error, not something to paper over at
// request time: `utils/moolreClient.js` fails fast on the first call.
export const MOOLRE_API_USER = process.env.MOOLRE_API_USER;
export const MOOLRE_API_KEY = process.env.MOOLRE_API_KEY;
export const MOOLRE_PUBLIC_KEY = process.env.MOOLRE_PUBLIC_KEY;
export const MOOLRE_ACCOUNT_NUMBER = process.env.MOOLRE_ACCOUNT_NUMBER;

// Base URL for the API. Sandbox is the same shape as production, so a
// deployment only ever changes this one value.
export const MOOLRE_BASE_URL = process.env.MOOLRE_BASE_URL || 'https://api.moolre.com';

// The base URL for the **messaging** (VAS) API.
//
// It is a separate value because Moolre's sandbox does not have a messaging
// account at all: `POST /open/sms/send` against `sandbox.moolre.com` answers
// `SMS02 — SMS Account not found`, and the balance query answers the same
// thing. The sandbox is a *payment* simulator; it has no wallet for
// messaging.
//
// So a deployment that collects payments against the sandbox and still owes a
// parent a receipt has to reach the live VAS endpoint, or the receipt can
// never be sent at all — which is not a configuration mistake but a
// provider fact, and it fails silently, because the SMS is a best-effort
// channel that reports failure in its return value.
//
// The default therefore follows the **payments** base URL *upwards*: sandbox
// payments reach the live messaging API, and production payments reach
// production. Set `MOOLRE_SMS_BASE_URL` explicitly to point the messaging API
// somewhere else — including back at the sandbox, for a deployment that must
// not spend real money on real messages.
export const MOOLRE_SMS_BASE_URL =
  process.env.MOOLRE_SMS_BASE_URL ||
  (MOOLRE_BASE_URL.includes('sandbox') ? 'https://api.moolre.com' : MOOLRE_BASE_URL);

// Where the hosted checkout lives.
//
// **Not used by the client.** The checkout URL is not a page this platform
// hosts or guesses at — Moolre creates a Web POS page per payment via
// `POST /embed/link` and returns its `authorization_url`. This is kept only as
// a record of the host Moolre serves that page from.
export const MOOLRE_CHECKOUT_URL =
  process.env.MOOLRE_CHECKOUT_URL ||
  (MOOLRE_BASE_URL.includes('sandbox') ? 'https://sandbox.moolre.com' : 'https://pos.moolre.com');

// Request timeout. Moolre's USSD push is a network round-trip to three
// carriers, so it is slower than a card authorisation.
export const MOOLRE_REQUEST_TIMEOUT_MS = Number(process.env.MOOLRE_REQUEST_TIMEOUT_MS || 30000);

// Where Moolre posts the transaction callback.
//
// The `/api` prefix is part of the path, not decoration: the app mounts its
// router at `/api` (`app.use('/api', routes)`), and the payment routes hang
// off that router at the root. So the callback lives at
// `<host>/api/pay/webhook/moolre` — a default without the prefix would 404,
// and Moolre would retry a callback that could never land.
//
// A deployment sets this explicitly when the API is behind a proxy or a
// custom domain, because `WEBHOOK_BASE_URL` is what the *platform* calls
// itself, and the two are not always the same address.
export const MOOLRE_CALLBACK_URL =
  process.env.MOOLRE_CALLBACK_URL || `${WEBHOOK_BASE_URL}/api/pay/webhook/moolre`;

// The secret Moolre echoes back in the payment callback.
//
// Moolre sends the callback secret in `data.secret`, and the docs are explicit:
// "Validate the callback and its expected secret before changing payment
// records." It is a second line of defence behind the re-verification with
// Moolre's own status endpoint — a callback that fails the secret check is
// still re-verified rather than trusted, and a callback that passes it is
// still re-verified.
//
// **The secret belongs to the wallet, and the sandbox and live wallets are
// separate records with separate secrets.** So the secret follows the
// environment the API is pointed at: a sandbox secret in a live deployment
// would refuse every live callback, which is the safe direction but a
// confusing one.
//
// Unset, the check is skipped rather than failing every callback.
export const MOOLRE_CALLBACK_SECRET = MOOLRE_BASE_URL.includes('sandbox')
  ? process.env.MOOLRE_CALLBACK_SECRET_SANDBOX || process.env.MOOLRE_CALLBACK_SECRET || ''
  : process.env.MOOLRE_CALLBACK_SECRET || '';

// ── Moolre VAS credentials ──
//
// Moolre issues one VAS credential per *VAS service*, and a service can cover
// both SMS and WhatsApp.
//
// **This account has one service.** Both keys issued for it decode to the same
// `vasid` (15118) and the same expiry, differing only in the signature —
// Moolre re-signed the key and revoked the old one. So there is one
// credential, and `MOOLRE_VASKEY` is where it lives.
//
// The per-channel names remain because the docs describe them as
// service-specific, and an account that *has* split SMS and WhatsApp into
// separate services needs two different keys. The precedence is:
//
//   MOOLRE_VASKEY            — the single credential (this account)
//   MOOLRE_SMS_VASKEY        — overrides it for SMS
//   MOOLRE_WHATSAPP_VASKEY   — overrides it for WhatsApp
//
// A key from one VAS service authenticates on the other channel's endpoints
// too, and then reports *its own* service's balance. That is a quiet way to
// read the wrong account's numbers, which is why the source of truth is one
// variable rather than two that have to be kept in step.
export const MOOLRE_VASKEY =
  process.env.MOOLRE_VASKEY || process.env.MOOLRE_SMS_VASKEY || process.env.MOOLRE_WHATSAPP_VASKEY || '';

// ── Moolre SMS ──
//
// SMS rides on a VAS credential separate from the payment API key, and the
// sender ID must be one Moolre has approved for the account — an unapproved
// ID is silently dropped by the carrier, so it is validated before sending.
export const MOOLRE_SMS_VASKEY =
  process.env.MOOLRE_SMS_VASKEY || MOOLRE_VASKEY || '';
export const MOOLRE_SMS_SENDER_ID = process.env.MOOLRE_SMS_SENDER_ID;

// ── Moolre WhatsApp ──
//
// The WhatsApp service is separate from the *payment* credentials, and from
// Meta's own WhatsApp credentials — this account is only used for outbound
// sends.
export const MOOLRE_WHATSAPP_VASKEY =
  process.env.MOOLRE_WHATSAPP_VASKEY || MOOLRE_VASKEY || '';

// A webhook that cannot be authenticated must not silently mutate money or
// delivery state. When a secret is missing the endpoints refuse the request in
// production and only warn-and-allow in development.
export const WEBHOOK_AUTH_ENFORCED =
  process.env.WEBHOOK_AUTH_ENFORCED ?? (NODE_ENV === 'production' ? 'true' : 'false');