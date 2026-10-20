import mongoose from "mongoose";
import { School } from "./schoolModel.js";
import { generateStudentId, resolveAcademicYearStart } from "../utils/generateStudentId.js";
import { generatePayLinkToken, buildPayLink } from "../utils/generatePayLink.js";

const RELATIONSHIP_ENUM = ["father", "mother", "guardian", "other"];

// ──────────────────── Parent subdocument ────────────────────
const parentSchema = new mongoose.Schema(
  {
    parentName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    relationship: {
      type: String,
      enum: RELATIONSHIP_ENUM,
      required: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      default: null,
    },
    isPrimary: {
      type: Boolean,
      default: false,
    },
    isAlive: {
      type: Boolean,
      default: true,
    },
  }
  // NOTE: sub-documents keep their own `_id` (Mongoose's default).
  //
  // They previously declared `{ _id: false }`, which made the three
  // `/students/:id/parents/:parentId` endpoints impossible: there was no
  // identifier to address a single parent by, so every update set the primary
  // and removed the wrong record. `addParent` had been pushing a hand-rolled
  // `_id` that the `_id: false` option then stripped on save.
  //
  // The proper follow-up is promoting parents to their own collection, which
  // would also give `Payment.parentId` (currently an untyped ObjectId with no
  // `ref`) a real target. That is a migration; this fix is not, and until it
  // happens the embedded array works and is addressable.
);

// ──────────────────── Emergency contact subdocument ────────────────────
const emergencyContactSchema = new mongoose.Schema(
  {
    contactName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    relationship: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    alternatePhone: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: false }
);

// ──────────────────── Class history subdocument ────────────────────
const classHistorySchema = new mongoose.Schema(
  {
    from: { type: String, required: true },
    to: { type: String, required: true },
    date: { type: Date, default: Date.now },
    reason: { type: String, default: "" },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { _id: false }
);

// ──────────────────── Student schema ────────────────────
const studentModel = new mongoose.Schema(
  {
    // ── Identity ──
    studentId: {
      type: String,
      unique: true,
      trim: true,
      index: true,
    },
    studentName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    // Derived from studentName by the pre-save hook; never set by a client.
    // They exist because `alumniQuerySchema` and `cohortDetailQuerySchema` both
    // offer `lastName` as a sortBy — sorting on a field that did not exist was
    // silently a no-op, and the sort was never applied.
    firstName: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    lastName: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    studentClass: {
      type: String,
      required: true,
      trim: true,
    },
    studentImage: {
      type: String,
      default: null,
    },
    gender: {
      type: String,
      enum: ["male", "female"],
      required: true,
    },
    dateOfBirth: {
      type: Date,
      default: null,
    },

    // ── School scope ──
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },

    // ── Status / lifecycle ──
    status: {
      type: String,
      enum: ["active", "suspended", "removed", "graduated", "transferred_out"],
      default: "active",
      index: true,
    },
    statusReason: {
      type: String,
      default: "",
    },
    statusChangedAt: {
      type: Date,
      default: null,
    },

    // ── Fee details (stored in pesewas as integers) ──
    totalOwed: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: (v) => Number.isInteger(v),
        message: "totalOwed must be an integer number of pesewas",
      },
    },
    totalPaid: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: (v) => Number.isInteger(v),
        message: "totalPaid must be an integer number of pesewas",
      },
    },
    balance: {
      type: Number,
      default: 0,
    },
    deadline: {
      type: Date,
      required: true,
    },

    // ── Parents ──
    parents: {
      type: [parentSchema],
      default: [],
      validate: {
        validator: (arr) => arr.length > 0,
        message: "At least one parent is required",
      },
    },

    // ── Emergency contacts ──
    emergencyContacts: {
      type: [emergencyContactSchema],
      default: [],
    },

    // ── Pay link ──
    //
    // **No `unique: true` here** — the uniqueness is declared once, in
    // `schema.index()` below, where the partial filter lives. Declaring both
    // makes Mongoose keep the first definition and discard the second's
    // options, which would leave the plain index in place.
    uniquePayLinkToken: {
      type: String,
    },
    payLink: {
      type: String,
      default: null,
    },

    // ── Academic lifecycle ──
    academicYear: {
      type: String,
      default: null,
    },
    promotedFrom: {
      type: String,
      default: null,
    },
    promotedTo: {
      type: String,
      default: null,
    },
    promotionDate: {
      type: Date,
      default: null,
    },
    graduationDate: {
      type: Date,
      default: null,
    },
    graduationYear: {
      type: String,
      default: null,
    },
    // The three fields below were assigned in `graduateStudent` and
    // `bulkGraduateStudents` and read back by `getAlumni` and `getCohorts`, but
    // were never declared here. With Mongoose `strict` on (the default) the
    // writes were dropped on save, so filtering alumni by honours returned an
    // empty list, sorting by certificate number was ignored, and the duplicate
    // certificate guard queried a path that did not exist.
    graduationType: {
      type: String,
      enum: ["STANDARD", "EARLY", "HONORARY", "DEFERRED"],
      default: null,
    },
    certificateNumber: {
      type: String,
      trim: true,
      default: null,
    },
    honors: {
      type: String,
      enum: ["NONE", "HONORS", "HIGH_HONORS", "HIGHEST_HONORS"],
      default: "NONE",
    },
    isAlumni: {
      type: Boolean,
      default: false,
    },
    transferOutDate: {
      type: Date,
      default: null,
    },
    transferOutReason: {
      type: String,
      default: null,
    },
    isRepeating: {
      type: Boolean,
      default: false,
    },
    // Incremented only by the repeat transition. Previously the repeat count was
    // derived by scanning `classHistory` on every call to `repeatStudent`, so
    // the array grew without bound and the guard cost grew with it.
    repeatCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // The destination of a transfer-out was built in memory, returned to the
    // caller and then discarded — nothing on the student recorded where they
    // went. `transferOutRecord` persists the whole submission.
    transferOutRecord: {
      destinationInstitution: { type: String, trim: true, default: null },
      destinationInstitutionType: { type: String, trim: true, default: null },
      contactPerson: { type: String, trim: true, default: null },
      contactEmail: { type: String, lowercase: true, trim: true, default: null },
      contactPhone: { type: String, trim: true, default: null },
      recordsTransferred: { type: Boolean, default: false },
    },
    classHistory: {
      type: [classHistorySchema],
      default: [],
    },

    // ── Payments (reserved for the future Payments module) ──
    paymentPlans: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "PaymentPlan",
      default: [],
    },

    // ── Audit ──
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deletedReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },
  },
  { timestamps: true }
);

// ── Indexes ──
studentModel.index({ schoolId: 1, studentClass: 1 });
studentModel.index({ schoolId: 1, status: 1 });
studentModel.index({ schoolId: 1, studentId: 1 }, { unique: true });
// An inbound WhatsApp message arrives in E.164 with no school reference, so the
// sender has to be resolved back to a school by parent number. Without this
// index that lookup is a collection scan on every webhook delivery.
studentModel.index({ "parents.phone": 1 });
// The roster's default filter is exactly school + status + class, and it is the
// query behind every page of the Students module. It was previously satisfied by
// two separate single-field indexes, which Mongo can only intersect at high cost.
studentModel.index({ schoolId: 1, status: 1, studentClass: 1 });
// Certificate numbers must be unique within a school, and only among students
// that actually have one — a partial index so the many nulls in a live roster
// do not collide with each other.
studentModel.index(
  { schoolId: 1, certificateNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { certificateNumber: { $type: "string" } },
  }
);
// The pay-link token is what a parent's payment link resolves through, so two
// students sharing one would send a payment to the wrong child. The pre-save
// hook mints a token for every student that reaches it, but rows written by
// an insert path that skips the hook would carry no token at all — and a plain
// unique index treats a missing token as one shared null value, which is the
// same E11000 trap the payments collection walked into. The partial filter
// keeps the guarantee for real tokens and leaves the rest of the roster alone.
studentModel.index(
  { uniquePayLinkToken: 1 },
  {
    unique: true,
    partialFilterExpression: { uniquePayLinkToken: { $type: "string" } },
  }
);

/**
 * The derived name fields for a student's `studentName`.
 *
 * **Shared, because the bulk importer writes without the hook.** `insertMany`
 * does not run a pre-save hook, so a student imported from a spreadsheet reaches
 * Mongo without the fields the hook would have derived — and the roster sorts
 * and searches on `firstName`/`lastName`, so that student is one the school
 * cannot find by name. The importer calls this too; a second copy of the rule
 * would be a second place for it to be right.
 *
 * Derived rather than accepted from a client so the two can never disagree — a
 * payload that set `lastName: "Mensah"` on a student named "Kwame Mensah Jr"
 * would otherwise sort and search under a name the school never entered.
 */
export const deriveNameParts = (studentName) => {
  const nameParts = String(studentName || "").trim().split(/\s+/).filter(Boolean);
  return {
    firstName: nameParts[0] || "",
    lastName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : "",
  };
};

// ── Pre-save hooks ──
studentModel.pre("save", async function () {
  const derived = deriveNameParts(this.studentName);
  this.firstName = derived.firstName;
  this.lastName = derived.lastName;

  // Auto-generate studentId if missing (safety net; the service normally
  // generates it so it can retry on rare collisions).
  if (!this.studentId) {
    const school = await School.findById(this.schoolId)
      .select("schoolCode academic.currentYear")
      .lean();
    const code = school?.schoolCode;
    const year = resolveAcademicYearStart(this.academicYear || school?.academic?.currentYear);
    this.studentId = await generateStudentId(code, year);
  }

  // Generate pay link token + URL if missing.
  if (!this.uniquePayLinkToken) {
    this.uniquePayLinkToken = generatePayLinkToken();
    this.payLink = buildPayLink(this.uniquePayLinkToken);
  }

  // Primary parent rule: exactly one isPrimary.
  if (Array.isArray(this.parents) && this.parents.length) {
    let foundPrimary = false;
    this.parents.forEach((parent) => {
      if (parent.isPrimary) {
        if (!foundPrimary) {
          foundPrimary = true;
        } else {
          parent.isPrimary = false;
        }
      }
    });
    if (!foundPrimary) {
      this.parents[0].isPrimary = true;
    }
  }

  // Always recompute balance from source-of-truth fields (business rule #3).
  this.balance = (this.totalOwed || 0) - (this.totalPaid || 0);
});

// ── toJSON: strip internal fields, keep everything else (no secrets). ──
studentModel.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    // Never leak the raw pay link token; the public payLink is sufficient.
    delete ret.uniquePayLinkToken;
    return ret;
  },
});

export const Student = mongoose.model("Student", studentModel);
