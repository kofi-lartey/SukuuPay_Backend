# SukuuPay Backend

**Node.js / Express / MongoDB API** for the SukuuPay school management platform.

## System Architecture Overview

SukuuPay is a multi-tenant school management platform serving Ghanaian schools. The backend powers **four distinct portals** through a single Express application:

| Portal | Audience | Mount Path | Authentication |
|--------|----------|------------|----------------|
| **Admin Console** | School admins, accountants, teachers, platform owner (`super_admin`) | `/api/*` | JWT access + refresh tokens, role gates |
| **Parent Pay Portal** | Parents paying fees via tokenised public links | `/api/pay/:token/*` | Token in URL path (no JWT) |
| **Teacher Portal** | Teachers marking attendance, viewing timetables | `/api/teacher/*` | JWT + `requireTeacher` gate |
| **Student Community** | Students in clubs, chat, events | `/api/community/*` | JWT + `communityAuth` (excludes parents) |

A **Socket.io** namespace (`/community`) shares the HTTP server for real-time club chat.

### Core Design Principles
1. **Layer separation**: Route → Controller → Service → Model. Controllers handle only HTTP concerns; business logic lives in services.
2. **School-scoped tenancy**: Every write scoped to `req.user.schoolId` (or explicit `schoolId` for `super_admin`). No cross-school leakage.
3. **Explicit error codes**: Services throw `ApiError(message, status, code, meta)`. Controllers forward `code` so frontend branches on machine-readable identifiers (`CLUB_PASSWORD_REQUIRED`, `SCHOOL_NOT_LINKED`).
4. **Boot-time invariants**: Critical platform state (single `super_admin`, index specs, gateway migrations) reconciled on every startup before accepting traffic.
5. **Idempotent migrations**: All boot scripts and migration utilities safe to re-run; use `partialFilterExpression` and upserts to avoid duplicate-key crashes.

## Technology Stack
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
- **Realtime**: Socket.io attached to same HTTP server

## Directory Structure
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

## Request Lifecycle

### Global Middleware Stack (`index.js`)
```
express.json({ verify: captureRawBody })    # Raw body for webhook signatures
express.urlencoded({ verify: captureRawBody })
cors()
app.use('/', healthRoute)                    # /health, /version, /ping (no auth)
app.use('/', webhookRoute)                   # Moolre, MTN, Arkesel, Meta callbacks
app.use('/', whatsappRoute)
app.use('/api', routes)                      # All authenticated API routes
app.use(recordRequestError)                  # Feeds in-memory error ring buffer
app.use(errorHandler)                        # Central error formatting (strips 5xx messages)
```

### `/api` Router Stack (`routes/index.js`)
```
router.use('/', healthRoute)                 # /api/health mirrors root
router.use(maintenanceGuard)                 # Blocks writes when maintenance: "on"
router.use('/', authRoute)                   # /auth/* (login, signup, verify, reset)
router.use('/', userRoute)                   # /users/* (profile, invites, impersonation)
router.use('/', schoolRoute)                 # /schools/* (provisioning, settings)
router.use('/', studentRoute)                # /students/* (roster, parents, status)
router.use('/', paymentRoute)                # /pay/* (Moolre checkout, webhooks)
router.use('/', paymentPlanRoute)            # /payment-plans/* (installments)
router.use('/', emailMessagingRoute)         # /email/* (Brevo)
router.use('/', analyticsRoute)              # /analytics/* (dashboards)
router.use('/', reportsRoute)                # /reports/*
router.use('/audit-logs', auditLogRoute)     # /audit-logs/*
router.use('/id-cards', idCardRoute)         # /id-cards/*
router.use('/id-card-templates', idCardTemplateRoute)
router.use('/upload', uploadRoute)           # Cloudinary signed upload
router.use('/notifications', notificationRoute)
router.use('/', parentMessageRoute)          # Parent → school messages
router.use('/pay', parentRoute)              # Parent portal (token auth)
router.use('/pay', lmsStudentRoute)          # Student LMS under same token
router.use('/community', communityRoute)     # Student community (JWT + communityAuth)
router.use('/teacher', teacherRoute)         # Teacher portal (JWT + requireTeacher)
router.use('/teacher/lms', lmsRoute)         # Teacher LMS
router.use('/settings', settingsRoute)
router.use('/admin', adminAttendanceRoute)   # School admin academic (before platform admin)
router.use('/admin', adminRecordsRoute)
router.use('/admin', adminTimetableRoute)
router.use('/admin', adminAcademicRoute)     # Headmaster academic console
router.use('/', manualPaymentRoute)          # Cash recording
router.use('/admin', adminRoute)             # Platform console (super_admin gate)
router.use('/', publicAdRoute)               # Unauthenticated ad slider
router.use('/', publicSchoolRoute)           # Unauthenticated school logo carousel
router.use('/', schoolAdRoute)               # School ad requests (authenticated)
router.use('/', whatsappRoute)               # Meta callbacks (also at root)
router.use('/', smsRoute)                    # SMS sending (root + /api)
router.use('/', smsRequestRoute)             # SMS credit purchase
```
**Mount order is load-bearing** — see inline comments in `routes/index.js`.

## Data Model Architecture

### Core Collections
| Collection | Purpose | Key Indexes |
|------------|---------|-------------|
| `User` | Staff + platform accounts | `email` (unique), `schoolId`, `providerId` (partial unique), `authProvider` (partial) |
| `Student` | Pupil records | `schoolId+studentId` (unique), `schoolId+status+studentClass`, `parents.phone`, `uniquePayLinkToken` (partial unique) |
| `School` | Tenant root | `schoolCode` (unique), `ownerId` (ref User) |
| `Payment` | Fee transactions | `schoolId+studentId`, `paymentReference` (unique), `gatewayReference` (partial unique) |
| `PaymentPlan` | Installment schedules | `schoolId`, `studentId` |
| `Club` | Student communities | `schoolId+createdAt`, `schoolId+category+privacy` |
| `Post`, `Comment`, `Event` | Community feed | `schoolId`, `clubId` |
| `ImpersonationSession` | Platform owner audit trail | `superAdminId`, `schoolId`, `endedAt` |

### Index Strategy
- **Partial unique indexes** for sparse fields (`providerId`, `certificateNumber`, `uniquePayLinkToken`, `gatewayReference`)
- **Compound indexes** matching exact query shapes (e.g., `schoolId+status+studentClass` for roster)
- **Boot reconciliation** ensures live indexes match declared specs

## Service Layer
Every service function follows:
```js
export const doSomething = async (input, user) => {
  // 1. Scope to school: { schoolId: user.schoolId, ... }
  // 2. Business logic
  // 3. Throw ApiError(code, status, meta) on failure
  // 4. Return plain object (no Mongoose docs)
};
```
- Never calls `res.*` or touches HTTP
- Receives authenticated `user` for scoping
- Uses `lean()` for reads; returns POJOs
- Emits events via `communityEventEmitter` for real-time updates

### Key Services by Domain
| Domain | Service | Responsibilities |
|--------|---------|------------------|
| Auth | `auth.service.js` | Login, signup, OTP, password reset, token rotation, Google OAuth |
| School | `school.service.js` | Provisioning, settings, gateway config, logo |
| Students | `student.service.js` | Roster CRUD, parents, status transitions, promotion, graduation |
| Payments | `payment.service.js` | Moolre checkout, webhook settlement, manual cash, refunds, receipts |
| Community | `club.service.js`, `communityPost.service.js`, etc. | Clubs, feed, chat, events, media |
| LMS | `lms.service.js` | Courses, lessons, assessments, submissions |
| ID Cards | `idCard.service.js`, `idCardTemplate.service.js` | Template designer, bulk PDF generation |
| SMS/WhatsApp | `sms.service.js`, `whatsapp.service.js` | Multi-provider send, delivery receipts, credit purchase |

## Frontend Interaction

The frontend (React + Vite, in `../frontend`) communicates via:

### REST API
- **Base URL**: `VITE_API_BASE_URL` (default `https://sukuupay-backend.onrender.com/api`)
- **Auth**: Bearer token in `Authorization` header (stored in `localStorage`)
- **Token refresh**: Automatic via Axios interceptor (shared with teacher portal)
- **Error codes**: Frontend branches on `error.response.data.code` (e.g., `CLUB_PASSWORD_REQUIRED` → password dialog)

### Real-time (Socket.io)
- **Namespace**: `/community`
- **Auth**: Token in handshake `auth.token`
- **Rooms**: `school:{schoolId}`, `club:{clubId}`
- **Events**: `post:new`, `club:updated`, `chat:message`, `reaction:added`
- **Client**: `frontend/src/utils/socket.js` (auto-reconnect, token refresh)

### Portal Integration Points
| Frontend Portal | Backend Routes | Auth Style |
|-----------------|----------------|------------|
| Admin Console | `/api/*` | JWT + role gates |
| Parent Portal | `/api/pay/:token/*` | Token in URL |
| Teacher Portal | `/api/teacher/*` | JWT + `requireTeacher` |
| Student Community | `/api/community/*` | JWT + `communityAuth` |

## Getting Started

### Prerequisites
- Node.js 22+
- MongoDB (Atlas or local)
- Moolre account (payments + SMS)
- Brevo account (email)
- Cloudinary account (file uploads)

### Environment Variables
See `config/env.js` for full annotated list. Critical:
```bash
MONGODB_URI=
JWT_SECRET=
PORT=2345
SUPER_ADMIN_EMAIL=
SUPER_ADMIN_PASSWORD=
SUPER_ADMIN_NAME=
CLIENT_URL=https://sukuupay.netlify.app
WEBHOOK_BASE_URL=https://sukuupay-backend.onrender.com
MOOLRE_API_USER=
MOOLRE_API_KEY=
MOOLRE_PUBLIC_KEY=
MOOLRE_ACCOUNT_NUMBER=
BREVO_API_KEY=
BREVO_EVENT_SECRET=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

### Development
```bash
cd Backend
npm install
npm run dev          # nodemon with hot reload
```

### Production
```bash
npm start            # node src/index.js
```

## Testing
```bash
npm test             # node --test (1128 tests, 244 suites)
```
- Real MongoDB (test DB) — no mocks for persistence
- Controllers tested via supertest against live Express app
- Services tested directly with seeded data

## Boot-Time Reconciliations
Run sequentially after MongoDB connects:
1. `ensureSuperAdmin.js` — Upserts platform owner from env vars
2. `migrateGateways.js` — Legacy gateway modes → `moolre`
3. `reconcileProviderIdIndex.js` — Fixes `providerId` partial unique index
4. `reconcileNullableUniqueIndexes.js` — Fixes unique indexes admitting explicit `null`
5. `reconcileDeclaredIndexSpecs.js` — Rewrites drifted index options

All idempotent — safe on every deploy.

## Health & Observability
- `GET /health` / `GET /api/health` — Dependency status (Mongo, Moolre, MTN, SMS), version, commit
- `GET /api/version` — API name, version, commit, build date
- `GET /admin/health/errors` — Recent error ring buffer (200 entries, auth required)
- In-memory error buffer fed by `recordRequestError` middleware

## Security
| Area | Mechanism |
|------|-----------|
| Auth | Short-lived access tokens (4h), rotating refresh tokens (7d), token version revocation |
| Webhooks | Raw body capture + HMAC verification (Moolre, MTN, Arkesel, Meta) |
| Tenancy | Every write scoped to `schoolId`; `super_admin` explicit opt-in |
| Passwords | bcrypt 12 rounds, `select: false`, `passwordChangedAt` tracking |
| Rate limits | Per-admin invite limit (25/hr), email daily quota (1000), SMS/WhatsApp daily quotas |

## Documentation
- [Backend Architecture Details](docs/backend-architecture.md) — Comprehensive technical reference
- [Frontend Architecture](docs/frontend-architecture.md) — Client-side architecture
- API Specs: `EMAIL_API_SPEC.md`, `SMS_API_SPEC.md`, `STUDENT_MANAGEMENT_API_SPEC.md`

## License
Proprietary — SukuuPay Platform