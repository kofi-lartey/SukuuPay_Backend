import { Router } from 'express';
import {
  signup,
  login,
  logout,
  refresh,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
  me,
} from '../controllers/authController.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { googleAuthConfig, googleLogin } from '../controllers/googleAuth.controller.js';
import { googleLoginSchema } from '../validators/googleAuthValidators.js';
import {
  signupSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resendVerificationSchema,
  paramsTokenSchema,
  resetPasswordParamsSchema,
  resetPasswordSchema,
} from '../validators/authValidators.js';

export const authRoute = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const emailLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });

authRoute.post('/auth/signup', loginLimiter, validate(signupSchema), signup);
authRoute.post('/auth/login', loginLimiter, validate(loginSchema), login);

/**
 * Google Sign-In.
 *
 * **`loginLimiter`, not `otpLimiter`**, despite this endpoint being the one that
 * *skips* the OTP step. The limiter is about the request, not the credential: this
 * accepts an unauthenticated assertion of identity, and ten per fifteen minutes per IP
 * is the same budget the password form gets. A higher ceiling "because it skips a
 * step" would be reasoning about the wrong thing.
 *
 * **`GET /auth/google/config` is deliberately unauthenticated and unthrottled.** It
 * reveals only whether the deployment has `GOOGLE_CLIENT_ID` set, which is a build
 * property the client needs before anyone can press a button — and the response is
 * identical for everyone, so there is nothing to enumerate.
 */
authRoute.get('/auth/google/config', googleAuthConfig);
authRoute.post('/auth/google', loginLimiter, validate(googleLoginSchema), googleLogin);

authRoute.post('/auth/logout', authenticate, logout);
authRoute.post('/auth/refresh', validate(refreshSchema), refresh);
authRoute.post('/auth/forgot-password', emailLimiter, validate(forgotPasswordSchema), forgotPassword);
authRoute.post('/auth/reset-password/:token', otpLimiter, validate(resetPasswordParamsSchema, 'params'), validate(resetPasswordSchema), resetPassword);
authRoute.post('/auth/verify-email/:token', otpLimiter, validate(paramsTokenSchema, 'params'), verifyEmail);
authRoute.post('/auth/resend-verification', emailLimiter, validate(resendVerificationSchema), resendVerification);
authRoute.get('/auth/me', authenticate, me);
