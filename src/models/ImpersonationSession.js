import mongoose from "mongoose";

/**
 * One impersonation of one school by one super admin.
 *
 * The product has exactly one `super_admin` (`boot/ensureSuperAdmin.js`), so
 * "impersonation" here is not a support feature that a school admin can also use
 * — it is the platform owner standing inside a tenant's console to reproduce a
 * parent's failed payment. That makes this collection the evidence for the single
 * most sensitive thing the owner can do: see a school exactly as its own admin
 * sees it.
 *
 * **Why a durable collection rather than a field on `User`.**
 *
 * `User.impersonatingSchoolId` holds only the *current* target, which is what the
 * request path needs and is why it exists at all. It cannot answer the two questions
 * that get asked afterwards:
 *
 *   - "who was in my school's records last Tuesday?" — a field holds one value and
 *     is overwritten by the next session, so the answer is gone;
 *   - "what did the platform owner actually look at while they were in there?" —
 *     which needs the `reason`, the operator's IP, and a count of what they touched.
 *
 * A support incident that ends in a data-integrity dispute is decided on exactly
 * those three facts, and none of them survive in a mutable field.
 *
 * **Sessions are append-only in practice.** Ending one sets `endedAt`; it never
 * deletes. `middleware/impersonation.js` matches on `endedAt: null`, so an expired
 * row cannot be reactivated and a deleted row cannot be read as "still open".
 */
const impersonationSessionSchema = new mongoose.Schema(
  {
    /**
     * Who impersonated.
     *
     * Required, and always the platform owner — but stored as a plain reference
     * rather than assumed, so the record stays truthful if the owner account is ever
     * replaced. A session is not deleted when the user is; the trail has to outlive the
     * account.
     *
     * **No `index: true` here.** Indexed once below, where the partial filter that
     * makes the hot-path lookup cheap lives. Declaring both makes Mongoose keep the
     * first definition and warn about the duplicate, so the bare field index would win
     * and the filter would be dropped — which defeats the entire point of that index,
     * since its size depends on holding only the currently-open sessions.
     */
    superAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    /** Whose console was opened. Indexed for the school's own "who looked at us" view. */
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },

    startedAt: {
      type: Date,
      default: Date.now,
    },

    /**
     * `null` while the session is open.
     *
     * Not `isActive`. A nullable timestamp answers a question the boolean cannot:
     * *when* did it end, and for how long was the door open? That duration is the
     * thing an audit looks at — an open session that ran for six hours is a very
     * different fact from a closed one that lasted four minutes.
     */
    endedAt: {
      type: Date,
      default: null,
    },

    /**
     * Why. Required, 10–500 characters.
     *
     * Enforced at the validation layer too, and the length floor is the whole point:
     * "testing" or "fix" is not a reason, and an unreasoned session is one nobody
     * can be shown afterwards. This string is read by the school's own staff, so it
     * is written to them rather than about them.
     */
    reason: {
      type: String,
      required: true,
      trim: true,
      minlength: 10,
      maxlength: 500,
    },

    /**
     * Where the operator was sitting.
     *
     * The reason a session is only as trustworthy as its operator, and "which
     * network did this come from" is the first thing asked when an impersonation
     * is questioned. Captured at start; never updated, so it describes the moment
     * the door opened rather than whatever the address header says now.
     */
    ipAddress: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: null,
    },

    /**
     * How much the operator did while inside.
     *
     * Incremented by `middleware/impersonation.js` on every request the session
     * sees — reads included, which is why a support call that only looked around
     * still reads as `31` rather than `0`. A count of zero on a four-minute session
     * would tell an auditor nothing; the count is evidence of attention, not of
     * damage, and it is deliberately the only thing derived rather than stored.
     */
    actionsCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

/*
 * Both indexes serve the two questions the console actually asks, and neither can
 * be served by the single-field indexes above.
 *
 * `GET /admin/impersonate/sessions?superAdminId=` with a `startedAt` sort is the
 * platform owner's own history; without the compound index Mongo would have to
 * filter every session this platform will ever have before it could sort the
 * handful being displayed. `?schoolId=` is the same query pointed the other way —
 * "has anyone been inside my school" — and is the one a school admin can ask.
 */
impersonationSessionSchema.index({ superAdminId: 1, startedAt: -1 });
impersonationSessionSchema.index({ schoolId: 1, startedAt: -1 });

/*
 * Partial, and that is the point: the middleware resolves the *live* session on
 * every authenticated admin request (`endedAt: null`), so this is the one lookup on
 * that hot path. A partial index holds only open sessions — normally zero or one —
 * so it stays tiny no matter how long the history grows, and the query cannot fall
 * back to scanning closed ones.
 */
impersonationSessionSchema.index(
  { superAdminId: 1 },
  { partialFilterExpression: { endedAt: null } }
);

impersonationSessionSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const ImpersonationSession = mongoose.model(
  "ImpersonationSession",
  impersonationSessionSchema
);

export default ImpersonationSession;