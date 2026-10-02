import Joi from 'joi';
import { ASSIGNABLE_ROLES } from '../validators/userValidators.js';
import { USER_ROLES } from '../config/constants.js';

/**
 * Joi schemas for the platform console's per-user writes.
 *
 * **The single most important line in this file is the import of
 * `ASSIGNABLE_ROLES`.** That list is the enforcement of the one-platform-owner rule
 * — it has four entries where the model's enum has five, and `super_admin` is
 * missing on purpose. Importing it rather than restating it here is what stops this
 * schema from becoming a *fourth* place where somebody later "helpfully" adds
 * `super_admin` back, and a fourth place is one that no test in
 * `tests/platformOwner.test.js` covers.
 *
 * The refusals themselves live in the service, not here, and that split is worth
 * stating because it looks inconsistent: a role change schema that cannot express
 * `super_admin` produces a 422, while the service also throws a 403 for the same
 * value. Both exist for the same reason they do in `userController`
 * (`resolveInvitableRole`, `changeUserRole`): the schema is the load-bearing half —
 * it closes the route for everyone, including a caller who reaches the service
 * through a route that forgot the middleware — and the service half is what makes
 * the refusal *legible*, naming `PLATFORM_ROLE_NOT_GRANTABLE` and explaining the
 * rule instead of leaving a field-level validation error to be interpreted.
 */

/** Route params. A literal 24-hex pattern, so the 422 names the format. */
export const userIdParamSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({ 'string.pattern.base': 'Invalid user ID format' }),
});

/**
 * `GET /admin/users` — the console's cross-tenant user table.
 *
 * `role` accepts all five model roles, including `super_admin`, because this is a
 * *filter* rather than a grant: the operator needs to find the platform accounts,
 * and there is one of them. The grantable set is `ASSIGNABLE_ROLES`, below, and the
 * two lists are different on purpose.
 *
 * `schoolId` is a string pattern rather than an ObjectId check — Joi has no Mongo
 * dependency, and the service converts it (and raises the 400 if it is not a
 * valid id).
 */
export const listAdminUsersQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  // Capped at 200 to match `MAX_PER_PAGE` in `utils/platformQuery.js`. The service
  // clamps anyway; the schema bound means the caller is told the ceiling in the
  // response to the request that asked for more, rather than silently receiving
  // fewer rows than it asked for.
  perPage: Joi.number().integer().min(1).max(200).default(20),
  role: Joi.string().valid(...USER_ROLES),
  status: Joi.string().valid('active', 'invited', 'suspended', 'deactivated'),
  schoolId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/),
  search: Joi.string().trim().max(120).allow('').optional(),
  sortBy: Joi.string()
    .valid('createdAt', 'updatedAt', 'name', 'role', 'status', 'lastLoginAt')
    .default('createdAt'),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
});

/**
 * `PUT /admin/users/:id/role`
 *
 * `.valid(...ASSIGNABLE_ROLES)`. There is no `super_admin` in this list and that is
 * not an oversight — see the module header. It is the same list the invite flow and
 * the school-scoped role change use, so all three role-write paths in the product
 * agree by construction rather than by three matching hand-edits.
 */
export const updateUserRoleAsPlatformSchema = Joi.object({
  role: Joi.string().valid(...ASSIGNABLE_ROLES).required(),
});

/**
 * `PUT /admin/users/:id/status`
 *
 * `active | suspended | deactivated` — **three of the model's four statuses.**
 * `invited` is the fourth and is deliberately excluded: it is written by the
 * invitation flow to mean "credentials have been sent, the account has never been
 * used", and the platform owner should not be able to manufacture that state. An
 * account put into `invited` by hand has never been emailed anything, cannot sign
 * in (`authenticate` refuses anything that is not `active`), and looks in a list
 * exactly like a pending invitation that somebody forgot about.
 *
 * `deactivated` is kept distinct from `suspended` rather than collapsed into it,
 * because they mean different things to a school and a reader of its activity log:
 * suspended is a consequence ("they have not paid"), deactivated is an
 * administrative end ("that staff member has left"). Collapsing them would lose the
 * distinction at exactly the point somebody is trying to establish it.
 */
export const updateUserStatusAsPlatformSchema = Joi.object({
  status: Joi.string().valid('active', 'suspended', 'deactivated').required(),
});

/**
 * Neither credential endpoint takes a body, and no schema is exported for them.
 *
 * `resetUserPasswordAsPlatform` mints a token and mails it; there is nothing for a
 * caller to choose. `resendUserVerificationAsPlatform` issues an OTP. Declaring an
 * empty body schema for them would be theatre, and an empty-object schema with
 * `stripUnknown: true` accepts *every* body while stripping it, which is the one
 * combination that looks like validation and is not. Both handlers read
 * `req.body?.x` defensively and `middleware/validate.js` already normalises a
 * missing body to `{}`, so the routes can be wired with no `validate` at all.
 *
 * `ASSIGNABLE_ROLES` is re-exported so the route table can be written against one
 * import from this file, and so a reader checking "can this endpoint grant a
 * platform owner?" finds the answer next to the schemas rather than two files away.
 */
export { ASSIGNABLE_ROLES };