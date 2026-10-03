import {
  GOOGLE_ALLOWED_ORIGINS,
  GOOGLE_CLIENT_ID,
} from '../config/env.js';
import ApiError from '../utils/ApiError.js';

/**
 * Google Sign-In: verifying what Google asserts.
 *
 * ### The one rule this module exists to enforce
 *
 * `isEmailVerified: true` may only ever be set on the strength of **Google's own
 * `email_verified` claim**, not on the strength of an email address appearing in a
 * token we were handed.
 *
 * Those are not the same thing, and the gap between them is the whole attack. Google
 * lets an account owner add an **unverified secondary address** to an account without
 * proving they own it. An address that has been added but never verified will appear
 * in ID tokens as the account's email, and it may be the *primary* address for the
 * purposes of a token. So a user who knows a bursar's unverified secondary address on
 * their own Google account could present a cryptographically valid Google token
 * carrying that address — and a flow that treated "the token is genuine" as "the email
 * is verified" would mark that account verified and hand over the bursar's SukuuPay
 * session.
 *
 * The signature check answers "did Google mint this?". Only the claim answers "does
 * Google vouch for this address?". Both are required, and neither substitutes for the
 * other.
 *
 * ### Signature verification is real, not simulated
 *
 * `OAuth2Client.verifyIdToken` fetches Google's public keys, checks the RS256
 * signature, and validates `aud` (our client ID), `iss` (Google) and `exp`. It is not
 * replaced by decoding the token and reading the payload — an unsigned or
 * wrong-audience token is trivially forgeable, and "decode and trust" is the single
 * most common way a Google login ends up as an account-takeover primitive.
 *
 * ### There is no redirect URI and no callback route
 *
 * The Google Cloud console asks for "Authorized redirect URIs" under the qualifier
 * "only if backend handles OAuth callback". **This backend does not**, so that field
 * is correctly left empty and there is no `/auth/google/callback` route to register.
 *
 * The reason is which grant is in use. This is the browser-flow ID token — GIS opens
 * a popup, the signed credential comes back to the tab, and the tab POSTs it here.
 * That is a **stateless JWT check**: the signature, `aud`, `iss` and `exp` are all
 * verifiable without anything stored anywhere.
 *
 * A redirect URI is for the `authorization_code` grant, where the server trades a
 * `code` for tokens using `GOOGLE_CLIENT_SECRET` and has to hold the transaction
 * state (`state` parameter, PKCE verifier, a code store). That buys capabilities this
 * product does not need — offline access, server-to-server calls — at the cost of the
 * client secret and of a stateful login path with more ways to go wrong.
 *
 * So if a redirect URI is ever genuinely required, the reason will be one of those
 * capabilities rather than this flow. Worth knowing when it happens: **the suggested
 * path in the console is also wrong for this API.** It offers
 * `/api/v1/auth/google/callback`, but `authRoute` is mounted under `/api` with no
 * version segment (`src/index.js:54`), so a real route here would be
 * `/api/auth/google/callback`.
 *
 * ### The dependency is imported lazily, on purpose
 *
 * `google-auth-library` is imported *inside* the function. A top-level import of a
 * package that is not installed throws at module load, and this module is imported by
 * the auth router — so a missing optional dependency would take down signup, login,
 * refresh and password reset along with the one new endpoint that needs it. Lazy, it
 * is a coded 503 on `POST /auth/google` and a working login form, which is the correct
 * degradation for a feature flag that is off by default anyway.
 */

/**
 * Is Google Sign-In usable at all on this deployment?
 *
 * Answered from configuration only, with no dependency import, so `/auth/google`
 * can answer honestly ("not configured") rather than by throwing when the library is
 * absent. The client uses this to hide the button, which is why it must not be a
 * try/catch around a real verification.
 */
export const isGoogleAuthConfigured = () => Boolean(GOOGLE_CLIENT_ID);

/**
 * Whether this request may present a Google credential.
 *
 * **Defence in depth, not the boundary.** The token's signature and audience are what
 * authenticate it; this narrows *where* a token can be presented from.
 *
 * Two requests are allowed through:
 *   - an `Origin` on the allowlist — the normal browser call; and
 *   - a request with **no** `Origin` at all — a server-to-server or native client.
 *
 * The second case is a deliberate decision worth stating, because the instinctive
 * version is to reject it and that would be wrong in both directions. Rejecting it
 * breaks every non-browser caller (the mobile app, a backend integration, a CLI).
 * Accepting *any* origin-bearing request would be worse, so the check is: **if an
 * origin is declared, it must match; if none is declared, fall through to the token
 * checks.** A browser always sends `Origin` on a cross-origin POST, so an attacker
 * cannot use this to launder a token from a page.
 *
 * Empty allowlist refuses every origin-bearing request rather than allowing every one
 * — an origin check that fails open is not an origin check.
 *
 * @param {string|undefined} origin  the request's `Origin` header
 * @throws {ApiError} 403 when an origin is present and not allowed
 */
export const assertOriginAllowed = (origin) => {
  if (!origin) return;

  const candidate = String(origin).trim().replace(/\/+$/, '');

  if (GOOGLE_ALLOWED_ORIGINS.includes(candidate)) return;

  throw new ApiError(
    'This sign-in request came from an origin that is not allowed',
    403,
    'ORIGIN_NOT_ALLOWED'
  );
};

/**
 * Verifies a Google ID token and returns the claims we rely on.
 *
 * @param {string} idToken  the credential from the client
 * @returns {Promise<{sub: string, email: string, emailVerified: boolean, name: string|null, picture: string|null}>}
 * @throws {ApiError} 503 when unconfigured, 400 when the token is invalid, 403 when
 *   Google's own claim says the address is not verified
 */
export const verifyGoogleIdToken = async (idToken) => {
  if (!isGoogleAuthConfigured()) {
    throw new ApiError(
      'Google sign-in is not configured on this deployment',
      503,
      'GOOGLE_AUTH_NOT_CONFIGURED'
    );
  }

  let ticket;
  try {
    const { OAuth2Client } = await import('google-auth-library');

    const client = new OAuth2Client(GOOGLE_CLIENT_ID);
    ticket = await client.verifyIdToken({
      idToken,
      // The audience is the check that stops a token minted for a *different* app —
      // including another app the same developer owns — being replayed at us. It is
      // passed explicitly rather than inferred from the library's client instance
      // because this is the only place the value is actually enforced.
      audience: GOOGLE_CLIENT_ID,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;

    /*
     * Two very different causes land here and the message must not tell them apart.
     *
     * "Invalid token" is the usual one: expired, wrong audience, forged, or mangled by
     * the client. The library's own error text can name the expected audience, which
     * is a configuration detail an attacker should not be able to read back by
     * submitting arbitrary tokens.
     *
     * The other is `ERR_MODULE_NOT_FOUND` — the optional dependency is not installed.
     * That is an operator problem, not a user one, and it gets a 503 with a message
     * that says so, because returning 400 for it would have support telling a user
     * their token was bad when the deployment is broken.
     */
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new ApiError(
        'Google sign-in is unavailable: the google-auth-library package is not installed',
        503,
        'GOOGLE_AUTH_DEPENDENCY_MISSING'
      );
    }

    throw new ApiError('Google sign-in failed. Please try again.', 400, 'INVALID_GOOGLE_TOKEN');
  }

  const payload = ticket.getPayload();

  /*
   * The claim check, in this order and for these reasons.
   *
   * `sub` first: it is the one field every Google ID token has, it is immutable, and
   * without it there is nothing to look the account up by. Failing here before the
   * email check keeps the two failure modes distinguishable in the log while both
   * answer the client the same way.
   */
  if (!payload?.sub) {
    throw new ApiError('Google sign-in failed. Please try again.', 400, 'INVALID_GOOGLE_TOKEN');
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';

  if (!email) {
    throw new ApiError(
      'Your Google account does not share an email address with SukuuPay',
      400,
      'GOOGLE_EMAIL_MISSING'
    );
  }

  /*
   * The crux. `email_verified` is Google's assertion that the account owner proved
   * control of the address. Without it we cannot mark anything verified, and we must
   * not create an account either — an unverified address is an address *anyone* who
   * added it can hold.
   *
   * Refused rather than degraded. The alternative of "sign them in unverified and let
   * them finish by email" would mean an account whose email ownership was never
   * established, which is precisely the state the OTP flow exists to prevent — and it
   * would be reached by the one route that cannot ask for an OTP.
   */
  if (payload.email_verified !== true) {
    throw new ApiError(
      'Verify this email address in Google, then try again. Google reports it as unverified, so SukuuPay cannot trust it.',
      403,
      'GOOGLE_EMAIL_NOT_VERIFIED'
    );
  }

  return {
    sub: payload.sub,
    email,
    emailVerified: true,
    // Both optional in a Google profile; `null` rather than `''` so the caller can
    // distinguish "Google sent nothing" from "Google sent an empty string".
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : null,
    picture: typeof payload.picture === 'string' && payload.picture.trim() ? payload.picture.trim() : null,
  };
};

export default {
  isGoogleAuthConfigured,
  assertOriginAllowed,
  verifyGoogleIdToken,
};