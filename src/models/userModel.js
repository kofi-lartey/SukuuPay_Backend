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
      required: true,
      trim: true,
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
