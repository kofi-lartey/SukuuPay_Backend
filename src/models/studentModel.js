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
  },
  { _id: false }
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
    uniquePayLinkToken: {
      type: String,
      unique: true,
      index: true,
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

// ── Pre-save hooks ──
studentModel.pre("save", async function () {
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
