// Can this deployment send an SMS right now?
//
//   npm test
//
// Every way a receipt fails to reach a parent is invisible from the outside:
// no credit, no approved sender ID, no messaging account on this service. A
// platform that sends nothing looks exactly like a platform that is working,
// right up until a parent says they got no receipt.
//
// So the rail is asked about, and the answer is checked here. These tests
// cover the three facts that decide it, and the one fact that is easy to get
// wrong: **the sender-ID registry is per SMS service, not per merchant.** A
// sender ID approved on one service is not approved on another, which looks
// exactly like "Moolre says my approved sender ID is not approved".
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MOOLRE_API_USER = 'test-api-user';
process.env.MOOLRE_SMS_VASKEY = 'test-vaskey';
process.env.MOOLRE_SMS_SENDER_ID = 'SukuuPay';

const {
  listMoolreSenderIds,
  getMoolreSenderIdStatus,
  getMoolreSmsReadiness,
  createMoolreSenderId,
} = await import('../src/utils/moolreSmsApi.js');

const originalFetch = global.fetch;
after(() => {
  global.fetch = originalFetch;
});

/**
 * A Moolre that answers with a registry and a balance.
 *
 * The endpoint decides the answer, because the registry and the balance are
 * different calls: `type: 7` lists the sender IDs, `type: 2` is the account
 * status.
 */
const stubMoolre = ({
  senderIds = [{ id: 6079, senderid: 'SukuuPay', approval: 'Approved', whitelisted: false }],
  balance = 25,
} = {}) => {
  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};

    if (body.type === 7) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 1, code: 'ASMQ08', data: senderIds }) };
    }
    if (body.type === 2) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 1, code: 'ASMQ03', data: { balance } }) };
    }
    if (body.type === 3) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 1, code: 'ASMQ12', data: null }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 1, data: null }) };
  };
};

describe('the Moolre sender ID registry', () => {
  beforeEach(() => stubMoolre());

  test('it lists what the account actually has', async () => {
    const rows = await listMoolreSenderIds();

    assert.equal(rows.length, 1);
    assert.equal(rows[0].senderid, 'SukuuPay');
    assert.equal(rows[0].approval, 'Approved');
  });

  test('an approved sender ID is reported as approved', async () => {
    const status = await getMoolreSenderIdStatus();

    assert.equal(status.approved, true);
    assert.equal(status.registered, true);
    assert.equal(status.reason, null);
  });

  test('a pending sender ID is reported as pending, with the reason', async () => {
    stubMoolre({
      senderIds: [{ id: 6079, senderid: 'SukuuPay', approval: 'Pending', whitelisted: false }],
    });

    const status = await getMoolreSenderIdStatus();

    assert.equal(status.approved, false);
    assert.match(status.reason, /Pending/);
  });

  test('a sender ID this service has never seen is reported as unregistered', async () => {
    stubMoolre({ senderIds: [] });

    const status = await getMoolreSenderIdStatus();

    assert.equal(status.registered, false);
    assert.match(status.reason, /not registered/);
  });

  test('registering a sender ID that already exists does not create a second row', async () => {
    // Two rows with the same name, and Moolre resolves a send against one of
    // them. A duplicate pending row left by an earlier attempt shadows the
    // approved one, and the send fails with "not approved" while the portal
    // shows it approved.
    const result = await createMoolreSenderId({ senderId: 'SukuuPay' });

    assert.equal(result.existing, true);
    assert.equal(result.data.approval, 'Approved');
  });
});

describe('whether the SMS rail is ready', () => {
  beforeEach(() => stubMoolre());

  test('an approved sender ID and credit means ready', async () => {
    const readiness = await getMoolreSmsReadiness();

    assert.equal(readiness.ready, true);
    assert.equal(readiness.reasons.length, 0);
    assert.equal(readiness.balance, 25);
    assert.equal(readiness.senderApproved, true);
  });

  test('no credit is named as the reason', async () => {
    stubMoolre({ balance: 0 });

    const readiness = await getMoolreSmsReadiness();

    assert.equal(readiness.ready, false);
    assert.match(readiness.reasons.join(' '), /no credit/i);
  });

  test('an unapproved sender ID is named as the reason', async () => {
    stubMoolre({
      senderIds: [{ id: 6079, senderid: 'SukuuPay', approval: 'Pending', whitelisted: false }],
    });

    const readiness = await getMoolreSmsReadiness();

    assert.equal(readiness.ready, false);
    assert.match(readiness.reasons.join(' '), /SukuuPay/);
  });

  test('both problems are named, not just the first', async () => {
    stubMoolre({
      balance: 0,
      senderIds: [{ id: 6079, senderid: 'SukuuPay', approval: 'Pending', whitelisted: false }],
    });

    const readiness = await getMoolreSmsReadiness();

    assert.equal(readiness.reasons.length, 2);
  });
});
