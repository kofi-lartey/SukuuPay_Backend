# Student Management API Specification

## Overview
This document specifies the RESTful API endpoints for student lifecycle management including promotion, graduation, transfer, and alumni/cohort retrieval.

**Base URL:** `/api/v1`
**Authentication:** Bearer Token (JWT)
**Content-Type:** `application/json`

---

## 1. Promote a Single Student

### Endpoint
```
POST /students/:id/promote
```

### Description
Promotes a single student to their next class level. Validates that the student exists, is active, and has a valid next level defined in the school's class structure.

### Path Parameters
| Parameter | Type   | Required | Description              |
|-----------|--------|----------|--------------------------|
| id        | string | Yes      | Student UUID             |

### Request Body
```json
{
  "targetClassId": "string (UUID, optional)",
  "promotionDate": "string (ISO 8601 date, optional, defaults to today)",
  "notes": "string (max 500 chars, optional)"
}
```

#### Validation Rules
- `targetClassId`: Must reference a valid class in the same school. If omitted, system auto-determines next level.
- `promotionDate`: Cannot be in the future beyond 30 days. Cannot be before student's enrollment date.
- `notes`: Optional free-text field for administrative notes.

### Success Response (200 OK)
```json
{
  "success": true,
  "message": "Student promoted successfully",
  "data": {
    "student": {
      "id": "stu_abc123",
      "studentNumber": "STU-2024-001",
      "firstName": "John",
      "lastName": "Doe",
      "currentClass": {
        "id": "cls_xyz789",
        "name": "Grade 10A",
        "level": 10
      },
      "previousClass": {
        "id": "cls_prev456",
        "name": "Grade 9B",
        "level": 9
      },
      "promotionDate": "2025-01-15",
      "status": "ACTIVE"
    }
  }
}
```

### Error Responses

| Status | Code | Message |
|--------|------|---------|
| 400 | VALIDATION_ERROR | Invalid request body or promotion date |
| 404 | STUDENT_NOT_FOUND | Student with id {id} not found |
| 409 | NO_NEXT_LEVEL | No next class level defined for student's current class |
| 409 | ALREADY_PROMOTED | Student already promoted for this academic period |
| 403 | FORBIDDEN | Insufficient permissions to promote students |
| 500 | INTERNAL_ERROR | Server error during promotion |

---

## 2. Bulk Promote Students

### Endpoint
```
POST /students/bulk-promote/:schoolId
```

### Description
Promotes multiple students within a specific school or selected classes. Supports filtering by class, grade level, or explicit student ID list.

### Path Parameters
| Parameter | Type   | Required | Description         |
|-----------|--------|----------|---------------------|
| schoolId  | string | Yes      | School UUID         |

### Request Body
```json
{
  "classIds": ["string (UUID)", "..."], // optional - specific classes to promote
  "gradeLevels": ["integer", "..."],    // optional - grade levels to promote (e.g., [9, 10])
  "studentIds": ["string (UUID)", "..."], // optional - explicit student list
  "promotionDate": "string (ISO 8601 date, optional)",
  "dryRun": "boolean (optional, default: false)",
  "notes": "string (max 500 chars, optional)"
}
```

#### Validation Rules
- At least one of `classIds`, `gradeLevels`, or `studentIds` must be provided.
- `classIds` and `gradeLevels` are mutually exclusive with `studentIds`.
- All referenced classes/students must belong to the specified `schoolId`.
- `dryRun: true` performs validation only without persisting changes.
- Maximum 500 students per request.

### Success Response (200 OK)
```json
{
  "success": true,
  "message": "Bulk promotion completed",
  "data": {
    "summary": {
      "totalProcessed": 150,
      "promoted": 142,
      "skipped": 5,
      "failed": 3
    },
    "promotedStudents": [
      {
        "studentId": "stu_abc123",
        "studentNumber": "STU-2024-001",
        "previousClass": "Grade 9B",
        "newClass": "Grade 10A"
      }
    ],
    "skippedStudents": [
      {
        "studentId": "stu_def456",
        "reason": "Already promoted this period"
      }
    ],
    "failedStudents": [
      {
        "studentId": "stu_ghi789",
        "reason": "No next level defined"
      }
    ]
  }
}
```

### Error Responses

| Status | Code | Message |
|--------|------|---------|
| 400 | VALIDATION_ERROR | Invalid filters or conflicting parameters |
| 404 | SCHOOL_NOT_FOUND | School with id {schoolId} not found |
| 400 | NO_STUDENTS_MATCHED | No students matched the provided criteria |
| 413 | PAYLOAD_TOO_LARGE | Exceeds maximum 500 students per request |
| 403 | FORBIDDEN | Insufficient permissions |
| 500 | INTERNAL_ERROR | Server error |

---

## 3. Preview Promotion Mapping

### Endpoint
```
POST /students/promote/preview
```

### Description
Provides a preview of the promotion mapping and potential changes before final confirmation. Does not persist any changes.

### Request Body
```json
{
  "schoolId": "string (UUID, required)",
  "classIds": ["string (UUID)", "..."], // optional
  "gradeLevels": ["integer", "..."],    // optional
  "studentIds": ["string (UUID)", "..."], // optional
  "promotionDate": "string (ISO 8601 date, optional)"
}
```

#### Validation Rules
- `schoolId` is required.
- At least one filter (`classIds`, `gradeLevels`, `studentIds`) must be provided.
- Same mutual exclusivity rules as bulk promote.

### Success Response (200 OK)
```json
{
  "success": true,
  "message": "Promotion preview generated",
  "data": {
    "previewDate": "2025-01-15T10:30:00Z",
    "schoolId": "sch_123",
    "totalEligibleStudents": 150,
    "mapping": [
      {
        "currentClass": {
          "id": "cls_9a",
          "name": "Grade 9A",
          "level": 9
        },
        "targetClass": {
          "id": "cls_10a",
          "name": "Grade 10A",
          "level": 10
        },
        "studentCount": 45,
        "students": [
          {
            "id": "stu_001",
            "studentNumber": "STU-2024-001",
            "name": "John Doe"
          }
        ]
      }
    ],
    "warnings": [
      {
        "type": "NO_TARGET_CLASS",
        "message": "5 students in Grade 12 have no next level defined",
        "affectedStudentIds": ["stu_123", "stu_124"]
      },
      {
        "type": "CLASS_CAPACITY",
        "message": "Grade 10A will exceed capacity by 3 students",
        "currentCapacity": 40,
        "projectedEnrollment": 43
      }
    ],
    "unmappedStudents": [
      {
        "studentId": "stu_999",
        "reason": "No next level defined for current class"
      }
    ]
  }
}
```

### Error Responses

| Status | Code | Message |
|--------|------|---------|
| 400 | VALIDATION_ERROR | Invalid or missing parameters |
| 404 | SCHOOL_NOT_FOUND | School not found |
| 403 | FORBIDDEN | Insufficient permissions |
| 500 | INTERNAL_ERROR | Server error |

---

## 4. Mark Student as Repeating

### Endpoint
```
POST /students/:id/repeat
```

### Description
Marks a specific student as repeating their current grade/level. The student remains in the same class for the next academic period.

### Path Parameters
| Parameter | Type   | Required | Description     |
|-----------|--------|----------|-----------------|
| id        | string | Yes      | Student UUID    |

### Request Body
```json
{
  "repeatReason": "string (required, enum: ACADEMIC, ATTENDANCE, MEDICAL, PARENTAL_REQUEST, OTHER)",
  "customReason": "string (max 500 chars, required if repeatReason is OTHER)",
  "repeatDate": "string (ISO 8601 date, optional, defaults to today)",
  "notes": "string (max 500 chars, optional)"
}
```

#### Validation Rules
- `repeatReason` is required and must be one of the enum values.
- `customReason` required when `repeatReason` is `OTHER`.
- `repeatDate` cannot be in the past before current academic year start.
- Student must be in `ACTIVE` status.
- Student cannot have already repeated the same grade more than once (configurable limit).

### Success Response (200 OK)
```json
{
  "success": true,
  "message": "Student marked as repeating",
  "data": {
    "student": {
      "id": "stu_abc123",
      "studentNumber": "STU-2024-001",
      "firstName": "John",
      "lastName": "Doe",
      "currentClass": {
        "id": "cls_9b",
        "name": "Grade 9B",
        "level": 9
      },
      "repeatCount": 1,
      "repeatReason": "ACADEMIC",
      "repeatDate": "2025-01-15",
      "status": "REPEATING"
    }
  }
}
```

### Error Responses

| Status | Code | Message |
|--------|------|---------|
| 400 | VALIDATION_ERROR | Invalid reason or missing custom reason |
| 404 | STUDENT_NOT_FOUND | Student not found |
| 409 | MAX_REPEATS_EXCEEDED | Student has reached maximum repeat limit |
| 409 | INVALID_STATUS | Student status must be ACTIVE |
| 403 | FORBIDDEN | Insufficient permissions |
| 500 | INTERNAL_ERROR | Server error |

---

## 5. Graduate a Single Student

### Endpoint
```
POST /students/:id/graduate
```

### Description
Processes the graduation of a single student. Transitions student to alumni status, archives their cohort membership, and generates graduation records.

### Path Parameters
| Parameter | Type   | Required | Description     |
|-----------|--------|----------|-----------------|
| id        | string | Yes      | Student UUID    |

### Request Body
```json
{
  "graduationDate": "string (ISO 8601 date, required)",
  "graduationType": "string (required, enum: STANDARD, EARLY, HONORARY, DEFERRED)",
  "certificateNumber": "string (optional, max 50 chars)",
  "honors": "string (optional, enum: NONE, HONORS, HIGH_HONORS, HIGHEST_HONORS)",
  "notes": "string (max 500 chars, optional)"
}
```

#### Validation Rules
- `graduationDate` required, cannot be in future beyond 30 days.
- Student must be in final year/grade of their program.
- Student must have completed all graduation requirements (credits, exams, etc.).
- `certificateNumber` must be unique if provided.
- Student status must be `ACTIVE` or `COMPLETED_REQUIREMENTS`.

### Success Response (200 OK)
```json
{
  "success": true,
  "message": "Student graduated successfully",
  "data": {
    "student": {
      "id": "stu_abc123",
      "studentNumber": "STU-2024-001",
      "firstName": "John",
      "lastName": "Doe",
      "graduationDate": "2025-06-15",
      "graduationType": "STANDARD",
      "certificateNumber": "CERT-2025-001234",
      "honors": "HIGH_HONORS",
      "finalClass": {
        "id": "cls_12a",
        "name": "Grade 12A",
        "level": 12
      },
      "cohort": {
        "id": "cohort_2025",
        "name": "Class of 2025"
      },
      "status": "GRADUATED"
    },
    "alumniRecord": {
      "id": "alumni_xyz789",
      "graduationYear": 2025,
      "schoolId": "sch_123"
    }
  }
}
```

### Error Responses

| Status | Code | Message |
|--------|------|---------|
| 400 | VALIDATION_ERROR | Invalid graduation date or type |
| 404 | STUDENT_NOT_FOUND | Student not found |
| 409 | NOT_ELIGIBLE | Student has not completed graduation requirements |
| 409 | ALREADY_GRADUATED | Student already graduated |
| 409 | DUPLICATE_CERTIFICATE | Certificate number already exists |
| 403 | FORBIDDEN | Insufficient permissions |
| 500 | INTERNAL_ERROR | Server error |

---

## 6. Bulk Graduate Students

### Endpoint
```
POST /students/bulk-graduate/:schoolId
```

### Description
Bulk graduates an entire final-year class or cohort within a school. Processes all eligible students in the specified cohort/class.

### Path Parameters
| Parameter | Type   | Required | Description         |
|-----------|--------|----------|---------------------|
| schoolId  | string | Yes      | School UUID         |

### Request Body
```json
{
  "cohortId": "string (UUID, optional)",
  "classIds": ["string (UUID)", "..."], // optional - specific final-year classes
  "graduationDate": "string (ISO 8601 date, required)",
  "graduationType": "string (enum: STANDARD, EARLY, HONORARY, DEFERRED, default: STANDARD)",
  "autoAssignCertificates": "boolean (optional, default: true)",
  "certificatePrefix": "string (optional, max 20 chars)",
  "dryRun": "boolean (optional, default: false)",
  "notes": "string (max 500 chars, optional)"
}
```

#### Validation Rules
- Either `cohortId` or `classIds` must be provided (not both).
- Referenced cohort/classes must belong to `schoolId` and be final-year.
- `graduationDate` required.
- `autoAssignCertificates: true` generates sequential certificate numbers.
- Maximum 300 students per request.

### Success Response (200 OK)
```json
{
  "success": true,
  "message": "Bulk graduation completed",
  "data": {
    "summary": {
      "totalProcessed": 120,
      "graduated": 115,
      "ineligible": 3,
      "failed": 2
    },
    "graduatedStudents": [
      {
        "studentId": "stu_abc123",
        "studentNumber": "STU-2024-001",
        "certificateNumber": "CERT-2025-001234",
        "honors": "HONORS"
      }
    ],
    "ineligibleStudents": [
      {
        "studentId": "stu_def456",
        "reason": "Incomplete credit requirements"
      }
    ],
    "failedStudents": [
      {
        "studentId": "stu_ghi789",
        "reason": "Certificate generation failed"
      }
    ],
    "cohort": {
      "id": "cohort_2025",
      "name": "Class of 2025",
      "archived": true
    }
  }
}
```

### Error Responses

| Status | Code | Message |
|--------|------|---------|
| 400 | VALIDATION_ERROR | Invalid parameters or missing graduation date |
| 404 | SCHOOL_NOT_FOUND | School not found |
| 404 | COHORT_NOT_FOUND | Cohort not found |
| 400 | NO_ELIGIBLE_STUDENTS | No students eligible for graduation |
| 413 | PAYLOAD_TOO_LARGE | Exceeds maximum 300 students |
| 403 | FORBIDDEN | Insufficient permissions |
| 500 | INTERNAL_ERROR | Server error |

---

## 7. Record Student Transfer Out

### Endpoint
```
POST /students/:id/transfer-out
```

### Description
Records a student's transfer to another educational institution. Updates student status to TRANSFERRED and creates a transfer record.

### Path Parameters
| Parameter | Type   | Required | Description     |
|-----------|--------|----------|-----------------|
| id        | string | Yes      | Student UUID    |

### Request Body
```json
{
  "destinationInstitution": "string (required, max 200 chars)",
  "destinationInstitutionType": "string (required, enum: PUBLIC_SCHOOL, PRIVATE_SCHOOL, INTERNATIONAL_SCHOOL, HOMESCHOOL, VOCATIONAL, COLLEGE_UNIVERSITY, OTHER)",
  "transferDate": "string (ISO 8601 date, required)",
  "transferReason": "string (required, enum: RELOCATION, ACADEMIC, FINANCIAL, PERSONAL, EXPULSION, OTHER)",
  "customReason": "string (max 500 chars, required if transferReason is OTHER)",
  "contactPerson": "string (optional, max 100 chars)",
  "contactEmail": "string (optional, email format)",
  "contactPhone": "string (optional, max 20 chars)",
  "recordsTransferred": "boolean (optional, default: false)",
  "notes": "string (max 500 chars, optional)"
}
```

#### Validation Rules
- `destinationInstitution` required.
- `transferDate` cannot be in future beyond 30 days, cannot be before enrollment date.
- `customReason` required when `transferReason` is `OTHER`.
- Student status must be `ACTIVE`.
- If `recordsTransferred: true`, generates transfer transcript package.

### Success Response (200 OK)
```json
{
  "success": true,
  "message": "Student transfer recorded",
  "data": {
    "student": {
      "id": "stu_abc123",
      "studentNumber": "STU-2024-001",
      "firstName": "John",
      "lastName": "Doe",
      "status": "TRANSFERRED",
      "lastClass": {
        "id": "cls_10a",
        "name": "Grade 10A",
        "level": 10
      }
    },
    "transferRecord": {
      "id": "transfer_xyz789",
      "destinationInstitution": "Lincoln High School",
      "destinationInstitutionType": "PUBLIC_SCHOOL",
      "transferDate": "2025-01-15",
      "transferReason": "RELOCATION",
      "recordsTransferred": true,
      "transcriptPackageId": "transcript_pkg_123"
    }
  }
}
```

### Error Responses

| Status | Code | Message |
|--------|------|---------|
| 400 | VALIDATION_ERROR | Invalid institution, date, or reason |
| 404 | STUDENT_NOT_FOUND | Student not found |
| 409 | INVALID_STATUS | Student must be ACTIVE to transfer |
| 409 | ALREADY_TRANSFERRED | Student already transferred |
| 403 | FORBIDDEN | Insufficient permissions |
| 500 | INTERNAL_ERROR | Server error |

---

## 8. Retrieve Alumni List

### Endpoint
```
GET /alumni/:schoolId
```

### Description
Retrieves a paginated, filterable list of graduated students (alumni) for a specific school.

### Path Parameters
| Parameter | Type   | Required | Description         |
|-----------|--------|----------|---------------------|
| schoolId  | string | Yes      | School UUID         |

### Query Parameters
| Parameter | Type    | Required | Description |
|-----------|---------|----------|-------------|
| page      | integer | No       | Page number (default: 1) |
| limit     | integer | No       | Items per page (default: 20, max: 100) |
| graduationYear | integer | No | Filter by graduation year |
| honors    | string  | No       | Filter by honors (NONE, HONORS, HIGH_HONORS, HIGHEST_HONORS) |
| search    | string  | No       | Search by name, student number, or certificate number |
| sortBy    | string  | No       | Sort field (graduationDate, lastName, certificateNumber) |
| sortOrder | string  | No       | Sort order (asc, desc) |

### Success Response (200 OK)
```json
{
  "success": true,
  "message": "Alumni retrieved successfully",
  "data": {
    "alumni": [
      {
        "id": "alumni_xyz789",
        "student": {
          "id": "stu_abc123",
          "studentNumber": "STU-2024-001",
          "firstName": "John",
          "lastName": "Doe",
          "email": "john.doe@example.com",
          "phone": "+1-555-0123"
        },
        "graduationDate": "2025-06-15",
        "graduationType": "STANDARD",
        "certificateNumber": "CERT-2025-001234",
        "honors": "HIGH_HONORS",
        "finalClass": {
          "name": "Grade 12A",
          "level": 12
        },
        "cohort": {
          "id": "cohort_2025",
          "name": "Class of 2025"
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "totalItems": 1250,
      "totalPages": 63,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### Error Responses

| Status | Code | Message |
|--------|------|---------|
| 400 | VALIDATION_ERROR | Invalid query parameters |
| 404 | SCHOOL_NOT_FOUND | School not found |
| 403 | FORBIDDEN | Insufficient permissions |
| 500 | INTERNAL_ERROR | Server error |

---

## 9. Retrieve Archived Cohorts

### Endpoint
```
GET /cohorts/:schoolId
```

### Description
Retrieves a list of archived (completed) cohorts for a specific school with summary statistics.

### Path Parameters
| Parameter | Type   | Required | Description         |
|-----------|--------|----------|---------------------|
| schoolId  | string | Yes      | School UUID         |

### Query Parameters
| Parameter | Type    | Required | Description |
|-----------|---------|----------|-------------|
| page      | integer | No       | Page number (default: 1) |
| limit     | integer | No       | Items per page (default: 20, max: 100) |
| year      | integer | No       | Filter by academic year |
| status    | string  | No       | Filter by status (ARCHIVED, ACTIVE) |
| search    | string  | No       | Search by cohort name |

### Success Response (200 OK)
```json
{
  "success": true,
  "message": "Cohorts retrieved successfully",
  "data": {
    "cohorts": [
      {
        "id": "cohort_2025",
        "name": "Class of 2025",
        "academicYear": "2024-2025",
        "startDate": "2024-09-01",
        "endDate": "2025-06-15",
        "status": "ARCHIVED",
        "studentCount": 120,
        "graduatedCount": 115,
        "transferredCount": 3,
        "droppedCount": 2,
        "finalClasses": [
          {
            "id": "cls_12a",
            "name": "Grade 12A",
            "level": 12,
            "studentCount": 40
          },
          {
            "id": "cls_12b",
            "name": "Grade 12B",
            "level": 12,
            "studentCount": 42
          }
        ]
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "totalItems": 15,
      "totalPages": 1,
      "hasNext": false,
      "hasPrev": false
    }
  }
}
```

### Error Responses

| Status | Code | Message |
|--------|------|---------|
| 400 | VALIDATION_ERROR | Invalid query parameters |
| 404 | SCHOOL_NOT_FOUND | School not found |
| 403 | FORBIDDEN | Insufficient permissions |
| 500 | INTERNAL_ERROR | Server error |

---

## 10. Retrieve Cohort Details

### Endpoint
```
GET /cohorts/:cohortId
```

### Description
Retrieves detailed information for a specific cohort, including the associated list of students with their graduation status.

### Path Parameters
| Parameter  | Type   | Required | Description       |
|------------|--------|----------|-------------------|
| cohortId   | string | Yes      | Cohort UUID       |

### Query Parameters
| Parameter | Type    | Required | Description |
|-----------|---------|----------|-------------|
| page      | integer | No       | Page number for students (default: 1) |
| limit     | integer | No       | Items per page (default: 50, max: 200) |
| status    | string  | No       | Filter students by status (GRADUATED, TRANSFERRED, DROPPED, REPEATING) |
| sortBy    | string  | No       | Sort field (lastName, studentNumber, graduationDate) |
| sortOrder | string  | No       | Sort order (asc, desc) |

### Success Response (200 OK)
```json
{
  "success": true,
  "message": "Cohort details retrieved successfully",
  "data": {
    "cohort": {
      "id": "cohort_2025",
      "name": "Class of 2025",
      "academicYear": "2024-2025",
      "startDate": "2024-09-01",
      "endDate": "2025-06-15",
      "status": "ARCHIVED",
      "schoolId": "sch_123",
      "schoolName": "Lincoln High School",
      "statistics": {
        "totalStudents": 120,
        "graduated": 115,
        "transferred": 3,
        "dropped": 2,
        "repeating": 0,
        "honorsBreakdown": {
          "NONE": 45,
          "HONORS": 35,
          "HIGH_HONORS": 25,
          "HIGHEST_HONORS": 10
        }
      },
      "classes": [
        {
          "id": "cls_12a",
          "name": "Grade 12A",
          "level": 12,
          "teacher": "Ms. Sarah Johnson",
          "studentCount": 40
        },
        {
          "id": "cls_12b",
          "name": "Grade 12B",
          "level": 12,
          "teacher": "Mr. Michael Brown",
          "studentCount": 42
        },
        {
          "id": "cls_12c",
          "name": "Grade 12C",
          "level": 12,
          "teacher": "Dr. Emily Davis",
          "studentCount": 38
        }
      ]
    },
    "students": [
      {
        "id": "stu_abc123",
        "studentNumber": "STU-2024-001",
        "firstName": "John",
        "lastName": "Doe",
        "email": "john.doe@example.com",
        "class": {
          "id": "cls_12a",
          "name": "Grade 12A"
        },
        "status": "GRADUATED",
        "graduationDate": "2025-06-15",
        "graduationType": "STANDARD",
        "certificateNumber": "CERT-2025-001234",
        "honors": "HIGH_HONORS"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 50,
      "totalItems": 120,
      "totalPages": 3,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### Error Responses

| Status | Code | Message |
|--------|------|---------|
| 400 | VALIDATION_ERROR | Invalid query parameters |
| 404 | COHORT_NOT_FOUND | Cohort not found |
| 403 | FORBIDDEN | Insufficient permissions |
| 500 | INTERNAL_ERROR | Server error |

---

## Common Response Format

### Success Response Structure
```json
{
  "success": true,
  "message": "Human-readable success message",
  "data": { ... }
}
```

### Error Response Structure
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": { ... } // Optional validation details
  }
}
```

---

## HTTP Status Codes Summary

| Code | Description |
|------|-------------|
| 200 | OK - Request successful |
| 201 | Created - Resource created successfully |
| 400 | Bad Request - Invalid request parameters |
| 401 | Unauthorized - Missing or invalid authentication |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource not found |
| 409 | Conflict - Resource state conflict (e.g., already promoted) |
| 413 | Payload Too Large - Request exceeds size limits |
| 422 | Unprocessable Entity - Semantic validation errors |
| 500 | Internal Server Error - Unexpected server error |

---

## Rate Limiting
- **Standard endpoints:** 100 requests/minute per IP
- **Bulk operations:** 10 requests/minute per IP
- **Preview endpoints:** 30 requests/minute per IP

Rate limit headers included in responses:
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

---

## Versioning
API version specified in URL path: `/api/v1/`
Breaking changes will increment major version (v2, v3).