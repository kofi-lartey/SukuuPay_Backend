# SukuuPay — SMS & Bulk Messaging API Specification

**Module:** SMS & Bulk Messaging
**Base URL:** `https://sukuupay-backend.onrender.com/api`
**Version:** `1.0`
**Last updated:** 2026-09-28

---

## 1. Overview

The SMS module lets a school communicate with parents over Ghana's mobile
networks (MTN, Vodafone, AirtelTigo) using a school's pooled prepaid credits.
It covers five concerns:

| Concern | Endpoints |
|:--|:--|
| Outbound delivery | `POST /sms/single/:studentId`, `POST /sms/bulk/:schoolId` |
| Bulk job control | `GET /sms/jobs/:jobId`, `POST /sms/jobs/:jobId/cancel` |
| Diagnostics | `POST /sms/test` |
| Delivery callbacks | `POST /sms/webhooks/provider` |
| Audit trail | `GET /sms/history` |
| Billing | `GET /sms/credits`, `POST /sms/credits/topup` |
| Content | `GET /sms/templates`, `GET /sms/templates/:templateId`, `POST /sms/templates`, `PUT /sms/templates/:templateId`, `DELETE /sms/templates/:templateId` |

### 1.1 Conventions

**Money** — all monetary amounts are integers in **pesewas** (1 Ghana cedi =
100 pesewas). `GHS 50.00` is sent as `5000`. SMS credits are a separate unit
and are always plain integers — they are *not* pesewas.

**Phone numbers** — Ghanaian mobile numbers only, on the wire in either
`0xx…` (e.g. `0241234567`) or `233xx…` (e.g. `233241234567`) form. Both are
accepted; a bare 9-digit local number (`241234567`) is also accepted and
treated as `0xx`. The response echoes whatever form the recipient's record
stores, which for parent records is always the `0xx` form. Provider calls are
made with the `233…` canonical form. Non-Ghana formats are rejected with
`422` at validation time, before any credit is touched.

**Response envelope** — every response, success or failure, uses one shape:

```json
{
  "success": true,
  "message": "Human-readable summary",
  "data": {},
  "meta": {}
}
```

`data` holds the resource. `meta` appears on list/paginated responses and on
asynchronous job responses. Failures never include `data`.

**Timestamps** — ISO 8601 in UTC (`2026-09-28T09:15:30.000Z`). Dates rendered
*inside* message text are formatted in `Africa/Accra` (UTC+0, no daylight
saving), matching how the rest of the platform renders Accra deadlines.

**Identifiers** — resources use 24-character hex MongoDB ObjectIds. The
human-facing student code (e.g. `AIS/26/0143`) appears as `studentId` in
message data and is distinct from the `_id` accepted in path parameters.

**Deletion** — templates are **soft-deleted**: `DELETE` sets `deletedAt` and
the record disappears from all list and read endpoints but remains in the
database. `GET /sms/history` is **append-only** — messages and bulk jobs are
never deleted, including those from a cancelled or failed job, because they
are the audit trail of what a parent was actually told.

### 1.2 Authentication and authorization

All endpoints except the delivery webhook require a bearer access token:

```http
Authorization: Bearer <access_token>
```

Tokens are issued by `POST /auth/login`. The role on the token determines
access.

| Endpoint | `super_admin` | `school_admin` | `accountant` | `teacher` | `viewer` |
|:--|:--:|:--:|:--:|:--:|:--:|
| `POST /sms/single/:studentId` | ✔ | ✔ | ✔ | ✘ | ✘ |
| `POST /sms/bulk/:schoolId` | ✔ | ✔ | ✔ | ✘ | ✘ |
| `GET /sms/jobs/:jobId` | ✔ | ✔ | ✔ | ✘ | ✘ |
| `POST /sms/jobs/:jobId/cancel` | ✔ | ✔ | ✔ | ✘ | ✘ |
| `POST /sms/test` | ✔ | ✔ | ✘ | ✘ | ✘ |
| `GET /sms/history` | ✔ | ✔ | ✔ | ✘ | ✘ |
| `GET /sms/credits` | ✔ | ✔ | ✘ | ✘ | ✘ |
| `POST /sms/credits/topup` | ✔ | ✔ | ✘ | ✘ | ✘ |
| `GET /sms/templates` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `GET /sms/templates/:templateId` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `POST /sms/templates` | ✔ | ✔ | ✘ | ✘ | ✘ |
| `PUT /sms/templates/:templateId` | ✔ | ✔ | ✘ | ✘ | ✘ |
| `DELETE /sms/templates/:templateId` | ✔ | ✔ | ✘ | ✘ | ✘ |
| `POST /sms/webhooks/provider` | — | — | — | — | — |

**School scoping.** A `school_admin`, `accountant`, `teacher` or `viewer` is
scoped to the `schoolId` on their own user record and can never read or write
outside it. Requesting a resource that belongs to another school returns
`404`, never `403` — the module does not confirm that the other school exists.

A `super_admin` may target any school. On the read endpoints
(`/sms/history`, `/sms/credits`) omitting `schoolId` returns a cross-school
view spanning every school the super admin can see; the response then groups
counts by school. On the write endpoints (`/sms/single`, `/sms/bulk`) an
explicit `schoolId` is **required** for a `super_admin`, so a send can never
be broadcast accidentally across schools.

### 1.3 Message lifecycle

Every outbound message is persisted as an `SmsMessage` *before* the provider
is called, so delivery is auditable even when the provider is unreachable.

| Status | Meaning |
|:--|:--|
| `queued` | Accepted and credits debited, awaiting the provider |
| `sent` | Handed to the provider successfully |
| `delivered` | Provider confirmed delivery to the handset |
| `failed` | Provider rejected the message (invalid number, blocked sender ID, insufficient sender credit) |
| `undelivered` | Provider accepted the message but never confirmed delivery within its reporting window |

`delivered`, `undelivered` and provider-side `failed` transitions arrive
asynchronously through the delivery callback (§7). A school whose provider
does not emit delivery reports will see messages remain at `sent`; that is
normal, not a fault, and is surfaced as `deliveryReporting: false` on the
school's `sms` configuration.

### 1.4 Credits and segments

One credit is charged per **SMS segment**:

- GSM-7 (Latin text): 160 characters per segment
- UCS-2 (Twi, emoji, most non-Latin text): 153 characters per segment

A 200-character English message therefore costs 2 credits. Every send
response and every history row reports the `segments` count so billing is
predictable before the fact.

**Debit and refund rules**

| Flow | Debited | Refunded |
|:--|:--|:--|
| `POST /sms/single/:studentId` | Immediately, on `queued` | In full if the provider rejects the message |
| `POST /sms/bulk/:schoolId` | The estimated total for the whole job, at `202` | Per message, for each message the provider fails |
| `POST /sms/test` | Never — free | n/a |

A request that would overdraw the balance fails with `400` and sends
nothing. Credits are never partially applied.

### 1.5 Category vocabulary

One canonical enum classifies every message and every template. It is
referenced by three different field names so each reads naturally at its call
site, but the values are identical and a template's `category` is always
directly comparable to a message's `type`:

| Value | Used for |
|:--|:--|
| `general` | Anything without a more specific fit |
| `balance` | Balance reminders, arrears notices, final notices |
| `payment` | Payment confirmations, receipts, payment links |
| `payment_plan` | Installment and plan-lifecycle messages |
| `academic` | Results, report cards, term dates |
| `attendance` | Absence and lateness alerts |
| `announcement` | Whole-school or class broadcasts |
| `emergency` | Urgent safety or closure notices |
| `result` | Individual pupil results |
| `receipt` | Receipt confirmations |

Field names per endpoint: `type` on send requests, `type` on the history
filter, `category` on templates and on template-filtered history. Values from
one are never accepted where the other is expected.

### 1.6 Error format

```json
{
  "success": false,
  "message": "Insufficient SMS credits (2 available, 5 required)"
}
```

| Status | When it is returned |
|:--:|:--|
| `400 Bad Request` | Business-rule failure (no credits, empty recipient set, unconfigured provider) |
| `401 Unauthorized` | Missing, malformed or expired access token; failed webhook signature |
| `403 Forbidden` | Authenticated but the role is not allowed, or no school in scope |
| `404 Not Found` | Resource does not exist, or is outside the caller's school scope |
| `409 Conflict` | The request collides with the resource's current state, or replays an idempotency key with a different payload |
| `422 Unprocessable Entity` | Request payload failed Joi validation |

`422` responses additionally carry an `errors` array with one entry per
failed rule:

```json
{
  "success": false,
  "message": "\"perPage\" must be less than or equal to 100",
  "errors": ["\"perPage\" must be less than or equal to 100"]
}
```

See Appendix D for the catalogue of recurring errors.

### 1.7 Rate limits and idempotency

| Scope | Limit |
|:--|:--|
| `POST /sms/single/:studentId` | 60 requests / minute / school |
| `POST /sms/bulk/:schoolId` | 5 requests / hour / school |
| `POST /sms/jobs/:jobId/cancel` | 5 requests / hour / school |
| `POST /sms/test` | 10 requests / hour / school |
| `POST /sms/credits/topup` | 3 requests / hour / school |
| All `GET` endpoints | 300 requests / minute / user |
| `POST /sms/webhooks/provider` | Not rate limited; must respond within 5 s |

Exceeding a limit returns `429 Too Many Requests` with a `Retry-After`
header.

**Idempotency.** `POST /sms/single/:studentId`, `POST /sms/bulk/:schoolId`
and `POST /sms/credits/topup` honour an `Idempotency-Key` header, retained for
24 hours:

| Replay | Response |
|:--|:--|
| First request | Normal response (`200` / `202` / `201`) |
| Same key, identical payload | The **original** response, replayed. No second message, no second charge. |
| Same key, different payload | `409 Conflict` |

```http
Idempotency-Key: 8f14e45f-ea4c-4f9b-9b2a-1c3d5e7f9a11
```

### 1.8 Quickstart

```bash
# 1. Check the credit balance before doing anything else
curl -X GET https://sukuupay-backend.onrender.com/api/sms/credits \
  -H "Authorization: Bearer $TOKEN"

# 2. Reuse an existing template — its `placeholders` tell you what to supply
curl -X GET "https://sukuupay-backend.onrender.com/api/sms/templates?category=balance" \
  -H "Authorization: Bearer $TOKEN"

# 3. Send one reminder to one parent
curl -X POST https://sukuupay-backend.onrender.com/api/sms/single/65f3b2c4d5e6f7g8h9i0j1k2 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 8f14e45f-ea4c-4f9b-9b2a-1c3d5e7f9a11" \
  -d '{
        "templateId": "65a1b2c3d4e5f6a7b8c9d0e1",
        "variables": {
          "studentName": "Ama Serwaa Mensah",
          "balance": 55000,
          "deadline": "2026-10-15T23:59:00.000Z"
        },
        "type": "balance"
      }'

# 4. Broadcast to one class, then watch it
curl -X POST https://sukuupay-backend.onrender.com/api/sms/bulk/65f2a1b3c4d5e6f7g8h9i0j1 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "templateId": "65a1b2c3d4e5f6a7b8c9d0e3",
        "recipients": { "target": "all" },
        "class": "Basic 7",
        "confirmBroadscope": true
      }'
# → 202 with data.jobId
curl -X GET https://sukuupay-backend.onrender.com/api/sms/jobs/65f9b2c3d4e5f6a7b8c9d0e1 \
  -H "Authorization: Bearer $TOKEN"
```

---

## 2. `POST /sms/single/:studentId`

Send a single message to one parent of one student.

**Authentication:** `super_admin`, `school_admin`, `accountant`
**Path parameters:** `studentId`
**Content-Type:** `application/json`

### 2.1 Description

Sends one message to one explicitly chosen recipient — the tool for targeted
communication such as a balance reminder, a plan notice or a result alert.
Selecting the recipient explicitly, rather than broadcasting to every parent on
record, is what keeps a bursar from notifying the wrong household.

`recipient: "primary"` (the default) targets the parent flagged
`isPrimary: true`; if no primary is flagged, the first parent on record is
used. `recipient: "all"` messages every parent on the student. An explicit
`parentId` overrides both.

The body is either written inline (`message`) or resolved from a stored
template (`templateId` with `variables`). Prefer templates for repeatable
school communications: they can be corrected centrally, and a correction does
not retroactively change messages already sent, because history stores the
rendered text rather than a template reference.

`scheduleAt` defers the send; the message is created `queued` and released to
the provider at that time, so it behaves identically to an immediate send
from the school's point of view.

### 2.2 Path parameters

| Parameter | Type | Required | Description |
|:--|:--:|:--:|:--|
| `studentId` | string (24-hex ObjectId) | ✔ | The student whose parent is to be messaged. Must belong to the caller's school and must not be soft-deleted. |

### 2.3 Request body

| Field | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `message` | string | conditional | — | Literal text, 1–1000 characters. Required unless `templateId` is supplied. |
| `templateId` | string (24-hex ObjectId) | conditional | — | Template to render. Required unless `message` is supplied. Must be active. |
| `variables` | object | optional | `{}` | Values for the template's placeholders, e.g. `{ "balance": 55000 }`. Money values in pesewas. |
| `recipient` | string | optional | `"primary"` | `primary`, `all`, or a specific parent `parentId` ObjectId. |
| `type` | string | optional | `general` | One of the values in §1.5. |
| `schoolId` | string | required for `super_admin` | caller's school | Target school. Ignored for other roles. |
| `scheduleAt` | string (ISO 8601) | optional | send now | Defer delivery. Must be in the future and within 30 days. |

`message` and `templateId` are mutually exclusive; supplying both returns
`422`. A template whose placeholders are not all supplied returns `400`.

### 2.4 Example request

```http
POST /api/sms/single/65f3b2c4d5e6f7g8h9i0j1k2 HTTP/1.1
Host: sukuupay-backend.onrender.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json
Idempotency-Key: 8f14e45f-ea4c-4f9b-9b2a-1c3d5e7f9a11
```

```json
{
  "templateId": "65a1b2c3d4e5f6a7b8c9d0e1",
  "variables": {
    "studentName": "Ama Serwaa Mensah",
    "balance": 55000,
    "deadline": "2026-10-15T23:59:00.000Z"
  },
  "recipient": "primary",
  "type": "balance"
}
```

### 2.5 Example response — `200 OK`

```json
{
  "success": true,
  "message": "Message queued for delivery",
  "data": {
    "id": "65f9a1b2c3d4e5f6a7b8c9d0",
    "studentId": "65f3b2c4d5e6f7g8h9i0j1k2",
    "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
    "parentName": "Kwabena Mensah",
    "phone": "0241234567",
    "message": "Dear Kwabena Mensah, Ama Serwaa Mensah (Basic 7) has an outstanding balance of GHS 550.00 payable by 15 Oct 2026. Pay via SukuuPay: https://pay.sukuupay.com/abc123",
    "type": "balance",
    "templateId": "65a1b2c3d4e5f6a7b8c9d0e1",
    "provider": "moolre",
    "status": "queued",
    "segments": 2,
    "creditsCharged": 2,
    "creditsRemaining": 1740,
    "providerReference": "HTL-88421903",
    "scheduledAt": null,
    "createdAt": "2026-09-28T09:15:30.000Z",
    "sentAt": null,
    "deliveredAt": null,
    "failureReason": null
  }
}
```

### 2.6 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | Message queued successfully |
| `400 Bad Request` | Insufficient credits for the segment count; `scheduleAt` already passed or more than 30 days out; student has no parents on record; a template placeholder was not supplied |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Role not permitted, or no school in scope |
| `404 Not Found` | Student does not exist, is soft-deleted, or belongs to another school; `parentId` is not on that student; template not found or inactive |
| `409 Conflict` | Idempotency key replayed with a different payload |
| `422 Unprocessable Entity` | Body failed validation |
| `429 Too Many Requests` | Per-school send rate exceeded |

### 2.7 Error examples

`400 Bad Request` — not enough credits:

```json
{
  "success": false,
  "message": "Insufficient SMS credits (2 available, 3 required). Top up via POST /sms/credits/topup."
}
```

`400 Bad Request` — school has no provider configured:

```json
{
  "success": false,
  "message": "This school has no SMS provider configured. Set school.sms.apiKey before sending."
}
```

`400 Bad Request` — template rendered with missing data:

```json
{
  "success": false,
  "message": "Template requires 5 placeholders but 3 were supplied: missing balance, deadline, payLink"
}
```

---

## 3. `POST /sms/bulk/:schoolId`

Send one message to a filtered set of parents across the school.

**Authentication:** `super_admin`, `school_admin`, `accountant`
**Path parameters:** `schoolId`
**Content-Type:** `application/json`

### 3.1 Description

Accepts a large broadcast and returns immediately with a job identifier.
Rendering and delivery then run in the background, so a broadcast to 2,000
parents never holds an HTTP connection open. Poll `GET /sms/jobs/:jobId` (§4)
for progress, or cancel it with `POST /sms/jobs/:jobId/cancel` (§5).

The recipient set is `recipients.target` narrowed by any combination of
filters. Filters combine with AND; the values within a single filter combine
with OR.

**Recipients are parents, not students.** Each parent is messaged at most once
per job even when several of their children match — the message renders with
the first matching child. Parents with no usable number, and guardians of
children who have left the school, are skipped and reported in the job result
as `recipientsSkipped`.

**Safeguards.** The service refuses a broadcast resolving to more than 5,000
unique parents, and refuses a full-school broadcast not marked with
`confirmBroadscope: true`. Both return `400` before any credit is debited.

**Partial failure is normal.** A job succeeds even if many of its messages
fail; per-message outcomes are in the job's `result` breakdown and in
`GET /sms/history?jobId=…`.

### 3.2 Path parameters

| Parameter | Type | Required | Description |
|:--|:--:|:--:|:--|
| `schoolId` | string (24-hex ObjectId) | ✔ | The school to broadcast to. For a non-`super_admin` this must match their own school. |

### 3.3 Request body

| Field | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `message` | string | conditional | — | Literal text, 1–1000 characters. Required unless `templateId` is supplied. |
| `templateId` | string (24-hex ObjectId) | conditional | — | Template rendered for every recipient. Per-recipient placeholders are injected automatically. |
| `variables` | object | optional | `{}` | Static placeholder values applied to all recipients, e.g. a shared `deadline`. |
| `recipients` | object | ✔ | — | Recipient selector — see below. |
| `type` | string | optional | `announcement` | One of the values in §1.5. |
| `class` | string | optional | — | Only students in this class. Must be one of the school's `academic.classes` entries. |
| `balanceRanges` | string[] | optional | — | Balance bands in **GHS**: `no_balance`, `overdue`, `1_100`, `101_500`, `501_1000`, `above_1000`. |
| `hasActivePlan` | boolean | optional | — | `true` keeps only parents of students with an `active` payment plan; `false` keeps only those without one. Omit for no filtering. |
| `status` | string[] | optional | `["active"]` | Student statuses to include: `active`, `suspended`, `removed`, `graduated`, `transferred_out`. |
| `confirmation` | string | optional | `"none"` | Consent handling: `none`, `opt_in` (only parents who opted in), `opt_out` (everyone except those who opted out). |
| `scheduleAt` | string (ISO 8601) | optional | send now | Defer the whole job; within 30 days. |
| `confirmBroadscope` | boolean | required | `false` | Must be `true` when `recipients.target` is `all`. |

#### `recipients` object

| Field | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `target` | string | ✔ | — | `all` (every parent on roll), `class`, `balance`, `payment_plan`, `individual`. See below. |
| `ids` | string[] | conditional | — | Student `_id` values. Required when `target` is `individual`; ignored otherwise. Max 1,000. |

**`target` values**

| Value | Resolves to |
|:--|:--|
| `all` | Every parent of every non-deleted student. Requires `confirmBroadscope: true`. |
| `class` | Parents of students in the `class` filter. Requires `class`. |
| `balance` | Parents of students matching any band in `balanceRanges`. Requires `balanceRanges`. |
| `payment_plan` | Parents of students with a payment plan. Combine with `hasActivePlan` to separate live from lapsed plans. |
| `individual` | Parents of the students named in `ids`. |

### 3.4 Example request

```http
POST /api/sms/bulk/65f2a1b3c4d5e6f7g8h9i0j1 HTTP/1.1
Host: sukuupay-backend.onrender.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json
Idempotency-Key: 3c9a7f21-55be-4d0e-9c11-7b2e4a6d8f30
```

```json
{
  "templateId": "65a1b2c3d4e5f6a7b8c9d0e3",
  "variables": {
    "schoolName": "Accra International School",
    "deadline": "2026-10-31T23:59:00.000Z"
  },
  "recipients": {
    "target": "all"
  },
  "class": "Basic 7",
  "balanceRanges": ["overdue", "1_100"],
  "type": "announcement",
  "confirmBroadscope": true
}
```

### 3.5 Example response — `202 Accepted`

```json
{
  "success": true,
  "message": "Bulk SMS accepted and queued for delivery",
  "data": {
    "jobId": "65f9b2c3d4e5f6a7b8c9d0e1",
    "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
    "templateId": "65a1b2c3d4e5f6a7b8c9d0e3",
    "type": "announcement",
    "status": "processing",
    "filters": {
      "target": "all",
      "class": "Basic 7",
      "balanceRanges": ["overdue", "1_100"]
    },
    "recipientsResolved": 143,
    "recipientsSkipped": 7,
    "estimatedCredits": 258,
    "creditsDebited": 258,
    "creditsRemaining": 1742,
    "scheduledAt": null,
    "createdAt": "2026-09-28T09:22:05.000Z",
    "startedAt": "2026-09-28T09:22:06.000Z",
    "completedAt": null
  }
}
```

### 3.6 Status codes

| Code | Condition |
|:--|:--|
| `202 Accepted` | Broadcast queued; `data.jobId` returned |
| `400 Bad Request` | Recipient set resolves to zero parents; exceeds 5,000 parents; `target: "all"` without `confirmBroadscope: true`; `target: "class"` without `class`; insufficient credits for the estimated total; `scheduleAt` in the past; no provider configured |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Role not permitted, or no school in scope |
| `404 Not Found` | School does not exist or is outside the caller's scope; template not found or inactive |
| `409 Conflict` | Idempotency key replayed with a different payload |
| `422 Unprocessable Entity` | Body failed validation |
| `429 Too Many Requests` | More than 5 bulk jobs per school per hour |

### 3.7 Error example — `400 Bad Request`

```json
{
  "success": false,
  "message": "Broadcast resolves to 0 parents. Relax the filters and try again."
}
```

---

## 4. `GET /sms/jobs/:jobId`

Retrieve the status and result of a bulk SMS job.

**Authentication:** `super_admin`, `school_admin`, `accountant`
**Path parameters:** `jobId`

### 4.1 Description

Reports how far a job has got, how many messages it produced, and how they
fared. The `result` block is the authoritative per-status tally for the job;
individual messages are listed by `GET /sms/history?jobId=…`.

A job in `queued` with a future `scheduledAt` has not started; a job in
`processing` is actively sending; `completed` means the run finished
regardless of how many messages failed, so always read `result.failed` rather
than inferring success from the status.

A cancelled job is terminal, as is a completed or failed one. Neither can be
re-run; submit a new `POST /sms/bulk/:schoolId` instead.

### 4.2 Path parameters

| Parameter | Type | Required | Description |
|:--|:--:|:--:|:--|
| `jobId` | string (24-hex ObjectId) | ✔ | The bulk job. Must belong to the caller's school. |

### 4.3 Example request

```http
GET /api/sms/jobs/65f9b2c3d4e5f6a7b8c9d0e1 HTTP/1.1
Host: sukuupay-backend.onrender.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 4.4 Example response — `200 OK`

```json
{
  "success": true,
  "message": "Bulk SMS job retrieved successfully",
  "data": {
    "jobId": "65f9b2c3d4e5f6a7b8c9d0e1",
    "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
    "templateId": "65a1b2c3d4e5f6a7b8c9d0e3",
    "type": "announcement",
    "status": "completed",
    "filters": {
      "target": "all",
      "class": "Basic 7",
      "balanceRanges": ["overdue", "1_100"]
    },
    "recipientsResolved": 143,
    "recipientsSkipped": 7,
    "skippedReasons": {
      "noValidPhone": 5,
      "optedOut": 2
    },
    "estimatedCredits": 258,
    "creditsDebited": 258,
    "creditsRefunded": 34,
    "progressPercent": 100,
    "result": {
      "total": 143,
      "queued": 0,
      "sent": 104,
      "delivered": 87,
      "failed": 6,
      "undelivered": 2
    },
    "provider": "moolre",
    "failureReason": null,
    "scheduledAt": null,
    "createdBy": "65a0f1e2d3c4b5a697887766",
    "createdAt": "2026-09-28T09:22:05.000Z",
    "startedAt": "2026-09-28T09:22:06.000Z",
    "completedAt": "2026-09-28T09:27:41.000Z"
  }
}
```

### 4.5 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | Job returned |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Role not permitted, or no school in scope |
| `404 Not Found` | Job does not exist or belongs to another school |

---

## 5. `POST /sms/jobs/:jobId/cancel`

Stop a bulk SMS job that has not finished.

**Authentication:** `super_admin`, `school_admin`, `accountant`
**Path parameters:** `jobId`
**Content-Type:** `application/json`

### 5.1 Description

Requests cancellation of a `queued` or `processing` job. Messages already
handed to the provider cannot be recalled — cancel stops the remainder of the
run, and the job's `result` reflects the split between what went out and what
did not.

Cancellation is **cooperative and asynchronous**: the worker checks for the
flag between batches, so a job may finish a few messages after `200` is
returned. Poll the job (§4) to confirm `status` has reached `cancelled`.

Cancelling a job that has already reached a terminal state returns `409`.
The endpoint is idempotent in the sense that it never partially executes — but
it does not treat a repeat cancel as success, so clients should read the job
status rather than retry blindly.

Credits for messages that were never sent are refunded; credits for messages
already delivered are not.

### 5.2 Path parameters

| Parameter | Type | Required | Description |
|:--|:--:|:--:|:--|
| `jobId` | string (24-hex ObjectId) | ✔ | The bulk job to cancel. Must belong to the caller's school. |

### 5.3 Request body

| Field | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `reason` | string | optional | `""` | Internal note recorded on the job, up to 300 characters. |

### 5.4 Example request

```http
POST /api/sms/jobs/65f9b2c3d4e5f6a7b8c9d0e1/cancel HTTP/1.1
Host: sukuupay-backend.onrender.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json
```

```json
{
  "reason": "Wrong class selected — resending to Basic 8 instead."
}
```

### 5.5 Example response — `200 OK`

```json
{
  "success": true,
  "message": "Cancellation requested. Messages already sent cannot be recalled.",
  "data": {
    "jobId": "65f9b2c3d4e5f6a7b8c9d0e1",
    "status": "cancelling",
    "cancellationReason": "Wrong class selected — resending to Basic 8 instead.",
    "cancelledAt": "2026-09-28T09:24:10.000Z",
    "result": {
      "total": 143,
      "queued": 0,
      "sent": 38,
      "delivered": 30,
      "failed": 1,
      "undelivered": 0
    }
  }
}
```

### 5.6 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | Cancellation recorded; job moves to `cancelled` |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Role not permitted, or no school in scope |
| `404 Not Found` | Job does not exist or belongs to another school |
| `409 Conflict` | Job already `completed`, `failed` or `cancelled` |

---

## 6. `POST /sms/test`

Send a test message to verify the school's provider configuration.

**Authentication:** `super_admin`, `school_admin`
**Content-Type:** `application/json`

### 6.1 Description

Sends one message to a number the administrator supplies, typically their own
handset. It proves the three things that usually break: the API key, the
registered sender ID, and the route/network combination.

A test message **never consumes credits**, is flagged `isTest: true` in the
history log, and is rate-limited to 10 per school per hour. The response
returns the provider reference and the sender ID actually used, which is the
fastest way to diagnose a rejected sender ID.

Test messages are excluded from credit projections and from the default
history view unless explicitly requested via `isTest`.

### 6.2 Request body

| Field | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `phone` | string | ✔ | — | Ghanaian mobile number, `0xx…` or `233xx…`. |
| `message` | string | optional | auto-generated | 1–1000 characters. When omitted, a fixed body naming the school is used. |
| `schoolId` | string | required for `super_admin` | caller's school | Target school. Ignored for other roles. |

### 6.3 Example request

```http
POST /api/sms/test HTTP/1.1
Host: sukuupay-backend.onrender.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json
```

```json
{
  "phone": "0241234567",
  "message": "SukuuPay SMS test from Accra International School. If you received this, your gateway is configured correctly."
}
```

### 6.4 Example response — `200 OK`

```json
{
  "success": true,
  "message": "Test message sent",
  "data": {
    "id": "65f9c3d4e5f6a7b8c9d0e1f2",
    "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
    "phone": "0241234567",
    "message": "SukuuPay SMS test from Accra International School. If you received this, your gateway is configured correctly.",
    "provider": "moolre",
    "senderId": "AccraIntlSch",
    "status": "sent",
    "segments": 1,
    "creditsCharged": 0,
    "isTest": true,
    "providerReference": "HTL-88422117",
    "createdAt": "2026-09-28T09:31:40.000Z",
    "sentAt": "2026-09-28T09:31:41.000Z",
    "deliveredAt": null,
    "failureReason": null
  }
}
```

### 6.5 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | Test message accepted by the provider |
| `400 Bad Request` | Provider rejected the message — invalid number, blocked sender ID, or unconfigured `sms.apiKey` |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Role not permitted, or no school in scope |
| `422 Unprocessable Entity` | Body failed validation |
| `429 Too Many Requests` | More than 10 tests per school per hour |

### 6.6 Error example — `400 Bad Request`

```json
{
  "success": false,
  "message": "Sender ID \"SCHOOL-1\" is not registered with the provider. Update school.sms.senderId or switch provider."
}
```

---

## 7. `POST /sms/webhooks/provider`

Delivery-status callbacks from the SMS provider. **No authentication header.**

**Authentication:** none — authenticated by request signature instead
**Content-Type:** `application/json`

### 7.1 Description

This is the only way a message reaches `delivered` or `undelivered`. SukuuPay
registers one callback URL per provider on the school's `sms` configuration;
the provider posts a status event for each message it has an opinion about.

Providers deliver this callback from their own infrastructure, so it cannot
carry a SukuuPay bearer token. It is authenticated instead by an HMAC
signature over the raw request body, verified with the school's provider API
secret:

```
X-Sms-Signature: t=1780048800,v1=6f8a1c...
```

`t` is the Unix timestamp the provider sent the body at; `v1` is the
lowercase hex HMAC-SHA256 of `"<t>.<raw body>"` keyed with the provider API
secret. Requests older than **5 minutes** are rejected, which bounds replay.
Compute the signature over the **unparsed** body — re-serializing the JSON can
change key order and break the hash.

**Always answer `200`.** Once the signature verifies, respond `200` with
`{"received": true}` even when the referenced message is unknown. The
provider retries non-2xx responses, and retrying an event for a message that
does not exist wastes the provider's retry budget for no benefit. Unknown
references are logged, not rejected.

The callback must respond within 5 seconds. Process the event asynchronously.

### 7.2 Request body

| Field | Type | Required | Description |
|:--|:--:|:--:|:--|
| `reference` | string | ✔ | The provider reference SukuuPay supplied when sending — `SmsMessage.providerReference`. |
| `status` | string | ✔ | `Delivered`, `Undelivered`, `Failed`, or `Sent`. |
| `errorCode` | string | optional | Provider error code, present on `Failed`. |
| `errorMessage` | string | optional | Provider error text, present on `Failed`. |
| `network` | string | optional | `MTN`, `VODAFONE`, `AIRTELTELIGO`, or `UNKNOWN`. |
| `timestamp` | string (ISO 8601) | optional | When the provider observed the event. Defaults to receipt time. |

### 7.3 Example request

```http
POST /api/sms/webhooks/provider HTTP/1.1
Host: sukuupay-backend.onrender.com
X-Sms-Signature: t=1780048800,v1=6f8a1c9d2b4e7f0a3c5d8e1b4a7f0c3d6e9b2a5f8c1d4e7b0a3f6c9d2e5b8a1f
Content-Type: application/json
```

```json
{
  "reference": "HTL-88421903",
  "status": "Delivered",
  "network": "MTN",
  "timestamp": "2026-09-28T09:16:12.000Z"
}
```

### 7.4 Example responses

`200 OK` — accepted, including for an unknown reference:

```json
{
  "received": true
}
```

`401 Unauthorized` — signature missing, malformed, or stale:

```json
{
  "success": false,
  "message": "Invalid webhook signature"
}
```

### 7.5 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | Event accepted (always, once the signature verifies) |
| `400 Bad Request` | Body is not valid JSON, or `reference`/`status` are missing or unrecognised |
| `401 Unauthorized` | Missing, mismatched, or more than 5 minutes stale signature |

---

## 8. `GET /sms/history`

Retrieve the SMS log for a school.

**Authentication:** `super_admin`, `school_admin`, `accountant`
**Query parameters:** supported

### 8.1 Description

Returns the school's message log, newest first: every single send, every bulk
delivery, and — when explicitly requested — every test message. This is both
the delivery audit trail and the evidence of what a parent was told, which is
why it is append-only.

`meta` carries the pagination cursor: `page` and `perPage` echo the request,
`total` is the number of matching messages and `totalPages` is derived from
them. `perPage` caps at 100; page further for more.

Because history stores the **rendered** message body, a later correction to a
template never rewrites what a parent received.

### 8.2 Query parameters

| Parameter | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `schoolId` | string | optional | caller's school | `super_admin` only. Omitting it returns a cross-school view. |
| `studentId` | string | optional | — | Filter to one student (24-hex `_id`). |
| `parentId` | string | optional | — | Filter to one parent. |
| `phone` | string | optional | — | Filter to a recipient number. |
| `status` | string | optional | — | `queued`, `sent`, `delivered`, `failed`, `undelivered`, or `all`. |
| `type` | string | optional | — | One of the values in §1.5, or `all`. |
| `templateId` | string | optional | — | Filter to a template. |
| `jobId` | string | optional | — | Filter to one bulk job. Use with `perPage: 100` to audit a broadcast. |
| `search` | string | optional | — | Case-insensitive match on the rendered body. Max 100 characters. |
| `from` | string (ISO 8601) | optional | — | Only messages created at or after this instant. |
| `to` | string (ISO 8601) | optional | — | Only messages created at or before this instant. |
| `isTest` | boolean | optional | `false` | `true` returns only test messages; `false` excludes them. |
| `page` | integer | optional | `1` | 1-based page number. |
| `perPage` | integer | optional | `20` | 1–100. |
| `sortBy` | string | optional | `createdAt` | `createdAt`, `sentAt`, `deliveredAt`, `status`. |
| `sortOrder` | string | optional | `desc` | `asc` or `desc`. |

### 8.3 Example request

```http
GET /api/sms/history?status=failed&from=2026-09-01T00:00:00.000Z&perPage=5 HTTP/1.1
Host: sukuupay-backend.onrender.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 8.4 Example response — `200 OK`

```json
{
  "success": true,
  "message": "SMS history retrieved successfully",
  "data": [
    {
      "id": "65f9d4e5f6a7b8c9d0e1f2a3",
      "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
      "studentId": "65f3b2c4d5e6f7g8h9i0j1k2",
      "parentName": "Ama Darko",
      "phone": "0209876543",
      "message": "Dear Ama Darko, Esther Darko (Basic 3) has an outstanding balance of GHS 320.00 payable by 15 Oct 2026.",
      "type": "balance",
      "templateId": "65a1b2c3d4e5f6a7b8c9d0e1",
      "jobId": null,
      "provider": "moolre",
      "providerReference": "MOL-88423011",
      "network": "MTN",
      "status": "failed",
      "segments": 2,
      "creditsCharged": 2,
      "creditsRefunded": 2,
      "isTest": false,
      "failureReason": "Unregistered number on MTN",
      "createdAt": "2026-09-27T14:02:11.000Z",
      "sentAt": "2026-09-27T14:02:12.000Z",
      "deliveredAt": null
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 5,
    "total": 23,
    "totalPages": 5
  }
}
```

### 8.5 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | History returned; an empty `data` array is a valid `200` |
| `400 Bad Request` | `from` is later than `to` |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Role not permitted, or no school in scope |
| `422 Unprocessable Entity` | A query parameter failed validation |

### 8.6 Error example — `422 Unprocessable Entity`

```json
{
  "success": false,
  "message": "\"perPage\" must be less than or equal to 100",
  "errors": ["\"perPage\" must be less than or equal to 100"]
}
```

---

## 9. `GET /sms/credits`

Check the school's current SMS credit balance.

**Authentication:** `super_admin`, `school_admin`
**Query parameters:** supported

### 9.1 Description

Returns the prepaid credit balance held against the school, what it consumed
in the current billing month, and — at the school's recent average daily
volume — roughly how long that lasts.

`balance` counts **segments**, not messages: a 200-character message costs 2.
`estimatedDaysRemaining` is `null` when the school has not sent enough
traffic in the last 30 days for the projection to mean anything; that is a
normal state for a small school, not an error.

`isLow` flips to `true` once the balance drops below the school's
`lowBalanceThreshold`, so a client can warn the administrator before the pool
runs dry mid-broadcast.

Test messages are excluded from every figure here.

### 9.2 Query parameters

| Parameter | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `schoolId` | string | optional | caller's school | `super_admin` only. Omitting it returns a per-school breakdown for all schools. |

### 9.3 Example request

```http
GET /api/sms/credits HTTP/1.1
Host: sukuupay-backend.onrender.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 9.4 Example response — `200 OK`

```json
{
  "success": true,
  "message": "SMS credit balance retrieved successfully",
  "data": {
    "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
    "provider": "moolre",
    "balance": 1742,
    "unit": "credits",
    "unitDescription": "SMS segments",
    "isLow": false,
    "lowBalanceThreshold": 250,
    "usedThisMonth": 258,
    "usedLast30Days": 1840,
    "averageDailyUsage": 61,
    "estimatedDaysRemaining": 28,
    "pendingTopUps": 0,
    "lastTopUpAt": "2026-08-14T10:02:44.000Z",
    "lastTopUpAmount": 2000,
    "updatedAt": "2026-09-28T09:40:00.000Z"
  }
}
```

### 9.5 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | Balance returned |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Role not permitted, or no school in scope |
| `404 Not Found` | School does not exist or is outside the caller's scope |
| `422 Unprocessable Entity` | A query parameter failed validation |

---

## 10. `POST /sms/credits/topup`

Purchase additional SMS credits.

**Authentication:** `super_admin`, `school_admin`
**Content-Type:** `application/json`

### 10.1 Description

Buys a block of SMS credits for the school, in one of two shapes:

- **Package purchase** — send a `packageCode` from the published catalogue.
  Amount and credit count come from the catalogue, so a caller cannot set
  their own price.
- **Custom purchase** — send `units` and `amount` explicitly. `amount` is in
  **pesewas** and is checked against the catalogue rate per 1,000 credits,
  rejecting underpayment. This path exists for negotiated enterprise rates and
  is refused for schools on a standard plan.

The request creates a `Payment` record in `pending` status and returns a
checkout reference. **Credits are added only when the payment settles through
the provider webhook — never at request time** — so a failed or abandoned
purchase cannot mint credits.

A top-up already in flight for the same school and amount is rejected with
`409`, which prevents a retrying client from being charged twice. Idempotency
keys are honoured on this endpoint too (§1.7).

### 10.2 Request body

| Field | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `packageCode` | string | conditional | — | Catalogue package, e.g. `sms_1000`, `sms_5000`. Required for standard plans. |
| `units` | integer | conditional | — | Custom credit count, min 100. Required when `packageCode` is absent. |
| `amount` | integer | conditional | — | Custom price in **pesewas**. Required when `packageCode` is absent. Must meet the catalogue rate. |
| `paymentMethod` | string | optional | `"momo"` | `momo` or `card`. |
| `phoneNumber` | string | conditional | — | Momo number to charge. Required when `paymentMethod` is `momo` and the admin has no phone on file. |
| `schoolId` | string | required for `super_admin` | caller's school | Target school. Ignored for other roles. |

`packageCode` and the `units`/`amount` pair are mutually exclusive.

### 10.3 Example request

```http
POST /api/sms/credits/topup HTTP/1.1
Host: sukuupay-backend.onrender.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json
Idempotency-Key: b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e
```

```json
{
  "packageCode": "sms_5000",
  "paymentMethod": "momo",
  "phoneNumber": "0241234567"
}
```

### 10.4 Example response — `201 Created`

```json
{
  "success": true,
  "message": "SMS credit top-up initiated. Credits are added once payment settles.",
  "data": {
    "id": "65f9e5f6a7b8c9d0e1f2a3b4",
    "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
    "packageCode": "sms_5000",
    "units": 5000,
    "amount": 12000,
    "currency": "GHS",
    "amountInCedis": 120,
    "paymentMethod": "momo",
    "paymentId": "PAY-20260928-QK7T2M",
    "status": "pending",
    "creditsBalance": 1742,
    "provider": "moolre",
    "providerReference": "MOL-88424550",
    "createdAt": "2026-09-28T09:45:12.000Z",
    "settledAt": null
  }
}
```

`status` moves `pending → completed | failed | cancelled`. `creditsBalance`
here is the balance **before** settlement and does not yet include this
purchase. Re-read `GET /sms/credits` afterwards; `lastTopUpAt` updates on
settlement.

### 10.5 Status codes

| Code | Condition |
|:--|:--|
| `201 Created` | Top-up initiated; checkout reference returned |
| `400 Bad Request` | Custom `amount` below the catalogue rate; custom purchase attempted on a standard plan; `phoneNumber` missing for a momo charge |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Role not permitted, or no school in scope |
| `404 Not Found` | `packageCode` not in the catalogue; school not in scope |
| `409 Conflict` | An identical top-up is already `pending`, or an idempotency key was replayed with a different payload |
| `422 Unprocessable Entity` | Body failed validation |
| `429 Too Many Requests` | More than 3 top-ups per school per hour |

### 10.6 Error example — `409 Conflict`

```json
{
  "success": false,
  "message": "A top-up of GHS 120.00 for this school is already pending (65f9e5f6a7b8c9d0e1f2a3b4)."
}
```

---

## 11. `GET /sms/templates`

List the SMS templates available to a school.

**Authentication:** any authenticated user in scope (all roles)
**Query parameters:** supported

### 11.1 Description

Returns the school's own templates plus the platform's system templates, which
are read-only and flagged `isSystem: true`.

`placeholders` is the field a compose screen needs: it lists the tokens the
template expects, e.g. `["studentName", "balance"]`, so a client knows which
inputs to render. The send endpoints reject a template whose required
placeholders were not supplied, so a client that builds its form from
`placeholders` can never trigger that error.

This is the one endpoint in the module open to every role, `viewer` included,
because knowing what the school is permitted to say to parents is a read, not
a write.

### 11.2 Query parameters

| Parameter | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `category` | string | optional | — | One of the values in §1.5. |
| `search` | string | optional | — | Case-insensitive match on `name` or `body`. Max 100 characters. |
| `isSystem` | boolean | optional | — | `true` returns only platform templates. |
| `isActive` | boolean | optional | — | `true` or `false` filters on active state; omit for both. |
| `page` | integer | optional | `1` | 1-based page number. |
| `perPage` | integer | optional | `20` | 1–100. |

### 11.3 Example request

```http
GET /api/sms/templates?category=balance HTTP/1.1
Host: sukuupay-backend.onrender.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 11.4 Example response — `200 OK`

```json
{
  "success": true,
  "message": "SMS templates retrieved successfully",
  "data": [
    {
      "id": "65a1b2c3d4e5f6a7b8c9d0e1",
      "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
      "name": "Balance Reminder — Standard",
      "category": "balance",
      "body": "Dear {{parentName}}, {{studentName}} ({{studentClass}}) has an outstanding balance of GHS {{balance}}. Please pay by {{deadline}} via {{payLink}}.",
      "placeholders": ["parentName", "studentName", "studentClass", "balance", "deadline", "payLink"],
      "charCount": 148,
      "estimatedSegments": 1,
      "language": "en",
      "isSystem": false,
      "isActive": true,
      "usageCount": 312,
      "createdBy": "65a0f1e2d3c4b5a697887766",
      "createdAt": "2026-07-02T08:11:00.000Z",
      "updatedAt": "2026-09-12T11:20:31.000Z"
    },
    {
      "id": "65a1b2c3d4e5f6a7b8c9d0e0",
      "schoolId": null,
      "name": "Overdue Balance — Final Notice",
      "category": "balance",
      "body": "Dear {{parentName}}, fees for {{studentName}} remain unpaid since {{deadline}}. Your balance is GHS {{balance}}. Please settle today to avoid interruption.",
      "placeholders": ["parentName", "studentName", "deadline", "balance"],
      "charCount": 176,
      "estimatedSegments": 2,
      "language": "en",
      "isSystem": true,
      "isActive": true,
      "usageCount": 0,
      "createdBy": null,
      "createdAt": "2026-06-18T10:00:00.000Z",
      "updatedAt": "2026-06-18T10:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 20,
    "total": 2,
    "totalPages": 1
  }
}
```

### 11.5 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | Templates returned |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | No school in scope |
| `422 Unprocessable Entity` | A query parameter failed validation |

---

## 12. `GET /sms/templates/:templateId`

Retrieve a single template.

**Authentication:** any authenticated user in scope (all roles)
**Path parameters:** `templateId`

### 12.1 Description

Returns one template by id — the school copy of a school template, or a system
template (identified by `schoolId: null` and `isSystem: true`). Its shape is
identical to a row from `GET /sms/templates`, so a client can reuse the same
renderer.

A `super_admin` may read any school's template by passing that template's
`schoolId`; a school-scoped user reading a template outside their school gets
`404`.

### 12.2 Path parameters

| Parameter | Type | Required | Description |
|:--|:--:|:--:|:--|
| `templateId` | string (24-hex ObjectId) | ✔ | The template. Must not be soft-deleted. |

### 12.3 Example request

```http
GET /api/sms/templates/65a1b2c3d4e5f6a7b8c9d0e1 HTTP/1.1
Host: sukuupay-backend.onrender.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 12.4 Example response — `200 OK`

```json
{
  "success": true,
  "message": "SMS template retrieved successfully",
  "data": {
    "id": "65a1b2c3d4e5f6a7b8c9d0e1",
    "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
    "name": "Balance Reminder — Standard",
    "category": "balance",
    "body": "Dear {{parentName}}, {{studentName}} ({{studentClass}}) has an outstanding balance of GHS {{balance}}. Please pay by {{deadline}} via {{payLink}}.",
    "placeholders": ["parentName", "studentName", "studentClass", "balance", "deadline", "payLink"],
    "description": "Standard arrears notice for the parent of record.",
    "charCount": 148,
    "estimatedSegments": 1,
    "language": "en",
    "isSystem": false,
    "isActive": true,
    "usageCount": 312,
    "createdBy": "65a0f1e2d3c4b5a697887766",
    "createdAt": "2026-07-02T08:11:00.000Z",
    "updatedAt": "2026-09-12T11:20:31.000Z"
  }
}
```

### 12.5 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | Template returned |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | No school in scope |
| `404 Not Found` | Template does not exist, is soft-deleted, or belongs to another school |

---

## 13. `POST /sms/templates`

Create a new SMS template.

**Authentication:** `super_admin`, `school_admin`
**Content-Type:** `application/json`

### 13.1 Description

Creates a school-owned template. `schoolId` comes from the caller's scope and
is not settable in the body for non-super-admins.

Placeholder tokens are written in double braces — `{{studentName}}` — and are
extracted from `body` into the `placeholders` array on save. The endpoint
rejects a body containing malformed or unbalanced tokens rather than letting
the template fail silently at send time, which would mean a parent simply
never receives the message.

`charCount` is measured on the template as written. `estimatedSegments` is
computed on a representative rendering — each token replaced by a
realistically long sample value — so the school can budget credits before a
broadcast rather than discovering the cost afterwards.

A name that duplicates an existing template in the same school and category
returns `409`.

### 13.2 Request body

| Field | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `name` | string | ✔ | — | Display name, 2–100 characters. Unique within the school and category. |
| `category` | string | ✔ | — | One of the values in §1.5. |
| `body` | string | ✔ | — | Message text with `{{placeholder}}` tokens, 1–1000 characters. |
| `description` | string | optional | `""` | Internal note for staff, up to 300 characters. Never sent to parents. |
| `language` | string | optional | `"en"` | `en` (English) or `ak` (Akan/Twi). Twi renders as UCS-2, so segments are charged at 153 characters. |
| `isActive` | boolean | optional | `true` | Inactive templates cannot be selected on send. |
| `schoolId` | string | required for `super_admin` | caller's school | Target school. Ignored for other roles. |

### 13.3 Example request

```http
POST /api/sms/templates HTTP/1.1
Host: sukuupay-backend.onrender.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json
```

```json
{
  "name": "Payment Plan — First Reminder",
  "category": "payment_plan",
  "body": "Dear {{parentName}}, installment {{installmentNumber}} of {{totalInstallments}} for {{studentName}} is due on {{dueDate}}. Amount: GHS {{amount}}. Pay via {{payLink}}.",
  "description": "Sent 3 days before an installment falls due.",
  "language": "en"
}
```

### 13.4 Example response — `201 Created`

```json
{
  "success": true,
  "message": "SMS template created successfully",
  "data": {
    "id": "65f9f6a7b8c9d0e1f2a3b4c5",
    "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
    "name": "Payment Plan — First Reminder",
    "category": "payment_plan",
    "body": "Dear {{parentName}}, installment {{installmentNumber}} of {{totalInstallments}} for {{studentName}} is due on {{dueDate}}. Amount: GHS {{amount}}. Pay via {{payLink}}.",
    "placeholders": ["parentName", "installmentNumber", "totalInstallments", "studentName", "dueDate", "amount", "payLink"],
    "description": "Sent 3 days before an installment falls due.",
    "charCount": 152,
    "estimatedSegments": 2,
    "language": "en",
    "isSystem": false,
    "isActive": true,
    "usageCount": 0,
    "createdBy": "65a0f1e2d3c4b5a697887766",
    "createdAt": "2026-09-28T09:52:30.000Z",
    "updatedAt": "2026-09-28T09:52:30.000Z"
  }
}
```

### 13.5 Status codes

| Code | Condition |
|:--|:--|
| `201 Created` | Template created |
| `400 Bad Request` | `body` contains malformed or unbalanced `{{placeholder}}` tokens |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Role not permitted, or no school in scope |
| `409 Conflict` | A template with the same `name` and `category` already exists for this school |
| `422 Unprocessable Entity` | Body failed validation |

### 13.6 Error example — `400 Bad Request`

```json
{
  "success": false,
  "message": "Template body has a malformed placeholder: expected \"{{name}}\" but found \"{{studentName\""
}
```

---

## 14. `PUT /sms/templates/:templateId`

Update an existing SMS template.

**Authentication:** `super_admin`, `school_admin`
**Path parameters:** `templateId`
**Content-Type:** `application/json`

### 14.1 Description

Applies a partial update: only the fields present in the body are changed, so
correcting the wording does not reset the template's `usageCount` or silently
re-drop its `isActive` flag. At least one field is required.

Supplying `body` re-parses the placeholders and recomputes `charCount` and
`estimatedSegments`. Supplying only `isActive` or only `name` leaves `body`
untouched.

Changing `body` does not retroactively affect messages already sent — history
stores the rendered text, so a past message always reads the way the parent
received it.

System templates (`isSystem: true`) are read-only and return `403`. Switching a
template off uses `isActive: false` rather than deletion, so historical
messages that were rendered from it keep their provenance.

### 14.2 Path parameters

| Parameter | Type | Required | Description |
|:--|:--:|:--:|:--|
| `templateId` | string (24-hex ObjectId) | ✔ | The template to update. Must be owned by the caller's school. |

### 14.3 Request body

All fields optional; at least one is required.

| Field | Type | Required | Description |
|:--|:--:|:--:|:--|
| `name` | string | optional | New display name, 2–100 characters. Must stay unique within the school and category. |
| `category` | string | optional | New category, from §1.5. |
| `body` | string | optional | New message text with `{{placeholder}}` tokens, 1–1000 characters. |
| `description` | string | optional | Internal note, up to 300 characters. |
| `language` | string | optional | `en` or `ak`. |
| `isActive` | boolean | optional | `false` deactivates the template without deleting it. |

### 14.4 Example request

```http
PUT /api/sms/templates/65f9f6a7b8c9d0e1f2a3b4c5 HTTP/1.1
Host: sukuupay-backend.onrender.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json
```

```json
{
  "body": "Dear {{parentName}}, installment {{installmentNumber}} of {{totalInstallments}} for {{studentName}} is due on {{dueDate}}. Amount: GHS {{amount}}. Pay via {{payLink}} or dial *733# to check your balance.",
  "isActive": true
}
```

### 14.5 Example response — `200 OK`

```json
{
  "success": true,
  "message": "SMS template updated successfully",
  "data": {
    "id": "65f9f6a7b8c9d0e1f2a3b4c5",
    "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
    "name": "Payment Plan — First Reminder",
    "category": "payment_plan",
    "body": "Dear {{parentName}}, installment {{installmentNumber}} of {{totalInstallments}} for {{studentName}} is due on {{dueDate}}. Amount: GHS {{amount}}. Pay via {{payLink}} or dial *733# to check your balance.",
    "placeholders": ["parentName", "installmentNumber", "totalInstallments", "studentName", "dueDate", "amount", "payLink"],
    "description": "Sent 3 days before an installment falls due.",
    "charCount": 189,
    "estimatedSegments": 2,
    "language": "en",
    "isSystem": false,
    "isActive": true,
    "usageCount": 0,
    "createdBy": "65a0f1e2d3c4b5a697887766",
    "updatedBy": "65a0f1e2d3c4b5a697887766",
    "createdAt": "2026-09-28T09:52:30.000Z",
    "updatedAt": "2026-09-28T10:04:17.000Z"
  }
}
```

### 14.6 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | Template updated |
| `400 Bad Request` | `body` contains malformed or unbalanced `{{placeholder}}` tokens |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Template is a system template, or role not permitted |
| `404 Not Found` | Template does not exist, is soft-deleted, or belongs to another school |
| `409 Conflict` | Another template already uses the requested `name` + `category` |
| `422 Unprocessable Entity` | Body failed validation, or the body is empty |

### 14.7 Error example — `404 Not Found`

```json
{
  "success": false,
  "message": "SMS template not found"
}
```

---

## 15. `DELETE /sms/templates/:templateId`

Soft-delete an SMS template.

**Authentication:** `super_admin`, `school_admin`
**Path parameters:** `templateId`
**Content-Type:** `application/json`

### 15.1 Description

Soft-deletes a template: sets `deletedAt` and it disappears from every list
and read endpoint, while remaining in the database. Messages already sent
from it are unaffected — history stores rendered text, so the audit trail is
intact.

Prefer `PUT` with `isActive: false` when the template is merely out of date:
an inactive template still shows up in history and keeps its `usageCount`,
whereas a deleted one is hidden entirely and can no longer be selected on send.

System templates are read-only and return `403`. Deleting a template is not
refundable and is not covered by idempotency keys — a repeat call returns
`404`, since the template is no longer visible.

### 15.2 Path parameters

| Parameter | Type | Required | Description |
|:--|:--:|:--:|:--|
| `templateId` | string (24-hex ObjectId) | ✔ | The template to delete. Must be owned by the caller's school. |

### 15.3 Request body

| Field | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `reason` | string | optional | `""` | Internal note recorded in the audit log, up to 300 characters. |

### 15.4 Example request

```http
DELETE /api/sms/templates/65f9f6a7b8c9d0e1f2a3b4c5 HTTP/1.1
Host: sukuupay-backend.onrender.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json
```

```json
{
  "reason": "Replaced by the 2026 fee structure; no longer valid."
}
```

### 15.5 Example response — `200 OK`

```json
{
  "success": true,
  "message": "SMS template deleted successfully"
}
```

### 15.6 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | Template soft-deleted |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Template is a system template, or role not permitted |
| `404 Not Found` | Template does not exist, is already deleted, or belongs to another school |
| `422 Unprocessable Entity` | Body failed validation |

---

## Appendix A — Placeholder tokens

Templates may use these tokens. Anything else must be supplied through
`variables` on the send endpoint, or the send is rejected with `400`.

| Token | Type | Source |
|:--|:--|:--|
| `parentName` | string | Parent record |
| `studentName` | string | Student record |
| `studentClass` | string | Student record (`studentClass`) |
| `studentId` | string | Human-facing code, e.g. `AIS/26/0143` |
| `balance` | integer (pesewas) | `totalOwed - totalPaid` |
| `totalOwed` | integer (pesewas) | Student record |
| `deadline` | string (ISO 8601) | Student record |
| `payLink` | string | Student record |
| `schoolName` | string | School record |
| `amount` | integer (pesewas) | Payment-plan installment amount |
| `dueDate` | string (ISO 8601) | Payment-plan installment due date |
| `installmentNumber` | integer | Payment-plan installment number |
| `totalInstallments` | integer | Payment-plan installment count |

Tokens from the payment-plan rows are only auto-populated for messages with
`type: "payment_plan"`; for other categories they must be passed in
`variables`. Note that `amount` here is a pesewa figure for an installment —
unrelated to the `amount` field in the top-up request body (§10.2), which is
also pesewas but means the price of a credit purchase.

Money placeholders are rendered as formatted cedis (`55000` → `GHS 550.00`),
never as a raw pesewa integer.

## Appendix B — Provider configuration

Per-school provider settings live on the `School` document under `sms` and
are managed through the existing school module. `apiKey` is `select: false`
and is never returned by any endpoint.

```json
{
  "sms": {
    "provider": "moolre",
    "senderId": "AccraIntlSch",
    "balance": 1742,
    "lowBalanceThreshold": 250,
    "deliveryReporting": true
  }
}
```

| Field | Type | Description |
|:--|:--|:--|
| `provider` | enum | `moolre` (default), `arke`, `mnotify`. |
| `senderId` | string | Registered alphanumeric sender ID. A rejected sender ID is the most common send failure. |
| `apiKey` | string | Provider credential. Write-only; never returned. |
| `balance` | number | Cached credit balance, in segments. |
| `lowBalanceThreshold` | number | Below this, `GET /sms/credits` reports `isLow: true`. |
| `deliveryReporting` | boolean | `false` when the provider emits no delivery callbacks, so messages stay at `sent`. |

The `provider` field on every message records which gateway actually carried
it, so a multi-provider school can be audited per channel. The delivery
callback URL registered with the provider is
`{API_BASE_URL}/api/sms/webhooks/provider`.

## Appendix C — Data model reference

**`SmsMessage`** — one per recipient per send.

| Field | Type | Notes |
|:--|:--|:--|
| `schoolId` | ObjectId → School | Indexed |
| `studentId` | ObjectId → Student | Indexed |
| `parentId` | ObjectId → Parent | |
| `parentName`, `phone` | string | Snapshot at send time |
| `message` | string | **Rendered** text, not a template reference |
| `type` | string | §1.5 vocabulary |
| `templateId` | ObjectId → SmsTemplate | Null for inline sends |
| `jobId` | ObjectId → SmsJob | Null for single sends |
| `provider`, `providerReference` | string | `providerReference` indexed, used by the callback |
| `network` | string | `MTN` / `VODAFONE` / `AIRTELTELIGO` / `UNKNOWN` |
| `status` | string | §1.3 vocabulary, indexed |
| `segments` | integer | 160 (GSM-7) or 153 (UCS-2) chars per credit |
| `creditsCharged`, `creditsRefunded` | integer | Both may be non-zero after a provider failure |
| `isTest` | boolean | Test messages are free |
| `failureReason` | string | Provider error text |
| `scheduledAt`, `sentAt`, `deliveredAt` | Date | |
| `createdBy` | ObjectId → User | |
| `createdAt`, `updatedAt` | Date | Timestamps |

**`SmsJob`** — one per bulk broadcast.

| Field | Type | Notes |
|:--|:--|:--|
| `schoolId` | ObjectId → School | Indexed |
| `templateId` | ObjectId → SmsTemplate | |
| `type` | string | §1.5 vocabulary |
| `status` | string | `queued`, `processing`, `cancelling`, `cancelled`, `completed`, `failed` |
| `filters` | Mixed | Resolved filter set, echoed for audit |
| `recipientsResolved`, `recipientsSkipped` | integer | |
| `skippedReasons` | Mixed | e.g. `{ "noValidPhone": 5, "optedOut": 2 }` |
| `result` | Mixed | Per-status tally once the run finishes |
| `creditsDebited`, `creditsRefunded` | integer | |
| `progressPercent` | number | 0–100 |
| `scheduledAt`, `startedAt`, `completedAt` | Date | |
| `cancelledAt`, `cancellationReason` | Date, string | |
| `failureReason` | string | Set when the job itself fails |
| `createdBy` | ObjectId → User | |

**`SmsTemplate`** — one per reusable message.

| Field | Type | Notes |
|:--|:--|:--|
| `schoolId` | ObjectId → School | `null` for system templates |
| `name` | string | 2–100 characters |
| `category` | string | §1.5 vocabulary |
| `body` | string | 1–1000 characters, with `{{tokens}}` |
| `placeholders` | string[] | Derived from `body` on save |
| `description` | string | Internal only |
| `charCount` | integer | Derived |
| `estimatedSegments` | integer | Derived from a representative rendering |
| `language` | string | `en` or `ak` |
| `isSystem` | boolean | Read-only |
| `isActive` | boolean | Selectable on send |
| `usageCount` | integer | Incremented per send |
| `createdBy`, `updatedBy` | ObjectId → User | |
| `deletedAt` | Date | Soft delete, indexed |

**`SmsCreditTopUp`** — one per purchase attempt.

| Field | Type | Notes |
|:--|:--|:--|
| `schoolId` | ObjectId → School | Indexed |
| `packageCode` | string | Null for custom purchases |
| `units` | integer | Credits purchased |
| `amount` | integer | Price in pesewas |
| `paymentMethod` | string | `momo` or `card` |
| `paymentId` | string → Payment | Settles the purchase |
| `status` | string | `pending`, `completed`, `failed`, `cancelled` |
| `providerReference` | string | Checkout reference |
| `settledAt` | Date | When credits were actually granted |

**Recommended indexes**

```
SmsMessage: { schoolId, createdAt: -1 }
            { schoolId, status }
            { jobId }
            { providerReference }                       (callback lookup)
            { schoolId, studentId, createdAt: -1 }
SmsJob:     { schoolId, createdAt: -1 }
            { schoolId, status }
SmsTemplate:{ schoolId, category, isActive }
            { schoolId, name, category }                (unique)
```

## Appendix D — Error reference

| Status | Message pattern | Likely cause |
|:--:|:--|:--|
| `400` | `Insufficient SMS credits (N available, M required)…` | Balance too low; top up first |
| `400` | `This school has no SMS provider configured…` | `school.sms.apiKey` unset |
| `400` | `Template requires N placeholders but M were supplied…` | Incomplete `variables` |
| `400` | `Broadcast resolves to 0 parents…` | Filters matched nothing |
| `400` | `Template body has a malformed placeholder…` | Unbalanced `{{token}}` |
| `400` | `Date cannot be in the past` | `scheduleAt` or `startDate` in the past |
| `401` | `Authentication required` | No bearer token |
| `401` | `Access token expired` | Re-authenticate |
| `401` | `Invalid webhook signature` | Callback signature mismatch or replay |
| `403` | `You do not have access to this resource` | Role not permitted |
| `403` | `No school in scope` | Account has no `schoolId` |
| `404` | `Student not found` | Wrong id, or another school's student |
| `404` | `Payment plan not found` | Plan id invalid, deleted, or cancelled |
| `404` | `Invalid or expired payment link` | Pay-link token stale |
| `409` | `A top-up of GHS X for this school is already pending…` | Duplicate purchase in flight |
| `409` | `A bulk SMS job with this Idempotency-Key already exists with a different payload` | Key reuse |
| `422` | `"<field>" …` plus an `errors` array | Joi validation failed |
| `429` | Rate limit exceeded | Back off for `Retry-After` seconds |

## Appendix E — Compliance notes

Ghana's Data Protection Act, 2012 (Act 843) governs the personal data this
module processes. Parent names, phone numbers and payment balances are
personal data.

- **Consent.** Bulk sends default to `confirmation: "none"`, which assumes the
  school holds a lawful basis for fee-related communication. Set
  `confirmation: "opt_in"` to restrict a campaign to parents who have
  explicitly opted in, and `opt_out` to honour opt-outs recorded against the
  parent record. A parent who opts out is counted in `skippedReasons.optedOut`
  rather than messaged.
- **Purpose limitation.** Fee balances and payment-plan state should only be
  sent to a parent for a child they are recorded against. The `recipient: "all"`
  option on `POST /sms/single/:studentId` messages every parent on a student,
  which is appropriate for a class-wide notice but not for one parent's
  arrears.
- **Record keeping.** `GET /sms/history` is the artefact a data-subject request
  or a complaint can be answered from, which is why messages are never
  hard-deleted. Retention is a deployment concern and should be enforced by a
  scheduled archival job, not by an API call.
- **Transport.** All endpoints are HTTPS-only; the delivery callback is
  signature-verified because it cannot carry a bearer token (§7).

## Appendix F — Endpoint index

| # | Method | Path | Roles | Success |
|:--:|:--|:--|:--|:--|
| 2 | `POST` | `/sms/single/:studentId` | `super_admin`, `school_admin`, `accountant` | `200` |
| 3 | `POST` | `/sms/bulk/:schoolId` | `super_admin`, `school_admin`, `accountant` | `202` |
| 4 | `GET` | `/sms/jobs/:jobId` | `super_admin`, `school_admin`, `accountant` | `200` |
| 5 | `POST` | `/sms/jobs/:jobId/cancel` | `super_admin`, `school_admin`, `accountant` | `200` |
| 6 | `POST` | `/sms/test` | `super_admin`, `school_admin` | `200` |
| 7 | `POST` | `/sms/webhooks/provider` | signature only | `200` |
| 8 | `GET` | `/sms/history` | `super_admin`, `school_admin`, `accountant` | `200` |
| 9 | `GET` | `/sms/credits` | `super_admin`, `school_admin` | `200` |
| 10 | `POST` | `/sms/credits/topup` | `super_admin`, `school_admin` | `201` |
| 11 | `GET` | `/sms/templates` | all roles | `200` |
| 12 | `GET` | `/sms/templates/:templateId` | all roles | `200` |
| 13 | `POST` | `/sms/templates` | `super_admin`, `school_admin` | `201` |
| 14 | `PUT` | `/sms/templates/:templateId` | `super_admin`, `school_admin` | `200` |
| 15 | `DELETE` | `/sms/templates/:templateId` | `super_admin`, `school_admin` | `200` |

All paths are prefixed with `/api`.
