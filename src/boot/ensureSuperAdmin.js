import { SUPER_ADMIN_EMAIL, SUPER_ADMIN_NAME, SUPER_ADMIN_PASSWORD } from '../config/env.js';
import { User } from '../models/userModel.js';

/**
 * Provision — and re-provision — the single platform owner.
 *
 * **The rule: exactly one `super_admin` exists, and it is the account named by
 * `SUPER_ADMIN_EMAIL`.** It is created from `SUPER_ADMIN_PASSWORD` at boot and is
 * never assignable through the API (`validators/userValidators.js`
 * `ASSIGNABLE_ROLES` excludes `super_admin`, and the two controllers that write a
 * role refuse it again).
 *
 * This is a **reconcile, not a create-if-absent**, and the difference is the whole
 * design. Three states have to converge on the same single owner:
 *
 *   1. no owner — the account is created;
 *   2. the owner exists under the configured email — reconciled in place;
 *   3. **other accounts hold `super_admin`** — demoted, because leaving them is how
 *      "only one super admin" silently becomes four.
 *
 * State 3 is not hypothetical. This database has carried an
 * `admin@example.com` super_admin that was a real, documented login, and
 * `changeUserRole` allowed any super_admin to promote anyone — so a promote here,
 * a revoke there, and the collection can hold more than one at any time.
 *
 * The reconcile is also the **recovery path**. `changeUserRole` can demote the only
 * super_admin, and doing so locks the platform out of every `authorize("super_admin")`
 * route — `/api/admin/*`, plus school creation, stamping, suspend and archive — with
 * no in-product way back in. Because the owner is re-derived from the environment
 * on every boot, redeploying restores it. That is why the owner cannot be a role
 * anyone else holds.
 *
 * Two details that are load-bearing rather than cosmetic:
 *
 *   - **`schoolId: null`.** Platform staff belong to no school; ~15 services branch
 *     on that, and `utils/accountLink.js` reports them as `PLATFORM_STAFF`. An owner
 *     with a school would be redirected into the onboarding wizard and refused at
 *     every platform route.
 *   - **`tokenVersion += 1` on any demotion.** A demoted account keeps its JWT until
 *     the version changes. Without the bump, a "former platform admin" keeps full
 *     access until their token expires, which defeats the demotion entirely.
 *
 * The password is written through `save()` rather than `updateOne` on purpose: the
 * model's `pre('save')` hook is what bcrypts it (`userModel.js:264-270`). A raw
 * `$set` would store the plaintext and the owner could not log in.
 *
 * **Fatal on failure.** `index.js` exits non-zero if this throws, matching how it
 * treats a failed database connection: a deployment with a listening port and no
 * platform owner is a service that looks healthy and answers 403 to its own
 * operator.
 */
export const ensureSuperAdmin = async () => {
  const missing = [];
  if (!SUPER_ADMIN_EMAIL) missing.push('SUPER_ADMIN_EMAIL');
  if (!SUPER_ADMIN_PASSWORD) missing.push('SUPER_ADMIN_PASSWORD');

  if (missing.length) {
    // Never log the value — and never log *which* is wrong in a way that could be
    // mistaken for the value. Names only.
    throw new Error(
      `Platform owner is not configured: ${missing.join(' and ')} must be set in the environment. ` +
        'Without them there is no account that can reach /api/admin, and no in-product way to create one.'
    );
  }

  const owner = await User.findOne({ email: SUPER_ADMIN_EMAIL });

  // ── Create ────────────────────────────────────────────────────────────────
  if (!owner) {
    const created = await User.create({
      name: SUPER_ADMIN_NAME || 'Platform Operations',
      email: SUPER_ADMIN_EMAIL,
      password: SUPER_ADMIN_PASSWORD,
      role: 'super_admin',
      // Null is the platform-staff convention, not a missing value. See above.
      schoolId: null,
      // `status` defaults to `'invited'` on the model and `authenticate` refuses
      // anything that is not `'active'` — so an owner created without this would
      // exist, appear in the users list, and fail every login with a 401 that
      // reads like a bad password.
      status: 'active',
      isEmailVerified: true,
      isPlatformOwner: true,
      // An env-provisioned account has no invite to accept and no ceremony to
      // walk through; forcing a password change would lock the operator out on
      // every login until they found this file and read it.
      mustChangePassword: false,
      onboardingCompleted: true,
    });

    console.log(
      `[platform-owner] provisioned ${created.email} from the environment (schoolId: null, status: active)`
    );
    return { action: 'created', email: created.email, id: created._id, demoted: 0 };
  }

  // ── Reconcile in place ────────────────────────────────────────────────────
  // Field by field, and only when it differs. Writing unconditionally would reset
  // `passwordChangedAt` on every boot via the pre-save hook, and would re-verify
  // or re-activate an owner an operator had deliberately suspended.
  let touched = false;

  if (owner.role !== 'super_admin') {
    owner.role = 'super_admin';
    touched = true;
  }
  if (owner.schoolId) {
    owner.schoolId = null;
    touched = true;
  }
  if (owner.status !== 'active') {
    owner.status = 'active';
    touched = true;
  }
  if (owner.isEmailVerified !== true) {
    owner.isEmailVerified = true;
    touched = true;
  }
  if (owner.isPlatformOwner !== true) {
    owner.isPlatformOwner = true;
    touched = true;
  }
  if (owner.deletedAt) {
    // `email` is `unique` and *not* sparse, so a soft-deleted account keeps the
    // address occupied forever. The owner has to be revived in place; creating a
    // replacement would collide on the index.
    owner.deletedAt = null;
    owner.tokenVersion += 1;
    touched = true;
  }

  if (touched) await owner.save();

  // ── Demote every other super_admin ────────────────────────────────────────
  //
  // The half that makes the invariant true rather than aspirational. Query is
  // `_id: { $ne: owner._id }` so the owner is excluded by identity, not by email —
  // an owner whose address changed is still the same account.
  const others = await User.find({
    role: 'super_admin',
    _id: { $ne: owner._id },
  });

  for (const other of others) {
    // Which role they land on: the first role they are allowed to hold. `viewer` is
    // the least-privilege fallback, and an account that has lost platform
    // authority should not silently gain school-admin authority over a school it
    // has no relationship with. A platform admin with no school and no viewers'
    // remit can still read their own profile and sign out, which is the correct
    // state for an account that should not be operating the platform.
    other.role = 'viewer';
    other.isPlatformOwner = false;
    // Revokes every token already issued to that account, immediately. Without
    // this a demoted super_admin keeps platform access until their token expires,
    // which is the entire reason for demoting them.
    other.tokenVersion += 1;
    await other.save();

    console.warn(
      `[platform-owner] demoted ${other.email} from super_admin to viewer ` +
        '(tokenVersion bumped, existing sessions revoked). Only the account named by ' +
        'SUPER_ADMIN_EMAIL may hold the platform role.'
    );
  }

  const summary = {
    action: others.length ? 'demoted-others' : touched ? 'reconciled' : 'unchanged',
    email: owner.email,
    id: owner._id,
    demoted: others.length,
  };

  console.log(
    `[platform-owner] ${summary.action}: ${summary.email} (${others.length} other super_admin account(s) demoted)`
  );

  return summary;
};

/**
 * Whether a role change is allowed to *leave* an account as the platform owner.
 *
 * Exported so the controllers and the tests ask the same question. Revoking the
 * owner is not forbidden by this rule — the boot reconcile deliberately restores
 * it, so the platform cannot be bricked by one careless request — but the caller
 * has to be told what they just did.
 */
export const revokesPlatformOwner = (currentRole, nextRole) =>
  currentRole === 'super_admin' && nextRole !== 'super_admin';

export default ensureSuperAdmin;