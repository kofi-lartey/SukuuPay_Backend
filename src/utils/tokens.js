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

/**
 * How long an impersonation token is good for.
 *
 * Sixty minutes, and it is a hard ceiling rather than a hint. The token is what
 * carries the impersonated school to the server between `POST /admin/impersonate`
 * and the refresh that would normally renew it, so an operator who abandons a tab
 * leaves behind a credential that keeps working until it expires. An hour is long
 * enough to reproduce a payment flow with a school on the phone and short enough
 * that the abandoned case self-heals without anybody having to think about it.
 *
 * Deliberately *not* the value `JWT_EXPIRE` holds: a support session should not be
 * able to hold a door open for the life of an ordinary login.
 */
export const IMPERSONATION_TOKEN_EXPIRE_MINUTES = 60;

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

/**
 * The access token used *while* impersonating a school.
 *
 * Signed with the impersonated school and session in the payload so that a request
 * arriving with it is self-describing, and short-lived
 * (`IMPERSONATION_TOKEN_EXPIRE_MINUTES`) so a forgotten tab cannot hold a door
 * open indefinitely.
 *
 * The payload is a **hint, never the authority**. `middleware/impersonation.js`
 * re-reads the open session from the database on every request and refuses the call
 * if the session has been ended — so ending an impersonation takes effect for every
 * token already in circulation, not merely for the client that asked to end it.
 * That is the difference between "the owner stopped impersonating" and "the owner
 * closed one tab", and the second is not a security boundary.
 *
 * `imp: true` marks the token so a client cannot pass one of these to an endpoint
 * that wants a real session, and `tokenVersion` is carried through unchanged so the
 * normal revocation check in `authenticate` still applies to it.
 */
export const signImpersonationToken = (user, schoolId, sessionId) =>
  jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
      schoolId: user.schoolId ? user.schoolId.toString() : null,
      // What the request is *acting as*, for a super admin whose own `schoolId` is
      // null by design. Never conflated with `schoolId` above: that one is who
      // they are, this one is what they are currently looking at.
      impersonatedSchoolId: schoolId.toString(),
      impersonationSessionId: sessionId.toString(),
      imp: true,
      type: 'access',
      tokenVersion: user.tokenVersion,
    },
    SECRET,
    { expiresIn: `${IMPERSONATION_TOKEN_EXPIRE_MINUTES}m` }
  );

/** 6 digit numeric OTP, cryptographically random. */
export const generateEmailOtp = () =>
  String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/** URL safe random token used for password reset links. */
export const generateResetToken = () => crypto.randomBytes(32).toString('hex');

export const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * A pay token reduced to the first 16 hex characters of its SHA-256 digest.
 *
 * Every parent-portal read is audited, and the audit has to name *which link*
 * was used — otherwise "who looked at this student's attendance" is unanswerable.
 * The token itself is the credential for that student's whole fee history, so it
 * is hashed first and never stored in full. Sixteen hex characters is
 * 2^64 of keyspace: more than enough to correlate a term's worth of reads from
 * one family, and not enough to recover a token whose space is
 * `STU-` + 8 hex characters.
 *
 * Lives beside `hashToken` rather than beside the parent services, because the
 * rule it enforces is about *tokens*, not about attendance.
 */
export const hashTokenForLog = (value) => hashToken(String(value || '')).slice(0, 16);

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
