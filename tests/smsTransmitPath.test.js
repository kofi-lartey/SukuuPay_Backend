// One transmit path.
//
//   npm test
//
// There used to be three ways to reach an SMS gateway, and they did not agree:
//
//   - the payment receipt, through `utils/smsService.sendSms`, which resolved
//     the provider from `school.sms.provider`;
//   - the school's own reminders and parent messages, through
//     `services/sms.service.js` `submitMessage`, which was **hard-wired to
//     Arkesel**;
//   - the platform console's broadcast, through the same `submitMessage`,
//     which **threw** if the platform was on any other provider.
//
// The result was a deployment that looked configured, a school whose balance
// looked full, and parents who heard nothing for two weeks — because the
// account the school was pointed at had run out of credit, and the two paths
// that actually sent never consulted the provider the school was configured
// for.
//
// These tests pin the rule: **every outbound message resolves its provider
// from the school, and every one of them goes through `transmitSms`.**
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MOOLRE_API_USER = 'test-api-user';
process.env.MOOLRE_SMS_VASKEY = 'test-vaskey';
process.env.MOOLRE_SMS_SENDER_ID = 'SukuuPay';
process.env.ARKESEL_API_KEY = 'test-arkesel-key';
process.env.ARKESEL_SENDER_ID = 'SukuuPay';

const { transmitSms } = await import('../src/utils/smsService.js');

const originalFetch = global.fetch;
after(() => {
  global.fetch = originalFetch;
});

/** Records which gateway was called, and answers as that gateway would. */
const stubGateways = () => {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ url: String(url), body, headers: options.headers });

    if (String(url).includes('arkesel')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'success', data: [{ id: 'ark-1' }] }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 1, data: null }) };
  };
  return calls;
};

describe('the transmit path', () => {
  let calls;

  beforeEach(() => {
    calls = stubGateways();
  });

  test('it goes to the provider the school is configured for', async () => {
    const result = await transmitSms({
      to: '0557655008',
      message: 'A message to a parent.',
      school: { sms: { provider: 'moolre', senderId: 'SukuuPay' } },
    });

    assert.equal(result.sent, true);
    assert.equal(result.provider, 'moolre');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /moolre\.com/);
  });

  test('a school on Arkesel still goes to Arkesel', async () => {
    const result = await transmitSms({
      to: '0557655008',
      message: 'A message to a parent.',
      school: { sms: { provider: 'arke', senderId: 'SukuuPay' } },
    });

    assert.equal(result.sent, true);
    assert.equal(result.provider, 'arke');
    assert.match(calls[0].url, /arkesel\.com/);
  });

  test('the sender ID belongs to the provider', async () => {
    // A sender ID is registered with a specific operator. Sending "SukuuPay"
    // through a gateway that has not approved it is dropped by the handset
    // with no report.
    await transmitSms({
      to: '0557655008',
      message: 'A message to a parent.',
      school: { sms: { provider: 'moolre', senderId: 'SchoolBrand' } },
    });

    assert.equal(calls[0].body.senderid, 'SchoolBrand');
  });

  test('a school with no provider falls back to the platform default', async () => {
    const result = await transmitSms({
      to: '0557655008',
      message: 'A message to a parent.',
      school: { sms: {} },
    });

    assert.equal(result.provider, 'moolre');
  });

  test('a provider with no transmit client is refused, by name', async () => {
    const result = await transmitSms({
      to: '0557655008',
      message: 'A message to a parent.',
      school: { sms: { provider: 'mnotify' } },
    });

    assert.equal(result.sent, false);
    assert.match(result.reason, /mnotify/);
    assert.equal(calls.length, 0, 'nothing was sent');
  });

  test('a gateway rejection comes back as a reason, not a throw', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ status: 0, message: 'nope' }),
    });

    const result = await transmitSms({
      to: '0557655008',
      message: 'A message to a parent.',
      school: { sms: { provider: 'moolre' } },
    });

    assert.equal(result.sent, false);
    assert.ok(result.reason, 'the failure says why');
  });

  test("a school's own key is used when it has one", async () => {
    await transmitSms({
      to: '0557655008',
      message: 'A message to a parent.',
      school: { sms: { provider: 'moolre', apiKey: 'the-school-own-vaskey' } },
    });

    assert.equal(calls[0].headers['X-API-VASKEY'], 'the-school-own-vaskey');
  });
});
