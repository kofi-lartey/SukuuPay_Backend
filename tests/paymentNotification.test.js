// Telling the parent and the school that a payment landed.
//
//   npm test
//
// A settled payment moves three balances and, before this, told nobody. The
// parent found out by polling and the school found out by opening the
// Payments screen. So these tests are about the two announcements:
//
//   - the **parent** is told by SMS, on the number that paid;
//   - the **school** is told by an in-app `payment.received` notification, one
//     per member of staff who handles fees.
//
// And about the property that makes both of them safe to send: **exactly
// once**. A gateway retries until it is answered, and a settlement whose
// balance step failed is released so the retry can redo it — so without a
// claim, one payment can produce two receipts. A family told twice stops
// believing the school.
//
// The models are stubbed at their statics, and the SMS transport is exercised
// through a stubbed `fetch` so the whole path — the provider call, the
// delivery log, the return value — runs for real.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MOOLRE_API_USER = 'test-api-user';
process.env.MOOLRE_SMS_VASKEY = 'test-vaskey';
process.env.MOOLRE_SMS_SENDER_ID = 'SukuuPay';
process.env.MOOLRE_BASE_URL = 'https://api.moolre.com';

const { Payment } = await import('../src/models/paymentModel.js');
const { Student } = await import('../src/models/studentModel.js');
const { School } = await import('../src/models/schoolModel.js');
const { User } = await import('../src/models/userModel.js');
const { Notification } = await import('../src/models/Notification.js');
const { SmsMessage } = await import('../src/models/smsMessageModel.js');
const { notifyPaymentSettled } = await import(
  '../src/services/paymentNotification.service.js'
);

const STUDENT = {
  _id: 'student-1',
  studentId: 'STU-1',
  studentName: 'Adwoa Boateng',
  studentClass: 'JHS 2A',
  balance: 40000,
  parents: [
    { parentName: 'Kwame Boateng', phone: '0244000000', isPrimary: true },
    { parentName: 'Ama Boateng', phone: '0555000000', isPrimary: false },
  ],
};

const SCHOOL = {
  _id: 'school-1',
  name: 'Test School',
  // The school on the live database is set to Arkesel, which is a *different*
  // account from the one that collects the payments — and one that may have
  // no credit. The receipt must not be routed there.
  sms: { provider: 'arke', senderId: '' },
};

const PAYMENT = {
  _id: 'pay-1',
  paymentId: 'PAY-20261021-GBEI8V',
  reference: 'SUK-1792573601108-NIZC2A',
  studentId: 'student-1',
  schoolId: 'school-1',
  amount: 110000,
  paymentMethod: 'momo',
  // The rail the money came in on. The receipt rides the same one.
  provider: 'moolre',
  momoPhoneNumber: '0557655008',
  // The settlement claim, taken before the balance moves. A receipt is a
  // statement about money, and this is what says the money moved.
  settlement: { appliedAt: new Date('2026-10-21T09:07:00.000Z'), reference: null },
  notification: { sentAt: null, channels: [] },
};

const ADMINS = [
  { _id: 'admin-1', schoolId: 'school-1', phone: '0200000001' },
  { _id: 'admin-2', schoolId: 'school-1', phone: '0200000002' },
];

/** Everything the stubs recorded. */
let calls = null;

const stubModels = ({ claim = true, admins = ADMINS, student = STUDENT } = {}) => {
  calls = { sms: [], notifications: [], claims: 0 };

  // The claim. Winning it is what lets this caller notify; losing it means
  // somebody else already did.
  Payment.findOneAndUpdate = async (_id, update) => {
    calls.claims += 1;
    if (!claim) return null;
    return { ...PAYMENT, notification: { sentAt: update?.$set?.['notification.sentAt'] } };
  };

  // Mongoose's statics return a **chainable query**, not a promise: the code
  // under test calls `.lean()` on the result before anything is awaited. A stub
  // that returns a promise instead has no `.lean` on it, and the failure looks
  // like a bug in the service rather than in the stub.
  Student.findById = () => ({ lean: async () => student });
  School.findById = () => ({ lean: async () => SCHOOL });

  User.find = (filter) => {
    // The recipient filter is the part that matters: a school that is told
    // about its own money, and only that school's.
    calls.userFilter = filter;
    return { select: () => ({ lean: async () => admins }) };
  };

  Notification.insertMany = async (rows) => {
    calls.notifications.push(...rows);
    return rows;
  };

  SmsMessage.create = async (row) => {
    calls.sms.push(row);
    return { ...row, _id: `sms-${calls.sms.length}`, save: async () => {} };
  };
};

/**
 * A gateway answer that accepts the message.
 *
 * The payload is chosen by the endpoint, because the two providers disagree on
 * the shape: Moolre answers `{ status: 1 }` and Arkesel answers
 * `{ status: "success" }`, and each checks its own.
 *
 * `failProviders` fails one named provider and lets the other through — which
 * is how "the school's rail is out of credit but the gateway is healthy" is
 * expressed.
 */
const stubSmsTransport = ({ ok = true, failProviders = [] } = {}) => {
  global.fetch = async (url, options = {}) => {
    calls.smsRequests = calls.smsRequests || [];
    calls.smsRequests.push({ url, body: options.body ? JSON.parse(options.body) : null });

    const isArkesel = String(url).includes('arkesel');
    const provider = isArkesel ? 'arke' : 'moolre';

    if (!ok || failProviders.includes(provider)) {
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ status: 0, message: 'nope' }),
      };
    }

    const body = isArkesel
      ? { status: 'success', data: [{ id: 'ark-1', credits_used: 1 }] }
      : { status: 1, data: null };

    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
};

const originalFetch = global.fetch;
after(() => {
  global.fetch = originalFetch;
});

describe('a settled payment tells the parent and the school', () => {
  beforeEach(() => {
    stubModels();
    stubSmsTransport();
  });

  test('the parent gets a receipt on the number that paid', async () => {
    const result = await notifyPaymentSettled(PAYMENT);

    assert.equal(result.claimed, true);
    assert.equal(calls.sms.length, 1, 'one receipt, and only one');
    assert.equal(calls.sms[0].to, '0557655008');
    assert.equal(result.parent.sent, true);
  });

  test('the receipt says what was paid, for whom, and what is left', async () => {
    await notifyPaymentSettled(PAYMENT);

    const { message } = calls.sms[0];
    assert.match(message, /1100\.00/, 'the amount is in cedis');
    assert.match(message, /Adwoa Boateng/, 'the student is named');
    assert.match(message, /400\.00/, 'the balance left is quoted');
    assert.match(message, /Test School/, 'the school is named');
  });

  test('the receipt is short enough to be one SMS', async () => {
    await notifyPaymentSettled(PAYMENT);

    // A long receipt is a segmented SMS: it costs the school money and arrives
    // as several messages on a phone the parent is reading over someone's
    // shoulder.
    assert.ok(calls.sms[0].message.length <= 160, 'the receipt is a single segment');
  });

  test('the school staff are told, one notification each', async () => {
    const result = await notifyPaymentSettled(PAYMENT);

    assert.equal(result.school.written, 2);
    assert.equal(calls.notifications.length, 2);
    assert.equal(calls.notifications[0].type, 'payment.received');
    assert.match(calls.notifications[0].title, /Adwoa Boateng/);
    assert.match(calls.notifications[0].message, /1100\.00/);
    assert.equal(calls.notifications[0].link, '/dashboard/payments');
  });

  test('the notification carries the detail the bell cannot', async () => {
    await notifyPaymentSettled(PAYMENT);

    const { meta } = calls.notifications[0];
    assert.equal(meta.amount, 110000, 'pesewas, as every other money field');
    assert.equal(meta.amountCedis, 1100, 'and the cedis, which is what a human reads');
    assert.equal(meta.studentName, 'Adwoa Boateng');
    assert.equal(meta.paymentId, 'PAY-20261021-GBEI8V');
  });

  test('only this school’s staff are told', async () => {
    await notifyPaymentSettled(PAYMENT);

    assert.deepEqual(calls.userFilter.schoolId, 'school-1');
    assert.deepEqual(calls.userFilter.role.$in, ['school_admin', 'accountant']);
    // `status` is the field name here, and a query for `isActive` matches
    // nobody — a silent failure where the payment is recorded and no human is
    // ever told.
    assert.equal(calls.userFilter.status, 'active');
  });

  test('the receipt tries the school’s provider, then the payment’s gateway', async () => {
    // The school's SMS provider and its payment gateway are separate accounts,
    // and either can be the one that is unusable on a given day. The receipt
    // goes over the first rail that accepts it.
    await notifyPaymentSettled(PAYMENT);

    assert.equal(calls.sms[0].provider, 'arke', 'the school’s own provider is tried first');
  });

  test('a dead rail does not stop the receipt', async () => {
    // The school's provider is out of credit, and the gateway is healthy. The
    // family still gets their receipt.
    stubSmsTransport({ failProviders: ['arke'] });

    await notifyPaymentSettled(PAYMENT);

    assert.equal(calls.sms.length, 2, 'both rails were tried');
    assert.equal(calls.sms[0].provider, 'arke');
    assert.equal(calls.sms[1].provider, 'moolre');
    assert.equal(calls.notifications[0].meta.receiptSent, true);
  });

  test('a desk payment falls back to the school’s own provider', async () => {
    // Cash at the desk came in over no rail at all, so the school's provider
    // is the only one there is.
    await notifyPaymentSettled({ ...PAYMENT, provider: 'manual' });

    assert.equal(calls.sms[0].provider, 'arke');
    assert.equal(calls.sms.length, 1, 'there is no second rail for cash');
  });

  test('a timeout does not get a second receipt sent', async () => {
    // A timeout is not a rejection: the gateway may have accepted the message
    // and lost the answer. Trying the next rail would deliver the same receipt
    // twice — a family told twice, and billed twice for the platform to tell
    // them.
    global.fetch = async () => {
      throw Object.assign(new Error('Moolre SMS timed out after 30000ms. The message may or may not have been accepted — reconcile before retrying.'), {
        name: 'AbortError',
      });
    };

    await notifyPaymentSettled(PAYMENT);

    assert.equal(calls.sms.length, 1, 'only one rail was tried');
    assert.equal(calls.notifications[0].meta.receiptSent, false);
  });

  test('a failing SMS is reported to the school, not swallowed', async () => {
    // The failure that used to be invisible: the payment is recorded, the
    // portal shows a receipt, and everyone believes the parent was told.
    stubSmsTransport({ ok: false });

    await notifyPaymentSettled(PAYMENT);

    assert.equal(calls.notifications.length, ADMINS.length);
    assert.match(calls.notifications[0].message, /receipt SMS could not be sent/i);
    assert.equal(calls.notifications[0].meta.receiptSent, false);
  });

  test('a sent receipt is recorded as sent', async () => {
    await notifyPaymentSettled(PAYMENT);

    assert.equal(calls.notifications[0].meta.receiptSent, true);
  });

  test('a payment that never settled is not announced', async () => {
    // A parent who starts a payment and walks away leaves a `processing`
    // payment behind, and every one of them is a payment this must stay
    // silent about. A receipt would tell the family money arrived when it
    // did not.
    const abandoned = { ...PAYMENT, settlement: { appliedAt: null, reference: null } };

    const result = await notifyPaymentSettled(abandoned);

    assert.equal(result.claimed, false);
    assert.equal(calls.sms.length, 0, 'no receipt for a payment that never settled');
    assert.equal(calls.notifications.length, 0, 'and nothing told to the school');
  });

  test('the payment is told once, however many times it settles', async () => {
    // The first settlement wins the claim.
    await notifyPaymentSettled(PAYMENT);
    assert.equal(calls.sms.length, 1);
    assert.equal(calls.notifications.length, ADMINS.length);

    // A gateway retry arrives and finds the claim taken. Re-stubbing resets the
    // recorders, so what follows is exactly what the retry added — which is
    // nothing.
    stubModels({ claim: false });
    const second = await notifyPaymentSettled(PAYMENT);

    assert.equal(second.claimed, false);
    assert.equal(calls.sms.length, 0, 'no second receipt');
    assert.equal(calls.notifications.length, 0, 'no second notification');
  });
});

describe('when one announcement fails', () => {
  beforeEach(() => {
    stubModels();
  });

  test('a failing SMS still leaves the school told', async () => {
    stubSmsTransport({ ok: false });

    const result = await notifyPaymentSettled(PAYMENT);

    assert.equal(result.parent.sent, false);
    assert.equal(result.school.written, 2, 'the school still hears about it');
  });

  test('a payment with no number on file does not throw', async () => {
    stubSmsTransport();
    stubModels({ student: { ...STUDENT, parents: [] } });
    const payment = { ...PAYMENT, momoPhoneNumber: null };

    const result = await notifyPaymentSettled(payment);

    assert.equal(result.claimed, true);
    assert.equal(calls.sms.length, 0, 'nothing is sent to nobody');
    assert.equal(result.school.written, 2, 'the school is still told');
  });

  test('a school with nobody to tell is not an error', async () => {
    stubSmsTransport();
    stubModels({ admins: [] });

    const result = await notifyPaymentSettled(PAYMENT);

    assert.equal(result.school.written, 0);
    assert.equal(result.parent.sent, true, 'the parent is still told');
  });
});
