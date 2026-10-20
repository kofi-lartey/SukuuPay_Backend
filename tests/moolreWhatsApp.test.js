// The Moolre WhatsApp transport.
//
//   npm test
//
// The failure that matters here is the quiet one. Moolre's send response is
// `status: 1` with an empty `data` array on success — and it is *also*
// `status: 1` when some references in the batch were already used, with the
// rejections listed in `data` and the reason in `error`. A client that only
// checks the status tells a school "sent" for messages that were never
// delivered. That is what these tests pin down.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MOOLRE_WHATSAPP_VASKEY = 'test-whatsapp-vas-key';

const moolreWa = await import('../src/utils/moolreWhatsAppApi.js');

/** The last request the stubbed `fetch` saw. */
let lastRequest = null;

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

// ──────────────────── Configuration ────────────────────

describe('Moolre WhatsApp configuration', () => {
  test('it is configured when the WhatsApp VAS key is present', () => {
    // The WhatsApp key is *not* the SMS key. Moolre issues one
    // service-specific `X-API-VASKEY` per service, and the WhatsApp endpoints
    // reject the SMS one with `AIN11`.
    assert.equal(moolreWa.isMoolreWhatsAppConfigured(), true);
  });
});

// ──────────────────── Templates ────────────────────

describe('Moolre WhatsApp templates', () => {
  test('the approved templates are listed with their placeholders', async () => {
    stubFetch({
      status: 1,
      code: 'WAS200',
      data: [
        {
          id: '1218877297066056',
          name: 'fee_reminder',
          language: 'en',
          status: 'APPROVED',
          message: 'Hello {{1}}, your balance is {{2}}.',
          placeholders: ['1', '2'],
        },
      ],
      next: null,
    });

    const result = await moolreWa.getMoolreWhatsAppTemplates();

    assert.match(lastRequest.url, /\/open\/whatsapp\/template$/);
    assert.equal(lastRequest.method, 'GET');
    assert.equal(lastRequest.headers['X-API-VASKEY'], 'test-whatsapp-vas-key');
    assert.equal(result.templates.length, 1);
    assert.equal(result.templates[0].name, 'fee_reminder');
    assert.equal(result.templates[0].status, 'APPROVED');
    assert.deepEqual(result.templates[0].placeholders, ['1', '2']);
    assert.equal(result.next, null);
  });

  test('the page cursor is passed on', async () => {
    stubFetch({ status: 1, code: 'WAS200', data: [], next: null });
    await moolreWa.getMoolreWhatsAppTemplates({ next: 'opaque-cursor' });
    assert.match(lastRequest.url, /next=opaque-cursor/);
  });
});

// ──────────────────── Sending ────────────────────

describe('Moolre WhatsApp sending', () => {
  test('a message carries the template, the recipient and the placeholders', async () => {
    stubFetch({ status: 1, code: 'WAS200', message: 'suceess', error: [], data: [] });

    const result = await moolreWa.sendMoolreWhatsAppMessage({
      templateName: 'fee_reminder',
      messages: [
        {
          to: '0244000000',
          placeholders: ['Kofi', 'GH₵ 250.00'],
          ref: 'our-ref-1',
        },
      ],
    });

    assert.match(lastRequest.url, /\/open\/whatsapp\/send$/);
    assert.equal(lastRequest.headers['X-API-VASKEY'], 'test-whatsapp-vas-key');
    assert.equal(lastRequest.body.template_name, 'fee_reminder');
    assert.equal(lastRequest.body.language, 'en');
    assert.equal(lastRequest.body.messages.length, 1);
    // The recipient is international digits with no `+` — the platform stores
    // numbers with the plus, and Moolre does not want it.
    assert.equal(lastRequest.body.messages[0].recipient, '233244000000');
    assert.deepEqual(lastRequest.body.messages[0].placeholders, ['Kofi', 'GH₵ 250.00']);
    assert.equal(lastRequest.body.messages[0].ref, 'our-ref-1');
    assert.equal(result.sent.length, 1);
    assert.equal(result.rejected.length, 0);
  });

  test('a ref is always supplied, because it is the only handle', async () => {
    // Moolre's send response carries no message id. Without a ref the delivery
    // status can never be looked up.
    stubFetch({ status: 1, code: 'WAS200', data: [] });
    const result = await moolreWa.sendMoolreWhatsAppMessage({
      templateName: 'fee_reminder',
      messages: [{ to: '0244000000' }],
    });
    assert.ok(result.sent[0].ref, 'a ref is generated');
  });

  test('a partially-rejected batch is not reported as a clean send', async () => {
    // Moolre answers `status: 1` even when some references were already
    // used. The rejections come back in `data` and the reason in `error`.
    // Treating that as a clean send tells a school "sent" for messages that
    // were never delivered.
    stubFetch({
      status: 1,
      code: 'WAS200',
      error: 'Some ref are not unique, corresponding messages will not be sent',
      data: [{ recipient: '233531419011', ref: 'dupe-ref' }],
    });

    const result = await moolreWa.sendMoolreWhatsAppMessage({
      templateName: 'fee_reminder',
      messages: [
        { to: '0244000000', ref: 'ok-ref' },
        { to: '0245000000', ref: 'dupe-ref' },
      ],
    });

    assert.equal(result.sent.length, 1, 'only the accepted message is reported as sent');
    assert.equal(result.sent[0].ref, 'ok-ref');
    assert.equal(result.rejected.length, 1, 'the duplicate is reported as rejected');
    assert.equal(result.rejected[0].ref, 'dupe-ref');
    assert.match(result.rejected[0].reason, /not unique/);
  });

  test('a template is required', async () => {
    await assert.rejects(
      () => moolreWa.sendMoolreWhatsAppMessage({ messages: [{ to: '0244000000' }] }),
      (error) => {
        assert.equal(error.code, 'MOOLRE_WHATSAPP_TEMPLATE_REQUIRED');
        return true;
      }
    );
  });

  test('a malformed number is refused before the provider is called', async () => {
    stubFetch({ status: 1, code: 'WAS200', data: [] });
    await assert.rejects(
      () =>
        moolreWa.sendMoolreWhatsAppMessage({
          templateName: 'fee_reminder',
          messages: [{ to: 'not-a-number' }],
        }),
      (error) => {
        assert.equal(error.code, 'MOOLRE_WHATSAPP_INVALID_MSISDN');
        return true;
      }
    );
  });

  test('an insufficient WhatsApp bundle is an error', async () => {
    stubFetch(
      {
        status: 0,
        code: 'WAS401',
        message: 'Insufficient balance to send messages. Please top up your WhatsApp bundle.',
      },
      { status: 401 }
    );

    await assert.rejects(
      () =>
        moolreWa.sendMoolreWhatsAppMessage({
          templateName: 'fee_reminder',
          messages: [{ to: '0244000000' }],
        }),
      (error) => {
        assert.equal(error.code, 'WAS401');
        assert.match(error.message, /top up your WhatsApp bundle/);
        return true;
      }
    );
  });
});

// ──────────────────── Status ────────────────────

describe('Moolre WhatsApp message status', () => {
  test('the status of each ref is returned', async () => {
    stubFetch({
      status: 1,
      code: 'WAS200',
      data: [
        { ref: 'ref-1', status: 'read' },
        { ref: 'ref-2', status: 'accepted' },
      ],
    });

    const result = await moolreWa.getMoolreWhatsAppMessageStatus({ refs: ['ref-1', 'ref-2'] });

    assert.match(lastRequest.url, /\/open\/whatsapp\/status$/);
    assert.deepEqual(lastRequest.body.ref, ['ref-1', 'ref-2']);
    assert.equal(result.statuses.length, 2);
    assert.equal(result.statuses[0].status, 'read');
    assert.equal(result.statuses[1].status, 'accepted');
  });

  test('at least one ref is required', async () => {
    await assert.rejects(
      () => moolreWa.getMoolreWhatsAppMessageStatus({ refs: [] }),
      (error) => {
        assert.equal(error.code, 'MOOLRE_WHATSAPP_NO_REFS');
        return true;
      }
    );
  });
});
