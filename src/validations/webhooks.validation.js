import Joi from 'joi';

// ─────────────────────────────────────────────
// Inbound third-party webhook payloads
// ─────────────────────────────────────────────
// These are deliberately NOT validated. The request is authenticated by its
// signature, not by its shape, and a provider is free to add a field, rename
// one, or send a new status code without warning.
//
// Rejecting an authenticated callback because a field moved would drop a real
// delivery report or payment confirmation. Instead the service layer folds the
// provider's own vocabulary into an internal shape, records the raw payload,
// and reports what it could not interpret. That keeps a provider change from
// becoming an outage, which is the same reasoning behind
// POST /email/webhooks/brevo being unvalidated.
//
// What the service DOES require is a usable payload: an entirely empty body is
// a misconfiguration and is worth a 4xx so the caller finds out immediately.
export const webhookBodySchema = Joi.object()
  .min(1)
  .messages({ 'object.min': 'A webhook payload is required' });

// Arkesel posts a form body and repeats the account key in a field; the query
// string variant is only read when the body is not a parsed object.
export const arkeselApiKeyQuerySchema = Joi.object({
  api_key: Joi.string().trim().max(200).optional(),
}).unknown(true);
