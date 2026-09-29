# SukuuPay — Email API Specification

**Module:** Email (parent communication)
**Base URL:** `https://api.sukuupay.com/api`
**Version:** `1.0`
**Last updated:** 2026-09-28
**Related:** [`SMS_API_SPEC.md`](./SMS_API_SPEC.md)

---

## 1. Overview

Email is the second channel for school-to-parent communication, covering the
cases where SMS is the wrong tool: long-form notices, statement PDFs, term
reports and anything a parent needs to keep.

| Concern | Endpoints |
|:--|:--|
| Outbound delivery | `POST /email/single`, `POST /email/bulk/:schoolId` |
| Audit trail | `GET /email/history` |
| Delivery callbacks | `POST /email/webhooks/brevo` |

The three endpoints in this document are the module's public surface. The
webhook is not optional: without it, no message can ever reach `delivered`,
`bounced` or `complained`, and those states are what make a bounce list
actionable.

Email shares its **category vocabulary** with the SMS module (§1.5) so a
parent's total communication can be reported on one axis.

### 1.1 What is different from SMS

| | SMS | Email |
|:--|:--|:--|
| Cost model | Prepaid **credits**, per 160/153-character segment | No prepaid balance. Bounded by the provider's **daily sending quota** |
| Recipient requirement | Ghanaian mobile number, always present | An email address, which is **often absent** on the parent record |
| Recipient identity | Phone number | Email address, verified in principle, bounced in practice |
| Body | Single plain-text string | **HTML and plain-text** parts; the text part is not optional |
| Length | ~1,600 characters (10 segments) | Effectively unlimited; long notices and attachments are normal |
| Delivery signal | Provider status callback | Provider event stream: delivered, opened, clicked, bounce, complaint |
| Practical role | Urgent, short, transactional | Non-urgent, long, documentary |

The recipient-availability asymmetry is the single biggest operational
difference: a phone number is `required` on the parent sub-document, while
`email` is optional and defaults to `null`. Any bulk email run over real data
will skip a meaningful share of parents. See Appendix A.

### 1.2 Conventions

**Money** — integers in **pesewas** (1 Ghana cedi = 100 pesewas), rendered as
formatted cedis inside message text (`55000` → `GHS 550.00`).

**Email addresses** — lowercased and trimmed on write, matching the parent
schema. Addresses are validated on the way in, not at the provider.

**Response envelope** — one shape for every response:

```json
{
  "success": true,
  "message": "Human-readable summary",
  "data": {},
  "meta": {}
}
```

`data` holds the resource; `meta` appears on list and job responses. Failures
never include `data`.

**Timestamps** — ISO 8601 in UTC. Dates rendered *inside* message text are
formatted in `Africa/Accra` (UTC+0, no daylight saving). This matters for the
daily quota, which resets at Accra midnight — the same instant as UTC
midnight.

**Deletion** — `GET /email/history` is **append-only**. Messages are never
hard-deleted, including those from a cancelled or failed job, because they are
the record of what a parent was told and the basis for any data-subject
request. Retention is enforced by a scheduled archival job, not by an API
call.

### 1.3 Authentication and authorization

All endpoints except the provider webhook require a bearer access token from
`POST /auth/login`.

| Endpoint | `super_admin` | `school_admin` | `accountant` | `teacher` | `viewer` |
|:--|:--:|:--:|:--:|:--:|:--:|
| `POST /email/single` | ✔ | ✔ | ✔ | ✘ | ✘ |
| `POST /email/bulk/:schoolId` | ✔ | ✔ | ✔ | ✘ | ✘ |
| `GET /email/history` | ✔ | ✔ | ✔ | ✔ | ✘ |
| `POST /email/webhooks/brevo` | — | — | — | — | — |

**School scoping.** Non-super-admins are confined to the `schoolId` on their
own user record. Requesting a resource from another school returns `404`,
never `403`. A `super_admin` may target any school; on write endpoints an
explicit `schoolId` is **required**, and on `GET /email/history` omitting it
returns a cross-school view.

`teacher` can read history but not send, on the view that a teacher needs
visibility into what was sent to a parent without a need to originate it.

### 1.4 Message lifecycle

Every message is persisted as an `EmailMessage` **before** the provider is
called, so a provider outage is visible in the log rather than silent.

| Status | Meaning |
|:--|:--|
| `queued` | Accepted, awaiting the provider |
| `sent` | Handed to the provider successfully |
| `delivered` | Accepted by the recipient's mail server |
| `opened` | Opened at least once (provider-tracked opens only) |
| `clicked` | At least one tracked link click |
| `deferred` | Provider accepted it but the mail server asked for retry |
| `soft_bounced` | Temporary failure — mailbox full, greylisted, server down |
| `bounced` | Permanent failure — address does not exist |
| `complained` | Recipient marked it as spam |
| `blocked` | Provider refused to send it (suppressed or blocklisted address) |
| `unsubscribed` | Recipient opted out via the unsubscribe link |
| `failed` | The API call itself failed, or the daily quota was exhausted |

`delivered` and everything after it arrives asynchronously through the
provider callback (§5). **Open and click tracking are heuristics** — Apple Mail
and Outlook strip the tracking pixel and rewrite links — so `clicked` is
indicative of interest, never of a security-sensitive action. Do not gate
anything on it.

### 1.5 Category vocabulary

One canonical enum classifies every message, identical to the SMS module's, so
a parent's communication can be reported on one axis across both channels.

| Value | Used for |
|:--|:--|
| `general` | Anything without a more specific fit |
| `balance` | Balance reminders, arrears notices, statements |
| `payment` | Payment confirmations, receipts, payment links |
| `payment_plan` | Installment statements and plan-lifecycle messages |
| `academic` | Term reports, report cards, term dates |
| `attendance` | Absence and lateness summaries |
| `announcement` | Whole-school or class broadcasts |
| `emergency` | Urgent safety or closure notices |
| `result` | Individual pupil results |
| `receipt` | Receipt confirmations and downloadable copies |

The field is named `type` on this module's endpoints, matching the SMS
module's `type`. The same names are rejected if passed as `category`.

### 1.6 Quota and rate limits

There is no prepaid credit balance. Sending is bounded by the provider
account's daily quota, which resets at 00:00 Accra.

| Scope | Limit |
|:--|:--|
| `POST /email/single` | 60 requests / minute / school |
| `POST /email/bulk/:schoolId` | 5 requests / hour / school |
| `GET /email/history` | 300 requests / minute / user |
| `POST /email/webhooks/brevo` | Not rate limited; must respond within 5 s |

A request whose recipient count would exceed the day's remaining quota fails
**before** any message is sent, with `429` and a `Retry-After` of seconds
until Accra midnight. Exceeding a rate limit also returns `429`.

**Idempotency.** `POST /email/single` and `POST /email/bulk/:schoolId` honour
an `Idempotency-Key` header, retained for 24 hours. A replay with an identical
payload returns the **original** response and sends nothing further; a replay
with a different payload returns `409`. A successful send response carries a
top-level `replayed` boolean — `false` on a first attempt, `true` on a replay —
so a client can branch on it without parsing the human-readable `message`.

The replay check covers every field that affects the outbound message,
including `html`, `text`, `scheduleAt` and `overrideSubject`, so reusing a key
with a changed body is a conflict rather than a silent replay.

```http
Idempotency-Key: 3c9a7f21-55be-4d0e-9c11-7b2e4a6d8f30
```

### 1.7 Error format

```json
{
  "success": false,
  "message": "Daily sending quota exhausted (1,000 per day, 1,000 used)"
}
```

| Status | When it is returned |
|:--:|:--|
| `400 Bad Request` | Business-rule failure (no emailable recipient, empty recipient set, missing template variables) |
| `401 Unauthorized` | Missing, malformed or expired access token; failed webhook signature |
| `403 Forbidden` | Authenticated but the role is not allowed, no school in scope, or the `:schoolId` in the path is not the caller's own school |
| `404 Not Found` | Resource does not exist, or is outside the caller's school scope |
| `409 Conflict` | Idempotency key replayed with a different payload |
| `422 Unprocessable Entity` | Request payload failed Joi validation |
| `429 Too Many Requests` | Daily quota exhausted, or a rate limit exceeded |
| `502 Bad Gateway` | The provider rejected the send outright |

See Appendix E for the catalogue of recurring errors.

### 1.8 Quickstart

```bash
# 1. Send a balance statement to one parent's verified address
curl -X POST https://api.sukuupay.com/api/email/single \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 8f14e45f-ea4c-4f9b-9b2a-1c3d5e7f9a11" \
  -d '{
        "studentId": "65f3b2c4d5e6f7g8h9i0j1k2",
        "recipient": "primary",
        "template": "balance_statement",
        "variables": { "balance": 55000, "deadline": "2026-10-15T23:59:00.000Z" },
        "type": "balance"
      }'

# 2. Email a term report to every parent of one class who has an address
curl -X POST https://api.sukuupay.com/api/email/bulk/65f2a1b3c4d5e6f7g8h9i0j1 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "template": "term_report_notice",
        "recipients": { "target": "class" },
        "class": "Basic 7",
        "type": "academic"
      }'
# → 202 with data.jobId
```

---

## 2. `POST /email/single`

Send one email to one recipient.

**Authentication:** `super_admin`, `school_admin`, `accountant`
**Content-Type:** `application/json`

### 2.1 Description

Sends a single email. The recipient is addressed in one of two ways, and
which one you use determines the compliance obligations:

1. **Resolved from a student** — supply `studentId` and a `recipient`
   selector. The address is taken from the parent record, the message is
   attributed to that student, and it lands in the school's history scoped to
   that student. This is the normal path for school communication.
2. **Explicit address** — supply `to`. Used for platform and administrative
   mail that has no student context.

The endpoint takes no path parameter precisely because both modes exist: the
first addresses a person, the second addresses a mailbox.

**Recipient resolution.** `recipient: "primary"` (the default) selects the
parent flagged `isPrimary: true`, falling back to the first parent on record.
`recipient: "all"` selects every parent on the student who has an email
address; those without one are reported in `skippedWithoutEmail` rather than
silently dropped. Note that parent sub-documents are declared with `_id: false`,
so a parent has no ObjectId — a specific parent cannot be addressed by id.
Use `recipientIndex` to select one by position when neither `primary` nor
`all` is right.

If the resolved address is missing or malformed, the request fails with `400`
rather than sending to a fallback address. Silently redirecting a fee notice to
a different household is not an acceptable failure mode.

**Body.** Either a built-in `template` or a caller-supplied `html` + `text`
pair. Both parts are required for a custom body: the plain-text alternative
is what gets indexed by spam filters, and a text-only fallback is what reaches
a parent on a text-only client. This mirrors what the platform's own
transactional templates already do.

### 2.2 Request body

| Field | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `to` | string | conditional | — | Explicit recipient address. Required unless `studentId` is supplied. Mutually exclusive with it. |
| `toName` | string | optional | — | Display name for the explicit address. |
| `studentId` | string (24-hex ObjectId) | conditional | — | Student whose parent record supplies the address. |
| `recipient` | string | optional | `"primary"` | `primary`, `all`, or `primary_indexed`. Only with `studentId`. |
| `recipientIndex` | integer | optional | — | Zero-based index into the student's parent array. Only used when `recipient` is `primary_indexed`. |
| `template` | string | conditional | — | Built-in template name (Appendix B). Required unless `html` is supplied. |
| `variables` | object | optional | `{}` | Values for the template's placeholders, e.g. `{ "balance": 55000 }`. |
| `subject` | string | conditional | — | Custom subject line, 1–150 characters. Required with a custom body; ignored for a built-in template unless `overrideSubject` is set. |
| `html` | string | conditional | — | Custom HTML body, 1–200,000 characters. Must be supplied with `text`. |
| `text` | string | conditional | — | Custom plain-text alternative, 1–100,000 characters. Must be supplied with `html`. |
| `replyTo` | string | optional | school sender | Address replies should go to. |
| `type` | string | optional | `general` | One of the values in §1.5. |
| `cc` | string[] | optional | `[]` | Carbon-copy addresses, max 10. Each is recorded as its own `EmailMessage`. |
| `bcc` | string[] | optional | `[]` | Blind carbon-copy addresses, max 10. **Not** exposed to other recipients. |
| `schoolId` | string | required for `super_admin` | caller's school | Target school. Ignored for other roles. |
| `scheduleAt` | string (ISO 8601) | optional | send now | Defer delivery. Must be in the future and within 30 days. |

### 2.3 Example request

```http
POST /api/email/single HTTP/1.1
Host: api.sukuupay.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json
Idempotency-Key: 8f14e45f-ea4c-4f9b-9b2a-1c3d5e7f9a11
```

```json
{
  "studentId": "65f3b2c4d5e6f7g8h9i0j1k2",
  "recipient": "primary",
  "template": "balance_statement",
  "variables": {
    "studentName": "Ama Serwaa Mensah",
    "balance": 55000,
    "deadline": "2026-10-15T23:59:00.000Z"
  },
  "type": "balance"
}
```

### 2.4 Example response — `200 OK`

```json
{
  "success": true,
  "message": "Email queued for delivery",
  "data": {
    "id": "65f9a1b2c3d4e5f6a7b8c9d0",
    "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
    "studentId": "65f3b2c4d5e6f7g8h9i0j1k2",
    "parentName": "Kwabena Mensah",
    "to": "kwabena.mensah@example.com",
    "subject": "Outstanding fees for Ama Serwaa Mensah (Basic 7)",
    "type": "balance",
    "template": "balance_statement",
    "provider": "brevo",
    "status": "queued",
    "providerMessageId": null,
    "hasHtmlPart": true,
    "hasTextPart": true,
    "quotaRemaining": 999,
    "scheduledAt": null,
    "createdAt": "2026-09-28T09:15:30.000Z",
    "sentAt": null,
    "deliveredAt": null,
    "openedAt": null,
    "firstClickedAt": null,
    "bounceType": null,
    "failureReason": null
  },
  "meta": {
    "skippedWithoutEmail": 0
  }
}
```

With `recipient: "all"`, `data` is an array of message objects, one per
addressable parent, and `meta` reports how many were skipped.

### 2.5 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | Email queued successfully |
| `400 Bad Request` | Resolved parent has no email address or an invalid one; `recipientIndex` out of range; both `to` and `studentId` supplied, or neither; a template variable was not supplied; `scheduleAt` in the past |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Role not permitted, no school in scope, or the `:schoolId` in the path is not the caller's own school |
| `404 Not Found` | Student does not exist, is soft-deleted, or belongs to another school; built-in template not found |
| `409 Conflict` | Idempotency key replayed with a different payload |
| `422 Unprocessable Entity` | Body failed validation |
| `429 Too Many Requests` | Daily quota exhausted, or per-school rate exceeded |
| `502 Bad Gateway` | Provider rejected the send outright |

### 2.6 Error examples

`400 Bad Request` — the primary parent has no email on record:

```json
{
  "success": false,
  "message": "The selected parent (Kwabena Mensah) has no email address on record. Add one via PUT /students/:id/parents/:parentId, or use POST /email/single with an explicit \"to\" address."
}
```

`400 Bad Request` — template rendered with missing data:

```json
{
  "success": false,
  "message": "Template balance_statement requires 3 variables but 2 were supplied: missing deadline"
}
```

`429 Too Many Requests` — quota exhausted:

```json
{
  "success": false,
  "message": "Daily sending quota exhausted (1,000 per day, 1,000 used). Quota resets at 2026-09-29T00:00:00.000Z."
}
```

---

## 3. `POST /email/bulk/:schoolId`

Send one email to a filtered set of parents.

**Authentication:** `super_admin`, `school_admin`, `accountant`
**Path parameters:** `schoolId`
**Content-Type:** `application/json`

### 3.1 Description

Accepts a broadcast and returns immediately with a job identifier. Rendering
and delivery run in the background, so a run over thousands of parents never
holds an HTTP connection open. The job's outcome is reported by the same
per-status tallies used for SMS.

**Recipients are parents, not students.** Each parent is messaged at most once
per job even when several of their children match; the message renders with
the first matching child. A parent who matches but has **no email address** is
counted in `skippedWithoutEmail` and listed in `skippedReasons` — the job
does not fail for them.

**The empty-set case is a `400`, not a `202` with zero sent.** A broadcast
that resolves to no addressable parent is almost always a filter or data
mistake, and reporting success would hide it. A run that resolves to *some*
parents succeeds normally; partial success is an expected outcome, reported
through `result`.

**Safeguards.** A run resolving to more than 5,000 parents, or one that would
exceed the day's remaining quota, is refused with `400`/`429` before anything
is sent. A full-school run must be confirmed with `confirmBroadscope: true`.

**Unsubscribe.** Every bulk message carries a `List-Unsubscribe` header and a
visible unsubscribe link, both pointing at the platform's preference endpoint.
Parents who unsubscribe are suppressed on subsequent runs of every category,
and are counted in `skippedReasons.unsubscribed` rather than messaged. This is
not optional for bulk send — see Appendix F.

### 3.2 Path parameters

| Parameter | Type | Required | Description |
|:--|:--:|:--:|:--|
| `schoolId` | string (24-hex ObjectId) | ✔ | The school to broadcast to. For a non-`super_admin` this must match their own school. |

### 3.3 Request body

| Field | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `template` | string | conditional | — | Built-in template name (Appendix B). Required unless a custom `html` + `text` body is supplied. |
| `variables` | object | optional | `{}` | Static placeholder values applied to all recipients, e.g. a shared `deadline`. |
| `subject` | string | optional | template's own | Override the subject line, 1–150 characters. |
| `html` | string | conditional | — | Custom HTML body. Must be supplied with `text`. |
| `text` | string | conditional | — | Custom plain-text alternative. Must be supplied with `html`. |
| `recipients` | object | ✔ | — | Recipient selector — see below. |
| `type` | string | optional | `announcement` | One of the values in §1.5. |
| `class` | string | optional | — | Only students in this class. Must be one of the school's `academic.classes` entries. |
| `balanceRanges` | string[] | optional | — | Balance bands in **GHS**: `no_balance`, `overdue`, `1_100`, `101_500`, `501_1000`, `above_1000`. |
| `hasActivePlan` | boolean | optional | — | `true` keeps only parents of students with an `active` payment plan; `false` keeps only those without. |
| `status` | string[] | optional | `["active"]` | Student statuses to include: `active`, `suspended`, `removed`, `graduated`, `transferred_out`. |
| `includeWithoutEmail` | boolean | optional | `false` | Always `false` in practice: a parent with no address is skipped and counted. Present so the skip is explicit rather than implied. |
| `confirmation` | string | optional | `"none"` | Consent handling: `none`, `opt_in`, `opt_out`. |
| `scheduleAt` | string (ISO 8601) | optional | send now | Defer the whole run; within 30 days. |
| `confirmBroadscope` | boolean | required | `false` | Must be `true` when `recipients.target` is `all`. |

#### `recipients` object

| Field | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `target` | string | ✔ | — | `all`, `class`, `balance`, `payment_plan`, `individual`. |
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
POST /api/email/bulk/65f2a1b3c4d5e6f7g8h9i0j1 HTTP/1.1
Host: api.sukuupay.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json
Idempotency-Key: 3c9a7f21-55be-4d0e-9c11-7b2e4a6d8f30
```

```json
{
  "template": "term_report_notice",
  "variables": {
    "schoolName": "Accra International School",
    "term": "Term 2",
    "releaseDate": "2026-10-05T09:00:00.000Z"
  },
  "recipients": {
    "target": "all"
  },
  "class": "Basic 7",
  "type": "academic",
  "confirmBroadscope": true
}
```

### 3.5 Example response — `202 Accepted`

```json
{
  "success": true,
  "message": "Bulk email accepted and queued for delivery",
  "data": {
    "jobId": "65f9b2c3d4e5f6a7b8c9d0e1",
    "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
    "template": "term_report_notice",
    "type": "academic",
    "status": "processing",
    "filters": {
      "target": "all",
      "class": "Basic 7"
    },
    "recipientsResolved": 150,
    "recipientsSkipped": 7,
    "skippedWithoutEmail": 41,
    "skippedReasons": {
      "noEmailAddress": 38,
      "unsubscribed": 3
    },
    "quotaRemainingBefore": 850,
    "scheduledAt": null,
    "createdAt": "2026-09-28T09:22:05.000Z",
    "startedAt": "2026-09-28T09:22:06.000Z",
    "completedAt": null
  }
}
```

`recipientsResolved` counts parents with a deliverable address.
`recipientsSkipped` counts parents excluded by consent or data state, and
breaks down in `skippedReasons`. The two are distinct from each other and
from the eligible-but-unaddressed set reported in `skippedWithoutEmail`.

### 3.6 Status codes

| Code | Condition |
|:--|:--|
| `202 Accepted` | Broadcast queued; `data.jobId` returned |
| `400 Bad Request` | No addressable recipients; exceeds 5,000 parents; `target: "all"` without `confirmBroadscope: true`; `target: "class"` without `class`; a template variable was not supplied; `scheduleAt` in the past |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Role not permitted, no school in scope, or the `:schoolId` in the path is not the caller's own school |
| `404 Not Found` | School does not exist or is outside the caller's scope; built-in template not found |
| `409 Conflict` | Idempotency key replayed with a different payload |
| `422 Unprocessable Entity` | Body failed validation |
| `429 Too Many Requests` | The run would exceed the day's remaining quota, or more than 5 bulk jobs per school per hour |

### 3.7 Error example — `400 Bad Request`

```json
{
  "success": false,
  "message": "Broadcast resolves to 0 parents with a deliverable email address. 143 parents matched the filters but none have an email address on record."
}
```

### 3.8 Inspecting and controlling a job

Job progress, per-status tallies, and cancellation follow the same contract as
the SMS module:

| Method | Path | Purpose |
|:--|:--|:--|
| `GET` | `/sms/jobs/:jobId` | Job status, `result` breakdown, per-status counts |
| `POST` | `/sms/jobs/:jobId/cancel` | Stop a `queued` or `processing` run |

Bulk email jobs are readable and cancellable through those endpoints, keyed
by channel, because the two modules share the same job lifecycle. A `GET
/sms/jobs/:jobId` against an email job returns `404`; the correct path for
email is `/email/jobs/:jobId`, and `/sms/jobs/:jobId` is documented here only
to make the shared contract explicit. Treat `GET /email/jobs/:jobId` and
`POST /email/jobs/:jobId/cancel` as required companions to this endpoint.

---

## 4. `GET /email/history`

Retrieve the email log for a school.

**Authentication:** `super_admin`, `school_admin`, `accountant`, `teacher`
**Query parameters:** supported

### 4.1 Description

Returns the school's email log, newest first: every single send and every
message produced by a bulk run. This is both the delivery audit trail and the
evidence of what a parent was told, which is why it is append-only.

Because history stores the **rendered** subject and body, a later correction
to a template never rewrites what a parent received.

The `result` of a bounce is a maintenance queue, not just a log: filtering
`status=bounced` yields the addresses to correct on the student record, and
`status=complained` yields the addresses to suppress. Both are worth
surfacing to an administrator as a standing report.

`meta` carries the pagination cursor: `page` and `perPage` echo the request,
`total` is the number of matching messages and `totalPages` is derived from
them. `perPage` caps at 100; page further for more.

### 4.2 Query parameters

| Parameter | Type | Required | Default | Description |
|:--|:--:|:--:|:--|:--|
| `schoolId` | string | optional | caller's school | `super_admin` only. Omitting it returns a cross-school view. |
| `studentId` | string | optional | — | Filter to one student (24-hex `_id`). |
| `to` | string | optional | — | Filter to a recipient address. |
| `status` | string | optional | — | One of §1.4, or `all`. |
| `type` | string | optional | — | One of §1.5, or `all`. |
| `template` | string | optional | — | Filter to a built-in template name. |
| `jobId` | string | optional | — | Filter to one bulk job. Use with `perPage: 100` to audit a run. |
| `search` | string | optional | — | Case-insensitive match on subject and rendered body. Max 100 characters. |
| `from` | string (ISO 8601) | optional | — | Only messages created at or after this instant. |
| `toDate` | string (ISO 8601) | optional | — | Only messages created at or before this instant. |
| `hasBounce` | boolean | optional | — | `true` returns only `bounced` and `soft_bounced` messages. |
| `page` | integer | optional | `1` | 1-based page number. |
| `perPage` | integer | optional | `20` | 1–100. |
| `sortBy` | string | optional | `createdAt` | `createdAt`, `sentAt`, `deliveredAt`, `openedAt`, `status`. |
| `sortOrder` | string | optional | `desc` | `asc` or `desc`. |

### 4.3 Example request

```http
GET /api/email/history?hasBounce=true&perPage=5 HTTP/1.1
Host: api.sukuupay.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 4.4 Example response — `200 OK`

```json
{
  "success": true,
  "message": "Email history retrieved successfully",
  "data": [
    {
      "id": "65f9d4e5f6a7b8c9d0e1f2a3",
      "schoolId": "65f2a1b3c4d5e6f7g8h9i0j1",
      "studentId": "65f3b2c4d5e6f7g8h9i0j1k2",
      "parentName": "Ama Darko",
      "to": "ama.darko@example.com",
      "subject": "Outstanding fees for Esther Darko (Basic 3)",
      "type": "balance",
      "template": "balance_statement",
      "jobId": null,
      "provider": "brevo",
      "providerMessageId": "<20260928092205.8841203@brevo.example>",
      "status": "bounced",
      "bounceType": "hard",
      "hasHtmlPart": true,
      "hasTextPart": true,
      "createdAt": "2026-09-27T14:02:11.000Z",
      "sentAt": "2026-09-27T14:02:12.000Z",
      "deliveredAt": null,
      "openedAt": null,
      "firstClickedAt": null,
      "failureReason": "550 5.1.1 The email account that you tried to reach does not exist."
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 5,
    "total": 31,
    "totalPages": 7,
    "summary": {
      "delivered": 218,
      "opened": 96,
      "clicked": 41,
      "bounced": 28,
      "softBounced": 3,
      "complained": 1,
      "unsubscribed": 2
    }
  }
}
```

`meta.summary` covers the whole filtered set, not just the current page, so a
bounce dashboard can be drawn from one request.

### 4.5 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | History returned; an empty `data` array is a valid `200` |
| `400 Bad Request` | `from` is later than `toDate` |
| `401 Unauthorized` | Missing, malformed or expired access token |
| `403 Forbidden` | Role not permitted, or no school in scope |
| `422 Unprocessable Entity` | A query parameter failed validation |

### 4.6 Error example — `422 Unprocessable Entity`

```json
{
  "success": false,
  "message": "\"perPage\" must be less than or equal to 100",
  "errors": ["\"perPage\" must be less than or equal to 100"]
}
```

---

## 5. `POST /email/webhooks/brevo`

Delivery, open, click, bounce and complaint events from the provider.
**No authentication header.**

**Authentication:** none — authenticated by a shared secret in the
`X-Brevo-Event-Secret` header instead
**Content-Type:** `application/json`

### 5.1 Description

This is the only way a message reaches `delivered`, `bounced`, `opened` or
`complained`. The provider streams one event per state change; `opened` and
`clicked` can each fire repeatedly, so the handler takes the **first**
occurrence of each and updates the timestamps rather than the status
backwards. An `opened` event arriving after a `bounced` one records
`openedAt` and leaves the status at `bounced`.

Bounces and complaints are the operationally important events: they are what
turn a delivery log into a list of addresses to correct or suppress.

**Always answer `200`** once the secret verifies, even for an unknown
`messageId`. The provider retries non-2xx responses, and retrying an event
for a message this platform does not have burns the provider's retry budget
for no benefit. Unknown references are logged, not rejected.

The handler must respond within 5 seconds; process events asynchronously.

### 5.2 Request headers

| Header | Type | Required | Description |
|:--|:--:|:--:|:--|
| `X-Brevo-Event-Secret` | string | ✔ | Shared secret configured on the provider's event account. Compared in constant time. |

### 5.3 Request body

| Field | Type | Required | Description |
|:--|:--:|:--:|:--|
| `events` | array | ✔ | One or more events. Brevo batches them. |
| `events[].messageId` | string | ✔ | The `providerMessageId` SukuuPay supplied when sending. |
| `events[].event` | string | ✔ | `delivered`, `soft_bounce`, `hard_bounce`, `opened`, `clicked`, `spam`, `unsubscribed`, `blocked`, or `deferred` — these are Brevo's wire names, not this module's internal status names. |
| `events[].date` | string (ISO 8601) | optional | When the provider observed the event. Defaults to receipt time. |
| `events[].reason` | string | optional | SMTP or provider reason, present on bounces. |
| `events[].url` | string | optional | Clicked or opened URL, present on `clicked` and `opened`. Brevo sends this as `link`, which is normalised on receipt. |
| `events[].ip` | string | optional | Originating IP, present on `clicked`. |

### 5.4 Example request

```http
POST /api/email/webhooks/brevo HTTP/1.1
Host: api.sukuupay.com
X-Brevo-Event-Secret: whsec_3f9a1c9d2b4e7f0a3c5d8e1b
Content-Type: application/json
```

```json
{
  "events": [
    {
      "messageId": "<20260928092205.8841203@brevo.example>",
      "event": "delivered",
      "date": "2026-09-28T09:22:41.000Z"
    },
    {
      "messageId": "<20260927140211.7719034@brevo.example>",
      "event": "hard_bounce",
      "date": "2026-09-27T14:04:02.000Z",
      "reason": "550 5.1.1 The email account that you tried to reach does not exist."
    }
  ]
}
```

### 5.5 Example response — `200 OK`

```json
{
  "received": true,
  "processed": 2
}
```

`401 Unauthorized` for a missing or mismatched secret:

```json
{
  "success": false,
  "message": "Invalid webhook secret"
}
```

### 5.6 Status codes

| Code | Condition |
|:--|:--|
| `200 OK` | Events accepted, including for unknown message references |
| `400 Bad Request` | Body is not valid JSON, `events` is missing or empty, or an event name is unrecognised |
| `401 Unauthorized` | Missing or mismatched `X-Brevo-Event-Secret` |

---

## Appendix A — Recipient addressing and the missing-email problem

`email` on the parent sub-document is **optional and defaults to `null`**.
`phone` is `required`. This asymmetry shapes the whole module.

**Parent sub-documents are declared with `_id: false`.** A parent therefore
has no ObjectId, and cannot be addressed by one. The addressing options are:

| Selector | Resolves to |
|:--|:--|
| `studentId` + `recipient: "primary"` | The parent flagged `isPrimary: true`, falling back to the first parent on record |
| `studentId` + `recipient: "all"` | Every parent on the student that has an address |
| `studentId` + `recipient: "primary_indexed"` + `recipientIndex` | One parent by zero-based position |

If a future change to the parent schema adds `_id: true`, a `parentId`
selector should be added alongside these rather than replacing them.

**Planning a bulk run.** Before the first campaign, measure the addressable
share:

```http
GET /api/students?perPage=100&class=Basic 7
```

and count parents with a non-null `email`. A first run on a school whose
records were entered before email capture will typically address well under
half the roll. The job reports `skippedWithoutEmail` so this is visible
immediately rather than after parents complain.

**Recommended sequencing.** SMS is the primary channel; email carries the
long-form or documentary content. For a parent with a number but no address,
a bulk run that silently omits them is worse than one that falls back to SMS
— but this module does not implement that fallback, deliberately, because
duplicating a fee notice across two channels invites the parent to pay twice.
Decide the channel at the point of sending.

---

## Appendix B — Built-in templates

Templates are code-defined in `src/templates/emails.js`, which returns
`{ subject, html }` from a shared branded shell. `html` is present; the
plain-text `text` part required by §1.1 is **not yet produced** by these
templates (see Appendix H).

| Name | Subject | Required variables | Typical `type` |
|:--|:--|:--|:--|
| `verification_email` | Verify your SukuuPay email address | `name`, `otp`, `expiresInMinutes` | `general` |
| `password_reset` | Reset your SukuuPay password | `name`, `token`, `expiresInMinutes` | `general` |
| `password_changed` | Your SukuuPay password was changed | `name` | `general` |
| `invitation` | You have been invited to join SukuuPay | `name`, `otp`, `expiresInMinutes`, `inviter` | `general` |
| `balance_statement` | Outstanding fees for {{studentName}} | `studentName`, `balance`, `deadline` | `balance` |
| `payment_receipt` | Payment receipt for {{studentName}} | `studentName`, `amount`, `paymentId`, `paidAt` | `receipt` |
| `payment_plan_installment` | Installment {{installmentNumber}} due for {{studentName}} | `studentName`, `installmentNumber`, `totalInstallments`, `dueDate`, `amount` | `payment_plan` |
| `term_report_notice` | {{term}} reports are now available | `schoolName`, `term`, `releaseDate` | `academic` |
| `announcement` | Notice from {{schoolName}} | `schoolName`, `headline`, `body`, `closingDate` | `announcement` |

The first four are the platform's own transactional mail and are used
internally by the auth flow; they are not available to school admins through
`/email/bulk`.

Placeholders in school-facing templates mirror the SMS module's list, plus
`headline`, `body`, `closingDate`, `paymentId`, `paidAt`, `term` and
`releaseDate`. Money placeholders render as formatted cedis.

---

## Appendix C — Provider configuration

Delivery uses the **Brevo** (formerly Sendinblue) REST API, configured
entirely through environment variables — not per school. There is one platform
sender identity for all schools.

| Variable | Purpose | Present in this repo |
|:--|:--|:--:|
| `BREVO_API_KEY` | API key sent as the `api-key` header | `src/config/env.js:26` |
| `BREVO_API_URL` | Transactional send endpoint, default `https://api.brevo.com/v3/smtp/email` | `src/config/env.js:27` |
| `SMTP_FROM` | Sender address, used as `sender.email` | `src/config/env.js:28` |
| `SMTP_FROM_NAME` | Sender display name, default `SukuuPay` | `src/config/env.js:29` |
| `BREVO_EVENT_SECRET` | Shared secret for the event webhook (§5) | `src/config/env.js` |

Consequences of a platform-level sender:

- All schools share one sending reputation and one daily quota. A school's
  volume competes with every other school's.
- A bounce or spam complaint against one school's traffic degrades delivery
  for all of them, which is the strongest argument for keeping the
  `confirmation` and suppression fields honoured.
- The event callback URL registered with the provider is
  `{API_BASE_URL}/api/email/webhooks/brevo`.

---

## Appendix D — Data model reference

**`EmailMessage`** — one per recipient per send.

| Field | Type | Notes |
|:--|:--|:--|
| `schoolId` | ObjectId → School | Indexed |
| `studentId` | ObjectId → Student | Null for a platform-transactional send |
| `parentName`, `to` | string | Snapshot at send time, so a later parent edit does not rewrite history |
| `subject` | string | **Rendered**, not a template reference |
| `type` | string | §1.5 vocabulary |
| `template` | string | Built-in template name, null for a custom body |
| `jobId` | ObjectId → EmailJob | Null for single sends |
| `provider`, `providerMessageId` | string | `providerMessageId` indexed — it is the callback lookup key |
| `status` | string | §1.4 vocabulary, indexed |
| `bounceType` | string | `hard` or `soft`, set from the callback |
| `hasHtmlPart`, `hasTextPart` | boolean | Exposed so a client can spot a non-compliant send |
| `isCc`, `isBcc` | boolean | Distinguishes copies from the primary recipient |
| `failureReason` | string | SMTP or provider reason |
| `createdAt`, `sentAt`, `deliveredAt`, `openedAt`, `firstClickedAt` | Date | First occurrence only; repeated opens do not move the timestamp |
| `createdBy` | ObjectId → User | |
| `deletedAt` | Date | Soft delete, indexed — reserved, not exposed on any endpoint |

**`EmailJob`** — one per bulk run.

| Field | Type | Notes |
|:--|:--|:--|
| `schoolId` | ObjectId → School | Indexed |
| `channel` | string | `email`; distinguishes an email job from an SMS job sharing the lifecycle |
| `template` | string | |
| `type` | string | §1.5 vocabulary |
| `status` | string | `queued`, `processing`, `cancelling`, `cancelled`, `completed`, `failed` |
| `filters` | Mixed | Resolved filter set, echoed for audit |
| `recipientsResolved` | integer | Parents with a deliverable address |
| `recipientsSkipped` | integer | Excluded by consent or data state |
| `skippedWithoutEmail` | integer | Eligible but no address on record |
| `skippedReasons` | Mixed | e.g. `{ "noEmailAddress": 38, "unsubscribed": 3 }` |
| `result` | Mixed | Per-status tally once the run finishes |
| `quotaRemainingBefore` | integer | Snapshot taken at acceptance |
| `scheduledAt`, `startedAt`, `completedAt` | Date | |
| `cancelledAt`, `cancellationReason` | Date, string | |
| `failureReason` | string | Set when the job itself fails |
| `createdBy` | ObjectId → User | |

**`EmailPreference`** — consent and suppression, per address.

| Field | Type | Notes |
|:--|:--|:--|
| `email` | string | Lowercased; uniquely indexed |
| `unsubscribed` | boolean | Blocks every category platform-wide |
| `unsubscribedAt` | Date | |
| `bounced` | boolean | Hard-bounced; blocks platform-wide |
| `bouncedAt` | Date | |
| `complainedAt` | Date | Spam complaint; blocks platform-wide |
| `optInCategories` | string[] | Empty means opted in to all |

Suppression is platform-wide rather than per school on purpose: otherwise the
same dead address gets mailed by every school on the platform and the shared
sending reputation degrades for everyone (Appendix C).

**Recommended indexes**

```
EmailMessage:     { schoolId, createdAt: -1 }
                  { schoolId, status }
                  { schoolId, to }
                  { schoolId, studentId, createdAt: -1 }
                  { providerMessageId }                     (callback lookup)
                  { jobId }
EmailJob:         { schoolId, createdAt: -1 }
                  { schoolId, status }
EmailPreference:  { email }                                 (unique)
```

---

## Appendix E — Error reference

| Status | Message pattern | Likely cause |
|:--:|:--|:--|
| `400` | `The selected parent (…) has no email address on record…` | Parent record has no address; add one or send explicitly |
| `400` | `Template … requires N variables but M were supplied…` | Incomplete `variables` |
| `400` | `Broadcast resolves to 0 parents with a deliverable email address…` | Filters matched parents who all lack addresses |
| `400` | `recipientIndex N is out of range…` | Fewer parents on the student than expected |
| `401` | `Authentication required` | No bearer token |
| `401` | `Access token expired` | Re-authenticate |
| `401` | `Invalid webhook secret` | Mismatched `X-Brevo-Event-Secret` |
| `403` | `You do not have access to this resource` | Role not permitted |
| `403` | `No school in scope` | Account has no `schoolId` |
| `404` | `Student not found` | Wrong id, or another school's student |
| `404` | `Template not found` | Unknown `template` name |
| `409` | `An email with this Idempotency-Key already exists with a different payload` | Key reuse |
| `422` | `"<field>" …` plus an `errors` array | Joi validation failed |
| `429` | `Daily sending quota exhausted (N per day, M used)…` | Provider quota; wait for Accra midnight |
| `502` | `Provider rejected the send…` | Provider-side rejection; retry may succeed |

---

## Appendix F — Compliance notes

Ghana's Data Protection Act, 2012 (Act 843) governs the personal data this
module processes: parent names, email addresses, and fee and attendance
balances. Unsolicited commercial bulk email is separately restricted
internationally (CAN-SPAM, GDPR where a parent is in the EU).

- **Consent.** Bulk sends default to `confirmation: "none"`, which assumes the
  school holds a lawful basis for fee-related communication. Set
  `confirmation: "opt_in"` to restrict a campaign to parents who opted in, and
  `opt_out` to honour opt-outs. Suppressed parents are counted in
  `skippedReasons.unsubscribed` rather than messaged.
- **Unsubscribe.** Every bulk message must carry a `List-Unsubscribe` header
  and a visible unsubscribe link. A single click must suppress that address
  for **all** categories, not just the campaign that carried the link.
- **One-click unsubscribe.** A `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  header is emitted for bulk runs so compliant mail clients can process an
  unsubscribe without visiting a page.
- **Bounce hygiene.** An address that hard-bounces or is marked as spam must
  be suppressed platform-wide, not just in this school's history. Otherwise
  the same dead address is mailed by every school on the platform and the
  sending reputation degrades for everyone.
- **Open and click data.** Tracking pixels and link rewriting are personal
  data under the Act. They are recorded in history as timestamps, not as a
  browsing profile, and should not be used to gate a decision.
- **Transport.** All endpoints are HTTPS-only; the event callback is
  secret-verified because it cannot carry a bearer token (§5).

---

## Appendix G — Endpoint index

| # | Method | Path | Roles | Success |
|:--:|:--|:--|:--|:--|
| 2 | `POST` | `/email/single` | `super_admin`, `school_admin`, `accountant` | `200` |
| 3 | `POST` | `/email/bulk/:schoolId` | `super_admin`, `school_admin`, `accountant` | `202` |
| 4 | `GET` | `/email/history` | `super_admin`, `school_admin`, `accountant`, `teacher` | `200` |
| 5 | `POST` | `/email/webhooks/brevo` | secret only | `200` |

All paths are prefixed with `/api`.

---

## Appendix H — Implementation gaps in the current codebase

> **Status: closed.** This appendix originally described the gaps between this
> specification and the pre-existing codebase, and is kept as the record of what
> the work involved. Every gap listed below is now implemented; the module was
> built against this document and verified end to end.

This specification describes endpoints that **do not exist yet**. The
following gaps in existing code must be closed for the module to behave as
documented, and are listed so the work is not mistaken for configuration.

1. **No `EmailMessage` or `EmailJob` model.** Nothing is persisted today —
   `sendEmail` is fire-and-forget, so there is no history to read and no
   record to attach provider events to. Both models are specified in
   Appendix D's shape (`id`, `schoolId`, `studentId`, `to`, `subject`,
   `template`, `type`, `providerMessageId`, `status`, the timestamp set, and
   `bounceType`).
2. **No text part.** `sendEmail` sends only `htmlContent`. §1.1 requires a
   plain-text alternative on every message; the built-in templates in
   `src/templates/emails.js` return `{ subject, html }` and would need a
   `text` field derived from the same content.
3. **No persistence before the call.** A provider failure currently throws
   after the message is lost. The documented lifecycle requires the record to
   exist with status `queued` before the provider is called, so a failure
   becomes a `failed` row rather than a gap.
4. **No `replyTo`, `cc`, `bcc`, `tags` or `List-Unsubscribe` support** in the
   `sendEmail` payload, all of which §2.2 and Appendix F rely on.
5. **No idempotency.** Repeated submission sends repeatedly. The
   `Idempotency-Key` behaviour in §1.6 needs a store and a unique constraint
   on (key, schoolId).
6. **`BREVO_EVENT_SECRET` is undefined** in `src/config/env.js`; §5 cannot be
   implemented until it exists, and its absence is a security hole if left
   open — an unauthenticated endpoint that mutates delivery state.
7. **Errors are untyped.** `sendEmail` throws plain `Error`s, so a provider
   rejection surfaces as `500` rather than the `502` §2.5 documents, and the
   per-recipient failure reason is not captured.
8. **No quota tracking.** `GET /email/credits`-equivalent daily-quota
   reporting has no backing field; a count of today's messages is the
   minimum viable source.
