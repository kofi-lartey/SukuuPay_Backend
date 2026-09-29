import { User } from '../models/userModel.js';
import { sendEmail } from '../services/emailService.js';
import {
  verificationEmail,
  passwordResetEmail,
  passwordChangedEmail,
} from '../templates/emails.js';
import {
  CLIENT_URL,
  EMAIL_OTP_EXPIRE_MINUTES,
  PASSWORD_RESET_EXPIRE_MINUTES,
} from '../config/env.js';
import {
  emailOtpExpiry,
  generateEmailOtp,
  generateResetToken,
  hashToken,
  issueSession,
  passwordResetExpiry,
  safeCompare,
  verifyToken,
} from '../utils/tokens.js';

const sendAuthResponse = (res, status, message, user, tokens) =>
  res.status(status).json({
    success: true,
    message,
    user: user?.toJSON?.() ?? user,
    ...(tokens ? { tokens } : {}),
  });

/**
 * POST /auth/signup
 * Creates a new account and sends an email verification OTP.
 */
export const signup = async (req, res) => {
  try {
    const { name, email, phone, password, position } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists',
      });
    }

    const user = await User.create({
      name,
      email,
      phone,
      password,
      position: position || null,
      role: 'school_admin',
      status: 'active',
      isEmailVerified: false,
    });

    const otp = generateEmailOtp();
    user.emailVerificationToken = hashToken(otp);
    user.emailVerificationExpires = emailOtpExpiry();
    await user.save();

    const { subject, html } = verificationEmail({
      name: user.name,
      otp,
      expiresInMinutes: EMAIL_OTP_EXPIRE_MINUTES,
    });

    try {
      await sendEmail({ to: user.email, toName: user.name, subject, html });
    } catch (error) {
      console.error('Verification email failed:', error.message);
      return res.status(502).json({
        success: false,
        message: 'Account created but the verification email could not be sent. Please resend it.',
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Account created successfully. A verification code has been sent to your email.',
      user: user.toJSON(),
      verification: {
        expiresInMinutes: EMAIL_OTP_EXPIRE_MINUTES,
        verifyUrl: `${CLIENT_URL}/verify-email/${otp}`,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * POST /auth/login
 */
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    if (user.deletedAt) {
      return res.status(401).json({ success: false, message: 'Account no longer exists' });
    }

    if (user.status === 'suspended' || user.status === 'deactivated') {
      return res.status(403).json({ success: false, message: 'This account is not active' });
    }

    if (!user.isEmailVerified) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email address before signing in',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    user.lastLoginAt = new Date();
    if (user.status === 'invited') user.status = 'active';

    const tokens = await issueSession(user);
    return sendAuthResponse(res, 200, 'Signed in successfully', user, tokens);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * POST /auth/logout
 * Invalidates the current session (and every token previously issued to the user).
 */
export const logout = async (req, res) => {
  try {
    const user = req.user;
    user.refreshToken = null;
    user.refreshTokenExpires = null;
    user.tokenVersion += 1;
    await user.save();

    return res.status(200).json({ success: true, message: 'Signed out successfully' });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * POST /auth/refresh
 */
export const refresh = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    const payload = verifyToken(refreshToken, 'refresh');
    const user = await User.findById(payload.sub).select('+refreshToken');

    if (!user || user.deletedAt) {
      return res.status(401).json({ success: false, message: 'Account no longer exists' });
    }

    // A suspended or deactivated account must not be able to mint fresh access
    // tokens from a refresh token that has not yet expired.
    if (user.status === 'suspended' || user.status === 'deactivated') {
      return res.status(403).json({ success: false, message: 'This account is not active' });
    }

    if (!safeCompare(user.refreshToken, hashToken(refreshToken))) {
      return res.status(401).json({ success: false, message: 'Session has been revoked' });
    }

    if (payload.tokenVersion !== user.tokenVersion) {
      return res.status(401).json({ success: false, message: 'Session has been revoked' });
    }

    if (user.refreshTokenExpires && user.refreshTokenExpires < new Date()) {
      return res.status(401).json({ success: false, message: 'Session has expired' });
    }

    const tokens = await issueSession(user);
    return sendAuthResponse(res, 200, 'Token refreshed successfully', user, tokens);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * POST /auth/forgot-password
 * Always responds the same way so accounts cannot be enumerated.
 */
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email, deletedAt: null });

    if (user) {
      const token = generateResetToken();
      user.passwordResetToken = hashToken(token);
      user.passwordResetExpires = passwordResetExpiry();
      await user.save();

      const { subject, html } = passwordResetEmail({
        name: user.name,
        token,
        expiresInMinutes: PASSWORD_RESET_EXPIRE_MINUTES,
      });

      try {
        await sendEmail({ to: user.email, toName: user.name, subject, html });
      } catch (error) {
        console.error('Password reset email failed:', error.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'If an account exists for that email, a password reset link has been sent.',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * POST /auth/reset-password/:token
 */
export const resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    const user = await User.findOne({
      passwordResetToken: hashToken(token),
      passwordResetExpires: { $gt: new Date() },
    }).select('+passwordResetToken +passwordResetExpires');

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'This password reset link is invalid or has expired',
      });
    }

    user.password = password;
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    user.refreshToken = null;
    user.refreshTokenExpires = null;
    user.tokenVersion += 1;
    await user.save();

    try {
      const { subject, html } = passwordChangedEmail({ name: user.name });
      await sendEmail({ to: user.email, toName: user.name, subject, html });
    } catch (error) {
      console.error('Password change confirmation email failed:', error.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Password reset successfully. Please sign in with your new password.',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * POST /auth/verify-email/:token
 * The token is the OTP delivered by email.
 */
export const verifyEmail = async (req, res) => {
  try {
    const { token } = req.params;

    const user = await User.findOne({
      emailVerificationToken: hashToken(token),
    }).select('+emailVerificationToken +emailVerificationExpires');

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'This verification code is invalid',
        code: 'INVALID_OTP',
      });
    }

    if (user.isEmailVerified) {
      return res.status(409).json({ success: false, message: 'Email address is already verified' });
    }

    if (!user.isEmailVerificationTokenValid()) {
      return res.status(400).json({
        success: false,
        message: 'This verification code has expired',
        code: 'OTP_EXPIRED',
      });
    }

    user.isEmailVerified = true;
    user.emailVerifiedAt = new Date();
    user.emailVerificationToken = null;
    user.emailVerificationExpires = null;
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'Email address verified successfully. You can now sign in.',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * GET /auth/me
 * Lets a client restore its session from an access token alone. The
 * `authenticate` middleware has already loaded the live user, so this only
 * reports it.
 */
export const me = async (req, res) => {
  return res.status(200).json({
    success: true,
    message: 'Current user retrieved',
    user: req.user.toJSON(),
  });
};

/**
 * POST /auth/resend-verification
 */
export const resendVerification = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email, deletedAt: null });

    const neutralResponse = res.status(200).json({
      success: true,
      message: 'If the account exists and is unverified, a new code has been sent.',
    });

    if (!user || user.isEmailVerified) return neutralResponse;

    const otp = generateEmailOtp();
    user.emailVerificationToken = hashToken(otp);
    user.emailVerificationExpires = emailOtpExpiry();
    await user.save();

    const { subject, html } = verificationEmail({
      name: user.name,
      otp,
      expiresInMinutes: EMAIL_OTP_EXPIRE_MINUTES,
    });

    try {
      await sendEmail({ to: user.email, toName: user.name, subject, html });
    } catch (error) {
      console.error('Verification email failed:', error.message);
    }

    return neutralResponse;
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
