import mongoose from 'mongoose';
import { WHATSAPP_TEMPLATE_CATEGORIES, WHATSAPP_TEMPLATE_STATUSES } from '../config/constants.js';

// ──────────────────── WhatsApp template ────────────────────
// The local registry of templates the platform may send. Meta approves templates
// out of band; a row is the single place that records what this deployment
// believes is sendable, and it is checked before any send is attempted.
//
// A template with no `schoolId` is platform-wide and visible to every school.
// Scoped templates exist so one school can keep its own approved copy without
// waiting on a platform-wide review.
const templateVariableSchema = new mongoose.Schema(
  {
    // Placeholder name as it appears between {{ }} in the body.
    name: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 40,
    },
    // Example value Meta shows during review so the reviewer can picture the
    // rendered message.
    example: {
      type: String,
      trim: true,
      maxlength: 120,
      default: '',
    },
  },
  { _id: false }
);

const whatsappTemplateSchema = new mongoose.Schema(
  {
    // Meta requires lowercase alphanumeric + underscore, no spaces.
    name: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      minlength: 1,
      maxlength: 512,
    },
    // Human label for the admin UI; never sent to Meta.
    displayName: {
      type: String,
      trim: true,
      maxlength: 120,
      default: '',
    },
    description: {
      type: String,
      trim: true,
      maxlength: 300,
      default: '',
    },
    category: {
      type: String,
      enum: WHATSAPP_TEMPLATE_CATEGORIES,
      default: 'UTILITY',
      index: true,
    },
    // WhatsApp language tag, e.g. `en` or `en_GH`.
    language: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      default: 'en',
      maxlength: 16,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1024, // Meta's documented body limit
    },
    // Declared placeholders. The service rejects a template whose declared
    // variables and {{ }} placeholders disagree, because a mismatch only
    // surfaces as a provider rejection at send time.
    variables: {
      type: [templateVariableSchema],
      default: [],
    },

    // ── Approval ──
    status: {
      type: String,
      enum: WHATSAPP_TEMPLATE_STATUSES,
      default: 'draft',
      index: true,
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    // Meta's numeric template id, once submitted.
    providerTemplateId: {
      type: String,
      default: null,
    },
    providerStatus: {
      type: String,
      default: null,
    },
    approvedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },

    // ── Scope ──
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      default: null, // null = platform-wide
      index: true,
    },

    // ── Audit ──
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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

whatsappTemplateSchema.index({ status: 1, name: 1 });
// A platform template and a school's own copy of the same name cannot both
// exist, so uniqueness on the name alone is intentional.
whatsappTemplateSchema.index({ schoolId: 1, status: 1 });

whatsappTemplateSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const WhatsAppTemplate = mongoose.model('WhatsAppTemplate', whatsappTemplateSchema);
