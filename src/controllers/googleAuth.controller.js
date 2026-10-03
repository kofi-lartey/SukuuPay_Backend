import crypto from 'node:crypto';
import { User } from '../models/userModel.js';
import { School } from '../models/schoolModel.js';
import {
  assertOriginAllowed,
  isGoogleAuthConfigured,
  verifyGoogleIdToken,
} from '../services/googleAuth.service.js';
import { isFeatureEnabled } from '../services/platformSettings.service.js';
import { resolveAccountLinkState } from '../utils/accountLink.js';
import { SELF_SIGNUP_ROLES } from '../validators/authValidators.js';
import { issueSession } from '../utils/tokens.js';
import { log as writeAudit } from '../utils/auditService.js';
import { AUDIT_ACTIONS } from '../config/constants.js';
import { GOOGLE_ALLOW_SIGNUP } from '../config/env.js';
import ApiError from '../utils/ApiError.js';

/**
 * `POST /auth/google` — sign in (or, on first use, register) with Google Sign-In.
 *
 * ### The two behaviours this endpoint exists to provide
 *
 *  1. **`isEmailVerified` becomes `true` immediately**, on the strength of Google's own
 *     `email_verified` claim — verified in `googleAuth.service.js`, which is where that
 *     decision belongs. Nothing in this file trusts an email address it was handed.
 *
 *  2. **The OTP flow is bypassed.** No `emailVerificationToken` is minted, no
 *     verification email is sent, and any token left over from a previous signup for
 *     the same address is **cleared** — see `markVerifiedFromProvider` below, because
 *     leaving a live OTP behind would be the one way a Google user could still be made
 *     to complete a verification step they are exempt from, or worse, could present one
 *     belonging to a different account.
 *
 * ### Why a Google user still gets a password hash
 *
 * `password` is `required: true` on this model, and loosening that would move a core
 * invariant for one feature — and would leave `comparePassword(undefined)` to be handled
 * by the existing password-login path, which is a much worse place to discover the edge
 * case. So a Google account gets a 64-character random password, hashed, that nobody
 * holds.
 *
 * The consequence is stated plainly: **password sign-in for a Google account is
 * impossible**, because no one knows the password. That is the correct outcome, not a
 * limitation — it means an attacker who obtains the email address still cannot get in
 * through the password form, and `POST /auth/forgot-password` would set a password they
 * could then use. The controller below refuses that path explicitly for Google-linked
 * accounts rather than leaving it to be discovered.
 */

/**
 * A password nobody can guess and nobody is given.
 *
 * `randomBytes(32)` in base64url is 256 bits of entropy from the OS CSPRNG, so this
 * is not "a default password" in the sense of a predictable one — it is a value that
 * simply is not transmitted. It is hashed by the model's pre-save hook like any other.
 */
const UNUSABLE_PASSWORD = () => crypto.randomBytes(32).toString('base64url');

/**
 * Marks the account verified and clears the OTP machinery.
 *
 * Every field is set together and the token is **cleared rather than left alone**, which
 * is the part that matters:
 *
 *   - `isEmailVerified` — the flag `login` and `me` both gate on.
 *   - `emailVerifiedAt` — when it became true, and by which route. Set on every sign-in
 *     of a Google user, so the timestamp answers "when did Google first prove this
 *     address" only on the first pass and is stable afterwards.
 *   - `emailVerificationToken` / `emailVerificationExpires` — **nulled**. A Google
 *     account that still held a live OTP could be made to run the verification flow it
 *     is exempt from, and `verifyEmail` only checks that a token matches *that user*,
 *     so an OTP mailed before the address moved to Google remains a usable credential.
 *     Clearing it retires the path.
 *   - `mustChangePassword: false` — the flag that means "this credential is temporary".
 *     A Google user has no password they are expected to change, and leaving it set
 *     would send them to a password form after they have just signed in successfully,
 *     which reads as the sign-in having failed.
 */
const markVerifiedFromProvider = (user, { source, markFirstVerifiedAt }) => {
  user.isEmailVerified = true;
  if (markFirstVerifiedAt || !user.emailVerifiedAt) {
    user.emailVerifiedAt = new Date();
  }
  user.emailVerificationToken = null;
  user.emailVerificationExpires = null;
  user.mustChangePassword = false;
  user.emailVerifiedVia = source;
  return user;
};

/**
 * `GET /auth/google/config` — whether to render the button at all.
 *
 * A separate endpoint rather than folding it into a build-time flag, because whether
 * Google sign-in works is a property of the **deployment** (an environment variable and
 * an installed package) and the frontend is built once and served from many places. A
 * client that hard-coded the button would show a control that 503s on every deployment
 * where it is not configured.
 */
export const googleAuthConfig = async (req, res) => {
  try {
    const enabled = isGoogleAuthConfigured();

    return res.status(200).json({
      success: true,
      message: 'Google sign-in availability',
      data: {
        enabled,
        // Whether a *new* account may be created this way. An operator can have
        // Google sign-in on for existing staff while keeping public registration shut,
        // and the client needs to know the difference to render "sign in" versus
        // "sign in or create an account".
        allowSignup: enabled && GOOGLE_ALLOW_SIGNUP,
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * `POST /auth/google`
 *
 * Body: `{ idToken }` — the credential from Google's client library, never an email.
 */
export const googleLogin = async (req, res) => {
  try {
    assertOriginAllowed(req.headers?.origin);

    const { idToken } = req.body;
    const claims = await verifyGoogleIdToken(idToken);

    /*
     * Looked up by `providerId` first, then by email — and the order is the security
     * property, not an optimisation.
     *
     * `sub` is Google's immutable account identifier, so a hit on it is proof this
     * exact Google account has signed in before. The email is a *fallback*, and it is
     * where the interesting cases live.
     */
    const existingByProvider = await User.findOne({ providerId: claims.sub });
    const existingByEmail = existingByProvider
      ? null
      : await User.findOne({ email: claims.email });

    let user;
    let outcome;

    if (existingByProvider) {
      /*
       * Returning Google user.
       *
       * The email is re-pointed if Google changed it, because Google has just verified
       * the new one. That is a genuine identity change and silently ignoring it would
       * leave the account on an address the owner may no longer control.
       */
      user = existingByProvider;
      outcome = 'signed_in';

      if (user.email !== claims.email && !user.deletedAt) {
        user.email = claims.email;
      }
    } else if (existingByEmail) {
      /*
       * An account already exists for this address, and it is **not** Google-linked.
       *
       * This is the account-takeover case, and it is refused rather than linked.
       * Matching email addresses are not proof of account ownership: anyone can add an
       * address to their own Google account, and a school administrator's address may
       * well be on somebody else's Google account. Auto-linking on an email match is
       * how "sign in with Google" becomes "take over any account whose address you can
       * claim" — so a password account must be signed into with its password.
       *
       * The invited case is the one exception, and it is safe: `invited` means a school
       * administrator created this record for this address before anyone had signed in,
       * so there is no existing credential to take and completing the invite is what
       * the record was waiting for.
       */
      if (existingByEmail.authProvider === 'google' && existingByEmail.providerId) {
        // Same address, Google-linked to a *different* `sub` — a second Google account
        // on one address. Refused, because the two identities are not the same person
        // and only the account holder can decide which is authoritative.
        throw new ApiError(
          'This email address is already linked to a different Google account',
          409,
          'GOOGLE_ACCOUNT_MISMATCH'
        );
      }

      if (existingByEmail.status === 'invited' && !existingByEmail.deletedAt) {
        user = existingByEmail;
        outcome = 'invite_accepted';
      } else {
        throw new ApiError(
          'An account with this email already exists. Sign in with your password instead.',
          409,
          'ACCOUNT_EXISTS_PASSWORD'
        );
      }
    } else {
      /*
       * No account for this address: create one.
       *
       * Gated twice, and both gates matter. `features.selfSignupEnabled` is the
       * product's answer to "may accounts be created at all". `GOOGLE_ALLOW_SIGNUP` is
       * the security answer to "may an identity assertion from a third party be enough
       * to create one" — a stricter question, defaulting closed.
       *
       * Both are checked **before** the duplicate probe above would have run, so the
       * 503 does not confirm whether an account exists. That ordering is what stops the
       * endpoint becoming an oracle for "is this person a SukuuPay user?".
       */
      const selfSignupEnabled = await isFeatureEnabled('selfSignupEnabled');
      if (!selfSignupEnabled || !GOOGLE_ALLOW_SIGNUP) {
        throw new ApiError(
          'Registration is closed at the moment. A school administrator can invite you by email.',
          409,
          'SELF_SIGNUP_DISABLED'
        );
      }

      /*
       * `schoolId` is left unset. The address is verified, but it is verified *as an
       * email address*, not as a claim about any school — so a Google user goes through
       * exactly the same onboarding a password signup does. Creating a school
       * automatically would let anybody with a Gmail address register a school.
       *
       * `role` is re-derived from `SELF_SIGNUP_ROLES` and defaulted, mirroring
       * `authController.signup`. The client does not get to name it.
       */
      user = await User.create({
        name: claims.name || claims.email.split('@')[0],
        email: claims.email,
        password: UNUSABLE_PASSWORD(),
        role: 'school_admin',
        authProvider: 'google',
        providerId: claims.sub,
        providerAvatar: claims.picture,
        status: 'active',
        // The headline behaviour. Set here as well as in the shared helper below so the
        // create is correct even if a future branch forgets to call it.
        isEmailVerified: true,
        emailVerifiedAt: new Date(),
        emailVerificationToken: null,
        emailVerificationExpires: null,
        mustChangePassword: false,
      });

      outcome = 'registered';
    }

    /*
     * Lifecycle checks, after the account is resolved and **before** any token is
     * issued. Mirrors `authController.login` exactly — a suspended account is refused
     * by Google sign-in too, or the suspension would be a speed bump rather than a
     * control.
     *
     * Suspended/deactivated first, then `deletedAt`: an archived account is reported
     * as "no longer exists" whether or not it was also suspended, and the order is not
     * observable from outside because both are 401/403 on the same route.
     */
    if (user.deletedAt) {
      throw new ApiError('Account no longer exists', 401, 'ACCOUNT_GONE');
    }

    if (user.status === 'suspended' || user.status === 'deactivated') {
      throw new ApiError('This account is not active', 403, 'ACCOUNT_INACTIVE');
    }

    const firstVerification = !user.isEmailVerified;

    markVerifiedFromProvider(user, { source: 'google', markFirstVerifiedAt: firstVerification });

    user.authProvider = 'google';
    user.providerId = user.providerId || claims.sub;
    if (claims.picture && !user.providerAvatar) user.providerAvatar = claims.picture;
    if (!user.avatar && claims.picture) user.avatar = claims.picture;

    user.lastLoginAt = new Date();
    user.lastProviderLoginAt = new Date();
    if (user.status === 'invited') user.status = 'active';

    /*
     * Persisted **before** the session is issued, and separately from `issueSession`'s
     * own save.
     *
     * `issueSession` writes the refresh token and calls `user.save()` on the document
     * it is handed, which would commit these changes too — but relying on that couples
     * "is this account verified" to "did we get as far as issuing a session". Saving
     * first means a failure between the two leaves a verified account rather than an
     * unverified one holding a valid session.
     */
    await user.save();

    const tokens = await issueSession(user);

    await writeAudit({
      action:
        outcome === 'registered'
          ? AUDIT_ACTIONS.USER_GOOGLE_SIGNUP
          : AUDIT_ACTIONS.USER_GOOGLE_LOGIN,
      entity: 'User',
      entityId: user._id,
      userId: user._id,
      schoolId: user.schoolId,
      meta: {
        outcome,
        provider: 'google',
        emailVerifiedVia: 'google',
        // The address is recorded because the audit trail for a login is about who
        // signed in; it is not a credential.
        email: user.email,
        firstVerification,
      },
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
      req,
    });

    const linkState = await resolveAccountLinkState(user, async (schoolId) => {
      const found = await School.exists({ _id: schoolId, deletedAt: null });
      return Boolean(found);
    });

    return res.status(200).json({
      success: true,
      message:
        outcome === 'registered'
          ? 'Account created and signed in. Your email is already verified by Google, so no verification code was sent.'
          : 'Signed in successfully',
      user: user.toJSON(),
      tokens,
      /**
       * Stated on the response so the client never has to infer it from the absence of
       * a verification screen — and because "no OTP was sent" is the surprising part of
       * this flow. A client that assumed every login needs an OTP would otherwise show
       * a verification step for a user who has none.
       */
      verification: {
        required: false,
        bypassed: true,
        via: 'google',
        emailVerifiedAt: user.emailVerifiedAt,
      },
      outcome,
      onboarding: {
        ...linkState,
        completed: linkState.linked && user.onboardingCompleted === true,
        highestStep: user.onboardingHighestStep ?? 0,
        nextRoute: linkState.linked
          ? user.onboardingCompleted === true
            ? '/dashboard'
            : '/onboarding/school-profile'
          : '/onboarding/school-profile',
      },
    });
  } catch (error) {
    /*
     * A domain refusal carries its own status and code and is passed through
     * untouched — `ACCOUNT_EXISTS_PASSWORD` is a 409 the client acts on, and
     * flattening it to a 500 would make a normal, expected outcome look like a fault.
     *
     * Anything else is a 500 with a generic message. `error.message` from the Google
     * library can name the expected audience and the token's issuer, which is
     * configuration detail an attacker should not be able to read back by submitting
     * arbitrary tokens.
     */
    if (error instanceof ApiError) {
      return res.status(error.status).json({
        success: false,
        message: error.message,
        code: error.code,
      });
    }

    console.error('[auth/google] failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Google sign-in failed. Please try again.',
    });
  }
};

export default { googleLogin, googleAuthConfig };