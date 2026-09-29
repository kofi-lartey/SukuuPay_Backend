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
} from '../controllers/authController.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
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
authRoute.post('/auth/logout', authenticate, logout);
authRoute.post('/auth/refresh', validate(refreshSchema), refresh);
authRoute.post('/auth/forgot-password', emailLimiter, validate(forgotPasswordSchema), forgotPassword);
authRoute.post('/auth/reset-password/:token', otpLimiter, validate(resetPasswordParamsSchema, 'params'), validate(resetPasswordSchema), resetPassword);
authRoute.post('/auth/verify-email/:token', otpLimiter, validate(paramsTokenSchema, 'params'), verifyEmail);
authRoute.post('/auth/resend-verification', emailLimiter, validate(resendVerificationSchema), resendVerification);
