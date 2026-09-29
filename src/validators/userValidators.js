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
}).min(1);

export const updateUserRoleSchema = Joi.object({
  role: Joi.string().valid(...validRoles).required(),
});
