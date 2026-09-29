import { Router } from 'express';
import {
  inviteUser,
  listUsers,
  getUser,
  updateUser,
  changeUserRole,
  deleteUser,
} from '../controllers/userController.js';
import { authenticate, authorize } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import {
  inviteUserSchema,
  updateUserSchema,
  updateUserRoleSchema,
} from '../validators/userValidators.js';

export const userRoute = Router();

userRoute.post(
  '/users/invite',
  authenticate,
  authorize('super_admin', 'school_admin'),
  validate(inviteUserSchema),
  inviteUser
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
