import Joi from 'joi';

const validRoles = ['super_admin', 'school_admin', 'accountant', 'teacher', 'viewer'];

/**
 * Roles a School Admin may hand out when inviting.
 *
 * The hard rule is `super_admin`, which is never delegable — a school admin who
 * can mint one can mint themselves a peer with strictly more power than the
 * school's own governance allows, and no audit of *that* action would exist.
 * `changeUserRole` and `signup` both enforce the same exclusion
 * (`SELF_SIGNUP_ROLES`); the invite path did not, which made it the one door
 * into the platform-admin tier that skipped the check entirely.
 *
 * `school_admin` *is* delegable. A headmaster bringing in a deputy head is
 * ordinary and expected, and refusing it would push schools toward sharing one
 * login, which is strictly worse: it destroys per-user attribution in exactly
 * the audit log this module exists to populate.
 */
export const INVITABLE_BY_SCHOOL_ADMIN = ['school_admin', 'accountant', 'teacher', 'viewer'];

const baseUserFields = {
  name: Joi.string().trim().min(2).max(100).required(),
  email: Joi.string().email().lowercase().trim().required(),
  phone: Joi.string().trim().min(7).max(20).allow('').optional(),
  position: Joi.string().trim().max(80).allow('').optional(),
};

/**
 * `POST /users/invite`
 *
 * Only `name` and `email` are required, per the product requirement: a school
 * admin inviting a colleague knows their name and their work address and
 * usually nothing else reliable. `role` defaults to `teacher` because that is
 * both the safest grant and the overwhelming majority of what a school invites.
 *
 * `schoolId` is accepted for `super_admin` only; the controller silently forces
 * it to the caller's own school for everyone else. It is declared rather than
 * stripped so the intent is visible in one place, but the schema cannot enforce
 * the rule — it has no view of who is calling.
 */
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
