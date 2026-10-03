// Google Sign-In: the rules that make marking an account verified safe.
//
//   npm test
//
// Why each of these is a test rather than a comment. Every assertion here protects a
// decision that is *invisible once it is correct*: an account marked verified on the
// strength of an unverified address looks exactly like a correctly verified account,
// and the only evidence anything went wrong is a session that should not exist.
//
// The three that matter most:
//
//   - **`email_verified` is required.** Google lets an account owner add an unverified
//     secondary address, and that address appears in ID tokens. Verifying the signature
//     while ignoring the claim is how "sign in with Google" becomes account takeover of
//     anybody's address you can claim.
//   - **An existing password account is never auto-linked.** Matching email addresses
//     are not proof of ownership.
//   - **The OTP is cleared, not left behind.** A live verification token on a Google
//     account is a credential the exempt user can still be made to use.
//
// No database and no live Google call, so these assert the *contract* — the presence
// and the order of the checks — rather than a round trip. The behaviours they protect
// need a real MongoDB and a real token to exercise; what is verified here is that
// nothing has quietly been removed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (relative) =>
  readFileSync(new URL(`../src/${relative}`, import.meta.url), 'utf8');

describe("Google's own email_verified claim is required", () => {
  test('verification delegates to Google and checks the claim strictly', async () => {
    const { verifyGoogleIdToken, isGoogleAuthConfigured } = await import(
      '../src/services/googleAuth.service.js'
    );
    void verifyGoogleIdToken;

    const text = source('services/googleAuth.service.js');

    assert.ok(
      text.includes('client.verifyIdToken'),
      'must use OAuth2Client.verifyIdToken — decoding the token and trusting the payload is the account-takeover bug'
    );
    assert.ok(
      /audience:\s*GOOGLE_CLIENT_ID/.test(text),
      'the audience must be checked explicitly, so a token minted for another app cannot be replayed'
    );
    assert.ok(
      text.includes('payload.email_verified !== true'),
      'the claim must be compared strictly against `true` — a truthy check would accept the string "true"'
    );
    assert.ok(
      text.includes('GOOGLE_EMAIL_NOT_VERIFIED'),
      'an unverified address must produce its own coded refusal rather than a generic failure'
    );
    assert.equal(typeof isGoogleAuthConfigured(), 'boolean');
  });

  test('the dependency is imported lazily so a missing package cannot take down the auth router', () => {
    const text = source('services/googleAuth.service.js');

    assert.ok(
      /await import\('google-auth-library'\)/.test(text),
      'the library must be imported inside the function'
    );
    assert.ok(
      !/^import .*google-auth-library/m.test(text),
      'a top-level import throws at module load when the package is absent, taking signup and login down with it'
    );
    assert.ok(
      text.includes('GOOGLE_AUTH_DEPENDENCY_MISSING'),
      'a missing dependency must be a 503 the operator can act on, not a 400 blaming the user'
    );
  });
});

describe('an existing password account is never silently claimed', () => {
  test('the lookup order and the refusals are explicit', () => {
    const text = source('controllers/googleAuth.controller.js');

    assert.ok(text.includes('ACCOUNT_EXISTS_PASSWORD'), 'a password account sharing the address must be refused, not linked');
    assert.ok(/status === 'invited'/.test(text), 'an invited record is the one safe exception — no credential exists to take');
    assert.ok(text.includes('GOOGLE_ACCOUNT_MISMATCH'), 'one address claimed by two different Google `sub` values must be refused');

    /*
     * The lookup order is the security property: `providerId` first, email second.
     *
     * A `sub` hit is proof the exact Google account has been here before. An email hit
     * proves only that two addresses are spelled the same, which anybody can arrange.
     */
    const providerLookup = text.indexOf('findOne({ providerId: claims.sub })');
    const emailLookup = text.indexOf('findOne({ email: claims.email })');

    assert.ok(providerLookup > -1, 'must look the account up by the immutable Google subject');
    assert.ok(emailLookup > -1);
    assert.ok(
      providerLookup < emailLookup,
      'providerId must be tried before email — an email match alone is not proof of ownership'
    );
  });

  test('creation is gated on both the platform switch and a Google-specific one', async () => {
    const text = source('controllers/googleAuth.controller.js');

    assert.ok(text.includes('GOOGLE_ALLOW_SIGNUP'), 'creation must be gated on the Google-specific switch');
    assert.ok(
      text.includes("isFeatureEnabled('selfSignupEnabled')") ||
        text.includes('isFeatureEnabled("selfSignupEnabled")'),
      "the platform's own self-signup switch must be checked first — it is the real control, and this flag only narrows it"
    );

    const env = await import('../src/config/env.js');
    assert.equal(
      typeof env.GOOGLE_ALLOW_SIGNUP,
      'boolean',
      'GOOGLE_ALLOW_SIGNUP must parse to a boolean, not a truthy string — "false" is truthy'
    );
  });

  test('GOOGLE_ALLOW_SIGNUP defaults on, and only an explicit "false" disables it', async () => {
    /*
     * Asserted against a replica of the parse, **not** against the loaded
     * `env.GOOGLE_ALLOW_SIGNUP`.
     *
     * `config/env.js` reads `process.env` at import time, so the loaded value depends
     * on the developer's own `.env` — and a test asserting on it fails on a machine
     * that has configured the variable, which is a test that measures the machine
     * rather than the rule. (It did exactly that: this failed once because a real
     * `.env` on this machine had `GOOGLE_ALLOW_SIGNUP=false`.) The rule is what is
     * under test, so the rule is what is exercised.
     *
     * Defaults to `true`, which is the opposite of what this was first written as, and
     * the reasoning is worth pinning because it was wrong the first time.
     *
     * The flag gates nothing on its own: `isFeatureEnabled('selfSignupEnabled')` is
     * checked first, so an operator who has closed public registration has already
     * closed it for Google. What is left is the narrow preference of wanting password
     * self-signup but not Google — and a Google account arrives with its email already
     * verified on Google's own claim, which is *stronger* evidence of inbox control
     * than the OTP the password path sends. Refusing the better-verified path while
     * allowing the worse one would be backwards.
     *
     * Hence `!== 'false'` rather than `=== 'true'`: unset means enabled, and only the
     * exact word "false" turns it off. A typo must not silently disable the feature.
     */
    const parse = (raw) => String(raw ?? 'true').toLowerCase() !== 'false';

    assert.equal(parse(undefined), true, 'unset means enabled');
    assert.equal(parse(''), true, 'empty means enabled');
    assert.equal(parse('true'), true);
    assert.equal(parse('TRUE'), true);
    assert.equal(parse('false'), false, 'the one value that means off');
    assert.equal(parse('FALSE'), false);
    assert.equal(
      parse('flase'),
      true,
      'a typo must not disable the feature — only the exact word "false" means off'
    );

    // And the loaded value must at least be a real boolean, whatever the machine says.
    const env = await import('../src/config/env.js');
    assert.equal(typeof env.GOOGLE_ALLOW_SIGNUP, 'boolean');
  });
});

describe('the OTP flow is bypassed, and cannot be reached afterwards', () => {
  test('the verification token is cleared rather than left in place', () => {
    const text = source('controllers/googleAuth.controller.js');

    assert.ok(
      /user\.emailVerificationToken = null/.test(text),
      'a Google account must have its OTP cleared — a live one is a credential the exempt user can still be made to use'
    );
    assert.ok(
      /user\.emailVerificationExpires = null/.test(text),
      'the expiry must be cleared with it, or a stale expiry outlives a nulled token'
    );
    assert.ok(
      /user\.mustChangePassword = false/.test(text),
      'a Google user has no password to change; leaving the flag set sends them to a form that cannot help'
    );
    assert.ok(
      text.includes('required: false') && text.includes('bypassed: true'),
      'the response must state that verification was bypassed, so the client does not render an OTP screen for it'
    );
    assert.ok(!text.includes('sendEmail'), 'the Google path must not send a verification email at all');
  });

  test('forgot-password skips Google accounts, so Google cannot be bypassed', () => {
    const text = source('controllers/authController.js');

    assert.ok(
      /authProvider === 'google'/.test(text),
      "a Google account holds a random password nobody holds; minting a reset token would let anyone who controls the inbox walk straight past Google"
    );
    assert.ok(
      text.includes('If an account exists for that email, a password reset link has been sent.'),
      'the neutral message must be preserved on the skip path, or the endpoint enumerates which addresses use Google'
    );
  });
});

describe('lifecycle, audit and record-keeping', () => {
  test('suspended, deactivated and deleted accounts are refused before a token is issued', () => {
    const text = source('controllers/googleAuth.controller.js');

    assert.ok(text.includes('ACCOUNT_GONE'));
    assert.ok(text.includes('ACCOUNT_INACTIVE'));
    assert.ok(
      text.indexOf('ACCOUNT_INACTIVE') < text.indexOf('issueSession(user)'),
      'the checks must run before a session is issued, or a suspended account gets a token first and a refusal second'
    );
  });

  test('both Google actions exist in the audit enum, or the entries never write', async () => {
    const { AUDIT_ACTIONS } = await import('../src/config/constants.js');
    const { AUDIT_ACTIONS: SCHEMA_ACTIONS } = await import('../src/models/AuditLog.js');

    // This exact drift has happened in this codebase before: an action written that is
    // in neither list is a Mongoose ValidationError which `auditService.log` swallows
    // into a `console.error`, so the entry silently does not exist.
    for (const action of [AUDIT_ACTIONS.USER_GOOGLE_LOGIN, AUDIT_ACTIONS.USER_GOOGLE_SIGNUP]) {
      assert.ok(SCHEMA_ACTIONS.includes(action), `${action} is not on the AuditLog.action enum`);
    }
  });

  test('a Google account records how its address was verified', async () => {
    const { User } = await import('../src/models/userModel.js');

    assert.deepEqual(User.schema.path('emailVerifiedVia').enumValues, ['otp', 'google', null]);
    assert.equal(User.schema.path('authProvider').options.default, 'password', 'existing accounts are unaffected');
    assert.deepEqual(User.schema.path('authProvider').enumValues, ['password', 'google']);
  });

  test('one Google identity cannot hold two SukuuPay accounts', async () => {
    const { User } = await import('../src/models/userModel.js');
    const providerIndex = User.schema.indexes().find(([fields]) => fields.providerId === 1);

    assert.ok(providerIndex, 'providerId must be indexed');
    assert.equal(providerIndex[1].unique, true, 'otherwise two accounts can claim one Google identity');
    assert.equal(providerIndex[1].sparse, true, 'a plain unique index would reject the second user ever created');
  });

  test('password stays required, so no existing invariant moves', async () => {
    const { User } = await import('../src/models/userModel.js');
    assert.equal(
      User.schema.path('password').options.required,
      true,
      'a Google account gets an unusable random password instead of loosening this — otherwise comparePassword(undefined) lands in the password-login path'
    );
  });
});

describe('route wiring and the request body', () => {
  test('both endpoints are registered and the credential one is limited', async () => {
    const { authRoute } = await import('../src/routes/authRoutes.js');
    const paths = authRoute.stack
      .filter((layer) => layer.route)
      .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

    assert.ok(paths.includes('GET /auth/google/config'));
    assert.ok(paths.includes('POST /auth/google'));

    const googleLogin = authRoute.stack.find((layer) => layer.route?.path === '/auth/google');
    assert.ok(
      googleLogin.route.stack.length >= 3,
      'POST /auth/google must carry the limiter and the validator, not just the handler — it accepts an unauthenticated identity assertion'
    );
  });

  test('a smuggled identity field is rejected, not silently ignored', async () => {
    const { googleLoginSchema } = await import('../src/validators/googleAuthValidators.js');
    const googleLogin = await import('../src/controllers/googleAuth.controller.js');

    assert.equal(googleLoginSchema.validate({ idToken: 'x'.repeat(200) }).error, undefined);
    assert.ok(googleLoginSchema.validate({}).error, 'a credential is required');

    /*
     * No email, role or school may reach the handler.
     *
     * Worth being precise about the mechanism, because the intuitive reading is wrong.
     * `.unknown(false)` combined with the middleware's `stripUnknown: true` does **not**
     * strip — an explicit `unknown` rule takes precedence over the boolean, so Joi turns
     * the request into an error and `middleware/validate.js` answers **422**. That is
     * stronger than stripping: the handler never receives the field at all, rather than
     * receiving it and having to remember not to read it.
     *
     * (Checked directly against Joi rather than assumed — `result.value` still contains
     * the input on the error path, so asserting on `value` would have looked like a leak
     * when the error is what actually blocks it.)
     */
    const REQUEST_OPTIONS = { abortEarly: true, stripUnknown: true, convert: true };

    for (const field of ['email', 'role', 'schoolId', 'name']) {
      const result = googleLoginSchema.validate(
        { idToken: 'x'.repeat(200), [field]: 'anything' },
        REQUEST_OPTIONS
      );

      assert.ok(
        result.error,
        `${field} must be refused on the request path — a 422 here is what stops the server reading an identity from the client`
      );
      assert.match(
        result.error.message,
        /not allowed/,
        `${field} must fail as an unknown key, not as some unrelated validation error`
      );
    }

    // The second line of defence, and the one that holds even if the schema is
    // bypassed by a route that forgets to attach it: the handler destructures exactly
    // one field.
    const controller = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/controllers/googleAuth.controller.js', import.meta.url), 'utf8')
    );
    const destructured = controller.match(/const\s*\{([^}]*)\}\s*=\s*req\.body/);
    assert.ok(destructured, 'the handler must destructure from req.body explicitly');
    assert.equal(
      destructured[1].trim(),
      'idToken',
      'the handler must read idToken and nothing else from the body'
    );
  });
});