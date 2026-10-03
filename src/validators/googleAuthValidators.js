import Joi from 'joi';

/**
 * `POST /auth/google`
 *
 * The body carries **only a credential**. No email, no name, no role, no school.
 *
 * That is the whole design, and it is worth stating because a body that accepted those
 * fields would invite the obvious implementation mistake: reading the email from the
 * request instead of from the verified token. A client can send anything it likes; the
 * only trustworthy address is the one inside a token whose signature we have checked
 * against Google's public keys, carrying our own client ID as its audience, and whose
 * `email_verified` claim Google has set.
 *
 * `.max(4096)` is generous for a JWT (Google's are around 1KB) while refusing a body
 * that is obviously not one. It is a shape guard, not a security control — a token that
 * is merely *wrong* is caught in `googleAuth.service.js`.
 */
export const googleLoginSchema = Joi.object({
  idToken: Joi.string().trim().min(20).max(4096).required().messages({
    'string.empty': 'A Google credential is required.',
    'any.required': 'A Google credential is required.',
    'string.min': 'That does not look like a Google credential.',
  }),
}).unknown(false);

export default { googleLoginSchema };