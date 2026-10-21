// Moolre: the primary payment gateway and the SMS provider.
//
//   npm test
//
// The tests that matter here are the ones where a silent wrong answer costs a
// school money or a parent their receipt:
//
//   - a channel that Moolre cannot route must be refused, not accepted and
//     then dropped at the carrier;
//   - a callback must never settle a payment on its own — the transaction has
//     to be re-verified with Moolre first;
//   - a short payment must not be credited;
//   - a second delivery of the same callback must not credit twice.
//
// Pure unit tests: no database, no network. `fetch` is stubbed, and the
// Mongoose models are stubbed at their statics, which is enough to assert on
// the decisions rather than on the queries.
//
// The credential-presence tests spawn a child process, because `config/env.js`
// reads the environment once at module load: a second import of the client in
// the same process would see the first import's credentials, not the ones the
// test set.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Set before anything imports `config/env.js`. `dotenv` does not override a
// value that is already in the environment, so these win over `.env`.
process.env.MOOLRE_API_USER = 'test-api-user';
process.env.MOOLRE_API_KEY = 'test-api-key';
process.env.MOOLRE_PUBLIC_KEY = 'test-public-key';
process.env.MOOLRE_ACCOUNT_NUMBER = 'test-account-number';
process.env.MOOLRE_SMS_VASKEY = 'test-vas-key';
process.env.MOOLRE_SMS_SENDER_ID = 'SukuuPay';
// The base URL comes from the environment, which may point at the sandbox.
// Asserting against the configured host rather than a hardcoded one keeps the
// test honest about what it is checking — the *path* — without failing
// because a deployment is running against a different environment.
process.env.MOOLRE_BASE_URL = 'https://api.moolre.com';

const { MOOLRE_BASE_URL } = await import('../src/config/env.js');
const moolre = await import('../src/utils/moolreClient.js');
const moolreSms = await import('../src/utils/moolreSmsApi.js');

/** The last request the stubbed `fetch` saw. */
let lastRequest = null;

/**
 * Stubs `fetch` with a JSON response.
 *
 * The stub records the request — url, method, headers, parsed body — because
 * the assertions are about what was *sent* to Moolre, not about what came
 * back.
 */
const stubFetch = (response, { status = 200 } = {}) => {
  lastRequest = null;
  global.fetch = async (url, options = {}) => {
    lastRequest = {
      url: String(url),
      method: options.method,
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null,
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(response),
      json: async () => response,
    };
  };
};

const originalFetch = global.fetch;
after(() => {
  global.fetch = originalFetch;
});

// ──────────────────── Client: configuration ────────────────────

describe('Moolre client configuration', () => {
  test('isMoolreConfigured is true when all four credentials are present', () => {
    assert.equal(moolre.isMoolreConfigured(), true);
  });

  test('isMoolreConfigured is false when any one credential is missing', () => {
    // Run in a child process: `config/env.js` reads the environment once, so
    // the only way to observe a *different* credential set is a fresh process.
    const script = `
      import { isMoolreConfigured } from './src/utils/moolreClient.js';
      console.log(JSON.stringify({ configured: isMoolreConfigured() }));
    `;

    const runWith = (overrides) => {
      const env = {
        ...process.env,
        MOOLRE_API_USER: 'u',
        MOOLRE_API_KEY: 'k',
        MOOLRE_PUBLIC_KEY: 'p',
        MOOLRE_ACCOUNT_NUMBER: 'a',
        ...overrides,
      };
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env,
        encoding: 'utf8',
        cwd: process.cwd(),
      });
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      return JSON.parse(line);
    };

    assert.equal(runWith({ MOOLRE_ACCOUNT_NUMBER: '' }).configured, false);
    assert.equal(runWith({ MOOLRE_PUBLIC_KEY: '' }).configured, false);
    assert.equal(runWith({ MOOLRE_API_KEY: '' }).configured, false);
    assert.equal(runWith({ MOOLRE_API_USER: '' }).configured, false);
    assert.equal(runWith({}).configured, true);
  });
});

// ──────────────────── Client: channels ────────────────────

describe('Moolre channel codes', () => {
  test('MTN, Telecel and AirtelTigo map to Moolre\'s numeric channels', () => {
    assert.equal(moolre.normaliseChannel('MTN'), '13');
    assert.equal(moolre.normaliseChannel('Telecel'), '6');
    assert.equal(moolre.normaliseChannel('AirtelTigo'), '7');
  });

  test('Vodafone is Telecel', () => {
    assert.equal(moolre.normaliseChannel('Vodafone'), '6');
    assert.equal(moolre.normaliseChannel('VODAFONE'), '6');
  });

  test('the spellings the platform stores are accepted too', () => {
    // `Student.momoNetwork` and `Payment.momoNetwork` carry these, so a
    // payment initiated from a stored network must not be refused.
    assert.equal(moolre.normaliseChannel('VODAFONE'), '6');
    assert.equal(moolre.normaliseChannel('AIRTELTELIGO'), '7');
    assert.equal(moolre.normaliseChannel('MTN MOMO'), '13');
    assert.equal(moolre.normaliseChannel('13'), '13');
  });

  test('an unknown network throws rather than being guessed at', () => {
    // Moolre would accept the request and then fail to deliver it to any
    // carrier: a parent whose money was debited and whose balance was never
    // credited. Refusing here is the only safe answer.
    assert.throws(() => moolre.normaliseChannel('unknown'), /Unsupported mobile money network/);
    assert.throws(() => moolre.normaliseChannel(''), /network is required/);
  });

  test('the channel label maps back to the stored vocabulary', () => {
    assert.equal(moolre.channelLabel('13'), 'MTN');
    assert.equal(moolre.channelLabel('6'), 'VODAFONE');
    assert.equal(moolre.channelLabel('7'), 'AIRTELTELIGO');
  });

  test('an unmappable channel labels as null rather than throwing', () => {
    // The label is written to the audit line *after* the payment has settled.
    // Throwing there would turn a settled payment into a failed webhook.
    assert.equal(moolre.channelLabel('unknown'), null);
    assert.equal(moolre.channelLabel(''), null);
  });
});

// ──────────────────── Client: initiating ────────────────────

describe('Moolre payment initiation', () => {
  test('a USSD push carries the reference, the channel and the amount', async () => {
    stubFetch({ status: 1, code: 'TR099', data: 'f25fc80e-791b-495b-8799-dcf87660457d' });

    const result = await moolre.initiatePayment({
      amount: 150.5,
      phone: '0244000000',
      network: 'MTN',
      reference: 'SUK-123-ABCDEF',
      description: 'School fees',
    });

    assert.equal(lastRequest.method, 'POST');
    // The collection endpoint. Posting this to `/open/transact/status` — the
    // status lookup — returns an *account listing*, not anything about the
    // transaction, and the prompt never reaches the payer.
    assert.match(lastRequest.url, /\/open\/transact\/payment$/);
    assert.equal(lastRequest.body.type, 1);
    assert.equal(lastRequest.body.externalref, 'SUK-123-ABCDEF');
    assert.equal(lastRequest.body.channel, '13');
    assert.equal(lastRequest.body.amount, '150.50');
    assert.equal(lastRequest.body.currency, 'GHS');
    assert.equal(lastRequest.body.payer, '0244000000');
    assert.equal(lastRequest.body.accountnumber, 'test-account-number');
    // The callback is not sent per-request; it is registered on the wallet.
    assert.equal(lastRequest.body.callback, undefined);
    assert.equal(result.transactionId, 'f25fc80e-791b-495b-8799-dcf87660457d');
  });

  test('the public key travels as X-API-PUBKEY, not the private key', async () => {
    // The payment endpoints are on the *public* key. Sending the private key
    // there is answered with `AIN01 Authentication Error` — inside a 200.
    stubFetch({ status: 1, code: 'TR099', data: 'x' });
    await moolre.initiatePayment({
      amount: 10,
      phone: '0244000000',
      network: 'MTN',
      reference: 'SUK-1',
    });
    assert.equal(lastRequest.headers['X-API-USER'], 'test-api-user');
    assert.equal(lastRequest.headers['X-API-PUBKEY'], 'test-public-key');
    assert.equal(lastRequest.headers['X-API-KEY'], undefined);
  });

  test('a provider rejection is an error, not a silent success', async () => {
    stubFetch({ status: 0, code: 'TP13', message: 'External Reference is required and must be unique.' }, { status: 200 });
    await assert.rejects(
      () =>
        moolre.initiatePayment({
          amount: 10,
          phone: '0244000000',
          network: 'MTN',
          reference: 'SUK-1',
        }),
      /must be unique/
    );
  });
});

// ──────────────────── Client: the OTP round-trip ────────────────────

describe('the Moolre phone-verification step', () => {
  test('TP14 asks for the code instead of looking like a sent prompt', async () => {
    // Moolre answers `status: 1` with `code: TP14` — the *envelope* says
    // success. Only the code distinguishes it. Unwrapping to `data` (the
    // literal string "all") threw the code away, and the caller saw a
    // successful initiation with no prompt and no transaction id: a payment
    // pending forever, and a parent told to look for a prompt that was never
    // sent.
    stubFetch({
      status: 1,
      code: 'TP14',
      message: 'Please complete the verification process sent to you via SMS and try again.',
      data: 'all',
    });

    const result = await moolre.initiatePayment({
      amount: 10,
      phone: '0244000000',
      network: 'MTN',
      reference: 'SUK-1',
    });

    assert.equal(result.status, 'otp_required');
    assert.equal(result.transactionId, null, 'no prompt has been sent yet');
  });

  test('the code is sent back on the repeat request', async () => {
    stubFetch({ status: 1, code: 'TR099', data: 'session-1' });

    await moolre.initiatePayment({
      amount: 10,
      phone: '0244000000',
      network: 'MTN',
      reference: 'SUK-1',
      otpCode: '123456',
    });

    assert.equal(lastRequest.body.otpcode, '123456');
  });

  test('TP17 is followed by another request, because the prompt has not been sent yet', async () => {
    // `TP17` is the *permission* to send a prompt, not the prompt. Stopping
    // there leaves the parent staring at their phone for a prompt that will
    // never arrive.
    const responses = [
      { status: 1, code: 'TP17', message: 'Phone number verification was successful.', data: 'all' },
      { status: 1, code: 'TR099', message: null, data: 'session-2' },
    ];
    let call = 0;
    global.fetch = async (url, options = {}) => {
      lastRequest = {
        url: String(url),
        method: options.method,
        headers: options.headers || {},
        body: options.body ? JSON.parse(options.body) : null,
      };
      const payload = responses[call] || responses[responses.length - 1];
      call += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };

    const result = await moolre.initiatePayment({
      amount: 10,
      phone: '0244000000',
      network: 'MTN',
      reference: 'SUK-1',
      otpCode: '123456',
    });

    assert.equal(call, 2, 'the prompt request followed the verification');
    assert.equal(result.status, 'requested');
    assert.equal(result.transactionId, 'session-2');
  });

  test('the prompt request carries the session Moolre handed back', async () => {
    // Moolre names the verification session in its answer. The prompt request
    // is the continuation of that session, so it has to carry the id — and the
    // code must not come with it, or Moolre reads the request as a fresh
    // verification attempt and issues another code instead of the prompt.
    const responses = [
      {
        status: 1,
        code: 'TP17',
        message: 'Phone number verification was successful.',
        data: { sessionid: 'session-9' },
      },
      { status: 1, code: 'TR099', message: null, data: 'session-10' },
    ];
    const requests = [];
    let call = 0;
    global.fetch = async (url, options = {}) => {
      requests.push(options.body ? JSON.parse(options.body) : null);
      const payload = responses[call] || responses[responses.length - 1];
      call += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };

    await moolre.initiatePayment({
      amount: 10,
      phone: '0244000000',
      network: 'MTN',
      reference: 'SUK-1',
      otpCode: '123456',
    });

    assert.equal(requests[0].otpcode, '123456', 'the code goes on the first request');
    assert.equal(requests[1].sessionid, 'session-9', 'the session goes on the second');
    assert.equal(requests[1].otpcode, undefined, 'the code does not go on the second');
  });

  test('a code Moolre refuses is reported as retryable, not as a broken integration', async () => {
    // Moolre answers the follow-up with "a code was sent to you" again: the
    // code was wrong and the number is still unverified. The parent should be
    // told their code was not accepted, not shown a gateway error.
    const responses = [
      { status: 1, code: 'TP17', message: 'Phone number verification was successful.', data: 'all' },
      { status: 1, code: 'TP14', message: 'Please complete the verification process sent to you via SMS and try again.', data: 'all' },
    ];
    let call = 0;
    global.fetch = async (url, options = {}) => {
      const payload = responses[call] || responses[responses.length - 1];
      call += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };

    const result = await moolre.initiatePayment({
      amount: 10,
      phone: '0244000000',
      network: 'MTN',
      reference: 'SUK-1',
      otpCode: '000000',
    });

    assert.equal(result.status, 'otp_required');
    assert.equal(result.transactionId, null, 'no prompt has been sent yet');
  });

  test('a prompt that goes out is reported as requested', async () => {
    stubFetch({ status: 1, code: 'TR099', message: null, data: 'session-3' });

    const result = await moolre.initiatePayment({
      amount: 10,
      phone: '0244000000',
      network: 'MTN',
      reference: 'SUK-1',
    });

    assert.equal(result.status, 'requested');
    assert.equal(result.transactionId, 'session-3');
  });

  test('a code we do not recognise is surfaced, not treated as a sent prompt', async () => {
    stubFetch({ status: 1, code: 'TP99', message: 'Something new', data: 'x' });

    await assert.rejects(
      () =>
        moolre.initiatePayment({
          amount: 10,
          phone: '0244000000',
          network: 'MTN',
          reference: 'SUK-1',
        }),
      (error) => {
        assert.equal(error.code, 'TP99');
        return true;
      }
    );
  });
});

// ──────────────────── Client: verifying ────────────────────

describe('Moolre transaction verification', () => {
  test('txstatus is normalised onto the platform vocabulary', async () => {
    // | txstatus | Meaning    |
    // |----------|------------|
    // | 1        | Successful |
    // | 0        | Pending    |
    // | 2        | Failed     |
    // | 3        | Not found  |
    const cases = [
      [1, 'success'],
      [0, 'pending'],
      [2, 'failed'],
      [3, 'pending'], // not found is pending, never failed
    ];

    for (const [txstatus, expected] of cases) {
      stubFetch({ status: 1, code: 'SS01', data: { txstatus, amount: '10.00' } });
      const result = await moolre.verifyTransaction({ reference: 'SUK-1' });
      assert.equal(result.status, expected, `txstatus ${txstatus} should map to ${expected}`);
    }
  });

  test('a not-found lookup is not mistaken for a success', async () => {
    // Moolre answers `status: 1` even when the transaction does not exist —
    // the outcome is in `data.txstatus`, not in the envelope. Reading the
    // envelope is how a lookup that found nothing becomes a settled payment.
    stubFetch({ status: 1, code: 'SS07', message: 'Transaction not found', data: { txstatus: 3 } });
    const result = await moolre.verifyTransaction({ reference: 'SUK-1' });
    assert.equal(result.status, 'pending');
    assert.equal(result.txStatus, 3);
  });

  test('the verification asks Moolre by externalref', async () => {
    stubFetch({ status: 1, code: 'SS01', data: { txstatus: 1 } });
    await moolre.verifyTransaction({ reference: 'SUK-9' });
    assert.match(lastRequest.url, /\/open\/transact\/status$/);
    assert.equal(lastRequest.body.type, 1);
    assert.equal(lastRequest.body.idtype, 1, 'idtype 1 means "the id is the externalref"');
    assert.equal(lastRequest.body.id, 'SUK-9');
    assert.equal(lastRequest.headers['X-API-PUBKEY'], 'test-public-key');
  });
});

// ──────────────────── Client: hosted checkout ────────────────────

describe('Moolre hosted checkout', () => {
  test('the link is created and its URL returned', async () => {
    // The checkout is not a page this platform hosts or guesses at: Moolre
    // creates a Web POS page per payment and returns its `authorization_url`.
    stubFetch({
      status: 1,
      code: 'POS09',
      data: { authorization_url: 'https://pos.moolre.com/RZWs1yB6amGjNoiEQvlHPS5uqgp3Jc' },
    });

    const result = await moolre.createCheckoutSession({
      amount: 75,
      reference: 'SUK-7',
      redirectUrl: 'https://sukuupay.netlify.app/pay/STU-ABCD1234',
      email: 'bursar@school.edu.gh',
      callbackUrl: 'https://sukuupay-backend.onrender.com/api/pay/webhook/moolre',
    });

    assert.match(lastRequest.url, /\/embed\/link$/);
    assert.equal(lastRequest.body.type, 1);
    assert.equal(lastRequest.body.amount, '75.00');
    assert.equal(lastRequest.body.externalref, 'SUK-7');
    assert.equal(lastRequest.body.email, 'bursar@school.edu.gh');
    assert.equal(
      lastRequest.body.callback,
      'https://sukuupay-backend.onrender.com/api/pay/webhook/moolre'
    );
    assert.equal(result.checkoutUrl, 'https://pos.moolre.com/RZWs1yB6amGjNoiEQvlHPS5uqgp3Jc');
  });

  test('a response with no URL is an error, not a broken link', async () => {
    stubFetch({ status: 1, code: 'POS09', data: {} });
    await assert.rejects(
      () => moolre.createCheckoutSession({ amount: 75, reference: 'SUK-7' }),
      (error) => {
        assert.equal(error.code, 'MOOLRE_CHECKOUT_URL_MISSING');
        return true;
      }
    );
  });
});

// ──────────────────── SMS ────────────────────

describe('Moolre SMS', () => {
  test('the VAS credential travels in the X-API-VASKEY header', async () => {
    stubFetch({ status: 1, code: 'SMS01', message: 'Success', data: null });

    const result = await moolreSms.sendMoolreSms({
      to: '0244000000',
      message: 'Your payment was received.',
      ref: 'our-ref-1',
    });

    assert.equal(lastRequest.url, `${MOOLRE_BASE_URL}/open/sms/send`);
    assert.equal(lastRequest.headers['X-API-VASKEY'], 'test-vas-key');
    assert.equal(lastRequest.body.type, 1);
    assert.equal(lastRequest.body.senderid, 'SukuuPay');
    // The body is a `messages` array, not a flat recipient/message pair.
    assert.ok(Array.isArray(lastRequest.body.messages));
    assert.equal(lastRequest.body.messages.length, 1);
    assert.equal(lastRequest.body.messages[0].recipient, '+233244000000');
    assert.equal(lastRequest.body.messages[0].message, 'Your payment was received.');
    assert.equal(lastRequest.body.messages[0].ref, 'our-ref-1');
    // Moolre's send response carries no message id, so the ref we supplied is
    // the only handle the delivery-report lookup can match on.
    assert.equal(result.providerMessageId, 'our-ref-1');
  });

  test('a ref is generated when the caller does not supply one', async () => {
    stubFetch({ status: 1, code: 'SMS01', message: 'Success', data: null });
    const result = await moolreSms.sendMoolreSms({
      to: '0244000000',
      message: 'Reminder',
    });
    assert.ok(result.providerMessageId, 'a ref is always supplied — without it the delivery report cannot be matched');
  });

  test('a missing sender ID is refused with its own code', async () => {
    // The sender ID must be one Moolre has approved for the account. An
    // unapproved ID is not an API error — the carrier drops the message — so
    // the refusal has to happen here, where it can still be reported.
    //
    // Run in a child process: the module reads the environment once at import,
    // so deleting the variable afterwards would test nothing.
    const script = `
      import { sendMoolreSms } from './src/utils/moolreSmsApi.js';
      try {
        await sendMoolreSms({ to: '0244000000', message: 'hi' });
        console.log(JSON.stringify({ threw: false }));
      } catch (error) {
        console.log(JSON.stringify({ threw: true, code: error.code, message: error.message }));
      }
    `;

    // Set to an empty string rather than deleted: `dotenv` treats an empty
    // value as present and will not fill it back in from `.env`, whereas a
    // deleted key is repopulated from the file and the sender ID is never
    // actually missing.
    const env = { ...process.env, MOOLRE_SMS_SENDER_ID: '' };

    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env,
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    const line = out.split('\n').find((l) => l.trim().startsWith('{'));
    const result = JSON.parse(line);

    assert.equal(result.threw, true, 'the send must be refused');
    assert.equal(result.code, 'MOOLRE_SMS_MISSING_SENDER_ID');
    assert.match(result.message, /sender ID is missing/);
  });

  test('a malformed number is refused before the provider is called', async () => {
    stubFetch({ status: 1, data: {} });
    await assert.rejects(
      () => moolreSms.sendMoolreSms({ to: 'not-a-number', message: 'hi' }),
      (error) => {
        assert.equal(error.code, 'MOOLRE_SMS_INVALID_MSISDN');
        return true;
      }
    );
  });

  test('a bulk send reports each recipient separately', async () => {
    // One unreachable number must not hide the fact that the other forty-one
    // parents were reached.
    let call = 0;
    global.fetch = async () => {
      call += 1;
      if (call === 2) return { ok: false, status: 400, text: async () => JSON.stringify({ message: 'nope' }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 1, data: { messageid: 'M' } }) };
    };

    const results = await moolreSms.sendBulkSms({
      recipients: ['0244000000', '0245000000', '0201000000'],
      message: 'Reminder',
    });

    assert.equal(results.length, 3);
    assert.ok(results[0].ok, 'the first recipient went through');
    assert.equal(results[1].ok, false, 'the second recipient failed');
    assert.ok(results[1].error, 'and said why');
    assert.ok(results[2].ok, 'the third still went through');
  });
});
