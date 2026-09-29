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
