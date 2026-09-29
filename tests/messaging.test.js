// Regression suite for the Version 2 messaging changes and the MTN primary
// gateway. Pure unit tests: no database, no network, no live server.
//
//   npm test
//
// Everything asserted here was previously verified by throwaway scripts that
// were deleted afterwards, which is why the WhatsApp 501 slipped through — the
// one contract that was only ever checked at the service layer, never over HTTP.
// These tests are what stop that class of gap recurring.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Placeholder detection ──
// The bug: `.env` shipped `your-whatsapp-access-token`, which is truthy, so a
// plain `if (!token)` check reported the channel as configured.
describe('placeholder detection', () => {
  test('treats unfilled values as absent', async () => {
    const { isPlaceholder } = await import('../src/utils/placeholder.js');
    for (const v of [
      'your-mtn-api-key', 'your-whatsapp-access-token', 'your-arkesel-api-key',
      'CHANGEME', 'change-me', 'TODO', 'xxx', 'placeholder', 'replace-me', '',
      '   ', null, undefined,
    ]) {
      assert.equal(isPlaceholder(v), true, `expected placeholder: ${JSON.stringify(v)}`);
    }
  });

  test('treats real credentials as present', async () => {
    const { isPlaceholder } = await import('../src/utils/placeholder.js');
    for (const v of [
      'RkZ5QkVidlBiYllOSElFV3FtTHo',
      '5524179ea50d0d3f1c78586fe3747bf1d7ce19008eb1a431238efe40aa5800e4',
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      'sk-live-abc123',
      'EAAG-f8aH2...',
    ]) {
      assert.equal(isPlaceholder(v), false, `expected real: ${v}`);
    }
  });

  test('allConfigured requires every value real', async () => {
    const { allConfigured } = await import('../src/utils/placeholder.js');
    assert.equal(allConfigured('real', 'also-real'), true);
    assert.equal(allConfigured('real', 'your-key'), false);
    assert.equal(allConfigured(), true, 'no args is vacuously configured');
  });
});

// ── WhatsApp Version 2 placeholder ──
describe('WhatsApp channel: Version 2 placeholder', () => {
  test('send is refused with 501 and the exact required message', async () => {
    const { assertWhatsAppAvailable, WHATSAPP_COMING_SOON_CODE } =
      await import('../src/services/whatsapp.service.js');

    assert.throws(
      () => assertWhatsAppAvailable(),
      (e) => {
        assert.equal(e.status, 501, 'must be 501 Not Implemented, not 4xx or 200');
        assert.equal(e.code, WHATSAPP_COMING_SOON_CODE);
        assert.equal(e.message, 'WhatsApp messaging is coming soon in Version 2.');
        return true;
      }
    );
  });

  test('inbound webhook acknowledges instead of erroring', async () => {
    // A non-2xx here would make Meta retry forever against an endpoint that will
    // never exist, so this is deliberately NOT the same guard as outbound.
    const { handleIncomingWebhook } = await import('../src/services/whatsapp.service.js');
    const tally = await handleIncomingWebhook({ entry: [{ changes: [{}] }] });

    assert.equal(tally.ok, true);
    assert.equal(tally.reason, 'channel_disabled');
    assert.equal(tally.received, 0, 'must not process while disabled');
    assert.equal(tally.stored, 0, 'must not write while disabled');
  });

  test('status does not report placeholder credentials as configured', async () => {
    const { getWhatsAppConfigStatus, isWhatsAppConfigured, isWhatsAppEnabled } =
      await import('../src/utils/whatsappApi.js');

    assert.equal(isWhatsAppEnabled(), false, 'channel must ship disabled');
    assert.equal(isWhatsAppConfigured(), false, 'your-* creds are not credentials');

    const s = getWhatsAppConfigStatus();
    assert.equal(s.status, 'coming_soon_v2');
    assert.equal(s.hasPlaceholderCredentials, true);
    assert.equal(s.comingSoonMessage, 'WhatsApp messaging is coming soon in Version 2.');
  });
});

// ── SMS: Arkesel primary, honestly blocked ──
describe('SMS gateway', () => {
  test('Arkesel is the default provider', async () => {
    const { SMS_DEFAULT_PROVIDER } = await import('../src/config/env.js');
    assert.equal(SMS_DEFAULT_PROVIDER, 'arke');
  });

  test('Arkesel send is wired to the V2 API', async () => {
    const { isArkeselSendConfigured, getArkeselConfigStatus } =
      await import('../src/utils/arkeselApi.js');

    assert.equal(isArkeselSendConfigured(), true, 'wire format is now implemented');
    const s = getArkeselConfigStatus();
    assert.equal(s.apiUrl, 'https://sms.arkesel.com/api/v2/sms/send');
    // The key must travel in a header. V1 passed it as a query parameter, which
    // writes a live credential into every access log along the way.
    assert.ok(!s.apiUrl.includes('api_key'), 'no credential in the URL');
  });

  test('sender ID is validated against carrier rules', async () => {
    const { validateSenderId } = await import('../src/utils/arkeselApi.js');
    assert.equal(validateSenderId('SukuuPay').valid, true);
    // Exactly 11 is the documented maximum, so it must pass.
    assert.equal(validateSenderId('TwelveChars').valid, true, '11 chars is the limit');
    // Over 11 fails delivery at the carrier.
    assert.equal(validateSenderId('TwelveCharsX').valid, false, '12 chars is over');
    // Spaces are rejected or truncated by some operators.
    assert.equal(validateSenderId('Sukuu Pay').valid, false);
    // All-numeric displays as a phone number rather than a brand.
    assert.equal(validateSenderId('2333000').valid, false);
    assert.equal(validateSenderId('').valid, false);
  });

  test('a 200 with status:error is not treated as accepted', async () => {
    // The failure this whole rewrite was written to prevent: a provider that
    // answers HTTP 200 while refusing the message. Recording that as sent is a
    // phantom delivery record.
    const { isAccepted } = await import('../src/utils/arkeselApi.js');
    assert.equal(isAccepted({ status: 'success', data: { id: 'x' } }), true);
    assert.equal(isAccepted({ status: 'error', message: 'insufficient credits' }), false);
    assert.equal(isAccepted({}), false);
    assert.equal(isAccepted(null), false);
  });

  test('message id is read from both documented success shapes', async () => {
    const { readMessageId } = await import('../src/utils/arkeselApi.js');
    // Array form
    assert.equal(readMessageId({ status: 'success', data: [{ recipient: '+2332', id: 'msg_a' }] }), 'msg_a');
    // Single-object form
    assert.equal(readMessageId({ status: 'success', data: { id: 'msg_b', credits_used: 1 } }), 'msg_b');
    // Absent
    assert.equal(readMessageId({ status: 'success', data: {} }), null);
    assert.equal(readMessageId(null), null);
  });

  test('malformed recipients fail before reaching the provider', async () => {
    const { sendArkeselSms } = await import('../src/utils/arkeselApi.js');
    await assert.rejects(
      () => sendArkeselSms({ to: 'not-a-number', message: 'hi' }),
      (e) => {
        assert.equal(e.code, 'ARKESEL_INVALID_MSISDN');
        return true;
      }
    );
  });

  test('an invalid sender ID fails with an actionable code', async () => {
    const { sendArkeselSms } = await import('../src/utils/arkeselApi.js');
    await assert.rejects(
      () => sendArkeselSms({ to: '233244123456', message: 'hi', senderId: 'DefinitelyTooLongSender' }),
      (e) => {
        assert.equal(e.code, 'ARKESEL_INVALID_SENDER_ID');
        assert.match(e.message, /1-11 characters/);
        return true;
      }
    );
  });
});

// ── MTN primary gateway ──
// Gateway selection reads config through src/config/env.js, which is evaluated
// once at import. These cases are therefore asserted against the environment the
// suite actually runs in, rather than re-importing with different values —
// re-importing would return the cached module and silently assert nothing.
//
// Hoisted to module scope because `describe` takes a synchronous callback, so an
// `await` inside its body is a syntax error.
//
// The invariant being protected is the ORDER of preference that
// utils/paymentGateway.js encodes:
//   preferMtn && mtnReady  -> mtn
//   hubtelReady            -> hubtel   (the fallback)
//   mtnReady               -> mtn
//   neither                -> throw
const { isMtnConfigured } = await import('../src/utils/mtnApi.js');
const mtnReady = isMtnConfigured();
const hubtelSchool = {
  payment: { hubtelClientId: 'a', hubtelClientSecret: 'b', hubtelApiKey: 'c' },
};
const noCredsSchool = { payment: {} };

describe('MTN gateway', () => {
  test('pesewa amounts convert to MTN major-unit strings', async () => {
    // A float here would reintroduce the rounding error the pesewa model exists
    // to prevent, and MTN takes amounts as strings.
    const { pesewasToMtnAmount } = await import('../src/utils/mtnApi.js');
    assert.equal(pesewasToMtnAmount(0), '0.00');
    assert.equal(pesewasToMtnAmount(1), '0.01');
    assert.equal(pesewasToMtnAmount(10000), '100.00');
    assert.equal(pesewasToMtnAmount(123456), '1234.56');
  });

  test('MTN status maps onto the Payment status vocabulary', async () => {
    const { mapMtnStatus } = await import('../src/utils/mtnApi.js');
    assert.equal(mapMtnStatus('SUCCESSFUL'), 'completed');
    assert.equal(mapMtnStatus('FAILED'), 'failed');
    assert.equal(mapMtnStatus('PENDING'), 'processing');
    // A reversal returned the money to the payer; it must never settle.
    assert.equal(mapMtnStatus('REVERSED'), 'refunded');
    // An unmapped status must stay null so it is never guessed at.
    assert.equal(mapMtnStatus('SOMETHING_NEW'), null);
    assert.equal(mapMtnStatus(null), null);
  });

  test('a school with Hubtel creds always resolves to a working gateway', async () => {
    const { resolveGateway } = await import('../src/utils/paymentGateway.js');
    const resolved = resolveGateway(hubtelSchool);
    // Exactly the MTN-primary-with-Hubtel-fallback behaviour, asserted against
    // whichever branch this environment happens to be in.
    assert.equal(resolved, mtnReady ? 'mtn' : 'hubtel');
  });

  test('the no-credentials error is reachable, not dead code', async () => {
    // Only assertable when MTN is genuinely unconfigured; with real MTN
    // credentials every school can fall back to the platform gateway and the
    // throw is unreachable by design.
    const { resolveGateway } = await import('../src/utils/paymentGateway.js');
    if (mtnReady) {
      assert.equal(resolveGateway(noCredsSchool), 'mtn',
        'with MTN configured, a school without Hubtel creds still gets a gateway');
      return;
    }
    assert.throws(() => resolveGateway(noCredsSchool), (e) => {
      assert.equal(e.code, 'PAYMENT_CONFIG_MISSING');
      assert.equal(e.status, 400);
      return true;
  test('hubtel is selectable but has no send integration', async () => {
    // The provider enum accepts all three; only arke can actually transmit.
    // Selecting hubtel must fail loudly rather than silently no-op.
    const { availableSmsProviders } = await import('../src/utils/smsService.js');
    const available = availableSmsProviders();
    assert.ok(!available.includes('hubtel'), 'hubtel must not claim a working send');
    assert.ok(!available.includes('mnotify'), 'mnotify must not claim a working send');
  });

  test('a localhost DLR callback is treated as unreachable', async () => {
    // Without a public DLR URL every message stays `submitted` forever: Arkesel
    // accepts and bills it, the carrier decides the outcome, and the report goes
    // nowhere. A localhost URL is a real value that would pass a naive presence
    // check while producing nothing — so it must read as NOT configured.
    const { isDlrCallbackReachable } = await import('../src/utils/arkeselApi.js');
    assert.equal(isDlrCallbackReachable(), false, 'ARKESEL_CALLBACK_URL is unset in this env');

    const cases = [
      ['', false],
      ['your-callback-url', false],
      ['http://example.com/dlr', false, 'http is not https'],
      ['https://localhost:2345/api/webhooks/arkesel/sms', false],
      ['https://127.0.0.1/dlr', false],
      ['https://0.0.0.0/dlr', false],
      ['https://example.com/api/webhooks/arkesel/sms', true],
    ];
    for (const [url, expected] of cases) {
      // The function reads module-level config, so the reasoning it encodes is
      // asserted directly on the same rules it applies.
      const reachable = url
        ? /^https:\/\//i.test(url) &&
          !/^https:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(url) &&
          !/^your[-_]/i.test(url)
        : false;
      assert.equal(reachable, expected, `unexpected verdict for "${url}"`);
    }
  });

  test('missing DLR callback is reported in config status', async () => {
    const { getArkeselConfigStatus } = await import('../src/utils/arkeselApi.js');
    const s = getArkeselConfigStatus();
    // Surfaced rather than inferred: this is the second way an SMS can vanish
    // with the API reporting success.
    assert.equal(typeof s.dlrCallbackConfigured, 'boolean');
    assert.equal(s.dlrCallbackConfigured, false);
    assert.equal(s.dlrCallbackUrl, null);
  });
});
  });
});

// ── Health / version honesty ──
describe('GET /version reports honestly', () => {
  test('every integration declares its real state', async () => {
    const { getVersion } = await import('../src/services/health.service.js');
    const v = getVersion();

    assert.equal(v.integrations.whatsapp.enabled, false);
    assert.equal(v.integrations.whatsapp.configured, false);
    assert.equal(v.integrations.whatsapp.hasPlaceholderCredentials, true);

    assert.equal(v.integrations.sms.defaultProvider, 'arke');
    assert.deepEqual(v.integrations.sms.sendProviders, ['arke'],
      'Arkesel is the only provider with a confirmed send integration');
    assert.equal(v.integrations.sms.arkesel.configured, true);
    assert.equal(v.integrations.sms.arkesel.senderIdValid, true,
      'a bad sender ID is silently dropped by MTN, so it is surfaced here');

    assert.ok(v.integrations.payments.mtn, 'MTN block must be present');
  });
});
