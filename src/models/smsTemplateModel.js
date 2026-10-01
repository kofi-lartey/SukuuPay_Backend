import mongoose from 'mongoose';
import { SMS_CATEGORIES, SMS_TOKENS } from '../config/constants.js';

/**
 * A reusable fee-reminder body.
 *
 * The body is stored with `{token}` placeholders rather than pre-rendered text,
 * because the numbers are the whole point: the same sentence sent to 200 parents
 * has to read "GHC 550" to one of them and "GHC 1,200" to another. Rendering
 * per recipient happens at send time; the template is the shape, not the message.
 *
 * A template with `schoolId: null` is platform-wide and every school can send
 * it. A scoped one belongs to the school that created it and is invisible to
 * everyone else — a bursar must not be able to broadcast another school's PTA
 * copy by guessing an id.
 *
 * Unlike `WhatsAppTemplate` there is no `status` field. WhatsApp templates need
 * one because Meta approves them out of band; an SMS body is not submitted to
 * anybody, so a lifecycle around it would be ceremony.
 */
const smsTemplateSchema = new mongoose.Schema(
  {
    // Lookup key, derived from the name: "Final Warning" → "final_warning".
    // Scoped unique, not globally unique, so two schools may each keep their own
    // "Final Warning" without either being forced to rename theirs.
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 80,
    },

    // What the composer shows in the preset row. The user-facing label, so it
    // keeps its capitalisation and spaces; `key` is the machine form.
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 300,
    },

    category: {
      type: String,
      enum: SMS_CATEGORIES,
      default: 'custom',
      index: true,
    },

    // The body, with `{token}` placeholders. Validated against SMS_TOKENS at
    // the service layer, where the token set and its error message live
    // together — an unknown token is a 400 with the offending name in it, not a
    // silently unsent row of `{parentname}`.
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 4800,
    },

    // The tokens this body actually uses, in order of first appearance. Stored
    // so the history and analytics views can filter by token usage without
    // re-parsing every body, and so the composer can highlight which rows a
    // given preset needs.
    tokens: {
      type: [String],
      default: [],
    },

    // The tokens the design's preset row marks as required. A hint for the UI,
    // not a validation rule — a school may send a body that uses any subset, in
    // any order, and may repeat one.
    requiredTokens: {
      type: [String],
      default: [],
    },

    // Marks the four seeded presets. Kept as a flag rather than by matching on
    // the name so a school that edits "Final Warning" is still offered the other
    // three, and so the "restore presets" action can tell a modified preset from
    // an untouched one.
    isPreset: {
      type: Boolean,
      default: false,
      index: true,
    },

    // The unedited seeded body, retained so a school's edits can be reverted
    // without re-deriving the copy. Null for anything the school wrote.
    presetBody: {
      type: String,
      default: null,
    },

    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      default: null,
      index: true,
    },

    // A soft delete rather than a removal: a `SmsMessage` references the
    // template it was rendered from, and that link has to keep resolving for
    // the history view. Deleting a template must not rewrite past sends.
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },

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
  },
  { timestamps: true }
);

// ── Indexes ──
// Partial on `deletedAt: null` so a school with a long history of renamed
// templates does not accumulate collisions on soft-deleted rows.
smsTemplateSchema.index(
  { schoolId: 1, key: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);
// A platform-wide preset is `schoolId: null`, so a plain `{schoolId, key}`
// index alone cannot express "or null" — it is kept separate for the seed
// check, which only ever looks for platform rows.
smsTemplateSchema.index({ key: 1, schoolId: 1 });
smsTemplateSchema.index({ schoolId: 1, category: 1 });

smsTemplateSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const SmsTemplate = mongoose.model('SmsTemplate', smsTemplateSchema);

/** Token vocabulary, re-exported so the service validates against one source. */
export { SMS_TOKENS, SMS_CATEGORIES };

export default SmsTemplate;
