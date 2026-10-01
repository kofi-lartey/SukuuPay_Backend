import { Router } from 'express';
import {
  inviteUser,
  resendUserInvite,
  listUsers,
  getUser,
  updateUser,
  changeUserRole,
  deleteUser,
} from '../controllers/userController.js';
import { authenticate, authorize } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { INVITE_RATE_LIMIT_PER_HOUR } from '../config/env.js';
import {
  inviteUserSchema,
  updateUserSchema,
  updateUserRoleSchema,
} from '../validators/userValidators.js';

export const userRoute = Router();

/**
 * Ceiling on invitations, keyed on the calling admin rather than the IP.
 *
 * `keyBy: 'user'` is the load-bearing option and the reason this cannot just
 * reuse the anonymous `emailLimiter` from authRoutes. That limiter guards
 * signup and password reset, whose threat is one host hammering the OTP mailer,
 * so keying on IP is right there. This endpoint's threat is different: an invite
 * mints a working credential and emails it, so the risk is a hijacked admin
 * session used as a mail cannon pointed at an arbitrary address list. IP keying
 * would also be wrong in the ordinary case — a whole school office behind one
 * NAT address would share a single allowance and throttle each other.
 *
 * `resend-invite` shares the limiter deliberately. Re-sending is the recovery
 * path for a failed invitation, so it must not be an unlimited retry channel
 * around the ceiling that `invite` enforces.
 */
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: INVITE_RATE_LIMIT_PER_HOUR,
  keyBy: 'user',
  message: 'Too many invitations sent. Try again later.',
});

userRoute.post(
  '/users/invite',
  authenticate,
  authorize('super_admin', 'school_admin'),
  inviteLimiter,
  validate(inviteUserSchema),
  inviteUser
);

userRoute.post(
  '/users/:userId/resend-invite',
  authenticate,
  authorize('super_admin', 'school_admin'),
  inviteLimiter,
  resendUserInvite
);

userRoute.get('/users', authenticate, listUsers);

userRoute.get('/users/:userId', authenticate, getUser);

userRoute.put(
  '/users/:userId',
  authenticate,
  validate(updateUserSchema),
  updateUser
);

userRoute.put(
  '/users/:userId/role',
  authenticate,
  authorize('super_admin', 'school_admin'),
  validate(updateUserRoleSchema),
  changeUserRole
);

userRoute.delete(
  '/users/:userId',
  authenticate,
  authorize('super_admin', 'school_admin'),
  deleteUser
);
