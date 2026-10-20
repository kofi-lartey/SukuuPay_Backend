import mongoose from "mongoose";

/**
 * A message a parent sent to their school from the public pay portal.
 *
 * ## Why this collection exists
 *
 * Until now a parent message lived in exactly two places: a `Notification` row per
 * admin, and — if an admin happened to have a phone number on file — an `SmsMessage`.
 * Both are *delivery attempts*, not records. Neither can answer the two questions a
 * bursar actually has:
 *
 *   1. "What has this parent told us, in their own words?" The `Notification` body is
 *      capped at 500 characters and carries a *summary*; the verbatim text lived in
 *      `meta`, which is unbounded but is not queryable and is deleted with the
 *      notification after 90 days.
 *   2. "Did anyone deal with it?" `Notification` has `read`, which is not the same
 *      thing. A bursar glancing at a badge has read the subject line, not answered a
 *      parent about a balance dispute they are still owed an answer on.
 *
 * So the message is now a first-class row, and the notification is only the alert
 * that points at it. That also gives audio somewhere to live: a voice note is a
 * megabyte-scale artefact that has no business being a base64 string inside a
 * notification's `meta`.
 *
 * The parent is identified by `studentId` but denormalised into `studentName` /
 * `studentClass` / `studentRef`. A message is evidence about a specific fee dispute;
 * if it could only be rendered by joining through to a student record that may since
 * have been renamed, transferred or graduated, the record stops answering the
 * question it was kept for.
 */
const PARENT_MESSAGE_STATUSES = ["new", "read", "resolved", "archived"];
const PARENT_MESSAGE_STATUS_VALUES = PARENT_MESSAGE_STATUSES;

/**
 * Audio containers a phone will actually produce.
 *
 * `MediaRecorder` does not let you choose a codec portably, and the four here are the
 * union of what Chrome, Safari and Firefox emit on the platforms this portal is used
 * on. Anything outside this set is rejected at the multer filter rather than trusted,
 * because the alternative is a Cloudinary upload of an arbitrary `video/*` subtype
 * from an unauthenticated parent endpoint.
 */
const PARENT_AUDIO_MIME_TYPES = [
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/ogg",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-m4a",
  "video/webm",
  "video/mp4",
];

const parentMessageSchema = new mongoose.Schema(
  {
    /**
     * Stable public identifier. Minted in a pre-save hook in the same shape as
     * `Payment.paymentId` and `IdCardBatch` would want one, so a bursar reading this
     * over the phone can quote it back without exposing a Mongo ObjectId.
     *
     * **No `unique: true` here** — the uniqueness is declared once, in
     * `schema.index()` below, where the partial filter lives. Declaring both
     * makes Mongoose keep the first definition and discard the second's
     * options, which would leave the plain index in place and the null in it
     * with it.
     */
    messageId: {
      type: String,
      default: null,
    },

    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },

    /**
     * `studentId` deliberately carries **no** `index: true`.
     *
     * It did, alongside `schema.index({ studentId: 1, createdAt: -1 })` below, and
     * mongoose warned at boot:
     *
     *   Duplicate schema index on {"studentId":1,"createdAt":-1} for model
     *   "ParentMessage" … MongoDB will not create the duplicate index
     *
     * Declaring a field index *and* a compound index that starts with that field
     * produces two index definitions for the same key pattern. Mongo keeps one and drops
     * the other, so whichever loses takes its options with it — and "whichever loses" is
     * decided by declaration order, not by anything stated here.
     *
     * The compound index serves `find({ studentId })` perfectly well on its own: a
     * compound index is usable by any query on a prefix of its keys. So the standalone
     * field index buys nothing and risks silently losing an option.
     */
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      default: null,
    },

    // Denormalised on purpose — see the class comment.
    studentRef: { type: String, default: null, trim: true },
    studentName: { type: String, default: null, trim: true },
    studentClass: { type: String, default: null, trim: true },

    parentName: { type: String, required: true, trim: true, maxlength: 100 },
    /**
     * Stored in full, unlike the masked copy that goes into the `Notification`.
     *
     * The notification is read by every admin in the school and is not the place to
     * accumulate parent numbers. This row is scoped to the school's own staff, is
     * already the record of who contacted them, and a bursar cannot return a call
     * without it. There is no other copy anywhere once the pay link expires.
     */
    parentPhone: { type: String, required: true, trim: true },

    /**
     * The parent's words. Nullable because a voice note is a valid message on its
     * own — "record this, I am sending a voice note about the fees" is a real thing
     * a parent does when they cannot read the form, which is the entire reason the
     * recorder exists.
     */
    message: { type: String, default: null, trim: true, maxlength: 1000 },

    /**
     * The voice note. `publicId` is `select: false` so a bulk export cannot leak a
     * deletable handle, and `toJSON` strips it as well.
     */
    audio: {
      url: { type: String, default: null },
      publicId: { type: String, default: null, select: false },
      mimeType: { type: String, default: null },
      bytes: { type: Number, default: null, min: 0 },
      durationSeconds: { type: Number, default: null, min: 0 },
    },

    /** Denormalised so the inbox can filter and sort without a $lookup per row. */
    hasAudio: { type: Boolean, default: false, index: true },

    /**
     * Why a recording that the parent attached did not make it onto the row.
     *
     * Set when `uploadAudioBuffer` throws and the parent also wrote text, so the
     * message is still saved. Null means either no audio was sent or it uploaded
     * cleanly — the two are indistinguishable from this field alone, which is
     * deliberate: a bursar should not have to wonder whether a silent row means
     * "no recording" or "recording lost".
     */
    audioUploadFailure: {
      type: String,
      default: null,
      trim: true,
      maxlength: 300,
    },

    status: {
      type: String,
      enum: PARENT_MESSAGE_STATUS_VALUES,
      default: "new",
      index: true,
    },

    readAt: { type: Date, default: null },
    readBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /** What was done about it. The only durable trace that the parent was answered. */
    resolutionNote: { type: String, default: null, trim: true, maxlength: 500 },

    /**
     * Whether an admin's handset actually received the SMS alert.
     *
     * Recorded because "no admin has a phone on file" and "the gateway rejected it"
     * are different problems with different fixes, and the parent is told a different
     * thing in each case. Null means not attempted.
     */
    smsAlerted: { type: Boolean, default: false },
    smsAlertFailure: { type: String, default: null, maxlength: 300 },

    source: { type: String, enum: ["pay_link"], default: "pay_link" },

    ip: { type: String, default: null },
  },
  { timestamps: true }
);

/**
 * The school inbox: newest first, filtered by status.
 *
 * This is the query behind the one page a bursar opens to answer a parent, so it is
 * the only read that matters at scale and the one that must not degrade as unread
 * messages accumulate.
 */
parentMessageSchema.index({ schoolId: 1, status: 1, createdAt: -1 });

/** The thread shown when a bursar opens a student from the roster. */
parentMessageSchema.index({ studentId: 1, createdAt: -1 });

/**
 * One message id per message — the handle a bursar quotes over the phone.
 *
 * **Partial, and it has to be.** `messageId` defaults to null and is minted in a
 * pre-save hook, so a row that skipped the hook would carry an explicit null —
 * and MongoDB's unique index treats that as a present value and indexes it as
 * null. One such row and the collection can never hold another, and the parent
 * writing in again would get a duplicate-key error on a public, unauthenticated
 * endpoint. The partial filter keeps the uniqueness for the rows that carry an
 * id and takes the rest out of it.
 */
parentMessageSchema.index(
  { messageId: 1 },
  { unique: true, partialFilterExpression: { messageId: { $type: "string" } } }
);

/**
 * No second, partial index on `{ studentId, createdAt }`.
 *
 * There was one, on the theory that a `{ $type: "objectId" }` partial filter would keep
 * it small by excluding archived students. Two problems: a partial index needs its own
 * `$expr`/`$type` filter on every query to be chosen, so the unpartial index above is what
 * the query planner actually picks and this one is dead weight; and having the same key
 * pattern twice is what produced the boot warning above. The archived-student rows are a
 * rounding error against the messages that matter, so filtering them out of the index was
 * optimising the wrong thing.
 */

/**
 * Mints `messageId` before first write.
 *
 * A pre-save hook rather than a caller-assigned value because there are two callers
 * today and a third is one refactor away, and a duplicate-key failure on a public
 * unauthenticated endpoint is a bad trade for one line of shared code.
 *
 * **No `next` parameter.** This hook took one and called `next()`, which worked on the
 * Mongoose the code was written against and throws on the installed one:
 *
 *     TypeError: next is not a function
 *
 * Mongoose 7 removed the callback argument from hooks; `kareem`, the hook library
 * underneath, applies a pre-hook with only its own arguments (`pres[i].fn.apply(context,
 * $args)`), so a `next` identifier is simply `undefined`. Verified against the installed
 * `kareem` rather than assumed from the changelog.
 *
 * The damage was not a crash on one endpoint. Every save of this document threw, so **a
 * parent message could not be recorded at all** — the row the school inbox reads was
 * never written, and `notifySchool` failed after the write attempt with an error the
 * controller passed straight back, so the parent was told "next is not a function" on an
 * unauthenticated page. The notification fix in `pay.service.js` was real but secondary:
 * nothing was ever created to notify anyone about.
 *
 * A hook with no parameters is promise-style and needs no callback. Keeping `function`
 * rather than an arrow is required — the hook reads `this`.
 */
parentMessageSchema.pre("save", function mintMessageId() {
  if (!this.messageId) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    this.messageId = `PMSG-${dateStr}-${Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()}`;
  }
});

parentMessageSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    if (ret.audio) delete ret.audio.publicId;
    return ret;
  },
});

export { PARENT_MESSAGE_STATUSES, PARENT_MESSAGE_STATUS_VALUES, PARENT_AUDIO_MIME_TYPES };
export const ParentMessage = mongoose.model("ParentMessage", parentMessageSchema);
export default ParentMessage;