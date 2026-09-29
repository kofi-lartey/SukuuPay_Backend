import Joi from 'joi';

const password = Joi.string()
  .min(8)
  .max(128)
  .pattern(/[a-zA-Z]/)
  .pattern(/\d/)
  .required()
  .messages({
    'string.pattern.base': 'Password must contain at least one letter and one number',
  });

const email = Joi.string().email().lowercase().trim().required();

export const signupSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  email,
  phone: Joi.string().trim().min(7).max(20).required(),
  password,
  position: Joi.string().trim().max(80).allow('').optional(),
});

export const loginSchema = Joi.object({
  email,
  password: Joi.string().required(),
});

export const refreshSchema = Joi.object({
  refreshToken: Joi.string().required(),
});

export const forgotPasswordSchema = Joi.object({
  email,
});

export const resendVerificationSchema = Joi.object({
  email,
});

export const paramsTokenSchema = Joi.object({
  token: Joi.string().trim().min(6).required(),
});

export const resetPasswordParamsSchema = Joi.object({
  token: Joi.string().trim().min(6).required(),
});

// The token travels in the URL, the new password in the body.
export const resetPasswordSchema = Joi.object({
  password,
});
