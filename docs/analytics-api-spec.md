# School Analytics API — Technical Specification

> Status: **Proposed** — these endpoints do not yet exist in the codebase.
> Target location: `src/routes/analytics.routes.js`, `src/controllers/analytics.controller.js`, `src/services/analytics.service.js`

This document specifies ten GET endpoints under `/analytics/:endpoint/:schoolId`,
maps them to the existing Mongoose models, and describes the expected JSON
contracts, UI integration, and security / performance guidance.

---

## 1. Conventions Inherited from the Codebase

| Concern | Pattern | Source references |
|---|---|---|
| **Money storage** | All monetary values are **integer pesewas** (1 GHS = 100 pesewas). The API surface may optionally include human-readable cedis strings. | `formatters.js:8`, `studentModel.js:147`, `paymentPlanModel.js:83` |
| **`:schoolId` scoping** | `resolveSchoolId(user, explicitSchoolId)` — `super_admin` can pass any `:schoolId`; all other roles are locked to `user.schoolId` from the JWT. The path parameter is still validated via `objectId` regex. | `paymentPlan.service.js:37`, `student.service.js:38` |
| **Soft delete** | Every query filters `deletedAt: null`. | All service files |
| **Auth** | `authenticate` (JWT) → `authorize(...)` role check. Analytics endpoints require `super_admin` or `school_admin`. | `authenticate.js:11`, `paymentPlan.routes.js:32` |
| **Validation** | Joi with `objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/)` for 24-char hex IDs. | `paymentPlan.validation.js:31` |
| **Response envelope** | `{ success: true, message, data, meta? }` — consistent across all controllers. | `paymentPlan.controller.js:19` |
| **Date handling** | All dates in `Africa/Accra` (UTC+0, no DST). `startOfDayAccra`, `endOfDayAccra`, `addDays`, `addMonths` helpers exist. | `dateHelpers.js` |

---

## 2. API Documentation

### 2.1 Overview — KPI Cards Summary

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/analytics/overview/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Query params** | Optional: `?academicYear=2025&term=term1` |
| **`:schoolId`** | 24-char hex ObjectId. Honored for `super_admin`; derived from JWT for `school_admin`. |

**Description**: Returns a single aggregation document summarising the entire
school's financial state — totals that feed the top-row KPI cards on the
dashboard. All figures are derived from the `Student`, `PaymentPlan`, and
`Payment` collections, filtered by `schoolId` and `deletedAt: null`.

### 2.2 Revenue — Total Revenue Generated

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/analytics/revenue/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Query params** | Optional: `?startDate=2025-01-01&endDate=2025-03-31&groupBy=term\|month\|class` |
| **`:schoolId`** | 24-char hex ObjectId |

**Description**: Returns the total **collected** revenue (sum of completed
`Payment.amount` records) for the school, optionally broken down by term, month,
or class. Also returns the expected-but-pending portion from active payment-plan
installments that have not yet been paid.

### 2.3 Paid vs Owed — Paid vs Owed Totals

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/analytics/paid-owed/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Query params** | Optional: `?academicYear=2025&class=KG%201` |
| **`:schoolId`** | 24-char hex ObjectId |

**Description**: Returns side-by-side totals for the school: the sum of
`Student.totalPaid` (actually collected) vs `Student.totalOwed` (billed),
plus the derived collection-rate percentage. Used to render a "collection
health" KPI or donut chart.

### 2.4 Persons — Students Paid vs Owing Count

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/analytics/persons/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Query params** | Optional: `?class=Primary%203&status=active` |
| **`:schoolId`** | 24-char hex ObjectId |

**Description**: Returns a student-level breakdown bucketed into "fully paid",
"partially paid", and "owing" (zero payments). Each bucket includes a count and
a representative array of student objects (paginated). Also includes parent/guardian contact summary counts.

### 2.5 Revenue Chart — Revenue by Term / Class / Month

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/analytics/revenue-chart/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Query params** | `?groupBy=month\|term\|class` (required), `?academicYear=2025`, `?class=Primary%202` (optional filter) |
| **`:schoolId`** | 24-char hex ObjectId |

**Description**: Returns a time-series or categorical array for a line / bar
chart. Each bucket has a `period` label, `collected` (completed payments),
`expected` (scheduled installment amounts), and the `collectionRate` percentage.
The `$group` aggregation pipeline groups `Payment` and/or `PaymentPlan.installments`
documents by the requested dimension.

### 2.6 Overdue — Overdue Students List

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/analytics/overdue/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Query params** | Optional: `?class=KG%202&severity=critical\|warning\|all`, `?page=1&perPage=50` |
| **`:schoolId`** | 24-char hex ObjectId |

**Description**: Returns a paginated list of students who have at least one
installment with `status: "overdue"`, including the days-overdue count, total
overdue amount, parent contact info, and class. This directly leverages the
existing `sweepPlanStatuses` cron logic that flips `pending`/`partial` installments
to `overdue` when `dueDate < now` (`planHelpers.js:174`).

### 2.7 Cashflow — Forecast Next 30 / 60 / 90 Days

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/analytics/cashflow/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Query params** | Optional: `?horizon=30\|60\|90` (default `90`), `?asOf=2025-06-01` |
| **`:schoolId`** | 24-char hex ObjectId |

**Description**: Returns a projected cash-in forecast based on upcoming
installment due dates for all `active` (non-defaulted, non-cancelled) payment
plans. Each installment with `status: "pending" | "partial"` and a `dueDate`
within the horizon is summed into daily/weekly buckets. The `PaymentPlan.totalRemaining`
field provides per-plan running totals.

### 2.8 Compliance — Installment Compliance Rate

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/analytics/compliance/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Query params** | Optional: `?class=Primary%205&term=term1` |
| **`:schoolId`** | 24-char hex ObjectId |

**Description**: Returns the overall installment compliance rate (percentage of
installments paid on or before due date) across all active plans, plus a
time-series of compliance per month/term. This is an aggregation version of
the existing `getSchoolCompliance` service which already classifies plans into
buckets (`on_track`, `approaching_due`, `overdue`, `completed`, `defaulted`).
`paymentPlan.service.js:796`

### 2.9 Default Rate — Default Rate

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/analytics/default-rate/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Query params** | Optional: `?academicYear=2025` |
| **`:schoolId`** | 24-char hex ObjectId |

**Description**: Returns the plan-level default rate: count and percentage of
plans with `planStatus: "defaulted"` relative to all plans that have reached
their `endDate`. Also includes the historical default rate per term and the
average number of missed installments per defaulted plan.

### 2.10 Class Performance — Class-wise Collection

| Field | Value |
|---|---|
| **Method** | `GET` |
| **Path** | `/analytics/class-performance/:schoolId` |
| **Auth** | `authenticate` + `authorize("super_admin", "school_admin")` |
| **Query params** | Optional: `?term=term1` (filters by plan `startDate`/`endDate` range) |
| **`:schoolId`** | 24-char hex ObjectId |

**Description**: Returns a per-class breakdown of collection performance,
joining `Student.studentClass` to `PaymentPlan` and `Payment` collections.
Each entry has the class name, `expected` (total `totalOwed`), `collected`
(sum of completed payments), `balance`, and `collectionRate`. Sorted by
collection rate ascending (worst performers first).

---

## 3. Data Model Inference — Expected JSON Response Structures

All monetary values use `Integer` (pesewas) unless otherwise noted. Optional
`_display` fields provide cedis strings for convenience.

### 3.1 `GET /analytics/overview/:schoolId`

```json
{
  "success": true,
  "message": "Analytics overview retrieved successfully",
  "data": {
    "school": {
      "name": "string",
      "schoolCode": "string"
    },
    "period": {
      "academicYear": "string",
      "term": "string | null"
    },
    "totalStudents": 1250,              // Integer — active (status="active"), deletedAt=null
    "totalRevenueCollected": 5500000,   // Integer (pesewas) — sum of completed Payment.amount
    "totalRevenueExpected": 7500000,    // Integer (pesewas) — sum of Student.totalOwed
    "totalOutstanding": 2000000,        // Integer (pesewas) — totalRevenueExpected - totalRevenueCollected
    "collectionRate": 73.33,            // Float (0-100, 2dp) — totalRevenueCollected / totalRevenueExpected * 100
    "activePlans": 340,                 // Integer — PaymentPlans with planStatus="active"
    "overduePlans": 42,                 // Integer — plans with ≥1 installment.status="overdue"
    "defaultedPlans": 5,                // Integer — plans with planStatus="defaulted"
    "completedPlans": 210,              // Integer — plans with planStatus="completed"
    "pendingAcceptancePlans": 15        // Integer — plans with planStatus="pending_acceptance"
  },
  "meta": {
    "generatedAt": "ISO-8601 string"
  }
}
```

**Source fields**: `Student.totalOwed`, `Student.totalPaid`, `Student.balance`
(all integer pesewas); `Payment.amount` where `Payment.status = "completed"`;
`PaymentPlan.planStatus` enum: `pending_acceptance | active | completed | defaulted | cancelled | expired`.

### 3.2 `GET /analytics/revenue/:schoolId`

```json
{
  "success": true,
  "message": "Revenue data retrieved successfully",
  "data": {
    "school": { "name": "string", "schoolCode": "string" },
    "period": { "startDate": "ISO-8601", "endDate": "ISO-8601", "groupBy": "month" },
    "summary": {
      "totalCollected": 5500000,      // Integer (pesewas)
      "totalExpected": 7500000,       // Integer (pesewas)
      "totalPending": 2000000,        // Integer (pesewas) — outstanding installments
      "totalCollectedDisplay": "GHS 55,000.00"
    },
    "series": [
      {
        "period": "2025-01",           // string label (YYYY-MM for monthly, term name for termly)
        "collected": 1800000,          // Integer (pesewas) — sum of completed Payment.amount in this period
        "expected": 2500000,           // Integer (pesewas) — sum of installment.amount due in this period
        "collectionRate": 72.00        // Float
      }
      // ... one entry per bucket
    ]
  }
}
```

### 3.3 `GET /analytics/paid-owed/:schoolId`

```json
{
  "success": true,
  "message": "Paid vs owed breakdown retrieved successfully",
  "data": {
    "school": { "name": "string" },
    "summary": {
      "totalPaid": 4500000,        // Integer — sum of Student.totalPaid
      "totalOwed": 7000000,        // Integer — sum of Student.totalOwed
      "totalOwedDisplay": "GHS 70,000.00",
      "collectionRate": 64.29      // Float
    },
    "breakdown": [
      {
        "category": "fully_paid",     // students where totalPaid >= totalOwed (balance <= 0)
        "count": 850,                // Integer
        "amountOwed": 3000000,       // Integer
        "amountPaid": 3000000,       // Integer
        "students": [ ... ]          // (see persons endpoint for shape)
      },
      {
        "category": "partially_paid", // students where 0 < totalPaid < totalOwed
        "count": 120,
        "amountOwed": 2000000,
        "amountPaid": 800000,
        "students": [ ... ]
      },
      {
        "category": "not_paid",       // students where totalPaid == 0
        "count": 280,
        "amountOwed": 2000000,
        "amountPaid": 0,
        "students": [ ... ]
      }
    ]
  }
}
```

### 3.4 `GET /analytics/persons/:schoolId`

```json
{
  "success": true,
  "message": "Student payment status breakdown retrieved successfully",
  "data": {
    "school": { "name": "string" },
    "summary": {
      "fullyPaid": 850,
      "partiallyPaid": 120,
      "owing": 280,
      "total": 1250,
      "parentsContacted": 1100       // Integer — count of students with at least one parent
    },
    "students": [
      {
        "_id": "ObjectId",
        "studentId": "STU-2025-000123",
        "studentName": "string",
        "studentClass": "Primary 3",
        "totalOwed": 400000,         // Integer (pesewas)
        "totalPaid": 200000,
        "balance": 200000,           // Integer — computed: totalOwed - totalPaid
        "balanceDisplay": "GHS 2,000.00",
        "status": "active",          // enum from Student.status
        "paymentStatus": "partial",  // inferred: "paid" | "partial" | "owing"
        "primaryParentPhone": "02******56"  // masked string
      }
    ],
    "meta": { "page": 1, "perPage": 50, "total": 1250, "totalPages": 25 }
  }
}
```

### 3.5 `GET /analytics/revenue-chart/:schoolId`

```json
{
  "success": true,
  "message": "Revenue chart data retrieved successfully",
  "data": {
    "school": { "name": "string" },
    "groupBy": "month",
    "series": [
      {
        "period": "2025-01",
        "collected": 1800000,        // Integer (pesewas) — completed Payment.amount
        "expected": 2500000,         // Integer — installment.amount due in period
        "outstanding": 700000,       // Integer — expected - collected
        "collectionRate": 72.00     // Float
      }
    ]
  }
}
```

### 3.6 `GET /analytics/overdue/:schoolId`

```json
{
  "success": true,
  "message": "Overdue students retrieved successfully",
  "data": {
    "school": { "name": "string" },
    "summary": {
      "totalOverdue": 52,
      "totalOverdueAmount": 3500000,   // Integer (pesewas) — sum of (installment.amount - installment.amountPaid) for overdue installments
      "totalOverdueAmountDisplay": "GHS 35,000.00",
      "avgDaysOverdue": 18             // Float — average days past dueDate
    },
    "students": [
      {
        "_id": "ObjectId",
        "studentId": "STU-2025-000123",
        "studentName": "string",
        "studentClass": "KG 2",
        "overdueInstallments": [
          {
            "installmentNumber": 2,      // Integer
            "planName": "3-Month Plan",  // string
            "dueDate": "ISO-8601",        // Date
            "daysOverdue": 23,            // Integer
            "amount": 50000,             // Integer (pesewas)
            "amountPaid": 20000,         // Integer
            "outstanding": 30000,        // Integer
            "severity": "critical"       // "warning" if daysOverdue < 14, "critical" otherwise
          }
        ],
        "totalOverdueAmount": 30000,     // Integer
        "planStatus": "defaulted",       // PaymentPlan.planStatus
        "primaryParentPhone": "02******56",
        "primaryParentName": "string"
      }
    ],
    "meta": { "page": 1, "perPage": 50, "total": 52, "totalPages": 2 }
  }
}
```

### 3.7 `GET /analytics/cashflow/:schoolId`

```json
{
  "success": true,
  "message": "Cashflow forecast retrieved successfully",
  "data": {
    "school": { "name": "string" },
    "horizonDays": 90,
    "asOf": "ISO-8601",
    "summary": {
      "projectedInflow": 4500000,      // Integer (pesewas) — sum of all projected due installments in horizon
      "projectedInflowDisplay": "GHS 45,000.00",
      "activePlansConsidered": 340,
      "avgMonthlyInflow": 1500000      // Integer — projectedInflow / 3
    },
    "buckets": [
      {
        "period": "week_1",             // or "2025-W22", or a date range string
        "startDate": "ISO-8601",
        "endDate": "ISO-8601",
        "projected": 500000,           // Integer (pesewas)
        "collectedToDate": 0,          // Integer — already-paid portions (always 0 for future buckets)
        "outstanding": 500000          // Integer
      }
    ]
  }
}
```

### 3.8 `GET /analytics/compliance/:schoolId`

```json
{
  "success": true,
  "message": "Compliance overview retrieved successfully",
  "data": {
    "school": { "name": "string" },
    "summary": {
      "overallComplianceRate": 87.50,    // Float (0-100) — % of installments paid on or before dueDate
      "totalPlans": 500,
      "activePlans": 340,
      "completedPlans": 210,
      "overduePlans": 42,
      "defaultedPlans": 5,
      "pendingAcceptancePlans": 15
    },
    "trend": [
      {
        "period": "2025-01",         // month or term
        "complianceRate": 90.00,      // Float
        "onTrack": 80,               // Integer count
        "approachingDue": 10,
        "overdue": 5,
        "completed": 5,
        "defaulted": 0
      }
    ]
  }
}
```

### 3.9 `GET /analytics/default-rate/:schoolId`

```json
{
  "success": true,
  "message": "Default rate retrieved successfully",
  "data": {
    "school": { "name": "string" },
    "summary": {
      "defaultedPlans": 5,
      "maturedPlans": 420,           // Integer — plans whose endDate has passed
      "defaultRate": 1.19,           // Float — defaultedPlans / maturedPlans * 100
      "avgMissedInstallments": 2.4   // Float — average installmentsMissed per defaulted plan
    },
    "trend": [
      {
        "period": "term1",            // term or month
        "defaultedPlans": 1,
        "maturedPlans": 140,
        "defaultRate": 0.71
      }
    ]
  }
}
```

### 3.10 `GET /analytics/class-performance/:schoolId`

```json
{
  "success": true,
  "message": "Class-wise collection performance retrieved successfully",
  "data": {
    "school": { "name": "string" },
    "classes": [
      {
        "className": "Primary 3",
        "studentCount": 85,            // Integer — active students in this class
        "totalOwed": 20000000,         // Integer (pesewas) — sum of Student.totalOwed
        "totalPaid": 16000000,        // Integer — sum of Student.totalPaid
        "balance": 4000000,           // Integer — totalOwed - totalPaid
        "collectionRate": 80.00,      // Float
        "totalPaidDisplay": "GHS 160,000.00",
        "balanceDisplay": "GHS 40,000.00"
      }
    ]
  }
}
```

---

## 4. Frontend Integration Mapping

### Dashboard Layout (recommended grid)

| Endpoint | Widget type | Rationale |
|---|---|---|
| `GET /analytics/overview/:schoolId` | **KPI cards** (4–6 tiles) | Pre-aggregated single document; minimal payload. Cards: Total Revenue Collected, Total Outstanding, Collection Rate (%), Overdue Plans, Defaulted Plans, Completed Plans. |
| `GET /analytics/paid-owed/:schoolId` | **Donut chart** + **KPI card** | Two numbers (paid vs owed) with a derived rate — ideal for a two-segment donut and a large collection-rate badge. |
| `GET /analytics/persons/:schoolId` | **Data table** + **bar legend** | Paginated student list with status badges. Bar legend shows counts per category (fully paid / partial / owing). |
| `GET /analytics/revenue-chart/:schoolId` | **Line chart** | Time-series `series` array maps directly to Chart.js/X axis (period) and Y axis (collected vs expected). `groupBy` query param lets user toggle month/term. |
| `GET /analytics/class-performance/:schoolId` | **Bar chart** (horizontal) | One bar per class, sorted by collection rate ascending. Hover shows totalOwed and balance. |
| `GET /analytics/cashflow/:schoolId` | **Forecast widget** (stacked bar or area chart) | Future buckets; `projected` bars with a "Today" vertical marker. Dropdown for 30/60/90-day horizon. |
| `GET /analytics/compliance/:schoolId` | **Progress ring** + **trend chart** | Overall compliance rate as a progress ring; `trend` as a line chart below. |
| `GET /analytics/default-rate/:schoolId` | **KPI card** + **trend chart** | Single default-rate figure as a prominent card; historical trend below. |
| `GET /analytics/overdue/:schoolId` | **Data table** + **severity filter** | Paginated table with color-coded severity tags (`warning` = yellow, `critical` = red). Filter dropdown for severity and class. |

### Data-fetching strategy

- **Parallel load**: `overview`, `paid-owed`, `persons`, `revenue-chart`,
  `class-performance` can all be fetched in parallel on dashboard mount —
  they are independent and each returns a smallish pre-aggregated payload.
- **Lazy / on-demand**: `overdue` and `cashflow` are heavier (joins +
  pagination); fetch only when the user navigates to the respective tab.
- **Stale-while-revalidate**: Overview and revenue-chart change slowly
  relative to drill-down pages; cache them client-side with a 60-second
  revalidation window.

---

## 5. Security Considerations

### 5.1 School-level data isolation (primary concern)

**Risk**: A `school_admin` from school A could pass school B's `:schoolId` in
the URL and read another school's analytics.

**Mitigation** (follow the existing `resolveSchoolId` pattern from
`paymentPlan.service.js:37` and `student.service.js:38`):

```js
// In every analytics service function:
const schoolId = resolveSchoolId(user, schoolIdParam);
if (!schoolId) {
  throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
}
```

- For `super_admin`: the explicit `:schoolId` path param is honored.
- For all other roles: `user.schoolId` from the JWT is used; the path param
  is cross-validated (must match) or simply ignored.
- Every downstream query includes `schoolId` as a hard filter — never rely
  on URL-only isolation.

### 5.2 Field-level redaction

- **Parent phone numbers**: Mask using the existing `maskPhone` utility
  (`student.service.js:76`) — only expose masked versions on list /
  analytics endpoints. Full numbers are only shown on the single-student
  detail page.
- **`acceptanceToken`**: Already stripped by `paymentPlanModel.set("toJSON")`
  (`paymentPlanModel.js:297`). Analytics endpoints must never `$project`
  it onto the output.
- **`webhookPayload`**: Stripped by `paymentSchema.set("toJSON")`
  (`paymentModel.js:229`). Aggregation pipelines must explicitly omit it.

### 5.3 Input validation

- `:schoolId` must match `^[0-9a-fA-F]{24}$` (Joi `objectId` pattern).
- Query params (`groupBy`, `horizon`, `academicYear`, `term`, `class`,
  `severity`, `page`, `perPage`) must be validated with Joi before reaching
  the service layer. Reject `groupBy` values not in an allow-list
  (`["month", "term", "class"]`) to prevent arbitrary `$group` key injection.
- `horizon` must be an integer in `[1, 365]`.

### 5.4 Rate limiting

Apply the existing in-memory `rateLimit` middleware (`rateLimit.js:5`) to the
analytics routes. Recommended config:

```js
rateLimit({ windowMs: 60_000, max: 30, keyBy: 'user' })
```

This allows 30 analytics requests per minute per user (per route), sufficient
for dashboard polling without exposing aggregation endpoints to brute-force
or DoS through expensive query combinations.

### 5.5 Audit logging

All analytics reads should emit an audit entry following the codebase's stub
pattern:

```js
await auditService.log({
  action: "ANALYTICS_READ",
  entity: "Analytics",
  entityId: schoolId,
  userId: user._id,
  details: { endpoint: req.path, query: req.query },
});
```

---

## 6. Performance Optimizations & Caching Strategies

### 6.1 MongoDB aggregation indexes

The following compound indexes are critical for analytics queries and should
be added to the relevant models:

```js
// paymentPlan.model
{ schoolId: 1, planStatus: 1, deletedAt: 1 }          // overview, compliance
{ schoolId: 1, planStatus: 1, startDate: 1, endDate: 1 } // cashflow, default-rate
{ schoolId: 1, "installments.status": 1, "installments.dueDate": 1 } // overdue, cashflow

// paymentModel
{ schoolId: 1, status: 1, createdAt: 1 }              // revenue, revenue-chart
{ schoolId: 1, status: 1, completedAt: 1 }

// studentModel
{ schoolId: 1, studentClass: 1, status: 1, deletedAt: 1 } // class-performance, persons
```

Existing indexes at `paymentPlanModel.js:235-239` and `paymentModel.js:177-180`
are a good start but lack `deletedAt` in most compound keys — add it to
prevent collection scans during soft-delete filtering.

### 6.2 Application-level caching

Cache **aggregation endpoints** (those returning summary / chart data)
rather than raw row-level data:

| Endpoint | Cache TTL | Cache key | Cache type |
|---|---|---|---|
| `overview` | 60 s | `analytics:overview:{schoolId}:{hash(query)}` | In-process (Map) or Redis |
| `revenue` | 120 s | `analytics:revenue:{schoolId}:{hash(query)}` | Redis |
| `paid-owed` | 60 s | `analytics:paid-owed:{schoolId}:{hash(query)}` | Redis |
| `revenue-chart` | 180 s | `analytics:revenue-chart:{schoolId}:{hash(query)}` | Redis |
| `compliance` | 120 s | `analytics:compliance:{schoolId}:{hash(query)}` | Redis |
| `default-rate` | 300 s | `analytics:default-rate:{schoolId}:{hash(query)}` | Redis |
| `class-performance` | 120 s | `analytics:class-performance:{schoolId}:{hash(query)}` | Redis |
| `cashflow` | 60 s | `analytics:cashflow:{schoolId}:{hash(query)}` | Redis (volatile) |
| `persons` | 15 s | `analytics:persons:{schoolId}:{hash(query)}` | In-process only (paginated, changes often) |
| `overdue` | 30 s | `analytics:overdue:{schoolId}:{hash(query)}` | In-process (time-sensitive) |

**Cache invalidation triggers**: When a `Payment` transitions to `completed`
(via the Hubtel webhook at `payment.service.js:390`), invalidate the school's
cache for `overview`, `revenue`, `paid-owed`, `persons`, and `class-performance`
(vary by ±0 TTL). The webhook handler is the single mutation chokepoint for
completed payments; plan status changes (via `sweepPlanStatuses` in
`paymentPlan.service.js:911`) should invalidate `overdue`, `cashflow`,
`compliance`, and `default-rate` caches.

### 6.3 Database-level optimizations

- **Use `$facet`** for endpoints that return both a summary and a paginated
  list (e.g., `persons`, `overdue`) to reduce round trips.
- **Pre-aggregate with `$group`** at the MongoDB level rather than pulling
  raw documents into the service layer and computing in JavaScript. The
  existing `getSchoolCompliance` does client-side classification — for the
  analytics version, push as much grouping as possible to the DB.
- **`allowDiskUse(true)`** on aggregation pipelines for `revenue-chart` and
  `class-performance` when schools have > 10 000 students, to avoid the 100 MB
  memory limit.
- **Projection**: Always use `.select()` to fetch only needed fields. Never
  pull full `installments` arrays into memory for chart endpoints — use
  `$unwind` + `$group` instead.

### 6.4 Background materialization (advanced)

For schools with large datasets (> 50 000 students), consider a daily
denormalization job (cron) that writes pre-computed monthly aggregates into a
dedicated `AnalyticsCache` collection, keyed by `schoolId + period + metric`.
The read endpoints then become simple `findOne` lookups with a 24-hour fallback
to live aggregation if the materialized record is missing or stale.
