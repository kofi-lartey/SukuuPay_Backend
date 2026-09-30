import Joi from 'joi';

const validRoles = ['super_admin', 'school_admin', 'accountant', 'teacher', 'viewer'];

const baseUserFields = {
  name: Joi.string().trim().min(2).max(100).required(),
  email: Joi.string().email().lowercase().trim().required(),
  phone: Joi.string().trim().min(7).max(20).required(),
  position: Joi.string().trim().max(80).allow('').optional(),
};

export const inviteUserSchema = Joi.object({
  ...baseUserFields,
  role: Joi.string()
    .valid(...validRoles)
    .default('teacher'),
  schoolId: Joi.string().optional(),
});

export const updateUserSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).optional(),
  email: Joi.string().email().lowercase().trim().optional(),
  role: Joi.string().valid(...validRoles).optional(),
  position: Joi.string().trim().max(80).allow('').optional(),
  phone: Joi.string().trim().min(7).max(20).optional(),
  /**
   * Wizard progress.
   *
   * These were previously absent, so `stripUnknown` deleted them and
   * `AuthContext.markOnboardingComplete`'s `updateMe` call silently did nothing
   * — the durable record of a finished wizard was a localStorage flag that could
   * not follow the bursar to another device. With self-service provisioning that
   * stopped being cosmetic: re-running Step 1 on a second device meant
   * re-creating a school.
   */
  onboardingCompleted: Joi.boolean().optional(),
  onboardingHighestStep: Joi.number().integer().min(0).max(3).optional(),
}).min(1);


export const updateUserRoleSchema = Joi.object({
  role: Joi.string().valid(...validRoles).required(),
});
