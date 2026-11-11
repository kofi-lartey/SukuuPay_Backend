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

/**
 * Roles a user may claim for themselves at signup.
 *
 * A strict subset of the User model's role enum, and the exclusion is the point:
 * `super_admin` is a platform operator with no school, and letting an anonymous
 * form field mint one would be a complete compromise of the platform. The client
 * constrains the same list in `SIGNUP_ROLES`, but that is convenience — this is
 * the control, and it must not trust the request.
 */
export const SELF_SIGNUP_ROLES = ["school_admin", "accountant", "teacher"];

export const signupSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  email,
  phone: Joi.string().trim().min(7).max(20).required(),
  password,
  /**
   * Job title. An unconstrained string rather than an enum: schools have titles
   * no fixed list anticipates, and forcing a bursar into a wrong one to get their
   * own job recorded is worse than a free-text field. The UI offers a curated
   * list with an "Other" escape, but the stored value is whatever they typed.
   */
  position: Joi.string().trim().max(80).allow("").optional(),
  role: Joi.string().valid(...SELF_SIGNUP_ROLES).default("school_admin"),

  /**
   * What the bursar typed about their school on the signup form.
   *
   * This key was missing, and the shared `validate` middleware runs Joi with
   * `stripUnknown: true` — so the nested object was silently deleted from the
   * request before the controller ever saw it. Signup asked for a school name,
   * classification and region, discarded all three, created an account with
   * `schoolId: null`, and left the user to discover that in Step 1 of
   * onboarding, where the correct action was never implemented.
   *
   * Kept as an *intent* rather than a School: the address is not yet verified,
   * so creating a real School here would let anyone register a school with a
   * throwaway inbox. `authController.signup` writes it to `User.schoolIntent`,
   * which `POST /schools/me` later turns into a real School.
   */
  school: Joi.object({
    name: Joi.string().trim().min(2).max(150).optional(),
    // Accepts the signup classification *and* a raw `School.type`; the mapping
    // to the enum happens at provisioning time, not here.
    classification: Joi.string().trim().max(40).allow('').optional(),
    region: Joi.string().trim().max(40).allow('').optional(),
  })
    .unknown(false)
    .optional(),
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
