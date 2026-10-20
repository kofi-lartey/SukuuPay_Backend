import { Router } from 'express';
import {
  arkeselSmsWebhookController,
  mtnPaymentWebhookController,
} from '../controllers/webhooks.controller.js';

export const webhookRoute = Router();

// ─────────────────────────────────────────────
// Incoming webhooks from third parties
// ─────────────────────────────────────────────
// None of these carry a bearer token: the caller is a payment gateway or an SMS
// provider. Each authenticates with a keyed MAC over the raw body, verified in
// the service layer against `req.rawBody` (captured by the `verify` hook in
// src/index.js — a re-serialised body does not reproduce the provider's bytes).
//
// None of them validate the payload shape either. See
// validations/webhooks.validation.js for why: a provider changing a field name
// must not turn into dropped payment confirmations or lost delivery reports.

// POST /webhooks/mtn/payment — MTN transaction result (secondary gateway)
webhookRoute.post('/webhooks/mtn/payment', mtnPaymentWebhookController);

// POST /webhooks/arkesel/sms — Arkesel SMS delivery report
webhookRoute.post('/webhooks/arkesel/sms', arkeselSmsWebhookController);
