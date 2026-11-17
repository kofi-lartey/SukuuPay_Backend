# Backend Architecture — SukuuPay

## 1. High-Level Overview

### 1.1 Purpose & Scope
The SukuuPay backend is a **Node.js / Express / MongoDB** API serving a multi-tenant school management platform in Ghana. It powers three distinct portals:

| Portal | Audience | Mount Path | Auth Style |
|--------|----------|------------|------------|
| **Admin Console** | School admins, accountants, teachers, platform owner (`super_admin`) | `/api/*` (most routes) | JWT access + refresh tokens, role gates |
| **Parent Pay Portal** | Parents paying fees via tokenised public links | `/api/pay/:token/*` | Token in URL path (no JWT) |
| **Teacher Portal** | Teachers marking attendance, viewing timetables | `/api/teacher/*` | JWT + `requireTeacher` gate |
| **Student Community** | Students in clubs, chat, events | `/api/community/*` | JWT + `communityAuth` (excludes parents) |

A single **Socket.io** namespace (`/community`) shares the HTTP server for real-time club chat.

### 1.2 Core Design Principles
1. **Layer separation**: Route → Controller → Service → Model. Controllers only handle HTTP concerns; business logic lives in services.
2. **School-scoped tenancy**: Every write is scoped to `req.user.schoolId` (or an explicit `schoolId` for `super_admin`). No cross-school leakage.
3. **Explicit error codes**: Every service throws `ApiError(message, status, code, meta)`. Controllers forward `code` so the frontend can branch on machine-readable identifiers (`CLUB_PASSWORD_REQUIRED`, `SCHOOL_NOT_LINKED`, etc.).
4. **Boot-time invariants**: Critical platform state (single `super_admin`, index specs, gateway migrations) reconciled on every startup before the app accepts traffic.
5. **Idempotent migrations**: All boot scripts and migration utilities are safe to re-run; they use `partialFilterExpression` and upserts to avoid duplicate-key crashes.

### 1.3 Technology Stack
- **Runtime**: Node.js 22 (ES modules)
- **Framework**: Express 5
- **Database**: MongoDB (Mongoose ODM)
- **Auth**: JWT (access 4h, refresh 7d) with token-version revocation
- **Payments**: Moolre (primary, aggregates MTN MoMo, Telecel Cash, AT Money), MTN MoMo direct (legacy), manual cash recording
- **SMS**: Moolre VAS (primary), Arkesel (legacy per-school override)
- **Email**: Brevo (transactional), daily quota enforcement
- **WhatsApp**: Meta Cloud API (v2, behind feature flag)
- **File storage**: Cloudinary (images, ID card assets)
- **Background jobs**: `node-cron` (installment reminders, health probes, teacher attendance sweep)
- **Realtime**: Socket.io attached to the same HTTP server

---

## 2. Directory Structure & Module Responsibilities

```
Backend/src/
├── boot/                    # One-time startup reconciliations
├── config/                  # Environment validation & constants
├── controllers/             # HTTP layer (thin)
│   ├── admin/               # Platform console controllers
│   ├── lms/                 # Learning management
│   ├── parent/              # Parent portal controllers
│   └── teacher/             # Teacher portal controllers
├── jobs/                    # Cron jobs (installment reminders, health, attendance)
├── middleware/              # Express middleware stack
├── models/                  # Mongoose schemas + indexes + hooks
├── routes/                  # Router composition & mount order
├── scripts/                 # CLI utilities (backfills, migrations, audits)
├── services/                # Business logic (fat, testable)
│   ├── admin/               # Platform admin services
│   ├── parent/              # Parent portal services
│   └── teacher/             # Teacher portal services
├── sockets/                 # Socket.io gateway (community chat)
├── templates/               # Email / WhatsApp message templates
├── utils/                   # Pure helpers (tokens, crypto, ids, signatures)
├── validations/             # Joi schemas (request body/query/params)
├── validators/              # Custom validator functions
├── index.js                 # App composition, boot, server listen
└── __emailSmoke.js          # Dev-only email test
```

---

## 3. Request Lifecycle & Middleware Stack

### 3.1 Global Stack (in `index.js`)
```
express.json({ verify: captureRawBody })   # Raw body for webhook signature verification
express.urlencoded({ verify: captureRawBody })
cors()
app.use('/', healthRoute)                   # /health, /version, /ping (no auth)
app.use('/', webhookRoute)                  # Moolre, MTN, Arkesel, Meta callbacks (root mount)
app.use('/', whatsappRoute)
app.use('/api', routes)                     # All authenticated API routes
app.use(recordRequestError)                 # Feeds in-memory error ring buffer
app.use(errorHandler)                       # Central error formatting (strips 5xx messages)
```

### 3.2 `/api` Router Stack (in `routes/index.js`)
```
router.use('/', healthRoute)                # /api/health mirrors root
router.use(maintenanceGuard)                # Blocks writes when maintenance: "on"
router.use('/', authRoute)                  # /auth/* (login, signup, verify, reset)
router.use('/', userRoute)                  # /users/* (profile, invites, impersonation)
router.use('/', schoolRoute)                # /schools/* (provisioning, settings)
router.use('/', studentRoute)               # /students/* (roster, parents, status)
router.use('/', paymentRoute)               # /pay/* (Moolre checkout, webhooks)
router.use('/', paymentPlanRoute)           # /payment-plans/* (installments)
router.use('/', emailMessagingRoute)        # /email/* (Brevo)
router.use('/', analyticsRoute)             # /analytics/* (dashboards)
router.use('/', reportsRoute)               # /reports/*
router.use('/audit-logs', auditLogRoute)    # /audit-logs/*
router.use('/id-cards', idCardRoute)        # /id-cards/*
router.use('/id-card-templates', idCardTemplateRoute)
router.use('/upload', uploadRoute)          # Cloudinary signed upload
router.use('/notifications', notificationRoute)
router.use('/', parentMessageRoute)         # Parent → school messages
router.use('/pay', parentRoute)             # Parent portal (token auth)
router.use('/pay', lmsStudentRoute)         # Student LMS under same token
router.use('/community', communityRoute)    # Student community (JWT + communityAuth)
router.use('/teacher', teacherRoute)        # Teacher portal (JWT + requireTeacher)
router.use('/teacher/lms', lmsRoute)        # Teacher LMS
router.use('/settings', settingsRoute)
router.use('/admin', adminAttendanceRoute)  # School admin academic (before platform admin)
router.use('/admin', adminRecordsRoute)
router.use('/admin', adminTimetableRoute)
router.use('/admin', adminAcademicRoute)    # Headmaster academic console
router.use('/', manualPaymentRoute)         # Cash recording
router.use('/admin', adminRoute)            # Platform console (super_admin gate)
router.use('/', publicAdRoute)              # Unauthenticated ad slider
router.use('/', publicSchoolRoute)          # Unauthenticated school logo carousel
router.use('/', schoolAdRoute)              # School ad requests (authenticated)
router.use('/', whatsappRoute)              # Meta callbacks (also at root)
router.use('/', smsRoute)                   # SMS sending (root + /api)
router.use('/', smsRequestRoute)            # SMS credit purchase
```

**Mount order is load-bearing** — see inline comments in `routes/index.js` for why each segment precedes or follows its neighbours.

### 3.3 Authentication Middleware (`middleware/authenticate.js`)
```js
// Two entry points:
authenticateUser(token)    // Pure function: token → user object (used by sockets, jobs)
authenticate(req, res, next) // Express middleware: extracts Bearer token, attaches req.user
```
- **Student tokens** resolve against `Student` collection (adds `studentId`, `name` from `studentName`).
- **Staff tokens** resolve against `User` collection.
- **Token version** (`user.tokenVersion`) invalidates all sessions on bump.

### 3.4 Role Gates
```js
authorize(...roles)   // req.user.role must be in list
requireTeacher        // role === 'teacher' + schoolId present
requireSchool         // schoolId present (excludes super_admin)
communityAuth         // allows student, teacher, school_admin, accountant, super_admin; rejects parent
```
All gates run **after** `authenticate`, so `req.user` is always populated.

### 3.5 School Scope Resolution (`middleware/communityAuth.js`)
```js
resolveCommunitySchool(user, explicitSchoolId)
```
- `super_admin` may pass explicit `schoolId` (platform console).
- Everyone else pinned to `user.schoolId`.
- Returns `ObjectId` or throws `SCHOOL_ACCESS_DENIED`.

---

## 4. Data Model Architecture

### 4.1 Core Collections
| Collection | Purpose | Key Indexes |
|------------|---------|-------------|
| `User` | Staff + platform accounts | `email` (unique), `schoolId`, `providerId` (partial unique), `authProvider` (partial), `impersonatingSchoolId` |
| `Student` | Pupil records | `schoolId+studentId` (unique), `schoolId+status+studentClass`, `parents.phone`, `uniquePayLinkToken` (partial unique), `certificateNumber` (partial unique) |
| `School` | Tenant root | `schoolCode` (unique), `ownerId` (ref User) |
| `Payment` | Fee transactions | `schoolId+studentId`, `paymentReference` (unique), `gatewayReference` (partial unique) |
| `PaymentPlan` | Installment schedules | `schoolId`, `studentId` |
| `Club` | Student communities | `schoolId+createdAt`, `schoolId+category+privacy` |
| `Post`, `Comment`, `Event` | Community feed | `schoolId`, `clubId` |
| `ImpersonationSession` | Platform owner audit trail | `superAdminId`, `schoolId`, `endedAt` |
| `SmsPurchaseRequest` | Credit top-up requests | `schoolId`, `status` |

### 4.2 Index Strategy
- **Partial unique indexes** everywhere a field is sparse (`providerId`, `certificateNumber`, `uniquePayLinkToken`, `gatewayReference`).
- **Compound indexes** match the exact query shapes used by list endpoints (e.g., `schoolId+status+studentClass` for the roster).
- **Boot reconciliation** (`reconcileDeclaredIndexSpecs`, `reconcileNullableUniqueIndexes`, `reconcileProviderIdIndex`) ensures live indexes match declared specs; Mongoose never rewrites an index whose options have drifted.

### 4.3 Model Hooks & Methods
- **`pre('save')`**: Derives `firstName`/`lastName` from `studentName`; mints `studentId` + pay-link token; enforces single `isPrimary` parent; recomputes `balance = totalOwed - totalPaid`.
- **`toJSON` transform**: Strips `__v`, `password`, `uniquePayLinkToken`, reset/verification tokens, refresh tokens.
- **Instance methods**: `comparePassword`, `isPasswordResetTokenValid`, `isEmailVerificationTokenValid`.

---

## 5. Service Layer Patterns

### 5.1 Service Contract
Every service function:
```js
export const doSomething = async (input, user) => {
  // 1. Validate input (Joi schema already run by controller)
  // 2. Scope to school: { schoolId: user.schoolId, ... }
  // 3. Business logic
  // 4. Throw ApiError(code, status, meta) on failure
  // 5. Return plain object (no Mongoose docs)
};
```
- **Never** calls `res.*` or touches HTTP.
- **Always** receives the authenticated `user` object for scoping.
- Uses **`lean()`** for reads; returns POJOs.
- Emits events via `communityEventEmitter` for real-time updates (club membership, posts, reactions).

### 5.2 Key Services by Domain
| Domain | Service | Responsibilities |
|--------|---------|------------------|
| **Auth** | `auth.service.js` | Login, signup, OTP, password reset, token rotation, Google OAuth |
| **School** | `school.service.js` | Provisioning, settings, gateway config, logo |
| **Students** | `student.service.js` | Roster CRUD, parents, status transitions, promotion, graduation, pay-link minting |
| **Payments** | `payment.service.js` | Moolre checkout, webhook settlement, manual cash, refunds, receipts |
| **Payment Plans** | `paymentPlan.service.js` | Installment schedules, reminders, auto-application |
| **Community** | `club.service.js`, `communityPost.service.js`, `communityComment.service.js`, `communityReaction.service.js`, `communityEvent.service.js`, `communityUpload.service.js` | Clubs, feed, chat, events, media |
| **LMS** | `lms.service.js` | Courses, lessons, assessments, submissions |
| **ID Cards** | `idCard.service.js`, `idCardTemplate.service.js` | Template designer, bulk PDF generation |
| **SMS/WhatsApp** | `sms.service.js`, `whatsapp.service.js` | Multi-provider send, delivery receipts, credit purchase |
| **Notifications** | `notification.service.js` | In-app + push + email unified |
| **Admin** | `admin.service.js` | Platform owner: schools, users, finances, analytics |

### 5.3 Cross-Cutting Utilities
- **`utils/tokens.js`**: JWT sign/verify (access + refresh), token version check.
- **`utils/crypto.js`**: HMAC verification for Moolre/MTN/Arkesel/Meta webhooks.
- **`utils/generateStudentId.js`**: School-code + year + sequence, collision retry.
- **`utils/generatePayLink.js`**: Cryptographically random token + signed URL.
- **`utils/errorBuffer.js`**: In-memory ring buffer (last 200 errors) for `/admin/health/errors`.
- **`utils/communityAuthor.js`**: Resolves author display name from dual `User`/`Student` namespaces.

---

## 6. Controller Layer

### 6.1 Standard Shape
```js
export const doSomethingController = async (req, res) => {
  try {
    const result = await doSomething(req.body, req.user);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,          // Always forwarded
      ...(error.meta ? { meta: error.meta } : {})
    });
  }
};
```
- **No business logic** — only HTTP mapping, validation delegation, response formatting.
- **Always forwards `error.code`** so the frontend can branch (e.g., `CLUB_PASSWORD_REQUIRED` → show password dialog).

### 6.2 Validation
- Joi schemas in `validations/*.js` (body, query, params).
- Mounted via `validate(schema, 'body'|'query'|'params')` middleware.
- `stripUnknown: true` — extra fields dropped before controller runs.

---

## 7. Background Jobs (`jobs/`)

| Job | Schedule | Purpose |
|-----|----------|---------|
| `cron.js` (health) | Every 14 min | Probes MongoDB, payment gateways, SMS; feeds health endpoint |
| `installmentReminder.job.js` | Daily 08:00 Accra | Sweeps due installments, sends SMS/email/WhatsApp reminders |
| `healthCheckJob.js` | Every 5 min | Lightweight dependency probes |
| `teacherAttendanceJob.js` | Every 5 min | Marks missed teacher periods as absent |

Jobs use the same service layer as controllers — no duplicate logic.

---

## 8. Boot-Time Reconciliations (`boot/`)

Run sequentially after MongoDB connects, **before** the app is considered healthy:

| Script | Purpose |
|--------|---------|
| `ensureSuperAdmin.js` | Upserts the single platform owner from `SUPER_ADMIN_EMAIL/PASSWORD/NAME` |
| `migrateGateways.js` | Moves legacy gateway modes (hubtel, paystack, arke, mnotify) → `moolre` |
| `reconcileProviderIdIndex.js` | Replaces legacy unique `providerId` index with partial unique |
| `reconcileNullableUniqueIndexes.js` | Fixes unique indexes that admitted explicit `null` (payment receipts, invites) |
| `reconcileDeclaredIndexSpecs.js` | Rewrites indexes whose `sparse`/`partialFilterExpression` options have drifted |

All are **idempotent** — safe on every deploy.

---

## 9. Real-Time: Community Socket Gateway (`sockets/communityGateway.js`)

- Attached to the **same HTTP server** as Express (`const io = new Server(server)`).
- Single namespace `/community`.
- Auth: token in handshake `auth.token` → `authenticateUser()` → attaches `socket.user`.
- Rooms: `school:{schoolId}`, `club:{clubId}`.
- Events emitted by services via `communityEventEmitter` → gateway broadcasts to rooms.
- Client connects via `utils/socket.js` (auto-reconnect, token refresh).

---

## 10. Error Handling & Observability

### 10.1 `ApiError` Class (`utils/ApiError.js`)
```js
class ApiError extends Error {
  constructor(message, status = 500, code = 'INTERNAL_ERROR', meta = {})
}
```
- `status`: HTTP status
- `code`: Machine-readable identifier (e.g., `CLUB_NOT_CREATOR`, `SCHOOL_NOT_LINKED`)
- `meta`: Structured context for audit logs

### 10.2 Central `errorHandler` (`middleware/errorHandler.js`)
- 4xx → returns `error.message` (user-facing)
- 5xx → logs full stack, returns generic `"Something went wrong. Please try again."`
- Handles: Mongoose duplicate key (11000), validation, JWT errors, JSON parse, body too large
- **Never leaks stack traces or internal paths to clients**

### 10.3 Error Ring Buffer (`utils/errorBuffer.js`)
- In-memory circular buffer (200 entries)
- Fed by `recordRequestError` middleware (runs before `errorHandler`)
- Exposed via `GET /admin/health/errors` for ops dashboard

---

## 11. Security Considerations

| Area | Mechanism |
|------|-----------|
| **Auth** | Short-lived access tokens (4h), rotating refresh tokens (7d), token version revocation |
| **Webhooks** | Raw body capture + HMAC verification (Moolre, MTN, Arkesel, Meta) |
| **Tenancy** | Every write scoped to `schoolId`; `super_admin` explicit opt-in |
| **Passwords** | bcrypt 12 rounds, `select: false`, `passwordChangedAt` tracking |
| **Rate limits** | Per-admin invite limit (25/hr), email daily quota (1000), SMS/WhatsApp daily quotas |
| **CORS** | `origin: true, credentials: true` for Socket.io; Express CORS default |
| **Helmet** | Not used — API behind gateway; security headers at edge |

---

## 12. Deployment & Operations

### 12.1 Required Environment Variables
See `config/env.js` for the full annotated list. Critical ones:
- `MONGODB_URI`, `JWT_SECRET`, `PORT`
- `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`, `SUPER_ADMIN_NAME`
- `CLIENT_URL` (frontend origin for email links)
- `WEBHOOK_BASE_URL` (backend origin for provider callbacks)
- `MOOLRE_*` credentials, `MTN_*` credentials
- `BREVO_API_KEY`, `BREVO_EVENT_SECRET`
- `WHATSAPP_*` (optional, behind `WHATSAPP_ENABLED`)
- `CLOUDINARY_*` for file uploads

### 12.2 Health Endpoints
- `GET /health` / `GET /api/health` — dependency status (Mongo, Moolre, MTN, SMS), version, commit
- `GET /api/version` — API name, version, commit, build date
- `GET /admin/health/errors` — recent error ring buffer (auth required)

### 12.3 Graceful Shutdown
- `server.close()` on MongoDB connection failure (exits non-zero)
- 5s forced exit if close hangs

---

## 13. Testing Strategy

- **Location**: `tests/**/*.test.js`
- **Runner**: Node built-in test runner (`node --test`)
- **Database**: Real MongoDB (test DB) — no mocks for persistence layer
- **Coverage**: 1128 tests across 244 suites (as of last run)
- **Key patterns**:
  - Controllers tested via supertest against live Express app
  - Services tested directly with seeded data
  - Auth flows exercise full JWT cycle
  - Webhook signature verification tested with real HMAC

---

## 14. Extending the Platform

### Adding a New Portal
1. Create `routes/{portal}.routes.js` with its own router
2. Add gate middleware in `middleware/` (e.g., `requirePortalX`)
3. Mount in `routes/index.js` at appropriate position (respecting order)
4. Create `services/{portal}/` for business logic
5. Add models if new collections needed

### Adding a New Payment Gateway
1. Add credentials to `config/env.js`
2. Create `services/payments/{gateway}.service.js` implementing `createCheckout`, `verifyWebhook`, `refund`
3. Register in `payment.service.js` gateway router
4. Add per-school override on `School.payment.gateway`

### Adding a New Background Job
1. Create `jobs/{name}.job.js` exporting `{ start, stop }`
2. Use `node-cron` schedule
3. Call service functions directly (no HTTP)
4. Register in `index.js` with `.start()`

---

## 15. Architectural Decision Records (Implicit)

| Decision | Rationale |
|----------|-----------|
| **Single `super_admin`** | Platform owner is a person, not a role; boot provisioning avoids "who creates the first admin" chicken-egg |
| **Student in separate collection** | Parents, pay-links, status lifecycle differ from staff; `User` stays lean |
| **Dual `User`/`Student` author IDs** | Community feed resolves names via `communityAuthor.js`; no polymorphic ref |
| **Pay-link token on Student** | Parent portal authenticates by token in URL; no JWT for parents |
| **Moolre as primary gateway** | One vendor for payments + SMS; simpler reconciliation |
| **Partial unique indexes** | Avoids null-collision bugs (payment receipts, invites, Google `providerId`) |
| **Boot-time index reconciliation** | Mongoose never rewrites drifted indexes; live deployments would silently keep wrong specs |
| **Socket.io on same server** | No extra port, no proxy config; upgrade path only |
| **In-memory error buffer** | No external dependency; ops needs recent errors, not history |

---

*Generated from codebase inspection — reflects the actual implementation as of the current commit.*