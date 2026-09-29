# School Reports API — Technical Specification

> Status: **Implemented** — routes, controller, service, and validation exist.
> Files: `src/routes/reports.routes.js`, `src/controllers/reports.controller.js`,
> `src/services/reports.service.js`, `src/validations/reports.validation.js`,
> `src/utils/reportExport.js` (serialisers). Registered in `src/routes/index.js`
> and served under `/api/reports`.

This document specifies nine `GET` endpoints under `/reports/:report/:schoolId`,
each producing a printable / exportable report for a single school. The module
sits alongside `docs/analytics-api-spec.md`: **analytics** endpoints feed
dashboard charts and KPI cards, while **reports** endpoints produce document-style
output — a dated header, summary totals, a detail table, and an optional
`format` export (CSV / Excel / PDF).

---

## 1. Conventions Inherited from the Codebase

| Concern | Pattern | Source references |
|---|---|---|
| **Money storage** | All monetary values are **integer pesewas** (1 GHS = 100 pesewas). Display strings are optional `*Display` fields. | `formatters.js:8`, `studentModel.js:147`, `paymentPlanModel.js:83` |
| **`:schoolId` scoping** | `resolveSchoolId(user, explicitSchoolId)` — `super_admin` may pass any `:schoolId`; every other role is locked to `user.schoolId` from the JWT. Path param is still validated with the 24-char hex `objectId` pattern. Note: this helper is currently re-declared per service file rather than shared. | `paymentPlan.service.js:37`, `student.service.js:37`, `analytics.service.js:24` |
| **Soft delete** | Every query filters `deletedAt: null`. | All service files |
| **Auth** | `authenticate` (JWT) → `authorize(...)` role check. Reports require `super_admin` or `school_admin`. | `authenticate.js:11`, `paymentPlan.routes.js:32` |
| **Validation** | Joi with `objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/)`. | `paymentPlan.validation.js:31`, `analytics.validation.js:3` |
| **Response envelope** | `{ success: true, message, data, meta? }` for the default (JSON) response. | `paymentPlan.controller.js:19` |
| **Date handling** | All dates in `Africa/Accra` (UTC+0, no DST). `startOfDayAccra`, `endOfDayAccra`, `addDays`, `addMonths` helpers exist and are the correct primitives for daily/monthly report boundaries. | `dateHelpers.js:7-81` |
| **Pagination** | `page` (default `1`) and `perPage` (default `50`, max `200`) for row-level reports. | `analytics.validation.js:53-54` |

### 1.1 Money, dates, and enums used by these reports

- **Amounts** are integer pesewas. `GHS 2,000.00` is `200000`.
- **`paymentMethod`** enum: `momo | card | bank_transfer | cash` (`paymentModel.js:61-65`).
- **`Payment.status`** enum: `pending | processing | completed | failed | cancelled | refunded`
  (`paymentModel.js:55-60`). Only `completed` payments count toward collected
  totals and only they carry a `receiptNumber`.
- **Installment `status`** enum: `pending | paid | partial | overdue | waived`
  (`paymentPlanModel.js:22`).
- **`Plan.planStatus`** enum: `pending_acceptance | active | completed | defaulted | cancelled | expired`.
- **`academicYear`** format is `\d{4}/\d{4}` (e.g. `2025/2026`).
- **Term** is a free-text label in this codebase (no term model); existing
  validation uses `Joi.string().trim().max(20)` — e.g. `term1`, `term2`, `term3`.
- **Dates** in the API are ISO-8601. Report *day* boundaries are computed in
  Accra time, so a `date=2025-03-04` daily report covers
  `2025-03-04T00:00:00+00:00` → `2025-03-04T23:59:59.999+00:00`.

---

## 2. Universal `format` Query Parameter

**Every endpoint in this document accepts the optional `format` query
parameter.** It is the only query parameter common to all nine reports, and it
is documented here once so it does not have to be repeated in every table —
but it applies to all of them.

| Field | Value |
|---|---|
| **Parameter** | `format` |
| **Required** | No. Omit (or leave empty) to get the default JSON response. |
| **Type** | string |
| **Valid values** | `csv`, `excel`, `pdf` |
| **Default** | `json` (i.e. parameter omitted) — returns the standard `{ success, message, data, meta }` envelope |
| **Invalid value** | `422 Unprocessable Entity` — e.g. `?format=docx` is rejected, not silently coerced. (The shared `validate` middleware answers `422`, not `400`; see §6.) |

**Behaviour when `format` is supplied**

| `format` | HTTP response | `Content-Type` | Filename disposition |
|---|---|---|---|
| *(omitted)* | `200` JSON envelope | `application/json; charset=utf-8` | — |
| `csv` | `200` file stream | `text/csv; charset=utf-8` | `attachment; filename="<report>-<schoolId>-<stamp>.csv"` |
| `excel` | `200` file stream | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `attachment; filename="<report>-<schoolId>-<stamp>.xlsx"` |
| `pdf` | `200` file stream | `application/pdf` | `attachment; filename="<report>-<schoolId>-<stamp>.pdf"` |

**Notes for implementers**

- When `format` is present the response is a **file**, not the JSON envelope —
  clients must not attempt to parse `data`/`meta`.
- `csv` and `excel` are served from the already-installed `xlsx` package
  (`package.json:28`) — both verified working. **No PDF library is a
  dependency**, so `format=pdf` currently returns `501 PDF_EXPORT_UNAVAILABLE`
  with a message naming the fix (`pdfkit` or similar). It is validated as a
  legal value so the parameter is future-proof.
- Exports are generated from the **same** filtered dataset as the JSON response:
  the service builds the rows first, then the serialiser renders them. The
  service also bypasses pagination whenever `format` is set, so a CSV contains
  every matching row rather than silently the first 50.
- The response envelope in this document therefore describes the `json` path
  only.
- Exports arrive as multiple blocks (summary, then detail sections) — one
  section per sheet in Excel, stacked tables in CSV.

```js
// Shared export fragment — applied by every report controller
const format = (req.query.format || "json").toLowerCase();
if (["csv", "excel", "pdf"].includes(format)) {
  return sendReportFile(res, rows, { report, schoolId, format });
}
return res.json({ success: true, message, data, meta });
```

Validation (Joi), shared by all nine endpoints:

```js
const formatSchema = Joi.string()
  .trim()
  .lowercase()
  .valid("csv", "excel", "pdf")
  .optional()
  .allow("", null);
```

---

## 3. Endpoint Index

All endpoints: **Method** `GET` · **Auth** `authenticate` +
`authorize("super_admin", "school_admin")` · **Required path parameter**
`:schoolId` (24-char hex ObjectId) · **Universal query parameter** `format`
(`csv` | `excel` | `pdf`).

| # | Path | Report | Primary audience |
|---|---|---|---|
| 3.1 | `/reports/daily/:schoolId` | Daily collection report | Bursar / cashier, end-of-day reconciliation |
| 3.2 | `/reports/term/:schoolId` | Term report | Headmaster, termly board pack |
| 3.3 | `/reports/outstanding/:schoolId` | Outstanding balances | Bursar, collections follow-up |
| 3.4 | `/reports/compliance/:schoolId` | Installment compliance report | Headmaster, plan performance |
| 3.5 | `/reports/payment-methods/:schoolId` | Payment method breakdown | Finance, channel mix analysis |
| 3.6 | `/reports/class-collections/:schoolId` | Class-wise collections | Headmaster, class-level comparison |
| 3.7 | `/reports/parent-contacts/:schoolId` | Parent contact list | Admin, arrears chasing |
| 3.8 | `/reports/overdue/:schoolId` | Overdue students report | Bursar, escalation list |
| 3.9 | `/reports/headmaster-monthly/:schoolId` | Monthly headmaster summary | Headmaster, monthly review |

---

## 4. Endpoint Documentation

### 4.1 Daily Collection Report

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/reports/daily/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Path parameters** | `:schoolId` — **required**, 24-char hex ObjectId. Honored for `super_admin`; derived from the JWT for `school_admin`. |
| **Query parameters** | `date`, `class`, `paymentMethod`, `status`, `page`, `perPage`, `format` |
| **Returns** | JSON envelope, or a CSV / Excel / PDF file when `format` is set |

**Purpose**: Produces the end-of-day cash-and-momo reconciliation sheet — every
payment received in a single Accra day, with per-row receipts and a footer of
totals by method. This is the report a cashier prints at close of business and
ties back to the bank/momo statement.

| Query param | Type | Required | Default | Description |
|---|---|---|---|---|
| `date` | ISO-8601 date | No | Today (Accra) | The reporting day. Range = `startOfDayAccra(date)` → `endOfDayAccra(date)`. |
| `class` | string | No | all classes | Restrict to one `Student.studentClass`. |
| `paymentMethod` | enum | No | all | `momo` \| `card` \| `bank_transfer` \| `cash` |
| `status` | enum | No | `completed` | `pending` \| `processing` \| `completed` \| `failed` \| `cancelled` \| `refunded` |
| `page` | integer ≥ 1 | No | `1` | Row pagination for the JSON response. Ignored for single-file exports. |
| `perPage` | integer 1–200 | No | `50` | Rows per page. |
| `format` | enum | No | `json` | `csv` \| `excel` \| `pdf` — see §2. |

**Notes**: The footer totals group by `paymentMethod` for the filtered set. Rows
sorted by `completedAt` ascending (falls back to `createdAt` for non-completed
statuses) so the sheet reads chronologically.

---

### 4.2 Term Report

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/reports/term/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Path parameters** | `:schoolId` — **required**, 24-char hex ObjectId. |
| **Query parameters** | `academicYear`, `term`, `class`, `format` |
| **Returns** | JSON envelope, or a CSV / Excel / PDF file when `format` is set |

**Purpose**: The termly financial statement for the whole school — billed,
collected, outstanding, and the per-class and per-month position across a full
term. This is the document a headmaster signs off on for a term's board report.

| Query param | Type | Required | Default | Description |
|---|---|---|---|---|
| `academicYear` | `\d{4}/\d{4}` | No | `school.academic.currentYear` | Academic year, e.g. `2025/2026`. |
| `term` | string | No | all terms in the year | Term label, e.g. `term1`, `term2`, `term3`. |
| `class` | string | No | all classes | Restrict to one `Student.studentClass`. |
| `format` | enum | No | `json` | `csv` \| `excel` \| `pdf` — see §2. |

**Notes**: There is no term calendar in the schema, so the window is derived
from the academic year label using the Ghanaian **September–August** academic
year, split into `termsPerYear` blocks of whole calendar months — a 3-term year
resolves to Sept–Dec / Jan–Apr / May–Aug. Terms are deliberately *not* split
into equal millisecond spans, which would produce arbitrary mid-week cut points.
Window ends are the true last instant of the day (`23:59:59.999`) so that a
payment at 23:59:59 on the last day of a term falls in exactly one term.

> **Caveat:** if a school's real term dates differ from the derived blocks, the
> `School.academic` schema should gain explicit per-term start/end dates and
> `resolveTermWindow` should read them. Today the derivation is an assumption,
> documented so it can be replaced rather than reverse-engineered.

The report body has four sections — term summary, per-class breakdown,
per-month collection trend, and a top-owing-students appendix. With `format=csv`
the sections are emitted as separate sheets (Excel) or stacked tables (CSV),
because a flat CSV cannot nest.

> **Note on `academicYear`:** students store the full `\d{4}/\d{4}` label while
> `School.academic.currentYear` holds a bare year (`"2026"`), so the report
> filters on `academicYear` **only** when the caller supplies the full form.
> Filtering on the school's bare year would match nothing.

---

### 4.3 Outstanding Balances

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/reports/outstanding/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Path parameters** | `:schoolId` — **required**, 24-char hex ObjectId. |
| **Query parameters** | `academicYear`, `class`, `minAmount`, `minAgeDays`, `status`, `sortBy`, `sortOrder`, `page`, `perPage`, `format` |
| **Returns** | JSON envelope, or a CSV / Excel / PDF file when `format` is set |

**Purpose**: A debtor ledger — every student with `Student.balance > 0`, showing
what is owed, how long it has been outstanding, and the contact needed to chase
it. This is the working list the collections team works from.

| Query param | Type | Required | Default | Description |
|---|---|---|---|---|
| `academicYear` | `\d{4}/\d{4}` | No | all | Scope balances to one academic year. |
| `class` | string | No | all classes | Restrict to one class. |
| `minAmount` | integer pesewas | No | `0` | Only students owing at least this amount. |
| `minAgeDays` | integer ≥ 0 | No | `0` | Only balances older than N days (based on the oldest unpaid installment `dueDate`). |
| `status` | enum | No | `all` | `not_paid` \| `partial` \| `all` — filters by whether any money has been received. |
| `sortBy` | enum | No | `balance` | `balance` \| `studentName` \| `studentClass` \| `oldestDueDate` |
| `sortOrder` | enum | No | `desc` | `asc` \| `desc` |
| `page` | integer ≥ 1 | No | `1` | Row pagination. |
| `perPage` | integer 1–200 | No | `50` | Rows per page. |
| `format` | enum | No | `json` | `csv` \| `excel` \| `pdf` — see §2. |

**Notes**: `Student.balance` is recomputed from source-of-truth fields on save
(`totalOwed - totalPaid`, `studentModel.js:315-316`) and is the authoritative
figure — do not recompute it in the report. Parent phone numbers are **masked**
via `maskPhone` (`student.service.js:76`); unmasked numbers never leave the
single-student detail endpoint.

---

### 4.4 Installment Compliance Report

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/reports/compliance/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Path parameters** | `:schoolId` — **required**, 24-char hex ObjectId. |
| **Query parameters** | `academicYear`, `term`, `class`, `planStatus`, `page`, `perPage`, `format` |
| **Returns** | JSON envelope, or a CSV / Excel / PDF file when `format` is set |

**Purpose**: How reliably plans are being honoured — the percentage of
installments paid on or before their `dueDate`, broken out by plan status. A
document-grade companion to the dashboard's compliance ring.

| Query param | Type | Required | Default | Description |
|---|---|---|---|---|
| `academicYear` | `\d{4}/\d{4}` | No | all | Academic year filter. |
| `term` | string | No | all | Term filter. |
| `class` | string | No | all classes | Restrict to one class. |
| `planStatus` | enum | No | `active` | `pending_acceptance` \| `active` \| `completed` \| `defaulted` \| `cancelled` \| `expired` |
| `page` | integer ≥ 1 | No | `1` | Row pagination. |
| `perPage` | integer 1–200 | No | `50` | Rows per page. |
| `format` | enum | No | `json` | `csv` \| `excel` \| `pdf` — see §2. |

**Notes**: Extends the existing `getSchoolCompliance` classification buckets
(`on_track`, `approaching_due`, `overdue`, `completed`, `defaulted` —
`paymentPlan.service.js:796`) into a per-plan table with the same counts.

---

### 4.5 Payment Method Breakdown

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/reports/payment-methods/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Path parameters** | `:schoolId` — **required**, 24-char hex ObjectId. |
| **Query parameters** | `startDate`, `endDate`, `groupBy`, `academicYear`, `class`, `format` |
| **Returns** | JSON envelope, or a CSV / Excel / PDF file when `format` is set |

**Purpose**: Shows how money came in — the amount and count of payments per
`paymentMethod` (momo / card / bank transfer / cash), optionally split by month,
term, or class. Used to confirm cash-in-hand reconciles and to track digital
adoption.

| Query param | Type | Required | Default | Description |
|---|---|---|---|---|
| `startDate` | ISO-8601 date | No | start of current term | Inclusive lower bound on `completedAt`. |
| `endDate` | ISO-8601 date | No | today (Accra) | Inclusive upper bound on `completedAt`. Must not precede `startDate`. |
| `groupBy` | enum | No | `method` | `method` \| `month` \| `term` \| `class` — controls the breakdown dimension. |
| `academicYear` | `\d{4}/\d{4}` | No | all | Academic year filter. |
| `class` | string | No | all classes | Restrict to one class. |
| `format` | enum | No | `json` | `csv` \| `excel` \| `pdf` — see §2. |

**Notes**: `groupBy` must be checked against an allow-list before it reaches the
`$group` key, to prevent arbitrary field injection. Each bucket reports
`amount`, `count`, and `percentage` of total collected; only `status =
completed` payments are counted. This is the natural source for a pie/bar
chart as well as a one-page PDF summary.

---

### 4.6 Class-wise Collections

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/reports/class-collections/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Path parameters** | `:schoolId` — **required**, 24-char hex ObjectId. |
| **Query parameters** | `academicYear`, `term`, `startDate`, `endDate`, `sortBy`, `sortOrder`, `format` |
| **Returns** | JSON envelope, or a CSV / Excel / PDF file when `format` is set |

**Purpose**: Compares every class side by side on billed vs collected vs
balance, ranked by collection rate. It answers "which classes are behind?" in
one table and is the standard page in the headmaster's term pack.

| Query param | Type | Required | Default | Description |
|---|---|---|---|---|
| `academicYear` | `\d{4}/\d{4}` | No | `school.academic.currentYear` | Academic year filter. |
| `term` | string | No | all terms | Term filter. |
| `startDate` | ISO-8601 date | No | — | Inclusive lower bound when a custom window is needed. |
| `endDate` | ISO-8601 date | No | — | Inclusive upper bound; must not precede `startDate`. |
| `sortBy` | enum | No | `collectionRate` | `className` \| `expected` \| `collected` \| `balance` \| `collectionRate` |
| `sortOrder` | enum | No | `asc` | `asc` \| `desc` — `asc` on `collectionRate` puts the worst performers first. |
| `format` | enum | No | `json` | `csv` \| `excel` \| `pdf` — see §2. |

**Notes**: One row per distinct `Student.studentClass`. `expected` is the sum of
`Student.totalOwed`, `collected` the sum of `Student.totalPaid`, and
`collectionRate = collected / expected * 100` (guard `expected = 0` to avoid
division by zero for empty classes).

---

### 4.7 Parent Contact List

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/reports/parent-contacts/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Path parameters** | `:schoolId` — **required**, 24-char hex ObjectId. |
| **Query parameters** | `class`, `relationship`, `onlyPrimary`, `onlyWithBalance`, `search`, `sortBy`, `sortOrder`, `page`, `perPage`, `format` |
| **Returns** | JSON envelope, or a CSV / Excel / PDF file when `format` is set |

**Purpose**: A flat directory of students and their parents/guardians, for
envelopes, SMS blasts, and arrears follow-up. Flattens the `parents[]` subdocument
array into one row per parent.

| Query param | Type | Required | Default | Description |
|---|---|---|---|---|
| `class` | string | No | all classes | Restrict to one class. |
| `relationship` | enum | No | all | `father` \| `mother` \| `guardian` \| `other` |
| `onlyPrimary` | boolean | No | `false` | Only the primary contact per student. |
| `onlyWithBalance` | boolean | No | `false` | Only students owing money — the arrears-chasing subset. |
| `search` | string | No | — | Case-insensitive match on `studentName`, `studentId`, or `parentName`. |
| `sortBy` | enum | No | `studentName` | `studentName` \| `studentClass` \| `parentName` |
| `sortOrder` | enum | No | `asc` | `asc` \| `desc` |
| `page` | integer ≥ 1 | No | `1` | Row pagination. |
| `perPage` | integer 1–200 | No | `50` | Rows per page. |
| `format` | enum | No | `json` | `csv` \| `excel` \| `pdf` — see §2. |

**Notes**: One student with two parents yields two rows. Phone numbers are
**masked by default** via `maskPhone` (`student.service.js:76`); an explicit
unmasked variant is deliberately **not** offered here, because exports are
spreadsheet-shaped and trivially forwarded. This report contains no financial
data unless `onlyWithBalance=true` adds the balance column.

---

### 4.8 Overdue Students Report

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/reports/overdue/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Path parameters** | `:schoolId` — **required**, 24-char hex ObjectId. |
| **Query parameters** | `academicYear`, `term`, `class`, `severity`, `minDaysOverdue`, `planStatus`, `sortBy`, `sortOrder`, `page`, `perPage`, `format` |
| **Returns** | JSON envelope, or a CSV / Excel / PDF file when `format` is set |

**Purpose**: The escalation list — students with at least one installment whose
`status` is `overdue`, with days-overdue per installment and a total overdue
amount, ready to print and carry into a parents' meeting.

| Query param | Type | Required | Default | Description |
|---|---|---|---|---|
| `academicYear` | `\d{4}/\d{4}` | No | all | Academic year filter. |
| `term` | string | No | all | Term filter. |
| `class` | string | No | all classes | Restrict to one class. |
| `severity` | enum | No | `all` | `warning` (< 14 days overdue) \| `critical` (≥ 14 days) \| `all` |
| `minDaysOverdue` | integer ≥ 0 | No | `0` | Only rows at least this many days past `dueDate`. |
| `planStatus` | enum | No | all | Filter by owning plan's `planStatus`. |
| `sortBy` | enum | No | `daysOverdue` | `daysOverdue` \| `totalOverdueAmount` \| `studentName` \| `studentClass` |
| `sortOrder` | enum | No | `desc` | `asc` \| `desc` — worst-first by default. |
| `page` | integer ≥ 1 | No | `1` | Row pagination. |
| `perPage` | integer 1–200 | No | `50` | Rows per page. |
| `format` | enum | No | `json` | `csv` \| `excel` \| `pdf` — see §2. |

**Notes**: Relies on `sweepPlanStatuses` (`paymentPlan.service.js:911`), which
flips `pending`/`partial` installments to `overdue` once their `dueDate` has
passed — overdue is defined by `isInstallmentOverdue` (`planHelpers.js:174`).
This report is a read-side view of that state; it must not re-derive overdue
status independently, or the two will disagree. Default sorting is worst-first,
matching the intent of the report.

---

### 4.9 Monthly Headmaster Summary

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/reports/headmaster-monthly/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Path parameters** | `:schoolId` — **required**, 24-char hex ObjectId. |
| **Query parameters** | `month`, `academicYear`, `term`, `includeHeadcount`, `format` |
| **Returns** | JSON envelope, or a CSV / Excel / PDF file when `format` is set |

**Purpose**: The one-page monthly briefing for the headmaster — collected,
outstanding, collection rate, headcount, and the month's notable movements,
with a month-on-month comparison to the previous month. Designed to be printed
as a single PDF and filed.

| Query param | Type | Required | Default | Description |
|---|---|---|---|---|
| `month` | `YYYY-MM` | No | current month (Accra) | The reporting month. |
| `academicYear` | `\d{4}/\d{4}` | No | `school.academic.currentYear` | Academic year context for the term breakdown. |
| `term` | string | No | all terms | Restrict term-level figures. |
| `includeHeadcount` | boolean | No | `true` | Include active-student and per-class headcount. Set `false` for a tighter financial-only page. |
| `format` | enum | No | `json` | `csv` \| `excel` \| `pdf` — see §2. |

**Notes**: Month boundaries use `startOfDayAccra` / `endOfDayAccra` so the window
never drifts with the server's timezone. The month-on-month deltas are computed
by re-running the same aggregation over the immediately preceding month window —
cache that result (60 s) since it is deterministic for a closed month.

---

## 5. Response Envelope (`format` omitted)

```json
{
  "success": true,
  "message": "Daily collection report retrieved successfully",
  "data": {
    "report": "daily",
    "school": { "name": "string", "schoolCode": "string" },
    "period": {
      "startDate": "2025-03-04T00:00:00.000Z",
      "endDate": "2025-03-04T23:59:59.999Z"
    },
    "summary": {
      "totalCollected": 1250000,
      "totalCollectedDisplay": "GHS 12,500.00",
      "transactionCount": 34,
      "averagePayment": 36765
    },
    "rows": []
  },
  "meta": {
    "page": 1,
    "perPage": 50,
    "total": 34,
    "totalPages": 1,
    "generatedAt": "ISO-8601 string"
  }
}
```

`rows` shape is specific to each report (see §4 for the row content each one
reports on). `meta` carries `page` / `perPage` / `total` / `totalPages` for
row-level reports and `generatedAt` for all of them.

---

## 6. Error Responses

| Status | Code | Condition |
|---|---|---|
| `422` | validation error | Bad `:schoolId`, a `format` outside `csv \| excel \| pdf`, a `groupBy` outside its allow-list, an out-of-range `page`/`perPage`, or `startDate` after `endDate`. Produced by the shared `validate` middleware (`validate.js:18-21`), which returns `422` — **not** `400`. |
| `400` | `UNSUPPORTED_FORMAT` | Unreachable while `format` is validated; kept as a guard in the serialiser. |
| `401` | `UNAUTHENTICATED` | Missing or invalid JWT. |
| `403` | `FORBIDDEN` | Role is not `super_admin` / `school_admin`. |
| `403` | `NO_SCHOOL_SCOPE` | A non-`super_admin` user passed a `:schoolId` that is not their own, or has no school on the JWT. |
| `404` | `SCHOOL_NOT_FOUND` | Valid ObjectId, no matching school. |
| `429` | `RATE_LIMITED` | Report rate limit exceeded (see §7.4). |
| `501` | `PDF_EXPORT_UNAVAILABLE` | `format=pdf` requested while no PDF library is a dependency. |
| `500` | `INTERNAL_ERROR` | Unexpected failure during aggregation or file generation. |

---

## 7. Security, Performance, and Audit Notes

### 7.1 School-level isolation (primary concern)

Apply `resolveSchoolId(user, schoolIdParam)` in every report service function —
the same pattern as `paymentPlan.service.js:37` — and treat `schoolId` as a hard
filter in **every** downstream query, never as a URL-only guarantee. For
`super_admin` the path param is honored; for all other roles `user.schoolId` from
the JWT wins.

### 7.2 Field-level redaction

- Mask parent phone numbers with `maskPhone` (`student.service.js:76`) on
  `/reports/parent-contacts` and `/reports/overdue`.
- Never `$project`   `PaymentPlan.acceptanceToken` — already stripped by
  `paymentPlanModel.set("toJSON")` (`paymentPlanModel.js:298`).
- Never emit `Payment.webhookPayload` — stripped by
  `paymentSchema.set("toJSON")` (`paymentModel.js:229`).

### 7.3 File exports

- Sanitise any value interpolated into CSV output (leading `=`, `+`, `-`, `@`
  are formula-injection vectors in Excel and Google Sheets) — prefix such cells
  or strip the leading character. This matters most for free-text fields such as
  `description` and `parentName`.
- Set `Content-Disposition: attachment` and a stable filename
  (`<report>-<schoolId>-<stamp>.<ext>`) built from the report name, not from
  user input.

### 7.4 Rate limiting and cost control

Reuse the in-memory `rateLimit` middleware (`rateLimit.js:5`), with a tighter
budget than analytics since exports are expensive:

```js
rateLimit({ windowMs: 60_000, max: 20, keyBy: "user" })
```

Additionally consider a separate, lower budget (e.g. `max: 5`) for requests that
carry a `format` parameter — file generation is materially more expensive than
serving the JSON form of the same report.

### 7.5 Audit logging

Every report read is auditable, and every **export** should be logged with the
format, since an exported file leaves the application boundary:

```js
await auditService.log({
  action: format === "json" ? "REPORT_VIEWED" : "REPORT_EXPORTED",
  entity: "Report",
  entityId: schoolId,
  userId: user._id,
  details: { report, format, query: req.query },
});
```

### 7.6 Aggregation and indexes

- Reuse the indexes specified in `docs/analytics-api-spec.md` §6.1 — the daily
  report additionally benefits from `{ schoolId: 1, status: 1, completedAt: 1 }`
  (already listed there), and the class/headcount counts from
  `{ schoolId: 1, studentClass: 1, status: 1, deletedAt: 1 }`.
- Use `$facet` where a report returns a summary plus a paginated list (daily,
  outstanding, overdue) to avoid a second round trip.
- Apply `allowDiskUse(true)` for `/reports/term` and `/reports/class-collections`
  once a school exceeds ~10 000 students.
- Stream exports rather than buffering a full workbook in memory for large
  schools.

---

## 8. Implementation Status

- [x] `src/validations/reports.validation.js` — one query schema per endpoint, each including the shared `formatSchema`.
- [x] `src/routes/reports.routes.js` — `reportsRoute.use("/reports", authenticate, requireSchoolAdmin, reportsRateLimit)`, then one `GET` per §4 with `validateSchoolId` and its query schema.
- [x] Registered the router in `src/routes/index.js` alongside `analyticsRoute`.
- [x] `src/services/reports.service.js` — one function per endpoint, each starting with `resolveSchoolId`. The helper is copied per service file as elsewhere in the codebase; extracting the four existing copies into a shared util is a worthwhile follow-up.
- [x] `src/controllers/reports.controller.js` — a single `format` dispatch driven by one `REPORTS` map, so the nine endpoints cannot drift apart on export behaviour.
- [x] `src/utils/reportExport.js` — `csv` and `excel` serialisers, with a formula-injection guard on user-supplied cells.
- [ ] `pdf` — blocked on adding a PDF dependency. The branch is wired and returns a clear `501`.
- [x] Audit log view vs export (§7.5) — currently a console-logged stub matching the analytics service.
- [ ] **Not yet exercised against a database.** The aggregation pipelines are verified to load and register, and the validation and serialisation paths are covered, but no query has been run against a live dataset. The pure date-window logic is unit-verified (44 checks).
