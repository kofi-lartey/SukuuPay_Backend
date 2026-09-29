import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import {
  SECRET,
  JWT_EXPIRE,
  REFRESH_TOKEN_EXPIRE,
  EMAIL_OTP_EXPIRE_MINUTES,
  PASSWORD_RESET_EXPIRE_MINUTES,
} from '../config/env.js';

export const signAccessToken = (user) =>
  jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
      schoolId: user.schoolId ? user.schoolId.toString() : null,
      type: 'access',
      tokenVersion: user.tokenVersion,
    },
    SECRET,
    { expiresIn: JWT_EXPIRE }
  );

export const signRefreshToken = (user, tokenVersion) =>
  jwt.sign(
    {
      sub: user._id.toString(),
      type: 'refresh',
      tokenVersion,
      // Unique per issue so rotation always produces a distinct token and
      // the previous one can be revoked.
      jti: crypto.randomUUID(),
    },
    SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRE }
  );

export const verifyToken = (token, expectedType) => {
  const payload = jwt.verify(token, SECRET);
  if (expectedType && payload.type !== expectedType) {
    throw new jwt.JsonWebTokenError('Invalid token type');
  }
  return payload;
};

/** 6 digit numeric OTP, cryptographically random. */
export const generateEmailOtp = () =>
  String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/** URL safe random token used for password reset links. */
export const generateResetToken = () => crypto.randomBytes(32).toString('hex');

export const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Constant-time comparison of two hex digests. */
export const safeCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/** Converts a duration string such as "15m", "7d", "900" (seconds) into milliseconds. */
export const durationToMs = (value) => {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(String(value).trim());
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2] || 's';
  const factors = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * factors[unit];
};

export const emailOtpExpiry = () =>
  new Date(Date.now() + EMAIL_OTP_EXPIRE_MINUTES * 60 * 1000);

export const passwordResetExpiry = () =>
  new Date(Date.now() + PASSWORD_RESET_EXPIRE_MINUTES * 60 * 1000);

/** Issues an access/refresh pair and stores the hashed refresh token on the user. */
export const issueSession = async (user) => {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user, user.tokenVersion);
  user.refreshToken = hashToken(refreshToken);
  user.refreshTokenExpires = new Date(Date.now() + durationToMs(REFRESH_TOKEN_EXPIRE));
  await user.save();
  return { accessToken, refreshToken };
};
