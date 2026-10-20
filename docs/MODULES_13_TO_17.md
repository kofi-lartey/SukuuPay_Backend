# Sukuupay — Modules 13–17 API Reference

> **Project:** Sukuupay — Ghanaian school fee collection SaaS (Node.js + Express + MongoDB)
> **Base URL:** `/api`
> **Timezone:** Africa/Accra (GMT+0)
> **Currency:** All monetary values stored as integer **pesewas** (1 GHS = 100 pesewas)

---

## MODULE 13 — AUDIT LOG

**Base path:** `/api/audit-logs`

### Overview

Records every create, update, delete, login, payment, and configuration change for accountability. Immutable — audit entries are soft-deleted at minimum and never permanently removed during normal operation.

- **Users:** Super Admin (full access across schools), School Admin (own school only)
- **Dependencies:** School, User, Payment, PaymentPlan, Student modules

### 1. `GET /audit-logs/:schoolId`

**Brief Description:** Returns a paginated, filterable list of audit log entries for a school.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:**

| Name | Type | Required | Description |
|---|---|---|---|
| `schoolId` | ObjectId | Yes | The school whose audit logs to retrieve |

**Query Params:**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `userId` | ObjectId | No | — | Filter by the acting user |
| `action` | String | No | — | Filter by action enum (e.g. `student.create`) |
| `entity` | String | No | — | Filter by entity (e.g. `student`, `payment`) |
| `entityId` | ObjectId | No | — | Filter by the entity's ID |
| `from` | Date (ISO) | No | — | Start of date range (inclusive) |
| `to` | Date (ISO) | No | — | End of date range (inclusive, end-of-day Accra) |
| `page` | Number | No | 1 | Page number |
| `perPage` | Number | No | 20 | Items per page (max 100) |

**Request Body:** None

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "Audit logs retrieved successfully",
  "data": [
    {
      "_id": "672a1b2c3d4e5f6789012345",
      "schoolId": "672a1b2c3d4e5f6789012300",
      "userId": {
        "_id": "672a1b2c3d4e5f6789012000",
        "name": "Admin User",
        "email": "admin@school.edu.gh",
        "role": "school_admin"
      },
      "action": "student.create",
      "entity": "Student",
      "entityId": "672a1b2c3d4e5f6789056789",
      "before": null,
      "after": { "studentName": "Ada Mensah", "studentClass": "JS 2" },
      "ip": "192.168.1.100",
      "userAgent": "Mozilla/5.0...",
      "meta": { "description": "Created student Ada Mensah (JS 2)" },
      "createdAt": "2025-10-15T08:30:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `401` | Authentication required |
| `403` | User does not have access to this school; no school in scope |
| `404` | School not found |
| `422` | Invalid `schoolId`, `userId`, or `entityId` format; invalid action enum |
| `500` | Internal server error |

**Rate Limit:** 60 requests / minute per IP

**Notes / Edge Cases:**
- The `userId` field is populated with `{ name, email, role }`.
- The `to` date is treated as end-of-day Accra (23:59:59.999) so the upper bound is inclusive.
- Audit entries are sorted by `createdAt` descending (newest first).
- Super admins may pass `schoolId` to query any school; school admins are restricted to their own `schoolId`.

---

### 2. `GET /audit-logs/:schoolId/export`

**Brief Description:** Exports the full audit log for a school as a downloadable CSV file.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:**

| Name | Type | Required | Description |
|---|---|---|---|
| `schoolId` | ObjectId | Yes | The school whose audit logs to export |

**Query Params:**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `userId` | ObjectId | No | — | Filter by the acting user |
| `action` | String | No | — | Filter by action enum |
| `entity` | String | No | — | Filter by entity name |
| `entityId` | ObjectId | No | — | Filter by entity ID |
| `from` | Date (ISO) | No | — | Start of date range |
| `to` | Date (ISO) | No | — | End of date range |

**Request Body:** None

**Response (`200 OK`):** Streaming CSV with `Content-Type: text/csv` and `Content-Disposition: attachment; filename="audit-log-<schoolSlug>-<YYYY-MM-DD>.csv"`

```csv
Timestamp,User Name,User Email,Action,Entity,Entity ID,IP Address,Description
2025-10-15T08:30:00.000Z,Admin User,admin@school.edu.gh,student.create,Student,672a1b2c3d4e5f6789056789,192.168.1.100,Created student Ada Mensah (JS 2)
```

**Error Responses:**

| Status | Reason |
|---|---|
| `401` | Authentication required |
| `403` | No school in scope |
| `404` | School not found |
| `422` | Invalid query parameters |
| `500` | Internal server error |

**Rate Limit:** 10 requests / minute per IP (exports are expensive)

**Notes / Edge Cases:**
- CSV export is capped at **50,000 rows**. If the filtered result exceeds this, only the first 50,000 rows are returned.
- Cell values containing commas, quotes, or newlines are automatically quoted.
- Formula-injection prevention: cells starting with `=`, `+`, `-`, `@`, `\t`, or `\r` are prefixed with a single quote.
- The filename uses the school's `slug` if available, otherwise the raw ObjectId.

---

### 3. `GET /audit-logs/user/:userId`

**Brief Description:** Returns a paginated list of audit log entries for a specific user across their school.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | ObjectId | Yes | The user whose activity to retrieve |

**Query Params:**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `from` | Date (ISO) | No | — | Start of date range |
| `to` | Date (ISO) | No | — | End of date range |
| `page` | Number | No | 1 | Page number |
| `perPage` | Number | No | 20 | Items per page (max 100) |

**Request Body:** None

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "User audit logs retrieved successfully",
  "data": [
    {
      "_id": "672a1b2c3d4e5f6789012345",
      "schoolId": "672a1b2c3d4e5f6789012300",
      "userId": "672a1b2c3d4e5f6789012000",
      "action": "user.login",
      "entity": "User",
      "entityId": null,
      "ip": "192.168.1.100",
      "userAgent": "Mozilla/5.0...",
      "meta": null,
      "createdAt": "2025-10-15T08:25:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `401` | Authentication required |
| `403` | No school in scope |
| `404` | User not found or not in the requester's school |
| `422` | Invalid `userId` format |
| `500` | Internal server error |

**Rate Limit:** 60 requests / minute per IP

**Notes / Edge Cases:**
- For **School Admins**, the `userId` must belong to the same school. If the user is not found in the school, a `404` is returned.
- For **Super Admins**, any `userId` is accepted. The school scope is derived from the target user's `schoolId` field.
- The `userId` field is **not** populated (returned as ObjectId) to avoid redundant joins when only one user is being viewed.

---

### Module-Level Notes

- **Related model:** `AuditLog` (`src/models/AuditLog.js`)
- **Related service:** `auditService` (`src/utils/auditService.js`) — all other modules call `log()` from this service to record their actions.
- **Fields:** `_id, schoolId, userId, action, entity, entityId, before, after, ip, userAgent, meta, createdAt`
- **Indexes:** `{ schoolId: 1, createdAt: -1 }`, `{ userId: 1, createdAt: -1 }`, `{ action: 1, createdAt: -1 }`, `{ entityId: 1 }`
- **TTL:** None — audit logs are retained indefinitely.
- **Jobs:** No scheduled jobs. Writes are append-only.

---

## MODULE 14 — ID CARDS

**Base path:** `/api/id-cards`

### Overview

Generates printable student ID cards as PDF documents with QR codes that link to the student's pay page. Supports both single-card generation (on-the-fly) and batch generation (via a background job).

- **Users:** Super Admin, School Admin
- **Dependencies:** Student, School, Notification modules; Cloudinary for PDF storage; QR Code generation via `qrcode` package

### 1. `POST /id-cards/batch`

**Brief Description:** Creates a batch of student ID cards and triggers background PDF generation.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:** None

**Query Params:** None

**Request Body:**

```json
{
  "studentIds": [
    "672a1b2c3d4e5f6789056789",
    "672a1b2c3d4e5f6789056790"
  ],
  "includeQr": true,
  "includePhoto": true,
  "cardTemplate": "default"
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `studentIds` | Array\<ObjectId\> | Yes | — | List of student IDs (min 1) |
| `includeQr` | Boolean | No | `true` | Whether to include QR code linking to pay page |
| `includePhoto` | Boolean | No | `true` | Whether to include student photo |
| `cardTemplate` | String | No | `"default"` | Template variant (`"default"` currently the only option) |

**Response (`202 Accepted`):**

```json
{
  "success": true,
  "message": "ID card batch creation started",
  "data": {
    "batchId": "672a1b2c3d4e5f6789099999",
    "status": "pending"
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `400` | One or more student IDs do not belong to the requester's school |
| `401` | Authentication required |
| `403` | No school in scope |
| `422` | Invalid `studentIds` format or empty array |
| `500` | Internal server error |

**Rate Limit:** 10 requests / minute per user

**Notes / Edge Cases:**
- All `studentIds` must belong to the same school as the requester (or the specified school for super admins).
- The PDF is generated asynchronously. Use the batch print preview endpoint to check status.
- The generated PDF is uploaded to Cloudinary under `schools/<slug>/id-cards/`.
- If generation fails, the batch status is set to `"failed"` and a system notification is sent to the requester.

---

### 2. `GET /id-cards/:studentId`

**Brief Description:** Generates a single student's ID card PDF on-the-fly and returns the binary stream.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:**

| Name | Type | Required | Description |
|---|---|---|---|
| `studentId` | ObjectId | Yes | The student whose ID card to generate |

**Query Params:** None

**Request Body:** None

**Response (`200 OK`):** Binary PDF stream with `Content-Type: application/pdf` and `Content-Disposition: inline; filename="id-card-<studentId>-<studentName>.pdf"`

**Error Responses:**

| Status | Reason |
|---|---|
| `401` | Authentication required |
| `403` | User does not have access to this school |
| `404` | Student not found or does not belong to the school |
| `422` | Invalid `studentId` format |
| `500` | Internal server error |

**Rate Limit:** 20 requests / minute per user

**Notes / Edge Cases:**
- The PDF is generated in real-time and streamed directly — no Cloudinary upload occurs.
- If the student has no `payLink`, the QR code is omitted from the card.
- If the student has no `studentImage`, a placeholder is rendered.

---

### 3. `GET /id-cards/batch/:batchId`

**Brief Description:** Returns either the batch's HTML print-preview page (when ready) or a pending status JSON (when still generating).

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:**

| Name | Type | Required | Description |
|---|---|---|---|
| `batchId` | ObjectId | Yes | The ID card batch to preview |

**Query Params:** None

**Request Body:** None

**Response (`200 OK` — ready):** HTML page with a grid of all cards, including a print button.

**Response (`202 Accepted` — pending):**

```json
{
  "success": true,
  "message": "Batch is still being generated",
  "data": {
    "status": "pending",
    "retryAfter": 15
  }
}
```

**Response (`500 — failed`):**

```json
{
  "success": false,
  "message": "ID card batch generation failed",
  "data": {
    "status": "failed",
    "error": "Error message from the generation job"
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `401` | Authentication required |
| `403` | User does not have access to this school |
| `404` | Batch not found |
| `422` | Invalid `batchId` format |
| `500` | Internal server error or batch generation failed |

**Rate Limit:** 30 requests / minute per user

**Notes / Edge Cases:**
- The HTML preview is rendered server-side with inline CSS. Click "Print All ID Cards" to open the browser print dialog.
- Each card in the preview shows the school name, student photo (or placeholder), student details, and a QR code placeholder.
- The endpoint must be registered **before** `/:studentId` so that "batch" is not captured as a student ID.

---

### 4. `GET /id-cards/qr-links/:schoolId`

**Brief Description:** Exports a CSV of all students in a school with their QR pay-link data.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:**

| Name | Type | Required | Description |
|---|---|---|---|
| `schoolId` | ObjectId | Yes | The school whose student QR links to export |

**Query Params:**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `page` | Number | No | 1 | Page number |
| `perPage` | Number | No | 20 | Items per page (max 100) |

**Request Body:** None

**Response (`200 OK`):** Streaming CSV with headers `Content-Type: text/csv` and `Content-Disposition: attachment; filename="qr-links-<schoolSlug>-<YYYY-MM-DD>.csv"`

```csv
Student ID,Student Name,Class,Pay Link,QR Image URL
PBS-2026-0001,Ada Mensah,JS 2,https://sukuupay.com/pay/STU-8F3K9D2L,data:image/png;base64,iVBORw0KGgo...
```

**Error Responses:**

| Status | Reason |
|---|---|
| `401` | Authentication required |
| `403` | No school in scope |
| `404` | School not found |
| `422` | Invalid `schoolId` format |
| `500` | Internal server error |

**Rate Limit:** 10 requests / minute per IP

**Notes / Edge Cases:**
- The `qrImageUrl` column contains a data-URL (base64-encoded PNG) when a pay link exists, or an empty string otherwise.
- Pagination is applied to the export to prevent excessively large CSVs.
- The endpoint must be registered **before** `/:studentId` so that "qr-links" is not captured as a student ID.

---

### Module-Level Notes

- **Related models:** `IdCardBatch` (`src/models/IdCardBatch.js`), `Student`, `School`
- **Related service:** `idCard.service.js`
- **Related job:** `jobs/generateIdCards.job.js` — background PDF generation
- **Related templates:** `templates/idCard.template.html`
- **IdCardBatch fields:** `_id, schoolId, studentIds[], totalCards, pdfUrl, publicId, status, generationError, requestedBy, createdAt, updatedAt`
- **Statuses:** `pending`, `generating`, `ready`, `failed`
- **Storage:** Generated PDFs are uploaded to Cloudinary under `schools/<slug>/id-cards/`.
- **Cron:** No scheduled cron job. Batch generation is triggered on-demand.

---

## MODULE 15 — FILE UPLOAD

**Base path:** `/api/upload`

### Overview

Centralized file upload endpoints via Cloudinary with validation, compression, and automatic cleanup. Handles student photos (single and bulk ZIP), and school logos. All uploads use in-memory storage with sharp-based dimension validation and resizing before Cloudinary upload.

- **Users:** Super Admin, School Admin
- **Dependencies:** Student model; Cloudinary via `utils/cloudinary.js`; `sharp` for image processing; `adm-zip` for ZIP extraction

### 1. `POST /upload/student-photo`

**Brief Description:** Uploads a single student photo, validates dimensions, resizes to 400×400, and optionally links it to a student record.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:** None

**Query Params:** None

**Request Body:** Multipart form data — `file` (required), `studentId` (optional)

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | File (multipart) | Yes | Image file (JPG, PNG, or WebP) |
| `studentId` | ObjectId | No | If provided, updates `student.studentImage` with the uploaded URL |

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "Student photo uploaded successfully",
  "data": {
    "url": "https://res.cloudinary.com/sukuupay/image/upload/v1234567890/sukuupay-1234567890.jpg",
    "publicId": "sukuupay-1234567890",
    "width": 400,
    "height": 400
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `400` | No file provided; invalid MIME type; file larger than 2 MB; image smaller than 200×200; invalid student ID |
| `401` | Authentication required |
| `403` | No school in scope; student does not belong to the requester's school |
| `404` | Student not found |
| `422` | Invalid `studentId` format |
| `500` | Cloudinary upload failure |

**Rate Limit:** 30 requests / minute per user

**Notes / Edge Cases:**
- MIME types accepted: `image/jpeg`, `image/png`, `image/webp`.
- Minimum dimensions: 200×200 pixels (enforced via `sharp`).
- The image is resized to 400×400 using a cover crop (centered) and converted to WebP (or PNG for PNG sources).
- If `studentId` is provided and the student already has a `studentImage`, the old Cloudinary image is deleted after the new one is successfully uploaded.
- If any error occurs after the image is uploaded to Cloudinary, the image is deleted to prevent orphaned assets.

---

### 2. `POST /upload/student-photos/bulk`

**Brief Description:** Uploads a ZIP archive of student photos. Each image filename must match a student ID (either a MongoDB ObjectId or a student number like `PBS-2026-0001`). Auto-matches, resizes, uploads to Cloudinary, and updates each student's `studentImage`.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:** None

**Query Params:** None

**Request Body:** Multipart form data — `file` (single ZIP archive)

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "850 photos uploaded, 12 skipped",
  "data": {
    "uploaded": 850,
    "skipped": 12,
    "errors": [
      {
        "file": "PBS-2026-0142.jpg",
        "reason": "No matching student"
      }
    ]
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `400` | No ZIP file provided; file is not a ZIP archive; ZIP larger than 50 MB; ZIP contains more than 2,000 files |
| `401` | Authentication required |
| `403` | No school in scope |
| `500` | Internal server error |

**Rate Limit:** 5 requests / minute per user

**Notes / Edge Cases:**
- Each image inside the ZIP is validated and resized to 400×400 (cover crop) before upload.
- A file is "skipped" if its filename does not match any student in the school.
- A file is "errored" if the image is corrupt, too small, or the Cloudinary upload fails.
- Skipped and errored files are both reported in the `errors` array but counted separately: `uploaded` + `skipped` + `errors` may not equal total files in the ZIP.
- Temp files are cleaned up automatically (files are processed from memory buffers, never written to disk).

---

### 3. `POST /upload/school-logo`

**Brief Description:** Uploads a school logo, validates and resizes to 512×512 square, replaces the old logo on the school record, and deletes the old Cloudinary image.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:** None (school is derived from the authenticated user)

**Query Params:** None

**Request Body:** Multipart form data — `file`

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | File (multipart) | Yes | Image file (JPG, PNG, or WebP), max 1 MB |

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "School logo uploaded successfully",
  "data": {
    "url": "https://res.cloudinary.com/sukuupay/image/upload/v1234567890/school-logo-123456.jpg",
    "publicId": "school-logo-123456"
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `400` | No file provided; invalid MIME type; file larger than 1 MB; image smaller than 200×200 |
| `401` | Authentication required |
| `403` | No school in scope |
| `404` | School not found |
| `500` | Cloudinary upload failure |

**Rate Limit:** 10 requests / minute per user

**Notes / Edge Cases:**
- The image is auto-cropped to a 512×512 square (center gravity).
- The old logo's Cloudinary `public_id` is extracted from the URL and deleted.
- School admins upload to their own school; super admins upload to the school determined by `req.user.schoolId`.

---

### Module-Level Notes

- **Related middleware:** `middleware/upload.js` — exports `studentPhotoUpload`, `schoolLogoUpload`, `zipUpload` (all use `multer.memoryStorage()`).
- **Related utilities:** `utils/cloudinary.js` — `uploadBuffer()`, `extractPublicId()`, `deleteFromCloudinary()` (from `middleware/upload.js`).
- **Dependencies added:** `sharp` (image processing), `adm-zip` (ZIP extraction).
- **Cloudinary folders:** `schools/students/photos`, `schools/logos`.
- **Cleanup:** Failed uploads always trigger Cloudinary cleanup to prevent orphaned assets.

---

## MODULE 16 — NOTIFICATIONS (IN-APP)

**Base path:** `/api/notifications`

### Overview

In-app notification center for admins. Notifies users of new payments, plan creation/acceptance/cancellation, student imports, SMS sends, subscription expirations, and system alerts. Notifications auto-expire after 90 days via MongoDB TTL index.

- **Users:** All authenticated users (notifications are scoped to the logged-in user)
- **Dependencies:** User model; Notification model is consumed by Payment, PaymentPlan, Student, and Settings modules.

### 1. `GET /notifications`

**Brief Description:** Returns a paginated list of notifications for the logged-in user.

**Auth Required:** Yes — `authenticate`

**Path Params:** None

**Query Params:**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `read` | Boolean | No | — | Filter by read status (`true` or `false`) |
| `type` | String | No | — | Filter by notification type enum |
| `page` | Number | No | 1 | Page number |
| `perPage` | Number | No | 20 | Items per page (max 100) |

**Request Body:** None

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "Notifications retrieved successfully",
  "data": [
    {
      "_id": "672a1b2c3d4e5f6789088888",
      "userId": "672a1b2c3d4e5f6789012000",
      "schoolId": "672a1b2c3d4e5f6789012300",
      "type": "payment.received",
      "title": "New payment received",
      "message": "A payment of GHS 500.00 was received for Ada Mensah.",
      "link": "/payments/672a1b2c3d4e5f6789055555",
      "read": false,
      "readAt": null,
      "meta": { "paymentId": "PAY-20251015-XF3K2L", "studentId": "672a1b2c3d4e5f6789056789" },
      "createdAt": "2025-10-15T08:30:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 20,
    "total": 1,
    "totalPages": 1,
    "unreadCount": 1
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `401` | Authentication required |
| `422` | Invalid `type` enum value |
| `500` | Internal server error |

**Rate Limit:** 60 requests / minute per user

**Notes / Edge Cases:**
- The `meta` object includes context like `{ paymentId, studentId, planId }` depending on the notification type.
- The `unreadCount` in `meta` is for displaying a badge in the UI.
- Notifications are sorted by `createdAt` descending (newest first).

---

### 2. `PUT /notifications/:id/read`

**Brief Description:** Marks a single notification as read for the logged-in user.

**Auth Required:** Yes — `authenticate`

**Path Params:**

| Name | Type | Required | Description |
|---|---|---|---|
| `id` | ObjectId | Yes | The notification to mark as read |

**Query Params:** None

**Request Body:** None

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "Notification marked as read",
  "data": {
    "_id": "672a1b2c3d4e5f6789088888",
    "userId": "672a1b2c3d4e5f6789012000",
    "schoolId": "672a1b2c3d4e5f6789012300",
    "type": "payment.received",
    "title": "New payment received",
    "message": "A payment of GHS 500.00 was received for Ada Mensah.",
    "link": "/payments/672a1b2c3d4e5f6789055555",
    "read": true,
    "readAt": "2025-10-15T09:00:00.000Z",
    "meta": { "paymentId": "PAY-20251015-XF3K2L" },
    "createdAt": "2025-10-15T08:30:00.000Z"
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `401` | Authentication required |
| `404` | Notification not found or does not belong to the user |
| `422` | Invalid `id` format |
| `500` | Internal server error |

**Rate Limit:** 30 requests / minute per user

**Notes / Edge Cases:**
- Ownership is verified via a `userId` filter on the query — a user cannot mark another user's notifications as read.
- The `readAt` timestamp is set to the current time in Accra (GMT+0).

---

### 3. `PUT /notifications/read-all`

**Brief Description:** Marks all unread notifications for the logged-in user as read.

**Auth Required:** Yes — `authenticate`

**Path Params:** None

**Query Params:** None

**Request Body:** None

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "5 notifications marked as read",
  "data": {
    "updatedCount": 5
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `401` | Authentication required |
| `500` | Internal server error |

**Rate Limit:** 20 requests / minute per user

**Notes / Edge Cases:**
- Only affects unread notifications for the current user.
- Already-read notifications are not touched.

---

### 4. `DELETE /notifications/:id`

**Brief Description:** Hard-deletes a notification for the logged-in user.

**Auth Required:** Yes — `authenticate`

**Path Params:**

| Name | Type | Required | Description |
|---|---|---|---|
| `id` | ObjectId | Yes | The notification to delete |

**Query Params:** None

**Request Body:** None

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "Notification deleted"
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `401` | Authentication required |
| `404` | Notification not found or does not belong to the user |
| `422` | Invalid `id` format |
| `500` | Internal server error |

**Rate Limit:** 30 requests / minute per user

**Notes / Edge Cases:**
- Notifications are hard-deleted (not soft-deleted) because they are ephemeral UI elements.
- Ownership is verified via a `userId` filter on the delete query.

---

### Module-Level Notes

- **Related model:** `Notification` (`src/models/Notification.js`)
- **Related service:** `notification.service.js` — exports `createNotification()` used by other modules.
- **Notification fields:** `_id, userId, schoolId, type, title, message, link, read, readAt, meta, createdAt`
- **Type enum:** `payment.received`, `plan.created`, `plan.accepted`, `plan.overdue`, `student.imported`, `sms.sent`, `subscription.expiring`, `system.alert`
- **TTL:** Auto-delete after 90 days via MongoDB TTL index on `createdAt`.
- **Indexes:** `{ userId: 1, read: 1, createdAt: -1 }`, `{ userId: 1, createdAt: -1 }`
- **Jobs:** No scheduled jobs. Notifications are created in real-time by other modules' service layers.

---

## MODULE 17 — SETTINGS

**Base path:** `/api/settings`

### Overview

Centralizes all school-level configuration that isn't part of the core profile. Includes general branding/settings, academic year & term, notification preferences, and billing/subscription info. All settings changes are audited.

- **Users:** Super Admin, School Admin
- **Dependencies:** School model (profile, academic, sms, payment, subscription, notifications subdocuments); Student, Payment models for usage stats; AuditLog for change tracking.

### 1. `GET /settings/:schoolId`

**Brief Description:** Returns an aggregated view of all school settings, grouped into profile, academic, SMS, payment, and notification sections.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:**

| Name | Type | Required | Description |
|---|---|---|---|
| `schoolId` | ObjectId | Yes | The school whose settings to retrieve |

**Query Params:** None

**Request Body:** None

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "School settings retrieved successfully",
  "data": {
    "profile": {
      "name": "Presbyterian Boys' Secondary School",
      "type": "private",
      "motto": "Boys Paani Wɔn",
      "yearFounded": 1979,
      "phone": "233241234567",
      "email": "info@pbss.edu.gh",
      "website": "https://pbss.edu.gh",
      "address": "P. O. Box 123, Legon",
      "city": "Accra",
      "region": "Greater Accra",
      "gpsAddress": "GA-123-4567",
      "brandColor": "#1E3A8A",
      "logo": "https://res.cloudinary.com/...",
      "stamp": "https://res.cloudinary.com/.../stamp.png"
    },
    "academic": {
      "currentTerm": "Term 1",
      "currentYear": "2025/2026",
      "termsPerYear": 3,
      "classes": ["JS 1", "JS 2", "SS 1", "SS 2", "SS 3"],
      "gradingSystem": "WAEC"
    },
    "sms": {
      "provider": "moolre",
      "senderId": "PBS-SCHOOL",
      "balance": 5000
    },
    "payment": {
      "gatewayMode": "moolre",
      "platformMarkupPercent": 5,
      "networksEnabled": {
        "mtn": true,
        "telecel": true,
        "airteltigo": true
      }
    },
    "notifications": {
      "email": true,
      "sms": true,
      "inApp": true
    }
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `401` | Authentication required |
| `403` | No school in scope; user does not have access to this school |
| `404` | School not found |
| `422` | Invalid `schoolId` format |
| `500` | Internal server error |

**Rate Limit:** 60 requests / minute per user

**Notes / Edge Cases:**
- Secret fields (`sms.apiKey`) are **never** returned.
- The response groups fields into logical sections even though they live in different parts of the School document.

---

### 2. `PUT /settings/:schoolId`

**Brief Description:** Updates general school settings (branding, contact info, academic classes, terms per year, grading system).

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:**

| Name | Type | Required | Description |
|---|---|---|---|
| `schoolId` | ObjectId | Yes | The school to update |

**Query Params:** None

**Request Body:**

```json
{
  "brandColor": "#0F766E",
  "motto": "Excellence in Education",
  "yearFounded": 1980,
  "website": "https://pbss-new.edu.gh",
  "gpsAddress": "GA-456-7890",
  "classes": ["JS 1", "JS 2", "SS 1", "SS 2", "SS 3", "SHS 1"],
  "termsPerYear": 3,
  "gradingSystem": "WAEC"
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `brandColor` | String (hex) | No | — | Must match `^#[0-9A-Fa-f]{6}$` |
| `motto` | String | No | — | Max 200 chars |
| `yearFounded` | Number | No | — | Min 1800, max 2099 |
| `website` | String (URI) | No | — | Must be a valid URL |
| `gpsAddress` | String | No | — | Max 200 chars |
| `classes` | Array\<String\> | No | — | Non-empty, unique, max 50 items |
| `termsPerYear` | Number | No | — | Min 1, max 4 |
| `gradingSystem` | String | No | — | One of `WAEC`, `IB`, `Cambridge`, `Custom` |

At least one field must be provided.

**Response (`200 OK`):** Same structure as GET `/settings/:schoolId`.

**Error Responses:**

| Status | Reason |
|---|---|
| `400` | `classes` is empty, contains duplicates, or exceeds 50 items |
| `401` | Authentication required |
| `403` | No school in scope |
| `404` | School not found |
| `422` | Invalid `schoolId` format or schema validation failure |
| `500` | Internal server error |

**Rate Limit:** 30 requests / minute per user

**Notes / Edge Cases:**
- Protected fields (`slug`, `schoolCode`, `createdBy`, `subscription`, `status`, `suspendedAt/Reason`, `deletedAt`) cannot be changed.
- An audit log entry of type `school.update` is written for every change.
- If `classes` is changed, the academic terms structure is updated in-place.

---

### 3. `PUT /settings/:schoolId/academic-year`

**Brief Description:** Sets the current academic year and term.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:**

| Name | Type | Required | Description |
|---|---|---|---|
| `schoolId` | ObjectId | Yes | The school to update |

**Query Params:** None

**Request Body:**

```json
{
  "currentYear": "2025/2026",
  "currentTerm": "Term 1",
  "termsPerYear": 3
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `currentYear` | String | Yes | Must match `YYYY/YYYY` format with consecutive years (e.g. `2025/2026`) |
| `currentTerm` | String | Yes | One of `Term 1`, `Term 2`, `Term 3` |
| `termsPerYear` | Number | No | Default `3`, min 1, max 4 |

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "Academic year and term updated successfully",
  "data": {
    "currentTerm": "Term 1",
    "currentYear": "2025/2026",
    "termsPerYear": 3,
    "classes": ["JS 1", "JS 2", "SS 1", "SS 2", "SS 3"],
    "gradingSystem": "WAEC"
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `400` | `currentYear` does not match `YYYY/YYYY` format; years are not consecutive |
| `401` | Authentication required |
| `403` | No school in scope |
| `404` | School not found |
| `422` | Invalid `schoolId` format or schema validation failure |
| `500` | Internal server error |

**Rate Limit:** 20 requests / minute per user

**Notes / Edge Cases:**
- The academic year format is strictly `YYYY/YYYY` where the second year is the first year + 1.
- An audit log entry of type `settings.update` is written.
- The endpoint must be registered **before** any `/:schoolId` wildcard-style routes.

---

### 4. `PUT /settings/:schoolId/notifications`

**Brief Description:** Updates the school's notification preferences (email, SMS, in-app).

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:**

| Name | Type | Required | Description |
|---|---|---|---|
| `schoolId` | ObjectId | Yes | The school to update |

**Query Params:** None

**Request Body:**

```json
{
  "email": true,
  "sms": false,
  "inApp": true
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `email` | Boolean | Yes | — | Whether to send email notifications |
| `sms` | Boolean | Yes | — | Whether to send SMS notifications |
| `inApp` | Boolean | Yes | — | Whether to create in-app notifications |

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "Notification preferences updated successfully",
  "data": {
    "email": true,
    "sms": false,
    "inApp": true
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `401` | Authentication required |
| `403` | No school in scope |
| `404` | School not found |
| `422` | Invalid `schoolId` format or schema validation failure |
| `500` | Internal server error |

**Rate Limit:** 20 requests / minute per user

**Notes / Edge Cases:**
- The `notifications` subdocument is created on the school if it does not already exist.
- An audit log entry of type `settings.update` is written.

---

### 5. `GET /settings/:schoolId/billing`

**Brief Description:** Returns subscription status, usage metrics, invoices, and the next invoice details.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin", "school_admin")`

**Path Params:**

| Name | Type | Required | Description |
|---|---|---|---|
| `schoolId` | ObjectId | Yes | The school whose billing to retrieve |

**Query Params:**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `page` | Number | No | 1 | Page number for invoice list |
| `perPage` | Number | No | 20 | Invoices per page (max 100) |

**Request Body:** None

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "Billing information retrieved successfully",
  "data": {
    "subscription": {
      "plan": "standard",
      "status": "active",
      "monthlyFee": 15000,
      "currentPeriodStart": "2025-10-01T00:00:00.000Z",
      "currentPeriodEnd": "2025-11-01T00:00:00.000Z",
      "trialEndsAt": null
    },
    "usage": {
      "studentsThisTerm": 1000,
      "smsSentThisMonth": 2450,
      "smsCreditsRemaining": 1550,
      "storageUsedMB": 320
    },
    "invoices": [],
    "nextInvoice": {
      "amount": 15000,
      "dueDate": "2025-11-01T00:00:00.000Z"
    }
  }
}
```

**Error Responses:**

| Status | Reason |
|---|---|
| `401` | Authentication required |
| `403` | No school in scope |
| `404` | School not found |
| `422` | Invalid `schoolId` format |
| `500` | Internal server error |

**Rate Limit:** 30 requests / minute per user

**Notes / Edge Cases:**
- `monthlyFee` is in **pesewas**.
- SMS usage is derived from completed payment records in the current calendar month (Accra timezone).
- Platform-level info (`platformMarkupPercent`, Sukuupay revenue) is intentionally excluded.
- `invoices` is currently an empty array; the invoice tracking system is planned for a future module.

---

### Module-Level Notes

- **Related models:** `School` (with `academic`, `sms`, `subscription`, `payment`, and `notifications` subdocuments)
- **Related services:** `settings.service.js`
- **Related validators:** `validations/settings.validation.js`
- **Audit:** All `PUT` endpoints write an audit log entry.
- **Protected fields:** `slug`, `schoolCode`, `createdBy`, `subscription`, `status`, `suspendedAt/Reason`, `deletedAt` cannot be modified via settings.
- **Secrets:** `sms.apiKey` is always excluded from responses.
- **Rate limiting:** Settings endpoints are protected by a custom rate limiter (30–60 req/min depending on the endpoint).
- **Timezone:** All dates in responses are ISO-8601 UTC. Accra is GMT+0, so UTC timestamps display correctly in local time.

---

## MODULE 18 — SUPER ADMIN (PLATFORM ADMIN)

**Base path:** `/api/admin`

### Overview

Platform-level operations available exclusively to `super_admin` users. Covers school lifecycle management, platform-wide revenue analytics, SMS balance monitoring, per-school usage inspection, and a consolidated dashboard of KPIs.

- **Users:** Super Admin only (`authorize("super_admin")`)
- **Dependencies:** School, User, Student, Payment, AuditLog modules
- **Currency:** All monetary values returned as integer pesewas (1 GHS = 100 pesewas)

### 1. `GET /admin/schools`

**Brief Description:** Returns a paginated, filterable list of all schools on the platform with basic stats (student count, staff count, payment volume).

**Auth Required:** Yes — `authenticate` + `authorize("super_admin")`

**Query Parameters:**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `page` | integer | no | 1 | Page number |
| `perPage` | integer | no | 20 | Items per page (max 100) |
| `status` | enum | no | — | Filter by status: `active`, `suspended`, `archived` |
| `region` | string | no | — | Filter by Ghana region name |
| `plan` | enum | no | — | Filter by subscription plan: `trial`, `basic`, `standard`, `premium`, `enterprise` |
| `search` | string | no | — | Search by name, email, school code, phone, or city |
| `sortBy` | string | no | createdAt | Sort field: `name`, `createdAt`, `schoolCode`, `region`, `status` |
| `sortOrder` | string | no | desc | Sort direction: `asc` or `desc` |

**Response (200):**

```json
{
  "success": true,
  "message": "Schools retrieved successfully",
  "data": [
    {
      "_id": "67abc123...",
      "name": "Sunnyvale Schools",
      "schoolCode": "SUN-001",
      "slug": "sunnyvale-schools",
      "type": "private",
      "email": "info@sunnyvale.edu.gh",
      "phone": "+233201234567",
      "city": "Accra",
      "region": "Greater Accra",
      "status": "active",
      "subscription": {
        "plan": "standard",
        "status": "active",
        "currentPeriodEnd": "2025-03-01T00:00:00.000Z"
      },
      "studentCount": 450,
      "staffCount": 25,
      "paymentVolume": 1250000
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 20,
    "total": 42,
    "pages": 3
  }
}
```

**Errors:** `401 Unauthorized`, `403 Forbidden` (non-super-admin)

---

### 2. `GET /admin/dashboard`

**Brief Description:** Returns consolidated platform KPIs including school counts by status, user counts, payment/revenue totals, MTD/YTD revenue, platform markup, pending payouts, and SMS balance.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin")`

**Response (200):**

```json
{
  "success": true,
  "message": "Dashboard KPIs retrieved successfully",
  "data": {
    "schools": {
      "total": 85,
      "active": 72,
      "suspended": 3,
      "archived": 5,
      "onTrial": 12,
      "paid": 60
    },
    "users": {
      "total": 45210,
      "students": 38500,
      "staff": 6710
    },
    "payments": {
      "totalCompleted": 15600,
      "totalRevenue": 317050000,
      "mtdRevenue": 34500000,
      "mtdCount": 760,
      "ytdRevenue": 285000000,
      "ytdCount": 13240,
      "platformMarkup": 15852500,
      "pendingPayouts": 8500000
    },
    "sms": {
      "totalBalance": 125000
    },
    "recentSchools": [
      {
        "_id": "67abc123...",
        "name": "New Horizon Sch.",
        "schoolCode": "NHS-042",
        "status": "active",
        "subscription": { "plan": "trial", "status": "trial" },
        "createdAt": "2025-02-20T10:00:00.000Z"
      }
    ]
  }
}
```

> `recentSchools` — shows the 5 most recently created schools (name, code, status, plan, creation date).

---

### 3. `GET /admin/revenue`

**Brief Description:** Returns platform-wide revenue aggregation. Supports period-based and date-range filtering. Platform markup is calculated as `sum(payment.amount / 100 × school.payment.platformMarkupPercent)` for each completed payment.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin")`

**Query Parameters:**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `startDate` | string (ISO date) | no | — | Filter payments completed on or after this date |
| `endDate` | string (ISO date) | no | — | Filter payments completed on or before this date |
| `period` | enum | no | all | Predefined period: `all`, `mtd` (month-to-date), `ytd` (year-to-date), `last30` |
| `plan` | enum | no | — | Filter to a subscription plan |
| `region` | string | no | — | Filter to a Ghana region |

> When `period` is set and `startDate`/`endDate` are also provided, both are applied (intersection).

**Response (200):**

```json
{
  "success": true,
  "message": "Platform revenue retrieved successfully",
  "data": {
    "summary": {
      "totalRevenue": 285000000,
      "totalPayments": 13240,
      "avgPayment": 21535,
      "platformMarkupRevenue": 14250000
    },
    "filters": {
      "period": "ytd",
      "startDate": null,
      "endDate": null,
      "plan": null,
      "region": null
    }
  }
}
```

---

### 4. `GET /admin/sms-balance`

**Brief Description:** Returns the aggregated SMS balance across all schools on the platform.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin")`

**Response (200):**

```json
{
  "success": true,
  "message": "SMS balance retrieved successfully",
  "data": {
    "totalBalance": 125000,
    "totalSchools": 72
  }
}
```

> Balance is in the school's configured currency unit (GHS).

---

### 5. `GET /admin/schools/:id/usage`

**Brief Description:** Returns detailed usage statistics for a single school — student/staff/parent counts, payment breakdown by status, pending amounts, and 10 recent audit log entries.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin")`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `id` | string (24-char hex) | School ID |

**Response (200):**

```json
{
  "success": true,
  "message": "School usage stats retrieved successfully",
  "data": {
    "school": {
      "_id": "67abc123...",
      "name": "Sunnyvale Schools",
      "schoolCode": "SUN-001",
      "status": "active",
      "subscription": { "plan": "standard", "status": "active", "currentPeriodEnd": "2025-03-01T00:00:00.000Z" },
      "sms": { "provider": "moolre", "balance": 1500, "senderId": "SUNSCHOOL" }
    },
    "counts": {
      "students": 450,
      "staff": 25,
      "parents": 312
    },
    "payments": {
      "totalRevenue": 1250000,
      "statusBreakdown": {
        "completed": { "count": 1200, "amount": 1250000 },
        "pending": { "count": 5, "amount": 45000 },
        "failed": { "count": 3, "amount": 2300 }
      },
      "pendingAmount": 45000,
      "pendingPlans": 5
    },
    "stats": {
      "totalStudents": 450,
      "totalTeachers": 20,
      "totalParents": 312,
      "totalPaymentsThisMonth": 42
    },
    "recentActivity": [/* last 10 audit log entries for this school */]
  }
}
```

**Errors:** `400 Bad Request` (invalid ID), `404 Not Found`

---

### 6. `PUT /admin/schools/:id/suspend`

**Brief Description:** Suspends a school and all its associated users. Requires a suspension reason. Delegates to `suspendSchool` in `school.service.js`.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin")`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `id` | string (24-char hex) | School ID |

**Request Body:**

```json
{
  "reason": "Non-payment of subscription fees for 3 consecutive months"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `reason` | string | yes | 10–500 characters |

**Response (200):**

```json
{
  "success": true,
  "message": "School suspended successfully",
  "data": {
    "_id": "67abc123...",
    "name": "Sunnyvale Schools",
    "status": "suspended",
    "suspendedReason": "Non-payment...",
    "suspendedAt": "2025-02-20T12:00:00.000Z",
    "subscription": { "status": "suspended" }
  }
}
```

**Errors:** `400 Bad Request` (already suspended, archived, or invalid ID), `403 Forbidden`, `404 Not Found`

---

### 7. `PUT /admin/schools/:id/unsuspend`

**Brief Description:** Reverts a suspended school back to active status and reactivates all its users. Delegates to `unsuspendSchool` in `school.service.js`.

**Auth Required:** Yes — `authenticate` + `authorize("super_admin")`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `id` | string (24-char hex) | School ID |

**Response (200):**

```json
{
  "success": true,
  "message": "School unsuspended successfully",
  "data": {
    "_id": "67abc123...",
    "name": "Sunnyvale Schools",
    "status": "active",
    "suspendedReason": "",
    "suspendedAt": null,
    "subscription": { "status": "active" }
  }
}
```

**Errors:** `400 Bad Request` (not currently suspended, or invalid ID), `403 Forbidden`, `404 Not Found`

---

### 8. GET /admin/revenue/series — platform revenue over time

Bucketed revenue so the platform console can draw a trend. It exists because
`GET /admin/revenue` returns aggregates and every `/api/analytics/*` route is
school-scoped, so nothing else in the API could plot platform revenue over time.

**Query parameters**

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `bucket` | `month` \| `day` | `month` | Explicit rather than derived: 30 daily points for `last30`, 24 monthly points for `ytd`. A chart whose shape depends on how the server sampled the data is a chart nobody can read. |
| `period` | `mtd` \| `ytd` \| `last30` \| `all` | `ytd` | `all` means roughly two years of history. `ytd` is the default because a two-year monthly series on a young platform is a flat line with one spike, which reads as a failure. |
| `startDate` | ISO date | derived from `period` | Intersects with `period` when both are given |
| `endDate` | ISO date | now | |
| `plan` | enum | — | |
| `region` | string | — | |

**Response `data`**

```json
{
  "series": [
    { "period": "2026-01", "totalRevenue": 4150000, "totalPayments": 192 },
    { "period": "2026-02", "totalRevenue": 0, "totalPayments": 0 },
    { "period": "2026-03", "totalRevenue": 5230000, "totalPayments": 241 }
  ],
  "filters": {
    "bucket": "month",
    "period": "ytd",
    "startDate": "2026-01-01T00:00:00.000Z",
    "endDate": "2026-03-28T12:00:00.000Z",
    "plan": null,
    "region": null
  },
  "totals": { "totalRevenue": 9380000, "totalPayments": 433 }
}
```

**The series has no gaps, and that is the contract.** A month in which nobody paid
produces no aggregation row, so mapping the rows would drop it and a chart would
draw a straight line across the hole — presenting zero revenue as smooth growth.
`buildCalendarSeries` walks the calendar instead and emits an explicit `0`, which
renders as a dip to the baseline. Series length is capped at 120 points (monthly) or
400 (daily); a longer range is truncated rather than returned in full.

**Errors:** `400 Bad Request` (invalid query), `403 Forbidden`

---

### 9. GET /admin/settings — platform configuration

```json
{
  "success": true,
  "message": "Platform settings retrieved successfully",
  "data": {
    "singletonKey": "platform",
    "defaultMarkupPercent": 5,
    "features": { "adsEnabled": true, "selfSignupEnabled": true, "trialDays": 30 },
    "maintenance": { "mode": "off", "message": "" },
    "updatedBy": null,
    "updatedAt": null
  }
}
```

The response is `DEFAULT_PLATFORM_SETTINGS` merged under whatever is stored, so the
endpoint answers with real values **before** any document exists. It is deliberately
not an upsert: a GET that writes needs write permissions, is unsafe to call
concurrently on a fresh database, and would race the unique index.

`singletonKey` is always `"platform"` and carries a **unique index** — the singleton
is enforced in the database, not in a convention. `defaultMarkupPercent` is the value
a *newly provisioned* school is given; it never rewrites an existing school's
`payment.platformMarkupPercent`, which is what the revenue aggregations read.

---

### 10. PUT /admin/settings — change platform configuration

Every field is optional and the object has `.min(1)`, so a PUT is a **patch**. A
client that reads the document, changes one flag and writes it back cannot blank the
settings it did not mean to touch.

**Request body** (any subset)

```json
{
  "defaultMarkupPercent": 6,
  "features": { "adsEnabled": false, "selfSignupEnabled": true, "trialDays": 45 },
  "maintenance": { "mode": "readonly", "message": "We are upgrading until 6am." }
}
```

**Response `data`** — the stored document plus `changed`:

```json
{
  "defaultMarkupPercent": 6,
  "features": { "adsEnabled": false, "selfSignupEnabled": true, "trialDays": 45 },
  "maintenance": { "mode": "readonly", "message": "We are upgrading until 6am." },
  "changed": [
    { "path": "defaultMarkupPercent", "from": 5, "to": 6 },
    { "path": "features.adsEnabled", "from": true, "to": false }
  ]
}
```

`changed` is a flat list of leaf paths with both sides of each. An entry that records
*that* something changed but not *what* does not answer the question an audit is
consulted for. When nothing differs the response message is `"No changes to save"`
and **no audit entry is written** — a client that PUTs an unchanged document on every
page load would otherwise bury the one entry that matters.

**Errors:** `400 Bad Request` (empty body, out-of-range value), `403 Forbidden`

#### What each setting actually does

Storing a setting nothing reads is how a settings console becomes a decoration, so
each field is enforced somewhere specific:

| Field | Enforced by | Behaviour when changed |
|-------|-------------|----------------------|
| `maintenance.mode` | `middleware/maintenance.js`, mounted on `/api` in `routes/index.js` | `off`: everything allowed. `readonly`: reads pass, writes refused — the state a schema migration wants. `on`: everything refused. |
| `features.selfSignupEnabled` | `controllers/authController.js` `signup` | `false` → `503 SELF_SIGNUP_DISABLED`. Checked **before** the duplicate-email probe, because with registration closed that probe is an oracle answering "does this email have an account here?" |
| `features.adsEnabled` | `controllers/schoolAd.controller.js` `listPublicSchoolAds` | `false` → `200` with `{ ads: [], adsEnabled: false }`, and `Cache-Control: no-store`. Never an error: an empty array is the endpoint's only existing "off" shape, and the success path's `max-age=300` would otherwise hide a flag flip for five minutes. |
| `features.trialDays` | `services/school.service.js` — `createSchool` and `provisionSchoolForUser` | The trial window for a **newly created** school. Replaces a hard-coded `+ 30` in both places. |
| `defaultMarkupPercent` | the same two provisioning sites | The `payment.platformMarkupPercent` a new school is given. **This field previously had no writer anywhere in the codebase** — the schema default is `0` — so every school provisioned before this change was collecting zero platform markup while the revenue aggregations divided by that number. Existing schools are untouched. |

**Maintenance mode has three exemptions**, and each is load-bearing:

- `/api/health` — `utils/cron.js` probes exactly this path; a 503 there makes the
  keep-alive log an error every cycle for a state the operator chose deliberately.
- `/api/admin/settings` — **the switch must not be behind itself.** Otherwise
  maintenance is a one-way door: turning it on refuses every write, including the
  write that would turn it off.
- Webhooks are exempt by *placement*, not by rule. `webhookRoute` and `whatsappRoute`
  are mounted at the root in `index.js` before `/api`, so a guard on `/api` cannot
  reach them. **Never mount it globally** — a guard above the root webhook mounts
  would refuse a Moolre settlement callback mid-migration, turning a planned outage
  into lost money, silently, because the provider's own retry would be refused too.

Settings reads go through `services/platformSettings.service.js`, which caches for 30
seconds and **fails open**: a read that throws returns the defaults, and `off`/`true`
are the permissive ones. A maintenance middleware that returned 503 for every request
because the database hiccuped would invent an outage the product did not have.
`updatePlatformSettings` invalidates the cache in-process immediately; across multiple
instances the 30-second TTL bounds how stale the others can be.

---

### 11. GET /admin/school-ads — the moderation queue

> These five school-ad routes (11–15) were implemented before they were documented
> here. `admin.routes.js` is the source of truth for their shape; this section was
> written from the validators in `validations/schoolAd.validation.js` and should be
> read alongside it.

The cross-placement creative queue. Shared with the public slider's schema, so
`listSchoolAdsQuerySchema` defaults `placement` to `auth_aside` — **a moderation
client must send no placement at all to see every placement**, or it will show one
slot and hide the rest of the submissions.

**Query parameters:** `status` (`draft` | `pending` | `approved` | `rejected` | `expired`),
`placement` (`auth_aside` | `home_hero` | `dashboard_sidebar`), `page` (default 1),
`perPage` (default 20).

There is deliberately **no `search` parameter** — a free-text search over creatives
does not exist, so a moderation UI filters by status and placement only.

**Response**

```json
{
  "success": true,
  "message": "Ads retrieved successfully",
  "data": [
    {
      "_id": "...",
      "schoolId": "...",
      "schoolName": "Greenfield Academy",
      "headline": "Admissions open for 2026",
      "imageUrl": "https://res.cloudinary.com/...",
      "imageAlt": "Greenfield Academy senior school campus building",
      "linkUrl": "https://example.com/greenfield/apply",
      "placement": "auth_aside",
      "sortWeight": 10,
      "startsAt": "2026-01-01T00:00:00.000Z",
      "endsAt": "2026-12-31T00:00:00.000Z",
      "status": "pending",
      "rejectedReason": null,
      "reviewedAt": null,
      "reviewedBy": null
    }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 4, "pages": 1 }
}
```

**Errors:** `403 Forbidden`

---

### 12. POST /admin/school-ads — submit a creative

`multipart/form-data` through `uploadSchoolAd` (multer → Cloudinary), so the body is
a `FormData`, not JSON — an `application/json` content type serialises the file's
`[object File]` and the server rejects a body it never parsed.

**Fields** (`createSchoolAdSchema`): `schoolId` (may be empty/null), `schoolName`,
`headline` (4–60 chars — it renders in the auth sidebar, so it is short on purpose),
`image` (file), `imageAlt` (**required**, and the only thing describing the creative
to a screen reader), `linkUrl` (**https only** — `javascript:` here would put an XSS
sink on every login page), `placement`, `endsAt` (required, must be in the future),
`sortWeight` (−100…100).

Filed `status: "pending"`. A new creative cannot go live by being submitted.

**Response `data`:** the created `SchoolAd`.

**Errors:** `400 Bad Request` (missing or invalid image), `403 Forbidden`

---

### 13. PUT /admin/school-ads/:adId — edit a creative

`multipart/form-data`; the same fields as create, all optional.

**It cannot change status.** `updateSchoolAdSchema` deliberately omits `status` and
`rejectedReason`, so an edit can never self-approve. A UI offering a status dropdown
on an edit form would be offering something the API silently discards — the creative
would stay `pending` and the operator would believe it had gone live. Status changes
go through route 14 and nowhere else.

The schema also carries `.min(1)`: an edit with no changed fields is a `400`, not a
silent no-op.

**Response `data`:** the updated `SchoolAd`.

**Errors:** `400 Bad Request` (no fields supplied), `403 Forbidden`, `404 Not Found`

---

### 14. PUT /admin/school-ads/:adId/approve — review a creative

**The only call that can change an ad's status.**

A review, not a boolean: `approveSchoolAdSchema` takes `status:
"approved" | "rejected"` and **requires `rejectedReason` whenever the decision is
`rejected`**. That requirement is the feature — the reason is what the submitting
school is told, so "rejected" with nothing to say is not an available action.

Note the route is named `/approve` while the decision lives in the body. That
mismatch is exactly how a queue ends up with a Reject button that approves things.

**Request body**

```json
{ "status": "approved" }
```
```json
{ "status": "rejected", "rejectedReason": "The creative names a fee discount. Fee terms cannot be advertised without written confirmation." }
```

**Response `data`:** the reviewed `SchoolAd`, with `reviewedAt` and `reviewedBy` set.

**Errors:** `400 Bad Request` (missing reason on a rejection, or an image that is
neither a URL nor a file), `403 Forbidden`, `404 Not Found`

---

### 15. DELETE /admin/school-ads/:adId — retire a creative

Soft delete (`deletedAt`), and it **purges the Cloudinary asset**. Not recoverable by
the platform: the school that submitted the creative cannot re-submit it. A
confirmation dialog has to say so.

**Response:** `{ "success": true, "message": "Ad deleted successfully" }`

**Errors:** `403 Forbidden`, `404 Not Found`

---

### Module-Level Notes

- **Related models:** `School`, `User`, `Payment`, `Student`, `AuditLog`, `PlatformSettings`, `SchoolAd`
- **Related services:** `admin.service.js`, `school.service.js`
- **Related controllers:** `admin.controller.js`, `schoolAd.controller.js`
- **Related validators:** `validations/admin.validation.js`, `validations/schoolAd.validation.js`
- **Authorization:** All routes are wrapped with `authenticate` + `authorize("super_admin")` middleware applied at the router level.
- **School lifecycle:** `suspendSchool` and `unsuspendSchool` set `school.status`, `school.suspendedReason`, `school.suspendedAt`, and `school.subscription.status`, then cascade `status` changes to all `User` documents for that school.
- **Revenue calculation:** Platform markup is `payment.amount` (pesewas) divided by 100, multiplied by `school.payment.platformMarkupPercent`, converted back to pesewas via `Math.round()`.
- **Currency:** All monetary values are integers in pesewas. `paymentVolume`, `totalRevenue`, `avgPayment`, `series[].totalRevenue`, etc. are all in pesewas.
- **Dashboard `recentSchools`:** Limited to 5 most recently created schools; returned in descending `createdAt` order.
- **Platform settings:** One document, ever, enforced by a unique index on `singletonKey`. Read with `getPlatformSettings`, which merges `DEFAULT_PLATFORM_SETTINGS` under whatever is stored rather than upserting.
- **Platform owner:** There is exactly one `super_admin`, provisioned from `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` by `boot/ensureSuperAdmin.js` and reconciled on every boot. The role cannot be granted through any API.
