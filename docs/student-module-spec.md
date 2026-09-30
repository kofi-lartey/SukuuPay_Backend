# Student Management Module — Technical Specification & Implementation Plan

**Status:** Implemented. §11 records what shipped and §12 what did not.
**Scope:** Full-stack — `Backend/src/{models,routes,controllers,services,validations}` and `frontend/src/{pages,components,services,hooks}`
**Companion document:** [`STUDENT_MANAGEMENT_API_SPEC.md`](../STUDENT_MANAGEMENT_API_SPEC.md) documents the seven *lifecycle* endpoints as built. This document covers the whole module — CRUD, bulk operations, the roster UI — and **supersedes it where the two disagree** (see §9.1).

> **Read §3 first.** The defects below were found by reading the code, not by
> using the product, and most of them failed *silently* — no `501`, no thrown
> error, a `200` with a payload that was quietly wrong. Every item in §3 has been
> fixed; the fix is named in its entry.

---

## 1. How to read this

The module is not greenfield. Twenty-seven routes exist across
`Backend/src/routes/student.routes.js`, and roughly a third of the model's fields
are live. But a large share of that surface is non-functional in ways that are
**silent** — no `501`, no `TODO`, no thrown error. A route that accepts a
request, returns `200`, and writes nothing reads as working.

So the plan below is ordered the way it should be built:

1. **§3 Defect register** — what is actually broken. Read this first; it drives
   the phasing in §10.
2. **§4–§5** — target architecture and data model.
3. **§6** — the full API surface, existing and new.
4. **§7** — UI component structure.
5. **§8** — the complete feature matrix.
6. **§10** — sequenced implementation plan.

Two conventions used throughout, and they are not stylistic:

- **Money is pesewas (integer) everywhere in the API.** Cedis exist only at
  render time. Where an existing endpoint disagrees, §3.1 says so.
- **Classes are strings.** `School.academic.classes` is `[String]` (`"JHS 2A"`).
  There is no Class model, and §3.6 explains why the endpoints that pretend
  otherwise cannot work.

---

## 2. Current state

### 2.1 What exists

| Area | State |
|---|---|
| Model | `studentModel.js` — 30+ fields, 4 embedded sub-schemas, 8 indexes, pre-save hook |
| Routes | 27 registered, all authenticated; 21 additionally `authorize('super_admin','school_admin')` |
| Validations | 21 Joi schemas, `abortEarly/stripUnknown/convert` on all |
| Bulk import | Works, partial-success, **non-transactional** |
| Export | Works, CSV + XLSX, unpaginated |
| Lifecycle | Promote / repeat / graduate / transfer-out implemented with real guards |
| Frontend service | `services/students.js` — **3 of 27** functions (`listStudents`, `createStudent`, `bulkImport`) |
| Frontend UI | `Step3ImportStudents.jsx` — a complete, working import wizard (872 lines) |
| Frontend roster | **None.** `pages/dashboard/Students.jsx` is a placeholder scaffold |
| Mock API | `mocks/handlers.js` — 3 student routes |
| Tests | **Zero.** `Backend/tests/` covers account creation, GPS, messaging, school provisioning. Nothing for students. |

### 2.2 What the module must grow into

The roster screen the design calls for needs four aggregates the API cannot
currently produce: total roster, fully-cleared count, active installment
pledges, and overdue balance. **There is no aggregate endpoint on students.**
`GET /students` returns rows; summing them client-side would be wrong (masked
rows, pagination caps, and it would read 20 rows to render 1,000 students).

---

## 3. Defect register

Severity: **BLOCKER** = data loss, corruption, or the endpoint can never succeed.
**HIGH** = silently wrong output. **MEDIUM** = incorrect under load or edge input.

### 3.1 BLOCKER — `totalOwed` means two different things on two write paths

| Path | Unit | Evidence |
|---|---|---|
| `POST /students/single` | **pesewas** — passed straight through | `createStudentSchema.totalOwed` is `Joi.number().integer()`, no transform |
| `POST /students/bulk` | **cedis** — multiplied by 100 | `toPesewas(value) = Math.round(Number(value) * 100)` in `student.service.js` |

A school that adds one student through the form and 200 through the CSV ends up
with one student owing GH₵ 0.01 and 200 owing GH₵ 85.00. The template
(`src/templates/student-import-template.csv`) shows `850` with no unit comment,
and nothing in the payload names it. This is the highest-value fix in the
module and it is a one-line change plus a template comment.

**Decision required:** cede to the API (pesewas everywhere) or to the CSV
(cedis in the file). Recommend **API-pesewas + explicit `totalOwedCedis` in the
CSV header documentation**, so the spreadsheet stays human-readable and the wire
format stays integer-typed. Any other choice re-introduces the ambiguity.

### 3.2 BLOCKER — all five parent endpoints are permanently broken

Routes are mounted at `/parents/:parentId`; the controllers read `req.params.id`.
There is no `:id` segment, so every one fails with 400 `INVALID_ID` before
reaching the database. Affected: `PUT /parents/:parentId`,
`PUT /parents/:parentId/primary`, `DELETE /parents/:parentId`. Compounding it,
`addParent` writes a fresh `ObjectId` onto a sub-schema declared `_id: false`, and
`setPrimaryParentController` never reads `req.body.isPrimary` despite the schema
requiring it.

**Root cause is the data model, not the routes.** Parent sub-documents have no
`_id`, so there is no identifier to address one by. Fixing the routes means
either giving parents real `_id`s or keying them by index — both are worse than
promoting parents to their own collection, which §5.2 recommends and which also
repairs the dangling `Payment.parentId` (an untyped `ObjectId` with no `ref`).

### 3.3 BLOCKER — `GET /cohorts/:cohortId` can never succeed

`cohortIdParamSchema` demands `/^[0-9a-fA-F]{24}$/` (an ObjectId).
`getCohortDetail` demands `cohortId.replace("cohort_","")` match `/^\d{4}$/`
(i.e. `cohort_2026`). **No input satisfies both**; the request always 422s at
validation. The same contradiction exists in `bulkGraduateSchema.cohortId`.
Related: there is no `Cohort` model, so nothing is persisted and `GET /cohorts`
reconstructs cohorts by aggregating `graduationYear`.

### 3.4 BLOCKER — `super_admin` cannot call any id-scoped student endpoint

`resolveSchoolId(user, null)` returns `null` for `super_admin` (the explicit-id
branch only fires when a value is passed), and every id-scoped service calls it
with `null` then throws 400 `NO_SCHOOL_SCOPE`. Affected: get, update, delete,
remove, suspend, reactivate, transfer-class, pay-link, promote, repeat, graduate,
transfer-out, all parents, cohort detail. Platform support staff cannot inspect a
single student. The cross-school guard written for them is unreachable, because
they never get past the scope check first.

### 3.5 BLOCKER — bulk import loses its whole result on a duplicate key

`Student.insertMany(validDocs, { ordered: false })` is **not wrapped in
try/catch**. A duplicate-key error still throws `BulkWriteError` out of the
call, so: `created` stays `0`, `School.stats.totalStudents` is never incremented,
and the controller returns **HTTP 500 with a raw driver message** — even though
partial documents may already be in the database. The
`{ created, failed, errors }` contract the UI depends on is lost exactly when it
matters most.

The cause is upstream: `generateStudentId` is **read-then-write** (`$max` of the
existing IDs, `+1`). Two concurrent imports against the same school and academic
year compute the same ID. The 3-attempt retry loop in `createStudent` is largely
decorative for the same reason — it regenerates deterministically and collides
again. **Fix:** a `Counters` collection with `findOneAndUpdate($inc)` under a
unique index, or pre-allocating an ID range per import batch.

### 3.6 HIGH — `graduationType`, `certificateNumber` and `honors` are never stored

All three are assigned on the document in `graduateStudent` and
`bulkGraduateStudents`, and all three are read back by `getAlumni` (filter on
`honors`, search and sort on `certificateNumber`) and `getCohorts`. **None exists
in the schema.** Mongoose `strict` is on, so the writes are dropped on `save()`
and the reads match nothing. An alumni list filtered by honours is silently
empty; a sort by certificate number is silently ignored. The duplicate-certificate
guard queries `graduation.certificateNumber` — a path that never existed — so
`409 DUPLICATE_CERTIFICATE` can never fire, and auto-assigned certificate
numbers are `Math.random()`-based with no uniqueness enforcement.

### 3.7 HIGH — `search` is interpolated raw into `$regex`

`query.search` is spliced into four `$regex` clauses (list, export, alumni,
cohorts) with no escaping. `?search=.*` matches every student; a malformed
pattern like `[` throws and 500s. `escapeRegExp` already exists in
`utils/generateStudentId.js` and is not used here.

### 3.8 HIGH — lifecycle fields are directly writable, bypassing every guard

`updateStudentSchema` permits `graduationDate`, `graduationYear`, `isAlumni`,
`isRepeating`, `promotedFrom/To`, `promotionDate`, `transferOutDate`,
`transferOutReason`. Each of those has a dedicated transition endpoint with real
preconditions — "only active students can be promoted", "not in a final year
class", "maximum repeat limit". A plain `PUT` walks straight past all of them.
`isRepeating` in particular can only be cleared by a raw `PUT`, since no endpoint
exists for it.

### 3.9 HIGH — `DELETE /students/:id` and `PUT /students/:id/remove` are the same endpoint

Both call `archiveStudent`, byte-for-byte. One returns `"Student removed"`, the
other `"Student archived"`. Two URLs, one behaviour, and a client cannot know
which to call.

### 3.10 HIGH — audit logging writes to `console.log`

`auditService` in `student.service.js` is a stub, so **no audit rows are
written** for any of the 27 endpoints. `src/models/AuditLog.js` and
`src/utils/auditService.js` both exist and are unused here. The Activity Log
module in the dashboard shell renders a log that is empty for every student
action.

Related: `sendPayLinkSms` reports `{ sent: true, provider }` **without sending
anything** when a provider is configured.

### 3.11 HIGH — `:id` is the Mongo `_id`, not `studentId`

`studentIdParamSchema` requires 24-hex. The human identifier is `studentId`
(`PBS-2026-0001`). Every screen a bursar reads shows `studentId`, so every
client that follows the obvious mapping — look up `studentId`, pass it — gets a
400. The param is also *named* `id` in the schema while the schema is called
`studentIdParamSchema`. Either accept both or rename; the current state is a trap.

### 3.12 MEDIUM — bulk operations truncate silently

`bulkPromoteStudents` `.limit(500)`; `bulkGraduateStudents` `.limit(300)`. No
error, no warning, no flag in the response. A school graduating a cohort of 400
gets 300 and is told 400 were processed.

### 3.13 MEDIUM — PII masking is inconsistent

`listStudents` masks guardian phone numbers (`maskStudentList`). `getStudentById`,
`exportStudents`, `getAlumni` and `getCohortDetail` return them **unmasked**.
`GET /students/:id/parents` is authenticated with **no role guard at all** and
returns full numbers. So the roster is the only surface protecting a phone number
— which is the opposite of what a masking rule is for.

### 3.14 MEDIUM — `error.code` is never serialised

`ApiError` carries a useful `code` on ~30 conditions, and every controller
returns only `{ success: false, message }`. The client cannot branch on
`INVALID_CLASS` vs `NO_SCHOOL_SCOPE` and must string-match an English sentence.
`api.js` in the frontend already branches on `data.code` for `SCHOOL_NOT_LINKED`,
so the pattern is established — the student module just never sends it.

### 3.15 MEDIUM — placeholders returned as real data

| Where | Placeholder |
|---|---|
| `getCohortDetail` | `teacher: ""`, `studentCount: 0` on every class |
| `previewPromotion` | class capacity hardcoded to `40`, not read from the school |
| `getFinalYearClasses` | final year = `classes.slice(-3)`, no per-school config |
| `transferOutStudent` | `transferRecord` built in memory and **never persisted**; destination institution, type, contacts and `recordsTransferred` are discarded |
| `bulkPromoteStudents` | `skippedStudents` is declared and returned but never populated |
| `getCohorts` | cohort `startDate`/`endDate` synthesised as `${year-1}-09-01` / `${year}-06-15`; `academicYear` uses a **hyphen** (`2025-2026`) where every other path uses a slash |

### 3.16 MEDIUM — export emits an empty file for an empty roster

The CSV header is derived from `Object.keys(rows[0] || {})`, so a zero-row export
returns `content: "\n"`. A bursar who filters to a class with no students and
downloads gets a file that opens as a single blank line and looks like data loss.

### 3.17 Other notes

- `classHistory` is an unbounded array on the document — a student repeating
  across years grows the doc without limit, and `repeatStudent` derives its
  repeat count by scanning it on every call.
- `paymentPlans: [ObjectId]` on Student is never populated; the real relation is
  `PaymentPlan.studentId`.
- `totalOwed` has no upper bound in Joi, and `balance` has no `min` — it may go
  negative, which is intentional (credit) but undocumented.
- The roster count lives on `School.stats.totalStudents`, not on a Student row,
  and `GET /students` returns its count in `meta.total`. Any UI that needs a
  student total must read `meta.total` or call `/students/stats` — reading
  `stats.totalStudents` off a list row yields `undefined`, and the two counts can
  disagree anyway, since import increments the stat but archive does not
  decrement it.

---

## 4. Target architecture

### 4.1 Layers

```
routes/student.routes.js      thin: auth, validation, controller. No logic.
  │
validations/student.validation.js   Joi contracts — the only place field rules live
  │
controllers/student.controller.js   HTTP: unwrap, status codes, envelope. No logic.
  │
services/student.service.js         domain: transactions, invariants, transitions
  │
models/                            persistence + schema invariants
```

Rules that keep this from rotting:

1. **Every money field is touched only through `toPesewas`/`fromPesewas`**, which
   live in one util. No arithmetic on amounts anywhere else.
2. **Lifecycle fields are writable only by the service function that owns the
   transition.** They are removed from `updateStudentSchema` (§3.8).
3. **A transition endpoint and a status guard are the same thing.** No endpoint
   writes `status` without asserting the current value first.
4. **`ApiError.code` is always serialised.** The envelope is
   `{ success, message, code, errors? }` everywhere.
5. **Every write emits an audit row** through the real `auditService` (§3.10).

### 4.2 Frontend layers

```
pages/dashboard/Students.jsx        route shell + ModuleTabs
  └── students/roster/              RosterTab, ImportTab, AlumniTab, CohortsTab
components/students/                presentational (dumb) components
components/dashboard/ui, charts/    the shared design system
services/students.js                one function per endpoint, no UI knowledge
hooks/useStudents.js                list state: filters, pagination, selection
mutations/                          one hook per write, with toasts + invalidation
```

`mutations/` is a new directory and the single most important frontend decision:
today `Step3ImportStudents.jsx` calls services directly and owns its own error
handling, so a 422 from `createStudent` is discovered by one caller. Centralising
writes means one place decides how a 409 surfaces and one place invalidates the
roster query after a mutation.

### 4.3 Data flow

```
UI intent → mutation hook → services/students.js → api.js (Bearer + refresh)
   → routes (auth, Joi) → controller (envelope) → service (transaction, invariant)
   → model (pre-save: studentId, pay token, primary parent, balance)
   → audit row
   ← { success, message, code, data } ── mutation invalidates useStudents
```

---

## 5. Data model

### 5.1 Changes to `Student`

| Change | Why | Notes |
|---|---|---|
| **Add** `firstName`, `lastName` | `lastName` is already a `sortBy` in `alumniQuerySchema` and `cohortDetailQuerySchema` — sorting on a non-existent field is currently a silent no-op | Derive both from `studentName` on save; keep `studentName` as the source of truth |
| **Add** `graduationType`, `certificateNumber`, `honors` | §3.6 | `certificateNumber` needs a unique index scoped to `(schoolId, graduationYear)` |
| **Add** `classHistory[]` cap or move out | §3.17 | Prefer a separate `ClassHistory` collection; keeps the Student doc bounded |
| **Add** `repeatCount` | derived today by scanning `classHistory` on every call | `default: 0`; incremented only by the repeat transition |
| **Add** compound index `{ schoolId, status, studentClass }` | the roster's default filter is exactly these three | Serves the list endpoint's common path |
| **Add** text index `{ studentName: 'text' }` | search is a four-way unescaped `$regex` today | Requires migrating the search path; keep `$regex` as a fallback behind the escaping fix |
| **Move** `parents`, `emergencyContacts` → own collections | §3.2 | Breaking; see migration note |
| **Drop** `paymentPlans: [ObjectId]` | never populated | `PaymentPlan.studentId` is the real relation |
| **Keep** soft delete (`deletedAt`) | payment history must survive | Never hard delete. Add `deletedBy`, `deletedReason` |

### 5.2 New `Parent` collection (replaces the embedded array)

```
Parent {
  _id, schoolId, studentId (ref Student, indexed),
  parentName, relationship [father|mother|guardian|other],
  phone (E.164, indexed), email, isPrimary (bool), isAlive (bool),
  createdBy, updatedBy, timestamps
}
// unique partial index: { studentId: 1, isPrimary: 1 } where isPrimary === true
```

This is what makes §3.2 fixable: a real `_id` to address, a real target for
`Payment.parentId`, and one place for the `parents.phone` WhatsApp inbound index
to live. It also enables per-parent payment history, which the embedded array
cannot express.

**Migration:** additive — dual-write for one release, backfill, then drop the
embedded array. The three broken parent routes stay broken until this lands; that
is preferable to fixing them against a structure that has to change anyway.

### 5.3 New `Class` collection (optional, recommended)

`School.academic.classes` as strings is the root of §3.6's class-Id/name
confusion and of the `gradeLevels` substring heuristic (`"1"` matches
`"JHS 11A"`). A `Class` document with `{ name, level, order, capacity, teacher }`
makes promotion mapping deterministic and gives class capacity a real home
instead of the hardcoded `40`.

**Interim, if deferred:** rename the misleading `classIds` / `targetClassId` /
`cohortId` Joi fields to `classNames` / `targetClass` / `graduationYear` and fix
their patterns. That is a smaller change and removes the contradiction without a
migration.

---

## 6. API surface

Legend — **OK** works · **FIX** exists but defective (§3) · **NEW** does not exist.

### 6.1 Read

| Method | Path | Guard | Status | Notes |
|---|---|---|---|---|
| GET | `/students` | auth | **OK** | See §6.5 query contract. Fix `$regex` escaping |
| GET | `/students/export` | auth | **FIX** | Unpaginated by design; header row missing when empty (§3.16) |
| GET | `/students/:id` | auth | **FIX** | Accept `studentId` as well as `_id` (§3.11) |
| **GET** | **`/students/stats`** | auth | **NEW** | Roster aggregates for the KPI band. See §6.4 |
| **GET** | **`/students/:id/profile`** | auth | **NEW** | Profile preview aggregate. See §6.4 |
| GET | `/alumni/:schoolId` | auth | **FIX** | Sorts on missing fields (§3.6) |
| GET | `/cohorts/:schoolId` | auth | **FIX** | Reconstructed, not persisted; `status` filter ignored |
| GET | `/cohorts/:cohortId` | auth | **BLOCKED** | §3.3 — always 422 |
| GET | `/students/:id/parents` | auth | **FIX** | Remove bare-auth; unmask policy needed (§3.13) |

### 6.2 Create / update / delete

| Method | Path | Guard | Status | Notes |
|---|---|---|---|---|
| POST | `/students/single` | admin | **FIX** | Unit bug (§3.1) |
| PUT | `/students/:id` | admin | **FIX** | Strip lifecycle fields (§3.8) |
| DELETE | `/students/:id` | admin | **OK** | Soft delete. Consolidate with `/remove` (§3.9) |
| PUT | `/students/:id/remove` | admin | **FIX** | Delete; redirect to `DELETE` (§3.9) |
| **POST** | **`/students/:id/restore`** | admin | **NEW** | Un-archive. Without it, a mis-click on 1,000 rows is permanent |
| **PUT** | **`/students/:id` (unarchive)** | admin | — | Reject `deletedAt != null` rather than silently editing a ghost |

### 6.3 Bulk operations

| Method | Path | Guard | Status | Notes |
|---|---|---|---|---|
| POST | `/students/bulk` | admin | **FIX** | Wrap `insertMany` (§3.5); atomic ID allocation; return `format` |
| **POST** | **`/students/bulk/update`** | admin | **NEW** | §6.4 |
| **POST** | **`/students/bulk/archive`** | admin | **NEW** | §6.4. Soft delete by `_id[]` or by filter |
| **POST** | **`/students/bulk/validate`** | admin | **NEW** | Dry run. Parse + validate, insert nothing, return the exact per-row report |
| **POST** | **`/students/bulk/duplicates`** | admin | **NEW** | Pre-flight dedupe by `studentId` / name+parentPhone |
| POST | `/students/bulk-promote/:schoolId` | admin | **FIX** | Class-name/Id mismatch (§3.6); `.limit(500)` (§3.12) |
| POST | `/students/promote/preview` | admin | **FIX** | Capacity hardcoded (§3.15) |
| POST | `/students/bulk-graduate/:schoolId` | admin | **FIX** | `cohortId` pattern (§3.3); certificates collide (§3.6) |
| **POST** | **`/students/bulk/pay-links`** | admin | **NEW** | Regenerate for many at once after an ID-leak incident |
| **POST** | **`/students/bulk/status`** | admin | **NEW** | Suspend/reactivate by filter, with the same guards as the single route |

Every bulk endpoint takes `dryRun: true` and returns the identical envelope with
`committed: false`. A destructive bulk action that cannot be previewed is a bulk
action nobody will use.

### 6.4 New endpoint contracts

**`GET /students/stats`** — powers the roster KPI band. One round trip; the client
must not derive these from a paginated list.

```
GET /students/stats?class=JHS%202A&status=active
200 { success: true, data: {
  totalRoster, fullyCleared, enrollmentPercent,
  activePlans, overdueStudents, overdueAmount,
  totalOwed, totalPaid, collectedAmount
} }
```

**`GET /students/:id/profile`** — the profile preview. One call, so the drawer
does not fan out into five requests and render a half-populated student.

```
GET /students/:id/profile
200 { success: true, data: {
  student,            // full record, unmasked
  guardians: [],      // from the new Parent collection
  emergencyContacts: [],
  activePlan,         // PaymentPlan or null
  installmentProgress:{ paid, total, remaining, percent, nextDueDate },
  recentPayments: [], // ≤ 20, newest first
  classHistory: [],
  auditTrail: []      // last 20, needs §3.10 fixed
} }
```

**`POST /students/bulk/update`** — set many students to many values. Field-level,
whitelisted, one transaction.

```jsonc
POST /students/bulk/update
{
  "filter": { "class": "JHS 2A", "status": "active" },  // or "ids": ["…"]
  "update": { "totalOwed": 85000, "deadline": "2026-03-31" },
  "fields": ["totalOwed", "deadline"],   // explicit: no $set on unlisted keys
  "dryRun": false
}
200 { success: true, data: {
  matched, updated, unchanged, failed,
  errors: [{ id, studentId, reason }],
  preview: [{ id, studentId, before, after }]   // when dryRun
} }
```

Rules: `update` is restricted to the same field whitelist as
`updateStudentSchema`; `filter` and `ids` are mutually exclusive; a matched count
above a hard cap (2,000) returns 400 rather than truncating (§3.12); the whole
batch runs in one transaction so a partial bulk fee update cannot occur.

**`POST /students/bulk/archive`** — same shape, `ids` or `filter`, writes
`deletedAt`/`status: 'removed'`/`deletedBy`, refuses any student with an unpaid
balance unless `force: true` plus a reason, and returns per-student refusals.

**`POST /students/bulk/validate`** — the dry run for import. Shares the exact
parser and validator with the real import, so the preview cannot disagree with
the outcome. Returns `{ total, valid, invalid, errors: [{ row, reason }] }`
without writing.

### 6.5 Query contract for `GET /students` (unchanged, documented)

`schoolId` · `class` · `status` (default `active`, or `all`) · `search` · `page`
(default 1) · `perPage` (1–100, default 20) · `sortBy`
(`studentName|studentId|createdAt|totalOwed|balance`) · `sortOrder` (default
`desc`) · `format` (`csv|xlsx`).

The roster table needs two additions: **`feeStatus`** (`cleared|partial|owing|overdue`)
and **`planStatus`** (`none|active|defaulted|completed`). Both are derived server-side
because they need plan state, and filtering on them client-side would require
fetching every row.

---

## 7. UI component structure

### 7.1 Routes

```
/dashboard/students              → Students (ModuleTabs shell)
  ?tab=roster                    RosterTab   (default)
  ?tab=import                    ImportTab
  ?tab=alumni                    AlumniTab
  ?tab=cohorts                   CohortsTab
/dashboard/students/:studentId   → StudentProfilePage (full page, deep-linkable)
```

Tab state in the query string, not component state: a bursar sharing
"overdue JHS 2A" with a colleague must send a URL that reproduces the view.

### 7.2 Component tree

```
Students
├── PageHeader                      eyebrow · title · actions (Export, Add Student)
├── RosterKpiRow                    4 × Tile (reuses the Overview's KPI primitive)
├── ModuleTabs                      Roster · Import · Alumni · Cohorts
│
├── RosterTab
│   ├── RosterFilterBar
│   │   ├── SearchInput              debounced 300ms
│   │   ├── ClassSelect              ← school.academic.classes
│   │   ├── FeeStatusSelect          NEW param (§6.5)
│   │   ├── PlanStatusSelect         NEW param (§6.5)
│   │   └── AdvancedFiltersPopover   gender, deadline range, balance range
│   ├── StudentTable
│   │   ├── SelectAllCheckbox
│   │   ├── StudentCell              avatar · name · Overdue-since
│   │   ├── ClassCell
│   │   ├── GuardianCell             masked phone, reveal on click
│   │   ├── MoneyCell                tabular-nums, right-aligned
│   │   ├── InstallmentProgressCell  plan label + progress bar
│   │   ├── FeeStatusBadge           Overdue · Due Soon · On Track · Paid
│   │   └── RowActions               drawer · edit · lifecycle menu
│   ├── BulkActionBar                appears on selection (sticky bottom)
│   │   ├── BulkUpdateDialog
│   │   ├── BulkArchiveDialog
│   │   └── BulkStatusDialog
│   └── Pagination                   rows-per-page · page numbers · total
│
├── ImportTab                        ── extracted from Step3ImportStudents.jsx
│   └── ImportWizard
│       ├── TemplateDownload         CSV + XLSX, with the unit note from §3.1
│       ├── FileDropzone             10MB cap, mirrors the multer limit
│       ├── ColumnMapper             only if unmapped headers are found
│       ├── ValidationPreview        per-row errors, download the failures
│       └── ImportResultSummary      created / failed / errors, + Download errors
│
├── AlumniTab / CohortsTab
│   ├── AlumniTable
│   └── CohortCardGrid
│
└── StudentProfilePage / StudentProfileDrawer
    ├── ProfileHeader                avatar · name · ID · status · actions
    ├── ProfileTabs
    │   ├── OverviewTab              fees, deadline, guardian, plan summary
    │   ├── PaymentsTab              payment history
    │   ├── PlanTab                  installment timeline
    │   ├── GuardiansTab             parent + emergency contacts, CRUD
    │   └── HistoryTab               class history + audit trail
    └── LifecycleDialogs
        ├── PromoteDialog            with a mapping preview
        ├── GraduateDialog
        ├── RepeatDialog
        ├── TransferClassDialog
        ├── TransferOutDialog
        └── SuspendDialog
```

### 7.3 Reuse from the existing app

| Reuse | From |
|---|---|
| `Card`, `Badge`, `Popover` | `components/dashboard/ui/` |
| `Tile` (KPI) | `pages/dashboard/overview/KpiRow.jsx` |
| `Modal` | `components/common/Modal.jsx` |
| `Field`, `SelectField`, `FormAlert` | `components/common/FormField.jsx` |
| `useToast` | `hooks/useToast.js` |
| `Table` + `Pagination` | **new** — no table primitive exists; the transactions table inlines it |
| `MoneyInput` | **new** — pesewas/cedis boundary, must be single-sourced |
| `PhoneInput` | **new** — Ghana normalisation, mirrors `phoneValidator` |
| `DataTable` sort/select state | **new** |

`MoneyInput` is the important one: it is the client half of §3.1. A text field
accepting cedis, emitting pesewas, and rendering the parsed value back is the
only way the two write paths cannot diverge.

### 7.4 State and hooks

| Hook | Responsibility |
|---|---|
| `useStudents(filters)` | list, `meta`, loading, refetch; URL is the source of truth for filters |
| `useStudentStats(filters)` | KPI band |
| `useStudentProfile(id)` | the §6.4 aggregate |
| `useRosterSelection()` | selection set, select-all-visible semantics, capped at the bulk limit |
| `useStudentMutations()` | `create`, `update`, `archive`, `restore` + toasts + cache invalidation |
| `useBulkStudents()` | `update`, `archive`, `status`, `payLinks`, each with `dryRun` |
| `useImportWizard()` | file → parse → validate → commit state machine |

**Select-all semantics matter.** "Select all" across 1,000 students cannot send
1,000 ids. Two modes: select the current page (sends ids) or select everything
matching the filter (sends the filter). The UI must state which one the user
picked, because the second archives people they never saw.

---

## 8. Feature matrix

Legend: **OK** · **FIX** blocked on §3 · **NEW**.

| # | Capability | Endpoint | UI | Status |
|---|---|---|---|---|
| **Read** | | | | |
| 1 | Roster list, filter, sort, paginate | `GET /students` | `RosterTable` | OK |
| 2 | Roster aggregates | `/students/stats` | `RosterKpiRow` | **NEW** |
| 3 | Student profile preview | `GET /students/:id/profile` | `StudentProfileDrawer` | **NEW** |
| 4 | Export roster CSV/XLSX | `GET /students/export` | `ExportMenu` | FIX |
| 5 | Alumni list | `GET /alumni/:schoolId` | `AlumniTab` | FIX |
| 6 | Cohort list / detail | `GET /cohorts/*` | `CohortsTab` | **BLOCKED** |
| **Create** | | | | |
| 7 | Add one student | `POST /students/single` | `StudentForm` | FIX |
| 8 | Bulk import CSV/XLSX | `POST /students/bulk` | `ImportWizard` | FIX |
| 9 | Dry-run import validation | `POST /students/bulk/validate` | `ValidationPreview` | **NEW** |
| 10 | Duplicate pre-flight | `POST /students/bulk/duplicates` | `ValidationPreview` | **NEW** |
| **Update** | | | | |
| 11 | Edit one student | `PUT /students/:id` | `StudentForm` | FIX |
| 12 | **Bulk update** | `POST /students/bulk/update` | `BulkUpdateDialog` | **NEW** |
| 13 | Add / edit / remove guardian | `/students/:id/parents` | `GuardiansTab` | **BLOCKED** |
| 14 | Set primary guardian | `PUT /parents/:parentId/primary` | `GuardiansTab` | **BLOCKED** |
| 15 | Emergency contacts | — | `GuardiansTab` | **NEW** (no endpoints exist; embedded only) |
| 16 | Regenerate pay link | `GET /students/:id/pay-link` | `RowActions` | FIX |
| 17 | Bulk regenerate pay links | `POST /students/bulk/pay-links` | `BulkActionBar` | **NEW** |
| **Delete** | | | | |
| 18 | Archive one (soft) | `DELETE /students/:id` | `RowActions` | OK |
| 19 | **Bulk archive** | `POST /students/bulk/archive` | `BulkArchiveDialog` | **NEW** |
| 20 | Restore archived | `POST /students/:id/restore` | `AlumniTab` / search | **NEW** |
| **Lifecycle** | | | | |
| 21 | Suspend / reactivate / remove | `PUT /students/:id/{suspend,reactivate,remove}` | `SuspendDialog` | OK |
| 22 | **Bulk status change** | `POST /students/bulk/status` | `BulkStatusDialog` | **NEW** |
| 23 | Transfer class | `PUT /students/:id/transfer-class` | `TransferClassDialog` | OK |
| 24 | Promote (one / bulk / preview) | `/students/:id/promote`, `/bulk-promote`, `/promote/preview` | `PromoteDialog` | FIX |
| 25 | Mark repeating | `POST /students/:id/repeat` | `RepeatDialog` | FIX |
| 26 | **Clear repeating** | — | `RepeatDialog` | **NEW** — no endpoint |
| 27 | Graduate (one / bulk) | `/students/:id/graduate`, `/bulk-graduate` | `GraduateDialog` | FIX |
| 28 | Transfer out | `POST /students/:id/transfer-out` | `TransferOutDialog` | FIX |
| **Cross-cutting** | | | | |
| 29 | Audit trail per student | `GET /audit-logs/:schoolId` | `HistoryTab` | FIX (stub, §3.10) |
| 30 | Notify guardian by SMS | `GET /students/:id/pay-link?notify=true` | `RowActions` | FIX (stub reports sent) |
| 31 | Student photo / ID card | `studentImage`, `idCard.routes.js` | `ProfileHeader` | OK |
| 32 | Duplicate detection | `POST /students/bulk/duplicates` | `ValidationPreview` | **NEW** |
| 33 | Class roster with capacity | `Class` collection | `RosterFilterBar` | **NEW** |
| 34 | `super_admin` can inspect any student | — | — | **FIX** (§3.4) |

**Totals:** 12 OK · 16 FIX · 21 NEW (of which 6 are blocked behind a model change).

---

## 9. Implementation plan

### 9.1 Phase 0 — Stop the bleeding (1–2 days, no new features)

Correctness defects that make any subsequent testing meaningless. Nothing else
should start until these land.

| # | Fix | Section |
|---|---|---|
| 0.1 | Resolve the `totalOwed` unit ambiguity; document per endpoint; comment the CSV template | §3.1 |
| 0.2 | Escape `$regex` in all four search paths | §3.7 |
| 0.3 | Serialise `ApiError.code` in the student error envelope | §3.14 |
| 0.4 | Wrap `insertMany`; never lose `{created, failed, errors}` | §3.5 |
| 0.5 | Atomic `studentId` allocation (counter collection) | §3.5 |
| 0.6 | Strip lifecycle fields from `updateStudentSchema` | §3.8 |
| 0.7 | Add `graduationType` / `certificateNumber` / `honors` + unique certificate index | §3.6 |
| 0.8 | Add role guard to `GET /students/:id/parents`; settle the masking policy | §3.13 |
| 0.9 | Replace the `auditService` stub with the real one | §3.10 |
| 0.10 | Fix export's empty-result header | §3.16 |
| 0.11 | Consolidate `DELETE /students/:id` and `/remove` | §3.9 |

Blocked routes (`/parents/:parentId`, `/cohorts/:cohortId`, `super_admin`
id-scoped access) are **deliberately not patched here** — each is fixed properly
by §5.2, §5.3 and the scope-resolution change in Phase 2. Patching them twice
costs more than leaving them visibly broken, which is what they now are: they
return 400/422, not wrong data.

### 9.2 Phase 1 — Roster read path (3–4 days)

The screen the design specifies, on endpoints that already work.

1. `services/students.js`: `listStudents`, `getStudent`, `exportStudents`,
   `getStudentStats`. One function per endpoint, no UI knowledge.
2. `useStudents` — URL-backed filters, debounced search, `meta` pagination.
3. `RosterFilterBar`, `StudentTable`, `Pagination`, `RosterKpiRow`.
4. `GET /students/stats` on the backend.
5. `feeStatus` / `planStatus` query params.
6. Row click → `StudentProfileDrawer` on `GET /students/:id` (not the aggregate
   yet; the aggregate lands with Phase 3).

### 9.3 Phase 2 — Single-record management (3–4 days)

1. `StudentForm` — create and edit, driven by a shared field descriptor so the
   two cannot drift. `MoneyInput` and `PhoneInput` land here.
2. `SuspendDialog`, `TransferClassDialog`, `PromoteDialog`, `GraduateDialog`,
   `RepeatDialog`, `TransferOutDialog` — all six, since they share the
   transition-dialog pattern.
3. `Parent` collection + migration (§5.2) → **rebuild the five parent endpoints**.
4. Fix `resolveSchoolId` for `super_admin` (§3.4).
5. Resolve the class-name/Id and `cohortId` contradictions — rename the Joi
   fields, or adopt the `Class` collection (§5.3).

### 9.4 Phase 3 — Bulk operations (5–7 days, the largest)

Sequenced so the riskiest piece, import, is not last.

1. `POST /students/bulk/validate` (dry run) — reuses the real parser.
2. Extract `ImportWizard` from `Step3ImportStudents.jsx` and mount it in
   `ImportTab`. The wizard is already written and working; this is a move, and
   onboarding then imports it back rather than keeping a copy.
3. `POST /students/bulk/update` + `BulkUpdateDialog` + `BulkActionBar`.
4. `POST /students/bulk/archive` + `BulkArchiveDialog`.
5. `POST /students/:id/restore` + the archive browser.
6. `POST /students/bulk/status`, `/pay-links`.
7. `GET /students/:id/profile` + the full profile drawer.
8. Remediate the silent truncation limits (§3.12).

### 9.5 Phase 4 — Hardening (ongoing)

- Test coverage, currently zero (§10).
- `schoolStats.totalStudents` reconciliation — incremented on import, never
  decremented on archive, and already inconsistent with the roster count.
- Concurrent-import load test for the counter fix.
- Soft-delete query leakage: every read path must filter `deletedAt: null`, and
  an index-backed assertion in CI should catch a new query that forgets.

### 9.6 Sequencing dependencies

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3
   │                      │
   └─ 0.7 ───────────────┴─► §5.2 Parent collection ──► parent endpoints
                             └─► §5.3 Class collection  ──► classId correctness
```

Phase 1 has no blockers. Phase 2's parent work is gated on the `Parent`
migration. Phase 3's bulk-update is gated on the Phase 0 field whitelist from
0.6, since a bulk write must not be able to set a field the single write cannot.

---

## 10. Test plan

`Backend/tests/` has **no student coverage at all**. Four files exist; none
touches a student. The proposed minimum, in priority order:

**Service-level (no HTTP)**
- `totalOwed` round-trips as pesewas on **both** write paths (§3.1) — the single
  most important test in the module.
- `generateStudentId` is unique under 20 concurrent allocations.
- `insertMany` with one duplicate still returns a per-row report (§3.5).
- The pre-save hook recomputes `balance` and normalises the primary parent.
- Each transition refuses an illegal source state.

**Route-level (supertest)**
- 422 carries `errors[]`; controller errors carry `code`.
- Cross-school access is refused on every id-scoped route.
- `super_admin` can reach an id-scoped route (§3.4).
- Search with `.*` and with `[` does not 500 (§3.7).
- Every route is denied to `teacher` and `viewer`.
- List filters, sorting and pagination compose correctly.

**Bulk**
- `dryRun` writes nothing and returns the same shape as the real run.
- Bulk update honours the field whitelist.
- Bulk archive refuses students with an unpaid balance without `force`.
- A matched count over the cap returns 400, never a silent truncation.

**Frontend (`check:dashboard` pattern)**
- The roster renders, and one row action is reachable.
- An empty roster, a filtered-to-zero roster, and a loading roster are three
  distinct states.
- Select-all states which mode it used.

---

## 11. Decisions required before Phase 1

| # | Decision | Recommendation |
|---|---|---|
| 1 | `totalOwed` unit on the CSV | Cedis in the file, pesewas on the wire, unit stated in the template header and the wizard's column mapper |
| 2 | Promote embedded parents to a `Parent` collection? | **Yes.** The parent endpoints cannot be fixed without it, and `Payment.parentId` is already dangling |
| 3 | Introduce a `Class` collection? | Yes, but Phase 4. Phase 2 renames the misleading Joi fields instead |
| 4 | Bulk delete semantics | Soft delete only, consistent with `DELETE /students/:id`. Hard delete is excluded by design |
| 5 | Bulk action cap | 2,000 per request, 400 above it, never a silent truncation |
| 6 | Phone masking policy | Mask in list and export, unmask in profile and to admins only. The current split is indefensible (§3.13) |
| 7 | Does the roster paginate server-side only? | Yes. `perPage` caps at 100; no client-side paging over a partial set |

---

## 11. What shipped

Backend: **35 routes** registered, `npm test` **130 passing** (41 new in
`tests/studentModule.test.js`). Frontend: build clean, `check:dashboard` **18**,
`check:mock` **94**, `check:auth` **8**.

### 11.1 Defects closed

| §3 | Defect | Resolution |
|---|---|---|
| 3.1 | `totalOwed` in two units | Both paths documented and named: the API is pesewas, the CSV is cedis and converts at the file boundary. `bulkUploadMetaSchema.defaultOwed` accepts decimals (cedis); `createStudentSchema.totalOwed` requires an integer (pesewas). The import template's header column is `Total Owed (CEDIS)`, and `MoneyInput` is the only client-side crossing |
| 3.2 | All five parent endpoints broken | Sub-documents keep their `_id`; routes nested under `/students/:id`; `addParent` no longer pushes a hand-rolled id that was then stripped. **Deferred:** promoting parents to a collection (§12) |
| 3.3 | `GET /cohorts/:cohortId` always 422 | Validator accepts `cohort_YYYY` or a bare year. Also found: `/cohorts/:schoolId` and `/cohorts/:cohortId` collided on path shape, so the detail handler was shadowed by the list — it is now `/cohorts/detail/:cohortId` |
| 3.4 | `super_admin` blocked from every id-scoped route | `loadStudent()` resolves scope from the student, so no explicit `schoolId` is needed. The eight repeated scope blocks are replaced by one helper that also puts the scope in the *query* rather than checking after an unscoped read |
| 3.5 | Bulk import lost its whole report | `insertMany` wrapped; a `BulkWriteError` maps each driver error back to the spreadsheet row. New `Counter` model allocates ids with a single atomic `$inc`, and `reserveStudentIds(count)` allocates a whole file in one round trip. `syncStudentIdCounter()` migrates existing schools |
| 3.6 | `graduationType`/`certificateNumber`/`honors` unstored | Declared on the model, with a partial unique index on `(schoolId, certificateNumber)`. Certificates come from a counter, not `Math.random()`; the duplicate check reads the real path |
| 3.7 | Unescaped `$regex` | `searchClause()` + `escapeRegExp` on all four paths |
| 3.8 | Lifecycle fields writable via `PUT` | Removed from `updateStudentSchema` *and* from the service's protected list. `isRepeating` gained `POST /students/:id/unrepeat` |
| 3.9 | `DELETE` and `/remove` identical | One implementation; `/remove` kept as an alias for existing clients |
| 3.10 | Audit log was `console.log` | Real `auditService`; every write logs, and the profile reads it back |
| 3.11 | `:id` was `_id` only | Both the `_id` and `studentId` (`PBS-2026-0001`) are accepted |
| 3.12 | Silent truncation at 500/300 | `BULK_LIMIT` of 2000 with an explicit `BULK_LIMIT_EXCEEDED` refusal |
| 3.13 | Inconsistent PII masking | Policy settled: masked in the roster and export, full on a single record and to admins. `GET /students/:id/parents` is now role-guarded |
| 3.14 | `error.code` dropped | One `fail()` responder in the controller; all 27 error paths use it |
| 3.15 | Placeholders as data | `teacher` is `null` (not `""`), class counts are counted, `transferOutRecord` persists, `skippedStudents` is populated, capacity is caller-supplied, cohorts honour `status` |
| 3.16 | Empty export was `"\n"` | Fixed `COLUMNS`; a header-only CSV, plus `rowCount` in the response |

### 11.2 Endpoints added

`GET /students/stats` · `GET /students/:id/profile` ·
`POST /students/:id/restore` · `POST /students/:id/unrepeat` ·
`POST /students/bulk/validate` (as `dryRun` on the existing import) ·
`POST /students/bulk/update` · `POST /students/bulk/archive` ·
`POST /students/bulk/status` · `POST /students/bulk/pay-links`

Plus `feeStatus`, `planStatus` and `gender` on `GET /students`, and `dryRun` on
the importer. `classIds` → `classNames` and `targetClassId` → `targetClass`;
`cohortId` now takes a year.

### 11.3 Frontend

`services/students.js` now covers the full surface (3 functions → 30).
`hooks/useStudents.js` adds URL-backed filters, the stats request, and selection
with **two explicit modes** — visible rows, or everything matching the filter.
`components/students/` holds the roster table, filter bar, KPI band, bulk action
bar, profile drawer, form and the three tabs. `MoneyInput`, `PhoneInput` and
`Tile` are shared primitives; `Tile` was extracted out of the Overview's page so
both KPI rows are literally the same component.

### 11.4 Breaking changes

| Change | Why it had to break |
|---|---|
| `listStudents` returns `{ rows, meta, offline }`, not an array | The old shape discarded `meta`, which is why no page could show a total. `offline` preserves the wizard's "degrade to empty" contract while distinguishing it from a genuinely empty roster |
| `regeneratePayLink` no longer returns the raw token | It returned exactly the field the `toJSON` transform exists to strip |
| `targetClassId` → `targetClass`, `classIds` → `classNames` | The old names promised ObjectIds the service compared against class names |
| `cohortId` is a year, and detail moved to `/cohorts/detail/:cohortId` | Both old values were unusable |
| Parent routes nested under `/students/:id` | They read a `:id` segment that did not exist |
| Export columns are `totalOwedCedis`/`totalPaidCedis`/`balanceCedis` | A column labelled `totalOwed` holding pesewas read as 85,000 in a spreadsheet |

---

## 12. Not done, and why

| Item | Status |
|---|---|
| **`Parent` collection** | Deferred. The embedded array is now addressable, so the endpoints work. Promoting parents is a data migration, and would also give `Payment.parentId` a real `ref`. It is still the right call — just not a same-day one |
| **`Class` collection** | Deferred. The misleading Joi fields were renamed instead (§11.1), so promotion is correct. Class ids, real capacities and teacher assignments still have no source |
| **DB-backed tests for the new service code** | Open. `reserveStudentIds` concurrency, `insertMany` recovery, the bulk limits and the audit rows all need a database; `Backend/` has no `mongodb-memory-server` and the suite is pure-unit by convention. This is the largest remaining gap |
| **`Class` capacity** | The promotion preview now takes `classCapacity` and skips the check when it is not supplied, rather than assuming 40 |
| **Cohort detail deep-link from the roster** | The tabs and cards exist; there is no `?cohort=` route parameter |
| **Guardian CRUD in the profile drawer** | The four endpoints work and the drawer lists guardians, but editing them from the drawer is not built — `GuardiansTab` is read-only |

---

## 13. Verification

| Layer | Command | Result |
|---|---|---|
| Backend unit | `npm test` (in `Backend/`) | 130 passing, 41 new |
| Frontend build | `npm run build` | clean |
| Shell + Overview + roster render | `npm run check:dashboard` | 18 passing |
| Mock API contract | `npm run check:mock` | 94 passing |
| Auth render | `npm run check:auth` | 8 passing |

`check:dashboard` gained four checks during this work, each covering a bug the
build could not see because `vite build` never executes a component body:
per-route render attribution, isolated renders of the roster sub-components, the
single-current-tab assertion, and a static guard against default-importing
`SelectField` (which is the text `Field`).

---

## Appendix — route inventory (as-built, for reference)

`student.routes.js`, all authenticated; `admin` = `authorize('super_admin','school_admin')`.

| Method | Path | Guard |
|---|---|---|
| POST | `/students/single` | admin |
| POST | `/students/bulk` | admin |
| GET | `/students` | — |
| GET | `/students/export` | — |
| GET | `/students/:id` | — |
| PUT | `/students/:id` | admin |
| DELETE | `/students/:id` | admin |
| PUT | `/students/:id/suspend` | admin |
| PUT | `/students/:id/reactivate` | admin |
| PUT | `/students/:id/remove` | admin |
| PUT | `/students/:id/transfer-class` | admin |
| GET | `/students/:id/pay-link` | admin |
| POST | `/students/:id/promote` | admin |
| POST | `/students/bulk-promote/:schoolId` | admin |
| POST | `/students/promote/preview` | admin |
| POST | `/students/:id/repeat` | admin |
| POST | `/students/:id/graduate` | admin |
| POST | `/students/bulk-graduate/:schoolId` | admin |
| POST | `/students/:id/transfer-out` | admin |
| POST | `/students/:id/parents` | admin |
| GET | `/students/:id/parents` | — |
| PUT | `/parents/:parentId` | admin |
| PUT | `/parents/:parentId/primary` | admin |
| DELETE | `/parents/:parentId` | admin |
| GET | `/alumni/:schoolId` | — |
| GET | `/cohorts/:schoolId` | — |
| GET | `/cohorts/:cohortId` | — |

Note: `:id` is the Mongo `_id` on every id-scoped route (§3.11). `GET
/students/export` is deliberately registered before `GET /students/:id` so
`"export"` is not captured as an id.
