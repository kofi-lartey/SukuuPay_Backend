import { User } from '../models/userModel.js';
import { School } from '../models/schoolModel.js';
import { sendEmail } from '../services/emailService.js';
import { invitationEmail } from '../templates/emails.js';
import { CLIENT_URL } from '../config/env.js';
import { AUDIT_ACTIONS, SCHOOL_JOIN_ROLES } from '../config/constants.js';
import { logRequest as auditLog } from '../utils/auditService.js';
import { createNotification } from '../services/notification.service.js';
import { generateDefaultPassword } from '../utils/defaultPassword.js';
import { INVITABLE_BY_SCHOOL_ADMIN } from '../validators/userValidators.js';

const sameSchoolOrAdmin = (requester, target) => {
  if (requester.role === 'super_admin') return true;
  return Boolean(target.schoolId) &&
    Boolean(requester.schoolId) &&
    target.schoolId.toString() === requester.schoolId.toString();
};

/**
 * Resolves which school a new account belongs to, and loads it.
 *
 * The School document is needed rather than just its id, because the default
 * password is derived from `schoolCode` and the invitation email names the
 * school. Two failure modes are separated deliberately, because they mean
 * different things to the admin reading the error:
 *
 *   - no school at all      → 403, the caller is not in a position to invite
 *   - schoolId points nowhere → 404, it is a data problem, not a permissions one
 *
 * A `super_admin` may target any school by passing `schoolId`; for everyone else
 * the field is ignored rather than rejected, matching `listUsers`, so a client
 * that echoes the current school id does not break on a 422.
 */
const resolveTargetSchool = async (requester, requestedSchoolId) => {
  const targetSchoolId =
    requester.role === 'super_admin' ? requestedSchoolId || requester.schoolId : requester.schoolId;

  if (!targetSchoolId) {
    return { error: { status: 403, message: 'Your account is not linked to a school yet', code: 'NO_SCHOOL' } };
  }

  const school = await School.findOne({ _id: targetSchoolId, deletedAt: null }).select('name schoolCode');
  if (!school) {
    return { error: { status: 404, message: 'School not found', code: 'SCHOOL_NOT_FOUND' } };
  }

  return { school };
};

/**
 * Which role the invited account may be granted.
 *
 * A `school_admin` is confined to `INVITABLE_BY_SCHOOL_ADMIN`. The load-bearing
 * case is `super_admin`: it is a platform-operator tier, and letting anybody mint
 * one means one compromised session is enough to create an account that is outside
 * every school's boundary entirely — able to read any school's data and, worse,
 * invisible in the audit logs of the schools it touched.
 *
 * There is exactly one platform owner and it is provisioned from the environment
 * (`boot/ensureSuperAdmin.js`), so `super_admin` is not a grantable role at all and
 * this refuses it **before** the caller's own privilege is considered. The first
 * line used to be an unconditional pass-through for a caller who was already a
 * `super_admin`, which made this the one endpoint that could produce a second
 * platform owner. `signup` and the schema already refused the grant; this did not,
 * because it copied `role` straight off the body.
 *
 * The schema (`ASSIGNABLE_ROLES`) is what makes the refusal unreachable in
 * practice — `super_admin` cannot survive validation — and this function is what
 * makes it *legible*, returning `PLATFORM_ROLE_NOT_GRANTABLE` rather than letting a
 * caller discover the rule as a field-level 422.
 */
const resolveInvitableRole = (requester, requestedRole) => {
  if (requestedRole === 'super_admin') {
    return {
      error: {
        status: 403,
        message:
          'The platform admin role cannot be granted. It is assigned to a single account from the server environment.',
        code: 'PLATFORM_ROLE_NOT_GRANTABLE',
      },
    };
  }

  if (requester.role === 'super_admin') return { role: requestedRole || 'teacher' };

  if (!INVITABLE_BY_SCHOOL_ADMIN.includes(requestedRole)) {
    return {
      error: {
        status: 403,
        message: 'You cannot grant that role',
        code: 'ROLE_NOT_GRANTABLE',
      },
    };
  }

  return { role: requestedRole };
};

/**
 * Builds and delivers the invitation email.
 *
 * Returns `{ sent, reason }` instead of throwing: the account already exists by
 * the time this runs, and a mail failure must not unwind that. The caller
 * surfaces it as `emailSent: false` and raises an in-app notification so the
 * admin has somewhere to go from, because "the invite silently failed" is the
 * one outcome that leaves a real teacher unable to work and nobody aware of it.
 */
const deliverInvitationEmail = async ({
  user,
  school,
  password,
  inviter,
  role,
  isResend = false,
}) => {
  const { subject, html, text } = invitationEmail({
    name: user.name,
    email: user.email,
    password,
    schoolCode: school.schoolCode || '—',
    schoolName: school.name,
    inviter: inviter.name,
    inviterRole: inviter.role,
    inviterPosition: inviter.position,
    role,
    loginUrl: `${CLIENT_URL}/login`,
    isResend,
  });

  try {
    await sendEmail({ to: user.email, toName: user.name, subject, html, text });
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}; 


export const inviteUser = async (req, res) => {
  let normalizedEmail;
  try {
    const { name, email, phone, role, position, schoolId } = req.body;

    const roleCheck = resolveInvitableRole(req.user, role);
    if (roleCheck.error) {
      return res.status(roleCheck.error.status).json({
        success: false,
        message: roleCheck.error.message,
        code: roleCheck.error.code,
      });
    }
    const targetRole = roleCheck.role;

    const { school, error: schoolError } = await resolveTargetSchool(req.user, schoolId);
    if (schoolError) {
      return res.status(schoolError.status).json({
        success: false,
        message: schoolError.message,
        code: schoolError.code,
      });
    }

    // Scoped to `deletedAt: null` on purpose. A soft-deleted account keeps the
    // unique email index occupied, so inviting that address again dies on a
    // duplicate-key error that reads as a 500. Catching it here turns that into
    // the accurate answer: the address is taken by a removed account.
    //
    // The query is lowercased explicitly because the index is case-sensitive but
    // the stored value is lowercased on write (`userModel.js`): a legacy mixed-
    // case address would otherwise slip past this check, reach `create`, and
    // surface as a raw E11000 instead of this legible 409.
    normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) {
      // Guard the empty-filter footgun: an undefined email would make this a
      // `findOne({})` and resolve to whichever account happens to come first.
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists',
        code: 'EMAIL_AMBIGUOUS',
      });
    }
    // Case-insensitive duplicate check: the unique index on `email` can be
    // case-insensitive (legacy mixed-case documents stored before the
    // `lowercase` setter were universal) whereas this query was case-sensitive,
    // so it missed a variant and `create` then threw the E11000 it could not
    // explain. Matching case-insensitively owns the collision up front and
    // surfaces the exact stored address in `conflict`.
    const emailVariant = new RegExp(
      `^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      'i'
    );
    const existingUser = await User.findOne({ email: emailVariant });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: existingUser.deletedAt
          ? 'That email belongs to a removed account. Restore it or use a different address.'
          : 'An account with this email already exists',
        code: existingUser.deletedAt ? 'EMAIL_ON_DELETED_ACCOUNT' : 'EMAIL_TAKEN',
        conflict: {
          email: existingUser.email,
          deleted: Boolean(existingUser.deletedAt),
          status: existingUser.status,
        },
      });
    }

    // The default password. Derived from the School ID so an admin can recognise
    // which institution issued it, plus a random suffix so it is not a secret
    // the whole staff share. See utils/defaultPassword.js for why neither half
    // works alone.
    const defaultPassword = generateDefaultPassword(school);

    const user = await User.create({
      name,
      email,
      phone: phone || null,
      password: defaultPassword,
      role: targetRole,
      position: position || null,
      status: 'invited',
      // Marked verified here, deliberately, and this is the single most
      // consequential judgement in the flow.
      //
      // `login` refuses any account where `isEmailVerified` is false, and the
      // only remedy it offers is an emailed OTP. Since this flow's entire
      // purpose is to hand the recipient a working password in one email,
      // leaving verification to a second message would mean the credentials in
      // that email do not work — the invitee would read a valid password, enter
      // it, and get "Please verify your email address before signing in", with
      // no indication that the fix is to go and check for another email.
      //
      // The address is therefore treated as verified on the strength of the
      // inviting admin: they are authenticated, school-scoped, and asserting it
      // by hand. That is the standard admin-provisioned account model, and its
      // real cost is that a mis-typed address is only discovered when the
      // invitee reports they got nothing — which is what the `emailSent`
      // response flag and the resend endpoint exist to make recoverable.
      isEmailVerified: true,
      schoolId: school._id,
      // Invited staff arrive already linked to their school, so for join-flow
      // roles (teacher, accountant, viewer) onboarding is complete by definition.
      // `school_admin` stays false so they still hit the provisioning + wizard.
      onboardingCompleted: SCHOOL_JOIN_ROLES.includes(targetRole),
      invitedBy: req.user._id,
      invitedAt: new Date(),
      inviteCount: 1,
      mustChangePassword: true,
    });

    const delivery = await deliverInvitationEmail({
      user,
      school,
      password: defaultPassword,
      inviter: req.user,
      role: targetRole,
    });

    user.inviteEmailSentAt = delivery.sent ? new Date() : null;
    await user.save();

    if (delivery.sent) {
      await auditLog(req, {
        action: AUDIT_ACTIONS.USER_INVITE,
        entity: 'User',
        entityId: user._id,
        schoolId: school._id,
        meta: {
          email: user.email,
          role: user.role,
          position: user.position,
          isResend: false,
        },
      });
    } else {
      // Logged too, and marked as a failure: an invitation that created a
      // credential but never delivered it is exactly the kind of gap the audit
      // trail exists to surface, and a success-only log would hide it.
      await auditLog(req, {
        action: AUDIT_ACTIONS.USER_INVITE,
        entity: 'User',
        entityId: user._id,
        schoolId: school._id,
        meta: {
          email: user.email,
          role: user.role,
          emailSent: false,
          failureReason: delivery.reason,
          isResend: false,
        },
      });

      // Wrapped: `createNotification` throws on its own validation failure, and
      // an unhandled throw here would escape into the outer catch and turn a
      // created-but-undelivered invitation into a 500 — telling the admin the
      // invite failed entirely, when the only thing that failed is the alert
      // about the failure.
      try {
        await createNotification({
          userId: req.user._id,
       schoolId: school._id,
       // Invited staff arrive already linked to their school, so for join-flow
       // roles (teacher, accountant, viewer) onboarding is complete by definition —
       // they have no wizard to walk. `school_admin` stays false so they still
       // hit the provisioning + wizard steps. Without this, the `user.onboardingCompleted`
       // field stays false forever, which on a backend without the SCHOOL_JOIN_ROLES
       // branch in `onboardingBlock` sends them through onboarding again.
       onboardingCompleted: SCHOOL_JOIN_ROLES.includes(targetRole),
          type: 'system.alert',
          title: `Invitation to ${user.name} was not delivered`,
          message: `The account was created, but the email to ${user.email} failed to send. Re-send the invitation so ${user.name.split(' ')[0]} can sign in.`,
          link: '/dashboard/user-management',
        });
      } catch (notificationError) {
        console.error('Invite failure notification failed:', notificationError.message);
      }
    }

    // 201 even when the mail failed. The account *was* created, and the caller
    // can only retry by re-sending — a 5xx here would invite a naive client to
    // repeat the whole request and collide with its own 409. The distinction is
    // carried in the body, where the UI can act on it, rather than in a status
    // code that would misrepresent what happened.
    return res.status(201).json({
      success: true,
      message: delivery.sent
        ? `Invitation sent to ${user.email}`
        : `${user.name} was added, but the invitation email could not be sent. Re-send it from this page.`,
      user: user.toJSON(),
      emailSent: delivery.sent,
      ...(delivery.sent ? {} : { code: 'INVITE_EMAIL_FAILED', emailFailureReason: delivery.reason }),
    });
  } catch (error) {
    if (error.code === 11000) {
      // The pre-check above should own email collisions; if we still hit the
      // index, `keyValue` says which key fired. The two real cases are:
      //
      //  - `email`: a case variant the lowercased query missed, or a document
      //    the `deletedAt: null` filter excluded (a soft-deleted account). Both
      //    return the 409 the invite flow expects, with the stored address.
      //  - `providerId`: on a database whose index still lacks its
      //    partialFilterExpression, the explicit `null` on every password-only
      //    account is indexed, so the second invite of any kind collides here.
      //    The declared index skips `null`, so this means the migration in
      //    `boot/reconcileProviderIdIndex.js` has not run (or failed).
      const conflict = error.keyValue || {};
      if (conflict.email) {
        console.warn('[inviteUser] duplicate email on invite', {
          requestedEmail: normalizedEmail,
          conflictEmail: conflict.email,
        });
        return res.status(409).json({
          success: false,
          message: 'An account with this email already exists',
          code: 'EMAIL_TAKEN',
          conflict: { email: conflict.email },
        });
      }
      //  - `providerId: null`: the database still holds the legacy *sparse*
      //    unique index, which MongoDB populated with the explicit `null` every
      //    password-only account carries. Only one such account can ever exist
      //    under it. `boot/reconcileProviderIdIndex.js` drops it and recreates
      //    the declared partial index (which skips null), so this log line
      //    should not appear on a booted instance after this migration.
      //
      //    It also fires if the index is missing altogether, which is what a
      //    database whose declared filter MongoDB refused to build looks like.
      if (conflict.providerId !== undefined) {
        console.warn(
          '[inviteUser] duplicate providerId on invite — the providerId index in this ' +
            'database is missing its partialFilterExpression; boot/reconcileProviderIdIndex.js ' +
            'should have replaced it',
          {
            keyValue: conflict,
            keyPattern: error.keyPattern,
            requestedEmail: normalizedEmail,
          }
        );
        return res.status(409).json({
          success: false,
          message: 'An account with this email already exists',
          code: 'EMAIL_TAKEN',
          conflict,
        });
      }
      console.warn('[inviteUser] unexpected duplicate key on invite', {
        keyValue: conflict,
        keyPattern: error.keyPattern,
        requestedEmail: normalizedEmail,
      });
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists',
        code: 'EMAIL_TAKEN',
        conflict,
      });
    }
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid school ID',
        code: 'INVALID_SCHOOL_ID',
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * `POST /users/:userId/resend-invite`
 *
 * Re-mints the default password and re-sends the mail.
 *
 * Exists because `inviteUser` deliberately does not roll back on a mail
 * failure, so there has to be a supported way to retry without inviting a second
 * person. Scoped to accounts still in `invited` status: re-sending to someone
 * who has already signed in would change a password out from under a working
 * user, which is a support incident, not a resend.
 *
 * `mustChangePassword` stays true regardless — it is cleared when the password
 * is changed, not when the invitation is re-issued.
 */
export const resendUserInvite = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findOne({ _id: userId, deletedAt: null });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found', code: 'USER_NOT_FOUND' });
    }

    if (!sameSchoolOrAdmin(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this resource',
        code: 'FORBIDDEN',
      });
    }

    if (user.status !== 'invited') {
      return res.status(409).json({
        success: false,
        message: 'This user has already accepted their invitation',
        code: 'ALREADY_ACCEPTED',
      });
    }

    const { school, error: schoolError } = await resolveTargetSchool(req.user, user.schoolId);
    if (schoolError) {
      return res.status(schoolError.status).json({
        success: false,
        message: schoolError.message,
        code: schoolError.code,
      });
    }

    const defaultPassword = generateDefaultPassword(school);

    // Assigned before hashing, and `save()` before the mail goes out, so a
    // delivered email always describes a credential that is already live. The
    // reverse order would let a mail arrive carrying a password that a failed
    // write never stored.
    user.password = defaultPassword;
    user.mustChangePassword = true;
    user.invitedAt = new Date();
    user.inviteCount = (user.inviteCount || 0) + 1;
    await user.save();

    const delivery = await deliverInvitationEmail({
      user,
      school,
      password: defaultPassword,
      inviter: req.user,
      role: user.role,
      isResend: true,
    });

    user.inviteEmailSentAt = delivery.sent ? new Date() : null;
    await user.save();

    await auditLog(req, {
      action: AUDIT_ACTIONS.USER_INVITE,
      entity: 'User',
      entityId: user._id,
      schoolId: school._id,
      meta: {
        email: user.email,
        role: user.role,
        isResend: true,
        emailSent: delivery.sent,
        ...(delivery.sent ? {} : { failureReason: delivery.reason }),
      },
    });

    return res.status(200).json({
      success: true,
      message: delivery.sent
        ? `Invitation re-sent to ${user.email}`
        : 'The invitation still could not be sent. Check the address and try again.',
      user: user.toJSON(),
      emailSent: delivery.sent,
      ...(delivery.sent ? {} : { code: 'INVITE_EMAIL_FAILED', emailFailureReason: delivery.reason }),
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, message: 'Invalid user ID' });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const listUsers = async (req, res) => {
  try {
    const { schoolId, page = 1, limit = 50, role, status } = req.query;

    let targetSchoolId;
    if (req.user.role === 'super_admin') {
      targetSchoolId = schoolId || req.user.schoolId;
    } else {
      targetSchoolId = req.user.schoolId;
      if (schoolId && schoolId !== String(req.user.schoolId)) {
        return res.status(403).json({
          success: false,
          message: 'You can only view users from your own school',
        });
      }
    }

    const query = { deletedAt: null };
    if (targetSchoolId) query.schoolId = targetSchoolId;
    if (role) query.role = role;
    if (status) query.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const [users, total] = await Promise.all([
      User.find(query).skip(skip).limit(Number(limit)).sort({ createdAt: -1 }),
      User.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      users,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findOne({ _id: userId, deletedAt: null });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!sameSchoolOrAdmin(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this resource',
      });
    }

    return res.status(200).json({
      success: true,
      user: user.toJSON(),
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID',
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, email, role, position, phone, onboardingCompleted, onboardingHighestStep } = req.body;

    const user = await User.findOne({ _id: userId, deletedAt: null });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!sameSchoolOrAdmin(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this resource',
      });
    }

    if (role && role === 'super_admin') {
      // The platform role is not assignable. The schema already refuses it
      // (`ASSIGNABLE_ROLES`), so this is unreachable through the API — which is the
      // point of it being here rather than only there: this endpoint carries no
      // `authorize` middleware at all, so it is the one place where a future edit
      // to the schema would have nothing else standing behind it. Refusing here
      // also means the answer is `PLATFORM_ROLE_NOT_GRANTABLE` with an
      // explanation, rather than a field-level 422 naming a role the caller was
      // never going to be allowed to set.
      return res.status(403).json({
        success: false,
        message:
          'The platform admin role cannot be granted. It is assigned to a single account from the server environment.',
        code: 'PLATFORM_ROLE_NOT_GRANTABLE',
      });
    }

    if (role && req.user.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Only a super admin can change roles',
      });
    }

    if (email && email !== user.email) {
      const emailConflict = await User.findOne({ email, _id: { $ne: userId } });
      if (emailConflict) {
        return res.status(409).json({
          success: false,
          message: 'An account with this email already exists',
        });
      }
      user.email = email;
    }

    if (name) user.name = name;
    // Captured before the assignment below, so the audit entry can record the
    // transition rather than just the destination.
    const previousRole = user.role;
    if (role) user.role = role;
    if (position !== undefined) user.position = position || null;
    if (phone) user.phone = phone;

    /*
     * The audit entry this endpoint never wrote.
     *
     * A role change through `PUT /users/:userId` was completely invisible: the
     * invite path logged `user.invite`, this one logged nothing, so a colleague
     * promoted to full governance of a school left no trace in that school's
     * activity log — the one record the school has of who could do what. Written
     * here rather than only in `changeUserRole` because this is a second,
     * undocumented route to the same effect, and the two endpoints having
     * different logging is exactly the gap.
     *
     * Both sides of the transition are recorded. For a role change, "who had it,
     * who has it now" is the entire question an administrator is asking later;
     * logging only the new value leaves the audit unable to say who was demoted.
     */
    const roleChanged = Boolean(role) && role !== previousRole;

    // Wizard progress. Restricted to the account itself: `sameSchoolOrAdmin`
    // above lets a school_admin edit their colleagues, and letting one admin
    // mark another's onboarding complete would skip a bursar straight into a
    // dashboard for a school they never configured.
    if (req.user._id.toString() === user._id.toString()) {
      if (onboardingCompleted !== undefined) user.onboardingCompleted = onboardingCompleted;
      if (onboardingHighestStep !== undefined) {
        user.onboardingHighestStep = onboardingHighestStep;
      }
    }

    await user.save();

    if (roleChanged) {
      await auditLog(req, {
        action: AUDIT_ACTIONS.USER_ROLE_CHANGE,
        entity: 'User',
        entityId: user._id,
        schoolId: user.schoolId,
        meta: { from: previousRole, to: user.role },
      });
    }

    return res.status(200).json({
      success: true,
      message: 'User updated successfully',
      user: user.toJSON(),
      onboarding: {
        completed: user.onboardingCompleted === true,
        highestStep: user.onboardingHighestStep ?? 0,
      },
    });

  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID',
      });
    }
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists',
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const changeUserRole = async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    const user = await User.findOne({ _id: userId, deletedAt: null });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!sameSchoolOrAdmin(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this resource',
      });
    }

    /*
     * The platform role cannot be assigned by anybody.
     *
     * The old check here was `role === 'super_admin' && req.user.role !== 'super_admin'`
     * — i.e. "a super_admin may promote anyone", which is precisely the second
     * platform owner the single-owner rule exists to prevent. The schema
     * (`ASSIGNABLE_ROLES`) now refuses the value before this runs, so this branch
     * is defence in depth; it is kept because the refusal needs to be an answer
     * with an explanation rather than a validation error, and because
     * `updateUserRoleSchema` is not the only way a body reaches this handler.
     */
    if (role === 'super_admin') {
      return res.status(403).json({
        success: false,
        message:
          'The platform admin role cannot be assigned. It is assigned to a single account from the server environment.',
        code: 'PLATFORM_ROLE_NOT_GRANTABLE',
      });
    }

    const previousRole = user.role;

    user.role = role;
    await user.save();

    /*
     * The audit entry this endpoint never wrote.
     *
     * Role changes were the widest silent action in the product: `user.invite` was
     * logged, this was not, and "who promoted this bursar to school admin?" had
     * no answer. Both sides of the transition are recorded, because the audit's
     * purpose here is to answer a question about a *change* — logging only the new
     * value leaves it unable to say who lost the role.
     */
    await auditLog(req, {
      action: AUDIT_ACTIONS.USER_ROLE_CHANGE,
      entity: 'User',
      entityId: user._id,
      schoolId: user.schoolId,
      meta: { from: previousRole, to: user.role },
    });

    return res.status(200).json({
      success: true,
      message: 'User role updated successfully',
      user: user.toJSON(),
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID',
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    if (userId === String(req.user._id)) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own account',
      });
    }

    const user = await User.findOne({ _id: userId, deletedAt: null });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!sameSchoolOrAdmin(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this resource',
      });
    }

    if (user.role === 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Cannot delete a super admin account',
      });
    }

    user.deletedAt = new Date();
    user.tokenVersion += 1;
    await user.save();

    /*
     * The audit entry this endpoint never wrote, and the widest omission of the
     * three: a removal destroys somebody's access to a school's records and
     * revokes every session they hold, irreversibly from their side, and left no
     * trace anywhere. A school's activity log — the record it has of who could
     * see its students' data — could not show that an account had been removed.
     *
     * The identity is captured before the soft delete, because afterwards the
     * document is only reachable through a `deletedAt` query and an audit reader
     * following `entityId` would find a row that looks active.
     */
    await auditLog(req, {
      action: AUDIT_ACTIONS.USER_REMOVE,
      entity: 'User',
      entityId: user._id,
      schoolId: user.schoolId,
      meta: { email: user.email, role: user.role, name: user.name },
    });

    return res.status(200).json({
      success: true,
      message: 'User removed successfully',
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID',
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};



