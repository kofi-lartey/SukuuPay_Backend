import mongoose from "mongoose";
import bcrypt from "bcryptjs";

export const userModel = new mongoose.Schema(
  {
    // ─────────────── Identity ───────────────
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
      default: null,
      // Was `required: true`. Team invitations take name + email only, so a
      // school admin inviting a colleague has no phone number to hand — often
      // no accurate one, since staff phones are frequently personal handsets.
      // Requiring it meant the invitation flow could only ever be satisfied by
      // inventing a placeholder, which is worse than recording none.
      //
      // Relaxing a required flag is backward compatible: Mongoose only enforces
      // path presence for documents written after the change, and every
      // existing account already carries a phone. Nothing in the codebase reads
      // `user.phone` — it was only ever written (see `updateUser`) — so there is
      // no consumer that can now receive `null` and mishandle it.
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false, // hide by default in queries
    },
    avatar: {
      type: String,
      default: null,
    },
    position: {
      type: String, // e.g. "Headmaster", "Accountant", "Founder"
      default: null,
    },

    // ─────────────── Role & Scope ───────────────
    role: {
      type: String,
      enum: ["super_admin", "school_admin", "accountant", "teacher", "viewer"],
      required: true,
      default: "school_admin",
    },
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      default: null, // null for super_admin
      index: true,
    },
    isPlatformOwner: {
      type: Boolean,
      default: false, // true ONLY for you (founder)
    },

    /**
     * The classes this account is assigned to teach.
     *
     * A class in SukuuPay is a **name** (`School.academic.classes`), not a
     * document — there is no `Class` collection and the student module
     * deliberately kept it that way. So a link between a teacher and a class
     * cannot be a reference; it is a `{ className, subject }` pair recorded on
     * the teacher's own account, one entry per class per subject taught.
     *
     * Two entries for the same class (Mathematics and English in JHS 2A) are
     * normal. `utils/teacherScope.js` is the single reader of this field and
     * collapses them into one class with both subjects, so no endpoint has to
     * decide how to present that.
     *
     * Additive and defaulted to `[]`, so no migration is needed: every teacher
     * created before this field simply has no assigned classes, which is the
     * state they were already in — nothing in the codebase could read a
     * teacher's classes, because there was no way to record them.
     *
     * `school_admin` and `super_admin` never need an entry here: they act on
     * every class in their school, and `teacherScope` resolves that from the
     * role rather than from a list an admin would have to maintain.
     */
    assignedClasses: [
      {
        className: { type: String, required: true, trim: true },
        subject: { type: String, default: "", trim: true },
      },
    ],

    /**
     * The school the platform owner is currently viewing, or null.
     *
     * This is a *pointer to the current impersonation*, not the record of it. Two
     * fields below and the `ImpersonationSession` collection hold the history;
     * everything here exists so the request path can answer "which tenant does this
     * super admin's request apply to" in one field read, on every authenticated
     * request, with no join.
     *
     * The field is on `User` rather than in the token on purpose, and that choice
     * is the security property: the JWT is signed at login and lives for hours, so a
     * target baked into it would keep asserting an impersonation long after
     * `POST /admin/impersonate/end` cleared it. A token can end an impersonation
     * only by being thrown away; a database field ends it for every outstanding
     * token at once, which is what "exit impersonation" has to mean.
     */
    impersonatingSchoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      default: null,
      index: true,
    },

    /**
     * The open `ImpersonationSession`, or null.
     *
     * Set and cleared with `impersonatingSchoolId`, and the two are always written
     * together — a session id with no school cannot be scoped, and a school with no
     * session has no `reason` attached to it. Kept anyway because the audit needs
     * the id: `actionsCount` lives on the session row, and a request arriving
     * without one has to be attributed to *something* specific.
     */
    impersonationSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ImpersonationSession",
      default: null,
    },

    // ─────────────── Onboarding ───────────────
    /**
     * What the bursar told us at signup, before any School exists.
     *
     * The signup form has always collected school name, classification and
     * region, but the payload was stripped by `stripUnknown` (the schema had no
     * `school` key) and thrown away — so the user was asked for it twice, or
     * rather the second time they hit a dead end. Storing it here rather than in
     * the browser means it survives a device change and can prefill Step 1.
     *
     * Deliberately not a School: nothing here is verified, and creating a
     * School for an unverified email address would let anyone register a school
     * with a throwaway inbox. The real record appears at Step 1 via
     * `POST /schools/me`, once the address is verified and the account is
     * authenticated.
     */
    schoolIntent: {
      name: { type: String, trim: true, maxlength: 150, default: "" },
      classification: { type: String, trim: true, maxlength: 40, default: "" },
      region: { type: String, trim: true, maxlength: 40, default: "" },
    },
    /**
     * Replaces the `sukuupay_onboarding_completed_<userId>` localStorage flag.
     *
     * The flag could not survive a device change, so an admin who onboarded on a
     * laptop was asked to walk the wizard again on their phone. With
     * self-service provisioning that stopped being cosmetic: re-running Step 1
     * would have meant re-creating a school.
     */
    onboardingCompleted: {
      type: Boolean,
      default: false,
    },
    onboardingHighestStep: {
      type: Number,
      default: 0,
      min: 0,
      max: 3, // ONBOARDING_STEPS has four entries, zero-indexed
    },

    // ─────────────── Status ───────────────
    status: {
      type: String,
      enum: ["active", "invited", "suspended", "deactivated"],
      default: "invited",
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },

    // ─────────────── Password Reset ───────────────
    passwordResetToken: {
      type: String,
      select: false,
      default: null,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
      default: null,
    },
    passwordChangedAt: {
      type: Date,
      default: null,
    },

    // ─────────────── Email Verification (OTP) ───────────────
    emailVerificationToken: {
      type: String,
      select: false,
      default: null, // hashed OTP
    },
    emailVerificationExpires: {
      type: Date,
      select: false,
      default: null,
    },
    emailVerifiedAt: {
      type: Date,
      default: null,
    },

    /**
     * **How** this address was verified: `otp` or `google`.
     *
     * Not derivable from `isEmailVerified`, which is a boolean and says only *that*.
     * This matters because the two routes have different guarantees, and support asks:
     * "is this account's email actually verified?" has two different answers depending
     * on whether a human proved control of the address through a code we mailed, or
     * whether Google asserted the same thing about an account that may itself have an
     * unverified secondary address.
     *
     * Nullable, because an account verified before this field existed has no recorded
     * route. A null here means "unknown, ask `isEmailVerified`", never "verified by
     * nobody" — treating it as unverified would lock out accounts that are fine.
     */
    emailVerifiedVia: {
      type: String,
      enum: ["otp", "google", null],
      default: null,
    },

    // ─────────────── Identity provider ───────────────
    /**
     * Which credential this account authenticates with: `password` (the default), or
     * `google`.
     *
     * A single field rather than a `providers: []` array, deliberately. The product
     * supports signing in with Google **or** a password, never both at once — a Google
     * account gets an unusable random password (see `googleAuth.controller.js`) so that
     * `password` stays `required` and no existing invariant moves. An array would
     * imply a two-factor-ish "link several ways in" capability that does not exist,
     * and would make every read of `authProvider` a question about which of several
     * values wins.
     *
     * Its real job is **account linking safety**: it is what lets sign-in tell an
     * account created *through Google* from one that merely happens to share its email
     * address. Without it, any Google account holding a given address would be able to
     * walk into a password account registered to that address, because the email
     * matches — and matching emails are not proof of ownership.
     */
    authProvider: {
      type: String,
      enum: ["password", "google"],
      default: "password",
      /*
       * **No `index: true` here.** Indexed once in `userModel.index()` below, where
       * the `partialFilterExpression` that keeps it to Google accounts lives.
       *
       * Declaring both would make Mongoose keep the first definition and warn about
       * the duplicate — so the bare field index would win and the partial filter would
       * be silently dropped, turning an index over a handful of Google users into a
       * full one over every account on the platform.
       */
    },

    /**
     * Google's stable `sub` claim — the account's immutable identifier.
     *
     * The key is the lookup for sign-in, **not** the email: Google's `sub` is stable
     * for the life of the account while the email can change, and a mutable identifier
     * used as a primary key is an account-takeover bug waiting for a user who changes
     * their address. The email is verified by Google and used for matching an existing
     * SukuuPay account; `sub` is used to recognise a returning one.
     *
     * Sparse-unique, so a second account cannot claim the same Google identity, and so
     * the many password-only accounts carry no value at all.
     */
    providerId: {
      type: String,
      trim: true,
      default: null,
    },

    /**
     * Google's profile picture URL, captured at first sign-in.
     *
     * **Not** refreshed on every login. Google's avatar URLs are stable while they last
     * and then expire, and re-fetching would mean fetching a remote image during an
     * authentication request that has no reason to make a network call. A stale URL
     * degrades to a broken avatar; a refresh inside login degrades to a slower, more
     * failure-prone login. A profile screen that wants a fresh one can request it
     * explicitly later.
     */
    providerAvatar: {
      type: String,
      trim: true,
      default: null,
    },

    /** When this account last signed in through Google, for support and audit. */
    lastProviderLoginAt: {
      type: Date,
      default: null,
    },

    // ─────────────── Session / Refresh Tokens ───────────────
    refreshToken: {
      type: String,
      select: false,
      default: null, // hashed refresh token of the active session
    },
    refreshTokenExpires: {
      type: Date,
      select: false,
      default: null,
    },
    tokenVersion: {
      type: Number,
      default: 0, // bump to invalidate every issued token at once
    },

    // ─────────────── Audit ───────────────
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ─────────────── Invitation lifecycle ───────────────
    //
    // Additive and every field defaults, so no migration is required: existing
    // documents simply read as "never invited through this flow", which is
    // true of every account created before the User Management module.
    //
    // `invitedBy` above already existed and was written by the old
    // `POST /users/invite`, but nothing recorded *when* the invitation went out
    // or whether the mail actually left. That gap is why the old endpoint could
    // swallow a Brevo failure and still answer 201: there was no field whose
    // value would have been a lie.
    invitedAt: {
      type: Date,
      default: null,
    },

    /**
     * Set when the invitation email was accepted by the provider, cleared when a
     * resend fails. Distinguishes "the admin sent it" from "Brevo took it" —
     * the difference between an invitee who never checked their junk folder and
     * one whose address is simply wrong.
     */
    inviteEmailSentAt: {
      type: Date,
      default: null,
    },

    /**
     * How many invitations have been issued for this account. Greater than one
     * means the default password was re-minted, so the first one is dead and
     * only the newest mail carries a working credential.
     */
    inviteCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    /**
     * True while the account still holds an admin-minted default password.
     *
     * Advisory, not enforced: `login` does not gate on it, because doing so
     * would lock the invitee out of the only page that could let them change it.
     * It is surfaced on the login and `/auth/me` payloads so the client can
     * prompt a change through the existing `/forgot-password` route, and so an
     * auditor can see at a glance which staff accounts are still running on a
     * password their administrator knows.
     */
    mustChangePassword: {
      type: Boolean,
      default: false,
    },

    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// ─────────────── Virtuals ───────────────
userModel.virtual("isEmailVerificationPending").get(function () {
  return (
    !this.isEmailVerified &&
    Boolean(this.emailVerificationToken) &&
    this.emailVerificationExpires > new Date()
  );
});

userModel.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.passwordResetToken;
    delete ret.passwordResetExpires;
    delete ret.emailVerificationToken;
    delete ret.emailVerificationExpires;
    delete ret.refreshToken;
    delete ret.refreshTokenExpires;
    delete ret.__v;
    return ret;
  },
});

// ─────────────── Hooks ───────────────
userModel.pre("save", async function () {
  if (!this.isModified("password")) return;
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  this.passwordChangedAt = new Date();
});

// ─────────────── Methods ───────────────
userModel.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userModel.methods.isPasswordResetTokenValid = function () {
  return (
    Boolean(this.passwordResetToken) && this.passwordResetExpires > new Date()
  );
};

userModel.methods.isEmailVerificationTokenValid = function () {
  return (
    Boolean(this.emailVerificationToken) &&
    this.emailVerificationExpires > new Date()
  );
};

export const User = mongoose.model("User", userModel);

/**
 * One SukuuPay account per Google identity.
 *
 * Unique, but partial: the index only covers documents where `providerId` is
 * present and non-null. Password-only accounts carry `providerId: null` (the
 * field default), and a sparse unique index still indexes that `null` — MongoDB
 * treats an explicit `null` as a present value under `sparse: true`, which is
 * what made the second password-only invite die on a `providerId: null` E11000.
 *
 * A `partialFilterExpression` of `providerId: { $ne: null }` is the index-level
 * guarantee the prose above meant: the index is only over Google accounts, and
 * nulls are genuinely skipped, so a password-only user never collides with
 * another one on this field.
 *
 * This is the database-level guarantee behind account linking. Application code
 * already checks for an existing `providerId` before creating anything, but that
 * check is a read followed by a write, and two simultaneous first sign-ins on a
 * new address both pass it. Without this index the loser gets a `E11000` at
 * write time; with it, the guarantee is in the database where it cannot be
 * raced past.
 *
 * Also indexed (non-uniquely) as a partial on `authProvider`, because the admin
 * console's "users signed in with Google" filter is a real question an operator
 * asks and this makes it cheap.
 */
userModel.index(
  { providerId: 1 },
  {
    unique: true,
    /*
     * `{ providerId: { $type: "string" } }`, and **not** `{ $ne: null }`.
     *
     * MongoDB does not support `$ne` in a `partialFilterExpression` — it answers
     * `Expression not supported in partial index: $not` and creates nothing. The
     * earlier `{ $exists: true, $ne: null }` was in that unsupported shape, so
     * `providerId_1` was **never built on any deployment**: `User.createIndexes()`
     * failed with code 67 on every boot and the database was left with no
     * constraint on `providerId` at all, so two simultaneous first sign-ins on one
     * Google identity could both create an account.
     *
     * `$type: "string"` is the filter MongoDB actually accepts, and it excludes
     * nulls the same way: a password-only account carries `providerId: null`,
     * which is not a string, so it is not in the index and cannot collide with
     * another null. Every value that *is* a string is a real Google `sub`.
     */
    partialFilterExpression: { providerId: { $type: "string" } },
  }
);
userModel.index(
  { authProvider: 1 },
  { partialFilterExpression: { authProvider: 'google' } }
);
