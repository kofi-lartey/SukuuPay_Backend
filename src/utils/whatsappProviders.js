// ─────────────────────────────────────────────
// WhatsApp provider registry
// ─────────────────────────────────────────────
// Which provider actually sends a WhatsApp message.
//
// This mirrors `utils/smsService.js`'s `SEND_CLIENTS`: the service layer asks
// the registry for a sender, and the registry decides which vendor is real.
// The alternative — reaching for Meta directly from the service — is what
// makes a provider swap a rewrite rather than a config change.
//
// ## The two providers are not interchangeable
//
// **Meta** (the Cloud API) is the only one with an *inbound* path: it posts
// message webhooks to `/whatsapp/webhook`, which is what the platform's
// inbound handling — conversation threads, a parent's `ACCEPT <token>` on a
// payment plan — is built on.
//
// **Moolre** resells the same Meta product and is the better fit for a school
// on Moolre for payments: one vendor, one balance, one relationship. But its
// documented WhatsApp surface is **outbound only** — list templates, send a
// message, check message status. There is no endpoint that accepts an inbound
// message.
//
// So Moolre can carry the *sending* of reminders and receipts, and cannot
// carry the *receiving* of replies. Anything that depends on a reply still
// needs Meta, and the registry says so rather than pretending otherwise.
import { isWhatsAppConfigured, sendWhatsAppMessage } from './whatsappApi.js';
import {
  isMoolreWhatsAppConfigured,
  sendMoolreWhatsAppMessage,
} from './moolreWhatsAppApi.js';

/**
 * A provider entry.
 *
 * `configured` is a function, not a value, because a provider's readiness is
 * decided at call time: the credentials can be added to a running deployment
 * without a restart of the registry itself.
 *
 * `outbound` is true for both. `inbound` is true only for Meta.
 */
const PROVIDERS = {
  meta: {
    configured: isWhatsAppConfigured,
    send: sendWhatsAppMessage,
    inbound: true,
    label: 'Meta WhatsApp Business',
  },
  moolre: {
    configured: isMoolreWhatsAppConfigured,
    send: sendMoolreWhatsAppMessage,
    // No inbound path: Moolre's documented WhatsApp API cannot accept a
    // reply. See the header.
    inbound: false,
    label: 'Moolre WhatsApp',
  },
};

/** The provider ids that have a working send integration. */
export const availableWhatsAppProviders = () =>
  Object.entries(PROVIDERS)
    .filter(([, provider]) => typeof provider.send === 'function' && provider.configured())
    .map(([id]) => id);

/** The provider ids that can also *receive* messages. */
export const availableWhatsAppInboundProviders = () =>
  Object.entries(PROVIDERS)
    .filter(([, provider]) => provider.inbound && provider.configured())
    .map(([id]) => id);

/**
 * The provider to send with.
 *
 * `preferred` wins when it is configured and real. Otherwise the first
 * configured provider is used, in registry order.
 *
 * @param {string} [preferred] the provider id the caller wants
 * @returns {{id: string, provider: object}}
 */
export const resolveWhatsAppProvider = (preferred) => {
  if (preferred && PROVIDERS[preferred]?.configured()) {
    return { id: preferred, provider: PROVIDERS[preferred] };
  }

  for (const [id, provider] of Object.entries(PROVIDERS)) {
    if (typeof provider.send === 'function' && provider.configured()) {
      return { id, provider };
    }
  }

  const error = new Error(
    'No WhatsApp provider is configured. Set the Meta credentials (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID) or MOOLRE_WHATSAPP_VASKEY.'
  );
  error.status = 503;
  error.code = 'WHATSAPP_NOT_CONFIGURED';
  throw error;
};

export default { availableWhatsAppProviders, availableWhatsAppInboundProviders, resolveWhatsAppProvider };
